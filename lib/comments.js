'use strict';

const crypto = require('crypto');

/**
 * The stored shape of a review comment.
 *
 * The client keeps extra bookkeeping on each comment (diff positions, match
 * state, draft text). Only the fields below are written to disk, so a comment
 * file stays readable and stable across UI changes.
 */

/**
 * @typedef {object} FollowUp
 * @property {string} [key] stable identity, minted when it is written
 * @property {string} text
 * @property {string} [timestamp] ISO 8601
 * @property {string} [by] who wrote it, when it was not the reviewer: an
 *   agent answering in the thread, say `claude`. Absent means the reviewer,
 *   which is what every follow-up written before this field existed was.
 * @property {string} [session] the agent session that wrote it, when known
 */

/**
 * @typedef {object} Comment
 * @property {string} [key] stable identity, minted when the comment is created
 * @property {string} file repo-relative path
 * @property {number} line 1-based line number
 * @property {string} [lineContent] the line the comment is anchored to
 * @property {string} text
 * @property {string} [selectedText] code the reviewer highlighted
 * @property {FollowUp[]} [followUps]
 */

/**
 * What a key looks like: short, and safe in a URL, a filename and an
 * unquoted shell argument, because `reviewer reply <key>` is typed.
 */
const KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** A name in `by`: something a person would recognise in a thread. */
const AUTHOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;

/** A session reference in `session`: an id, not prose. */
const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** @param {unknown} value */
function isKey(value) {
  return typeof value === 'string' && KEY_PATTERN.test(value);
}

/**
 * A new random key: eight characters, 48 bits from `crypto`.
 *
 * Short on purpose. The comment file is meant to stay readable, the key is
 * typed on a command line, and two collisions in one review would need tens
 * of millions of comments.
 *
 * @returns {string}
 */
function mintKey() {
  return crypto.randomBytes(6).toString('base64url');
}

/**
 * The key a comment written without one has always had.
 *
 * Derived rather than random so that every reader -- a tab, an agent, `reviewer
 * export` -- names the same comment the same way without anyone having to
 * write the file first. The parts are what identified a comment before keys
 * existed, plus how many earlier entries shared them, so two identical
 * comments on one line still get two keys.
 *
 * @param {string[]} parts
 * @returns {string}
 */
function derivedKey(parts) {
  return crypto.createHash('sha256').update(parts.join('\u0000')).digest('base64url').slice(0, 8);
}

/**
 * Give every comment and follow-up a key, keeping the ones they already have.
 *
 * Comments saved before keys existed are read through here, and so is
 * anything posted by a client that does not send keys. Both get the derived
 * key, so the same comment comes back with the same key on every read, and a
 * script that re-posts the same list keeps its comments' identities rather
 * than turning each save into a delete and an add.
 *
 * @template {Comment} T
 * @param {T[]} comments
 * @returns {T[]} new objects; the input is left alone
 */
function withKeys(comments) {
  const occurrences = new Map();
  const nth = identity => {
    const n = occurrences.get(identity) ?? 0;
    occurrences.set(identity, n + 1);
    return String(n);
  };

  return comments.map(comment => {
    const key = isKey(comment.key)
      ? comment.key
      : derivedKey(['comment', comment.file, String(comment.line), comment.text,
        nth(JSON.stringify([comment.file, comment.line, comment.text]))]);

    const keyed = { ...comment, key };
    if (Array.isArray(comment.followUps)) {
      keyed.followUps = comment.followUps.map(followUp => (isKey(followUp?.key)
        ? followUp
        : {
          ...followUp,
          key: derivedKey(['follow-up', key, followUp?.timestamp ?? '', followUp?.text ?? '',
            followUp?.by ?? '', nth(JSON.stringify([key, followUp?.timestamp, followUp?.text, followUp?.by]))])
        }));
    }
    return keyed;
  });
}

/**
 * Reduce a follow-up to the fields that get persisted.
 *
 * @param {object} followUp
 * @param {string} where position, for the error message
 * @returns {FollowUp}
 * @throws {TypeError} when it is malformed
 */
