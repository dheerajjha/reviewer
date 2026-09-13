'use strict';

const fs = require('fs').promises;
const path = require('path');

const simpleGit = require('simple-git');

const { buildReviewDocument, filterReviewDocument } = require('./agent');
const { readSavedComments, belongsTo } = require('./store');
const { commentsFilename, canonicalRepoPath, repoSlug } = require('./review');

/**
 * Producing a `code-review/v1` document from a repository on disk.
 *
 * This chain — read the saved comments, build the document, filter it — used
 * to be assembled exactly once, inside a local un-exported function in
 * `bin/reviewer.js`. That was fine while the CLI was the only consumer. It
 * stops being fine the moment there is a second one, because the second
 * consumer cannot call it and has to rebuild it, and then the two copies
 * drift in the way that matters most: quietly, and only in the edge cases.
 *
 * The HTTP server reaches the same document by a third route entirely
 * (`POST /api/submit-review`), which is session-bound and writes two files to
 * disk as a side effect of being asked for a document. That one is left alone
 * here; this module is what anything new should call.
 *
 * Nothing in here knows about the CLI. The three conditions the CLI reports
 * as usage errors are raised as domain errors and translated at the boundary,
 * so an MCP tool or an agent handover can answer them its own way rather than
 * inheriting a message written for a terminal.
 */

/** No review has been saved for this repository. */
class NoReviewError extends Error {
  /** @param {string} repoPath */
  constructor(repoPath) {
    super(`No saved review for ${repoPath}. Review it first, then export.`);
    this.name = 'NoReviewError';
    this.repoPath = repoPath;
  }
}

/** A review exists, but the requested filter selected none of it. */
class NoMatchingCommentsError extends Error {
  /**
   * @param {string} repoPath
   * @param {string} file the filter that matched nothing
   */
  constructor(repoPath, file) {
    super(`The saved review for ${repoPath} has no comments for ${file}.`);
    this.name = 'NoMatchingCommentsError';
    this.repoPath = repoPath;
    this.file = file;
  }
}

/**
 * Where the working tree is, as far as git will say.
 *
 * Every failure here is answered with nulls rather than raised. A review is
 * still a review when git cannot be reached, and this has to hold for three
 * separate failures that do not look alike:
 *
 *   - the directory is not a repository       -> revparse rejects
 *   - git is not installed                    -> revparse rejects
 *   - the directory does not exist at all     -> `simpleGit()` throws
 *     *synchronously, at construction*, which is why the constructor is
 *     inside the try and not above it. The CLI never hit this because
 *     `main()` does an `fs.access` check first; a library has no such
 *     guarantee, and an agent asking about a repository that has since been
 *     moved or deleted would otherwise get a crash instead of an answer.
 *
 * @param {string} repoPath
 * @returns {Promise<{head: string|null, branch: string|null}>}
 */
async function readGitPosition(repoPath) {
  try {
    const git = simpleGit(repoPath);
    const [head, branch] = await Promise.all([
      git.revparse(['HEAD']).then(sha => sha.trim()).catch(() => null),
      git.revparse(['--abbrev-ref', 'HEAD']).then(name => name.trim()).catch(() => null)
    ]);
    return { head, branch };
  } catch {
    return { head: null, branch: null };
  }
}

/**
 * Load a repository's saved review as a `code-review/v1` document.
 *
 * @param {string} reviewsDir directory holding the saved comment files
 * @param {string} repoPath repository to export
 * @param {object} [options]
 * @param {string|null} [options.file] restrict to one repo-relative path
 * @returns {Promise<import('./agent').ReviewDocument>}
 * @throws {NoReviewError} when nothing has been saved for this repository
 * @throws {NoMatchingCommentsError} when `file` selects no comments
 * @throws {import('./store').ReviewOwnershipError} when the file on disk
 *   records a different repository than the one asked for
 */
async function loadReviewDocument(reviewsDir, repoPath, { file = null } = {}) {
  const { comments } = await readSavedComments(reviewsDir, repoPath);

  if (comments.length === 0) throw new NoReviewError(repoPath);

  // Recording the commit lets a consumer tell whether the tree has moved on
  // since the review was written. Neither is fatal if git will not say.
  //
  // Caveat worth knowing before you build on this: `head` is read live, here,
  // at export time -- it is not what HEAD was when the review was written. So
  // docs/agent-format.md telling consumers to compare it against current HEAD
  // to detect staleness cannot work, because it is always current HEAD. That
  // is a real contract bug (#32); it is reproduced rather than fixed here so
  // this stays the pure lift it claims to be, and so the fix lands where it
  // can change the stored format deliberately.
  const { head, branch } = await readGitPosition(repoPath);

  // Build then filter, in that order, and do not tidy this into one step:
  // `filterReviewDocument` recomputes `summary` honestly and returns the very
  // same object reference when no filter is given. `test/agent.test.js`
  // asserts that identity with `assert.equal`.
  const document = filterReviewDocument(
    buildReviewDocument({ repoPath, comments, generatedAt: new Date(), head, branch }),
    { file }
  );

  if (document.comments.length === 0) throw new NoMatchingCommentsError(repoPath, file);

  return document;
}

/**
 * Every repository with a saved review in `reviewsDir`.
 *
 * Nothing in this codebase enumerated `reviews/` before: there was no way to
 * ask "which repositories have reviews?", only to ask about one you already
 * knew the path of. Any agent-facing surface needs discovery first.
 *
 * Entries are reported from what each file records about itself, with the
 * same ownership rule `readSavedComments` enforces: a file whose recorded
 * repository disagrees with its own filename is corrupt and is skipped rather
 * than listed under a name it does not own. Unreadable and unparseable files
 * are skipped for the same reason — a listing that throws because one file in
 * the directory is damaged is useless.
 *
 * A missing `reviewsDir` is an empty list, not an error: nobody has reviewed
 * anything yet.
 *
 * @param {string} reviewsDir
 * @returns {Promise<Array<{repoPath: string, name: string, comments: number, updatedAt: string}>>}
 *   newest first
 */
async function listReviews(reviewsDir) {
  let names;
  try {
    names = await fs.readdir(reviewsDir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const reviews = [];

  for (const name of names) {
    if (!name.startsWith('.code-review-comments-') || !name.endsWith('.json')) continue;

    const file = path.join(reviewsDir, name);

    let saved;
    let stat;
    try {
      [saved, stat] = await Promise.all([
        fs.readFile(file, 'utf-8').then(JSON.parse),
        fs.stat(file)
      ]);
    } catch {
      continue; // unreadable or not JSON; a damaged file is not a listing failure
    }

    const repoPath = saved?.repoPath;
    if (typeof repoPath !== 'string' || repoPath === '') continue;

    // The filename carries a fingerprint of the canonical path. If the file
    // records a repository that would not produce this filename, the two
    // disagree about who it belongs to, and store.js would refuse to serve
    // it. Listing it anyway would advertise a review that cannot be opened.
    if (commentsFilename(repoPath) !== name) continue;
    if (!belongsTo(repoPath, repoPath)) continue;

    const comments = Array.isArray(saved.comments) ? saved.comments.length : 0;
    if (comments === 0) continue; // an emptied review is not a review

    reviews.push({
      repoPath: canonicalRepoPath(repoPath),
      name: repoSlug(repoPath),
      comments,
      updatedAt: stat.mtime.toISOString()
    });
  }

  return reviews.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

module.exports = { loadReviewDocument, listReviews, NoReviewError, NoMatchingCommentsError };
