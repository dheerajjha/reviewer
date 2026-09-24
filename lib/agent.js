'use strict';

const path = require('path');
const { groupByFile } = require('./comments');
const { fence, repoSlug } = require('./review');

/**
 * The machine-readable form of a review.
 *
 * The `.txt` review is written for a person to read. A coding agent asked to
 * act on a review needs something else: a stable schema, and above all an
 * *anchor* — the exact text of the line a comment was left on. Line numbers
 * are the first thing to go stale, because the agent's own first edit shifts
 * every line below it. The anchor is what lets a comment still be found after
 * that.
 */

const SCHEMA = 'code-review/v1';

/**
 * @typedef {object} ReviewDocument
 * @property {string} schema
 * @property {string} generatedAt ISO 8601
 * @property {{path: string, name: string, head: string|null, branch: string|null}} repository
 * @property {'working'|'lastCommit'|null} mode
 * @property {{comments: number, files: number}} summary
 * @property {AgentComment[]} comments
 */

/**
 * @typedef {object} AgentComment
 * @property {string} id stable within a document
 * @property {string} file repo-relative path
 * @property {number} line line number when the comment was written
 * @property {string|null} anchor the exact source line, for relocating the comment
 * @property {string} [selection] the snippet the reviewer highlighted
 * @property {string} body
 * @property {Array<{body: string, at?: string}>} [followUps]
 */

/**
 * Build the machine-readable review document.
 *
 * @param {object} args
 * @param {string} args.repoPath
 * @param {import('./comments').Comment[]} args.comments
 * @param {Date} args.generatedAt
 * @param {string|null} [args.head] the commit the review was written against
 * @param {string|null} [args.branch]
 * @param {string|null} [args.mode]
 * @returns {ReviewDocument}
 */
function buildReviewDocument({ repoPath, comments, generatedAt, head = null, branch = null, mode = null, range = null }) {
  const grouped = groupByFile(comments);

  return {
    schema: SCHEMA,
    generatedAt: generatedAt.toISOString(),
    repository: {
      path: repoPath,
      name: repoSlug(repoPath),
      head,
      branch
    },
    mode,
    // Omitted rather than null when there is no range, so `"range" in
    // document` is a meaningful test -- the same rule the optional comment
    // fields follow. A `working` review has no range and never will.
    ...(range ? { range } : {}),
    summary: {
      comments: comments.length,
      files: grouped.length
    },
    comments: assignIds(grouped.flatMap(([, fileComments]) => fileComments))
  };
}

/**
 * Give every comment an id that is unique within the document.
 *
 * `<file>:<line>` was assumed to be unique because "the UI anchors one
 * comment per line". It does not: in a diff, the removed line and the line
 * that replaced it can carry the *same* number, one on each side, and
 * commenting on both is two ordinary clicks. The export then contained two
 * different comments under one id, and a consumer keyed by id — which is
 * what an id is for — silently kept one of them. See #26.
 *
 * The first comment on a line keeps the bare `<file>:<line>`, so ids do not
 * churn for the overwhelmingly common case and stay stable for anything
 * already consuming them. Only a genuine collision gets a suffix.
 *
 * Stable across exports because the order is: `groupByFile` sorts by line
 * with a stable sort, so two comments sharing a line keep the order they
 * were saved in, and saving appends.
 *
 * @param {import('./comments').Comment[]} comments in document order
 * @returns {AgentComment[]}
 */
function assignIds(comments) {
  const seen = new Map();

  return comments.map(comment => {
    const base = `${comment.file}:${comment.line}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return toAgentComment(comment, n === 1 ? base : `${base}#${n}`);
  });
}


/**
 * Select comments from an already-built document and keep its summary honest.
 *
 * @param {ReviewDocument} document
 * @param {object} filters
 * @param {string|null} [filters.file]
 * @returns {ReviewDocument}
 */
function filterReviewDocument(document, { file = null } = {}) {
  if (file === null) return document;

  const wanted = normalizeReviewPath(file, document.repository.path);
  const comments = document.comments.filter(comment => comment.file === wanted);
  return {
    ...document,
    summary: {
      comments: comments.length,
      files: new Set(comments.map(comment => comment.file)).size
    },
    comments
  };
}

/**
 * Turn a `--file` argument into the repo-relative, forward-slash form comments
 * are stored in.
 *
 * Shells hand paths over as `./src/auth.js` on tab-completion, scripts often
 * pass absolute paths, and Windows users type backslashes. Matching literally
 * made every one of those miss and fail with the same error as a file that
 * genuinely has no comments.
 *
 * @param {string} file
 * @param {string} repoPath
 * @returns {string}
 */
function normalizeReviewPath(file, repoPath) {
  let candidate = file;
  if (path.isAbsolute(candidate)) candidate = path.relative(repoPath, candidate);

  const normalized = path.posix.normalize(candidate.replace(/\\/g, '/'));
  return normalized.replace(/^(\.\/)+/, '').replace(/\/$/, '');
}

/**
 * @param {import('./comments').Comment} comment
 * @returns {AgentComment}
 */
function toAgentComment(comment, id) {
  const entry = {
    // Derived from file and line so it stays stable across exports, with a
    // suffix where that is not enough on its own. See `assignIds`.
    id,
    file: comment.file,
    line: comment.line,
    anchor: comment.lineContent ?? null,
    body: comment.text
  };

  if (comment.selectedText) entry.selection = comment.selectedText;

  if (comment.followUps?.length > 0) {
    entry.followUps = comment.followUps.map(followUp => {
      const item = { body: followUp.text };
      if (followUp.timestamp) item.at = followUp.timestamp;
      return item;
    });
  }

  return entry;
}

