'use strict';

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const { commentsFilename, legacyCommentsFilename, canonicalRepoPath } = require('./review');
const { withKeys } = require('./comments');

/**
 * Reading a repository's saved comments, whatever name they were written under.
 *
 * There is exactly one rule here: a review is served to the repository it was
 * written for, or not at all. Comment files used to be named after the
 * repository's basename alone, so two checkouts called `api-service` shared one
 * file — the second review overwrote the first, and every reader afterwards
 * handed one repository's comments out under the other's name. Filenames now
 * carry a fingerprint of the full path, and this module is the single place
 * that decides which file answers for a repository.
 */

/** A comment file that belongs to a different repository than the one asking. */
class ReviewOwnershipError extends Error {
  /**
   * @param {string} requested repository being opened
   * @param {string} owner repository the file records itself as belonging to
   */
  constructor(requested, owner) {
    super(
      `The saved review in this file was written for ${owner}, not ${requested}. ` +
        'Refusing to serve one repository\'s review under another\'s name.'
    );
    this.name = 'ReviewOwnershipError';
    this.requested = requested;
    this.owner = owner;
  }
}

/**
 * Whether a stored `repoPath` names the repository being opened.
 *
 * Files written before the fingerprint existed, and those written by tests,
 * may carry no `repoPath` at all. An absent owner is not a mismatch — there is
 * simply nothing to check — and the filename is doing the identifying.
 *
 * @param {string|undefined} stored
 * @param {string} repoPath
 * @returns {boolean}
 */
function belongsTo(stored, repoPath) {
  if (typeof stored !== 'string' || stored === '') return true;
  return canonicalRepoPath(stored) === canonicalRepoPath(repoPath);
}

/**
 * @param {string} file
 * @returns {Promise<object|null>} parsed contents, or null when absent
 */
