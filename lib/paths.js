'use strict';

const path = require('path');

/**
 * Where review state lives, and confining request-supplied paths to the
 * repository being reviewed.
 */

/**
 * Where comment state and submitted reviews are written.
 *
 * This lived in `server.js`, which meant `bin/reviewer.js` imported the whole
 * server module -- express and all -- to read one path constant, for a command
 * (`export`) that never starts a server. It is a path, so it lives with the
 * paths.
 *
 * `..` because this file is one directory deeper than the package root the
 * constant is relative to.
 */
const REVIEWS_DIR = path.join(__dirname, '..', 'reviews');

class PathEscapeError extends Error {
  /** @param {string} requested the offending path, as received */
  constructor(requested) {
    super('Path escapes the repository');
    this.name = 'PathEscapeError';
    this.requested = requested;
  }
}

/**
 * Resolve a repo-relative path to an absolute one, refusing anything that
 * lands outside the repository.
 *
 * The file endpoints take their path straight from the URL, so without this a
 * request for `../../../../etc/passwd` would be served happily. Absolute paths
 * are refused for the same reason: only files inside the opened repository are
 * in scope for a review.
 *
 * @param {string} repoPath absolute path of the repository
 * @param {string} filePath path relative to `repoPath`
 * @returns {string} absolute path inside `repoPath`
 * @throws {PathEscapeError} when the result would sit outside `repoPath`
 */
function resolveRepoFile(repoPath, filePath) {
  const requested = String(filePath ?? '');

  if (requested === '' || path.isAbsolute(requested)) {
    throw new PathEscapeError(requested);
  }

  const root = path.resolve(repoPath);
  const resolved = path.resolve(root, requested);

  // `relative` is '' for the root itself and starts with '..' for anything
  // above it. Comparing prefixes instead would accept a sibling `repo-evil`.
  const relative = path.relative(root, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new PathEscapeError(requested);
  }

  return resolved;
}

module.exports = { REVIEWS_DIR, resolveRepoFile, PathEscapeError };