/**
 * What this review was of, in one line.
 *
 * An agent applying a review needs to know whether it is looking at
 * uncommitted work or at a commit that is already in history -- "make this
 * change" means a different thing in each. Both used to print
 * `Reviewed at commit: <sha>`, which in `working` mode is not merely vague:
 * the review is of changes that are *not* in that commit, and saying they
 * are is the kind of authoritative-looking line this project exists to
 * avoid.
 *
 * A null mode is a review exported from a file written before the mode was
 * recorded. Reporting only where HEAD is, exactly as it always did, is the
 * honest answer there -- nothing on disk says what was compared.
 *
 * @param {ReviewDocument} document
 * @returns {string|null}
 */
function describeScope({ repository, mode, range }) {
  const at = repository.head ? ` (${repository.head})` : '';

  if (mode === 'working') {
    return `Reviewed: uncommitted changes in the working tree, against ${repository.branch ?? 'HEAD'}${at}.`;
  }

  if (mode === 'range' && range?.kind === 'commits') {
    // Commits themselves, picked from a list. Both ends are *in* the review,
    // which is the difference from a comparison and worth saying: an agent
    // told "between A and B" would reasonably assume A's own changes were
    // outside it.
    if (range.first === range.last) {
      return `Reviewed: commit ${range.last}${range.subject ? ` ("${range.subject}")` : ''} on its own, against its parent.`;
    }
    return `Reviewed: ${range.commits} commits, ${range.first} through ${range.last} inclusive, as a single combined diff.`;
  }

  if (mode === 'range' && range) {
    // Both ends, and the count, because the count is the only thing that
    // distinguishes "one commit of work" from "nine" once the diff has been
    // flattened -- and an agent reading a flattened diff of nine commits
    // should know that is what it is holding.
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const commits = plural(range.commits, 'commit');

    // Ranges saved before 2.12 carry neither names nor a merge base. Say what
    // they can support and no more.
    if (!range.from || !range.baseName || !range.headName) {
      return `Reviewed: everything between ${range.base} and ${range.head} (${commits}), as a single combined diff.`;
    }

    const ends = `${range.baseName} \u2192 ${range.headName}`;
    if (range.from === range.base) {
      return `Reviewed: ${ends} (${range.base}..${range.head}), ${commits} as a single combined diff.`;
    }

    // Diverged. The agent needs the left-out half as much as the reviewed
    // half: code on the base that differs from the head is not something the
    // reviewer asked anyone to change, and an agent that "fixes" it has
    // reverted someone else's work.
    const behind = range.behind > 0
      ? ` ${range.baseName} has ${plural(range.behind, 'newer commit')} that ${range.behind === 1 ? 'is' : 'are'} deliberately not part of this review; leave that code alone.`
      : '';
    return `Reviewed: what ${range.headName} changes since it diverged from ${range.baseName} (merge base ${range.from}, head ${range.head}), ${commits} as a single combined diff.${behind}`;
  }

  if (mode === 'lastCommit') {
    return repository.head
      ? `Reviewed: commit ${repository.head}, against its parent.`
      : 'Reviewed: the most recent commit, against its parent.';
  }

  return repository.head ? `Reviewed at commit: ${repository.head}` : null;
}

/**
 * Render a review as instructions for a coding agent.
 *
 * This is the format meant to be piped straight into a tool like Claude Code.
 * It leads with what to do and how to locate each comment, because an agent
 * reads top-down and the instruction has to arrive before the data it governs.
 *
 * @param {ReviewDocument} document
 * @returns {string}
 */
function formatPrompt(document) {
  const { repository, summary } = document;
  const lines = [
    '# Code review to address',
    '',
    `Repository: ${repository.path}`,
    describeScope(document),
    `${summary.comments} comment(s) across ${summary.files} file(s), written ${document.generatedAt}.`,
    '',
    'Work through every comment below and make the change it asks for, or, if',
    'you disagree, say why and leave the code alone. Comments are grouped by',
    'file and ordered by line.',
    '',
    'Line numbers are from when the review was written, so treat them as a',
    'hint: locate each comment by its `anchor` line instead, since your own',
    'edits will shift everything below them. If an anchor no longer appears in',
    'the file, say so rather than guessing at the intended location.',
    ''
  ].filter(line => line !== null);

  let currentFile = null;
  for (const comment of document.comments) {
    if (comment.file !== currentFile) {
      currentFile = comment.file;
      lines.push(`## ${currentFile}`, '');
    }

    lines.push(`### ${comment.id}`, '');
    // Fenced with `fence`, not a literal ```, because the anchor is arbitrary
    // source and in a Markdown file it is routinely a fence itself. A
    // same-length marker closes the block on the anchor's own line, and the
    // comment body below it — the instruction the agent is meant to act on —
    // becomes code, taking the next comment's heading with it. See #22.
    if (comment.anchor !== null) {
      lines.push('Anchor line:', '', fence(comment.anchor), '');
    }
    if (comment.selection) {
      lines.push('Selected code:', '', fence(comment.selection), '');
    }

    lines.push(comment.body, '');

    if (comment.followUps?.length > 0) {
      lines.push('Follow-ups:', '');
      comment.followUps.forEach((followUp, index) => {
        lines.push(`${index + 1}. ${followUp.body}`);
      });
      lines.push('');
    }
  }

  return `${lines.join('\n')}`;
}

module.exports = { buildReviewDocument, filterReviewDocument, formatPrompt, SCHEMA };