async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Read the comments saved for a repository.
 *
 * Looks under the current name first. Falling back to the legacy name is the
 * migration: a review written before this change is adopted, but only when the
 * file says it belongs to this repository — the whole point of the legacy name
 * is that two repositories could share it, so adopting one blindly would
 * reintroduce the bug it is here to fix.
 *
 * @param {string} reviewsDir
 * @param {string} repoPath
 * @returns {Promise<{comments: object[], mode: string|null, range: object|null, untracked?: boolean, adopted: boolean, lastUpdated: string|null}>}
 *   `mode` is null for a file written before it was recorded -- there is
 *   nothing on disk that says what was compared, and guessing would be
 *   worse than admitting it. `lastUpdated` is null when the file carries
 *   no stamp (or there is no file yet): it is the version token a caller
 *   sends back on save so the server can tell a current writer from a
 *   stale one (#107). Every comment and follow-up comes back with a `key`;
 *   one saved before keys existed gets the key derived from its content (see
 *   `withKeys`), the same on every read.
 * @throws {ReviewOwnershipError} when the current file names another repository
 */
async function readSavedComments(reviewsDir, repoPath) {
  const current = path.join(reviewsDir, commentsFilename(repoPath));
  const saved = await readJson(current);

  if (saved !== null) {
    // The fingerprint should already have kept these apart. Checking anyway is
    // cheap, and the failure it guards against is silent corruption.
    if (!belongsTo(saved.repoPath, repoPath)) {
      throw new ReviewOwnershipError(repoPath, saved.repoPath);
    }
    return {
      comments: withKeys(saved.comments ?? []), mode: saved.mode ?? null, range: saved.range ?? null,
      ...(saved.mode === 'working' && saved.untracked === false ? { untracked: false } : {}),
      adopted: false,
      lastUpdated: saved.lastUpdated ?? null
    };
  }

  const legacyName = legacyCommentsFilename(repoPath);
  if (legacyName === commentsFilename(repoPath)) return { comments: [], mode: null, range: null, adopted: false, lastUpdated: null };

  const legacy = await readJson(path.join(reviewsDir, legacyName));
  if (legacy === null || !belongsTo(legacy.repoPath, repoPath)) {
    return { comments: [], mode: null, range: null, adopted: false, lastUpdated: null };
  }

  // Move it under the new name so the next read is a plain hit and the old
  // name stops shadowing another checkout. A read-only reviews directory is
  // not a reason to withhold the review, so a failed rename is not fatal.
  try {
    await fs.rename(path.join(reviewsDir, legacyName), current);
  } catch {
    /* the comments are already in hand; renaming is housekeeping */
  }

  return {
    comments: withKeys(legacy.comments ?? []), mode: legacy.mode ?? null, range: legacy.range ?? null,
    ...(legacy.mode === 'working' && legacy.untracked === false ? { untracked: false } : {}),
    adopted: true,
    lastUpdated: legacy.lastUpdated ?? null
  };
}

/**
 * The `lastUpdated` stamp for a save that follows `previous`.
 *
 * Stamps are the version token for conditional saves (#107), so a new stamp
 * must differ from the one it replaces even when two saves land inside the
 * same millisecond -- otherwise a stale tab would look current by accident.
 *
 * @param {string|null} previous stamp currently on disk, if any
 * @returns {string} ISO 8601 stamp strictly after `previous`
 */
function nextLastUpdated(previous) {
  const parsed = previous ? Date.parse(previous) : NaN;
  const stamp = Number.isNaN(parsed) ? Date.now() : Math.max(Date.now(), parsed + 1);
  return new Date(stamp).toISOString();
}

// A lock older than this belongs to a writer that died holding it. Reading
// and writing one small JSON file takes milliseconds; ten seconds is not a
// writer that is merely slow.
const LOCK_STALE_MS = 10000;
const LOCK_RETRY_MS = 15;
const LOCK_TIMEOUT_MS = 5000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Run `task` holding the lock on `file`, against every process on the machine.
 *
 * The page is no longer the only writer. An agent answering in a thread
 * writes the same file from another process -- `reviewer channel`, run by
 * Claude Code -- and a read-modify-write from each, interleaved, loses one of
 * them. The lock is a sibling file created with `wx`, which the operating
 * system creates atomically or refuses, on every platform Node runs on.
 *
 * @template T
 * @param {string} file
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
async function withFileLock(file, task) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      const handle = await fs.open(lock, 'wx');
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;

      const stat = await fs.stat(lock).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        await fs.rm(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${path.basename(lock)}; if no reviewer is running, delete it.`);
      }
      await sleep(LOCK_RETRY_MS);
    }
  }

  try {
    return await task();
  } finally {
    await fs.rm(lock, { force: true });
  }
}

/**
 * Replace `file` in one step, so no reader ever sees half of it.
 *
 * A reader in another process -- an agent watching the review -- would
 * otherwise be able to catch the file truncated mid-write and parse nothing.
 * Windows refuses to rename over a file another process has open for a
 * moment, so that is retried briefly rather than failing the save.
 *
 * @param {string} file
 * @param {string} content
 */
async function writeFileAtomic(file, content) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(temporary, content);
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(temporary, file);
      return;
    } catch (error) {
      if (attempt < 20 && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) {
        await sleep(10);
        continue;
      }
      await fs.rm(temporary, { force: true });
      throw error;
    }
  }
}

// Writes from this process to one file go one at a time, so they queue here
// instead of polling for the lock against each other.
/** @type {Map<string, Promise<void>>} */
const queues = new Map();

function serialize(file, task) {
  const previous = queues.get(file) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.then(() => {}, () => {});
  queues.set(file, tail);
  tail.then(() => {
    if (queues.get(file) === tail) queues.delete(file);
  });
  return run;
}

/**
 * @typedef {object} SavedReview
 * @property {import('./comments').Comment[]} comments keyed
 * @property {string|null} mode
 * @property {object|null} range
 * @property {boolean} [untracked]
 * @property {string|null} lastUpdated
 */

/**
 * Change a repository's saved comments, safely against every other writer.
 *
 * Takes the lock, reads what is on disk now, and hands it to `update`, which
 * returns the comments to write -- or null to write nothing, which is how a
 * conditional save turns itself down. What it returns is written in one step
 * with a `lastUpdated` strictly after the one it replaced. The scope fields
 * (`mode`, `range`, `untracked`) are kept from disk unless `update` supplies
 * them: a reply in a thread does not change what the review is of.
 *
 * @param {string} reviewsDir
 * @param {string} repoPath
 * @param {(current: SavedReview) => ({comments: object[], scope?: {mode: string|null, range: object|null, untracked?: boolean}}|null|Promise<object|null>)} update
 * @returns {Promise<{written: boolean, comments: object[], lastUpdated: string|null}>}
 */
async function updateSavedComments(reviewsDir, repoPath, update) {
  const file = path.join(reviewsDir, commentsFilename(repoPath));

  return serialize(file, async () => {
    await fs.mkdir(reviewsDir, { recursive: true });

    return withFileLock(file, async () => {
      const current = await readSavedComments(reviewsDir, repoPath);
      const change = await update(current);
      if (!change) return { written: false, comments: current.comments, lastUpdated: current.lastUpdated };

      const scope = change.scope ?? current;
      const lastUpdated = nextLastUpdated(current.lastUpdated ?? null);
      const data = {
        repoPath,
        lastUpdated,
        mode: scope.mode ?? null,
        range: scope.range ?? null,
        ...(scope.mode === 'working' && scope.untracked === false ? { untracked: false } : {}),
        comments: change.comments
      };
      await writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`);

      return { written: true, comments: change.comments, lastUpdated };
    });
  });
}

module.exports = {
  readSavedComments,
  updateSavedComments,
  nextLastUpdated,
  withFileLock,
  writeFileAtomic,
  ReviewOwnershipError,
  belongsTo
};
