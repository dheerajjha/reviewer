'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Where review state lives, and confining request-supplied paths to the
 * repository being reviewed.
 */

/** The directory reviews were written to before #33. Inside the package. */
const LEGACY_REVIEWS_DIR = path.join(__dirname, '..', 'reviews');

/**
 * The per-user directory this tool may keep state in.
 *
 * Reviews used to be written to `<package>/reviews`, which put user data
 * inside a directory npm owns and reuses. Both of the things npm does to that
 * directory destroy the data:
 *
 *   npm uninstall git-reviewer     -> the reviews go with it
 *   npm i git-reviewer@<newer>     -> npm replaces the package directory
 *
 * and `npx git-reviewer .` -- the command the README leads with -- writes into
 * the npx cache, which is pruned on npm's schedule rather than the user's.
 *
 * A review someone wrote by hand is the most expensive thing this tool holds.
 * It does not belong anywhere a package manager is entitled to delete.
 *
 * @returns {string}
 */
function userDataDir() {
  const home = os.homedir();

  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support');
  }

  if (process.platform === 'win32') {
    return (
      process.env.LOCALAPPDATA ||
      process.env.APPDATA ||
      path.join(home, 'AppData', 'Local')
    );
  }

  return process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
}

/**
 * Where comment state and submitted reviews are written.
 *
 * Resolved on every call rather than frozen at import, so that setting
 * `REVIEWER_DATA_DIR` always takes effect. That is not only a convenience:
 * the test suite spawns the real CLI, and a value captured at import time
 * would have those tests writing into the developer's actual review
 * directory.
 *
 * @returns {string}
 */
function reviewsDir() {
  const override = process.env.REVIEWER_DATA_DIR;
  if (override) return path.resolve(override);
  return path.join(userDataDir(), 'git-reviewer');
}

/**
 * Move reviews written by an older version out of the package directory.
 *
 * Same shape, and the same reasoning, as the legacy-filename adoption in
 * `lib/store.js`: a review someone wrote is not ours to abandon because we
 * changed our minds about where it belongs.
 *
 * Copy rather than rename: the source may be read-only, on another device, or
 * an npx cache we do not own, and none of those is a reason to fail. Existing
 * files at the destination always win -- a second run must not overwrite newer
 * work with the stale copy it already migrated.
 *
 * Synchronous on purpose. It runs once, before anything can read the
 * directory, and an async version would let a read start against a directory
 * that is still half-populated.
 *
 * @param {string} [target] defaults to the resolved reviews directory
 * @returns {number} how many files were adopted
 */
function adoptLegacyReviews(target = reviewsDir()) {
  if (path.resolve(target) === path.resolve(LEGACY_REVIEWS_DIR)) return 0;

  let names;
  try {
    names = fs.readdirSync(LEGACY_REVIEWS_DIR);
  } catch {
    return 0; // nothing written by an older version
  }

  let adopted = 0;
  for (const name of names) {
    const from = path.join(LEGACY_REVIEWS_DIR, name);
    const to = path.join(target, name);
    try {
      if (!fs.statSync(from).isFile()) continue;
      if (fs.existsSync(to)) continue;
      fs.mkdirSync(target, { recursive: true });
      fs.copyFileSync(from, to);
      adopted += 1;
    } catch {
      /* one unreadable file is not a reason to abandon the rest */
    }
  }

  return adopted;
}

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

module.exports = {
  reviewsDir,
  userDataDir,
  adoptLegacyReviews,
  LEGACY_REVIEWS_DIR,
  resolveRepoFile,
  PathEscapeError
};

// Kept so `require('./lib/paths').REVIEWS_DIR` and the server's re-export
// keep working. A getter, not a value, so it honours REVIEWER_DATA_DIR at
// the moment it is read.
Object.defineProperty(module.exports, 'REVIEWS_DIR', {
  get: reviewsDir,
  enumerable: true
});
