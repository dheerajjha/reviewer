'use strict';

const fs = require('fs').promises;
const path = require('path');

const { commentsFilename, legacyCommentsFilename, canonicalRepoPath } = require('./review');

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
 * @returns {Promise<{comments: object[], mode: string|null, adopted: boolean}>}
 *   `mode` is null for a file written before it was recorded -- there is
 *   nothing on disk that says what was compared, and guessing would be
 *   worse than admitting it.
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
    return { comments: saved.comments ?? [], mode: saved.mode ?? null, adopted: false };
  }

  const legacyName = legacyCommentsFilename(repoPath);
  if (legacyName === commentsFilename(repoPath)) return { comments: [], mode: null, adopted: false };

  const legacy = await readJson(path.join(reviewsDir, legacyName));
  if (legacy === null || !belongsTo(legacy.repoPath, repoPath)) {
    return { comments: [], mode: null, adopted: false };
  }

  // Move it under the new name so the next read is a plain hit and the old
  // name stops shadowing another checkout. A read-only reviews directory is
  // not a reason to withhold the review, so a failed rename is not fatal.
  try {
    await fs.rename(path.join(reviewsDir, legacyName), current);
  } catch {
    /* the comments are already in hand; renaming is housekeeping */
  }

  return { comments: legacy.comments ?? [], mode: legacy.mode ?? null, adopted: true };
}

module.exports = { readSavedComments, ReviewOwnershipError, belongsTo };