function normalizeFollowUp(followUp, where) {
  if (followUp === null || typeof followUp !== 'object' || Array.isArray(followUp)) {
    throw new TypeError(`${where} must be an object`);
  }
  if (typeof followUp.text !== 'string' || followUp.text.trim() === '') {
    throw new TypeError(`${where}.text must be a non-empty string`);
  }

  /** @type {FollowUp} */
  const entry = {};
  if (followUp.key !== undefined) {
    if (!isKey(followUp.key)) throw new TypeError(`${where}.key must be 1-64 letters, digits, _ or -`);
    entry.key = followUp.key;
  }
  entry.text = followUp.text;
  if (followUp.timestamp) entry.timestamp = followUp.timestamp;

  // Empty and absent are the same thing here -- the reviewer -- so only a
  // real name is stored, and the file never says `"by": ""`.
  if (followUp.by !== undefined && followUp.by !== null && followUp.by !== '') {
    if (typeof followUp.by !== 'string' || !AUTHOR_PATTERN.test(followUp.by)) {
      throw new TypeError(`${where}.by must be a short name, such as "claude"`);
    }
    entry.by = followUp.by;
  }
  if (followUp.session !== undefined && followUp.session !== null && followUp.session !== '') {
    if (typeof followUp.session !== 'string' || !SESSION_PATTERN.test(followUp.session)) {
      throw new TypeError(`${where}.session must be a session id`);
    }
    entry.session = followUp.session;
  }

  return entry;
}

/**
 * Reduce a client comment to the fields that get persisted.
 *
 * Optional fields are omitted rather than stored as `null` so that an absent
 * selection and an empty one are not two different states on disk.
 *
 * A comment missing its file, line or text is rejected here rather than stored:
 * `JSON.stringify` would silently drop the missing fields, and the record would
 * only surface later, in `reviewer export`, as a comment on a file called
 * `undefined` for an agent to act on.
 *
 * @param {object} comment
 * @param {number} index position in the batch, for the error message
 * @returns {Comment}
 * @throws {TypeError} when a required field is missing or malformed
 */
function normalizeComment(comment, index) {
  const where = `comments[${index}]`;
  if (comment === null || typeof comment !== 'object' || Array.isArray(comment)) {
    throw new TypeError(`${where} must be an object`);
  }
  if (typeof comment.file !== 'string' || comment.file.trim() === '') {
    throw new TypeError(`${where}.file must be a non-empty string`);
  }
  if (!Number.isInteger(comment.line) || comment.line < 1) {
    throw new TypeError(`${where}.line must be a positive integer`);
  }
  if (typeof comment.text !== 'string' || comment.text.trim() === '') {
    throw new TypeError(`${where}.text must be a non-empty string`);
  }
  if (comment.key !== undefined && !isKey(comment.key)) {
    throw new TypeError(`${where}.key must be 1-64 letters, digits, _ or -`);
  }

  const normalized = {
    ...(comment.key !== undefined ? { key: comment.key } : {}),
    file: comment.file,
    line: comment.line,
    lineContent: comment.lineContent,
    text: comment.text
  };

  if (comment.selectedText) {
    normalized.selectedText = comment.selectedText;
  }

  if (Array.isArray(comment.followUps) && comment.followUps.length > 0) {
    normalized.followUps = comment.followUps.map(
      (followUp, i) => normalizeFollowUp(followUp, `${where}.followUps[${i}]`)
    );
  }

  return normalized;
}

/**
 * Normalize a batch of comments.
 *
 * Two comments claiming one key are refused: a key is how a reply finds its
 * thread, and a reply that could land on either of two comments is the
 * confidently-wrong outcome keys exist to rule out.
 *
 * @param {object[]} comments
 * @returns {Comment[]}
 * @throws {TypeError} when `comments` is not an array or a comment is malformed
 */
function normalizeComments(comments) {
  if (!Array.isArray(comments)) {
    throw new TypeError('comments must be an array');
  }
  const normalized = comments.map((comment, index) => normalizeComment(comment, index));

  const seen = new Set();
  normalized.forEach((comment, index) => {
    if (comment.key === undefined) return;
    if (seen.has(comment.key)) {
      throw new TypeError(`comments[${index}].key "${comment.key}" is used by another comment`);
    }
    seen.add(comment.key);
  });

  return normalized;
}

/**
 * Group comments by file, each group sorted by line number.
 *
 * Insertion order of the files is preserved so a review reads in the order the
 * reviewer worked through the changes.
 *
 * @param {Comment[]} comments
 * @returns {Array<[string, Comment[]]>}
 */
function groupByFile(comments) {
  /** @type {Map<string, Comment[]>} */
  const groups = new Map();

  for (const comment of comments) {
    const group = groups.get(comment.file);
    if (group) group.push(comment);
    else groups.set(comment.file, [comment]);
  }

  return [...groups.entries()].map(([file, group]) => [
    file,
    [...group].sort((a, b) => a.line - b.line)
  ]);
}

module.exports = {
  normalizeComment,
  normalizeComments,
  normalizeFollowUp,
  groupByFile,
  withKeys,
  mintKey,
  isKey,
  KEY_PATTERN,
  AUTHOR_PATTERN
};
