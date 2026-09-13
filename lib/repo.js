'use strict';

const path = require('path');

const simpleGit = require('simple-git');

/**
 * Finding the repository a directory belongs to.
 *
 * Everything downstream of this — the session, the saved review's filename,
 * every diff — is keyed on one path, and that path has to be the root of the
 * working tree rather than wherever the person happened to be standing. Two
 * things go wrong otherwise, and neither announces itself:
 *
 *   - `git status --porcelain` reports paths relative to the root, but a
 *     pathspec is resolved relative to the process's directory. Ask a git
 *     rooted at `repo/src` for `git diff -- src/deep/file.txt` and you get an
 *     empty string back, not an error. The file is listed, the diff is blank,
 *     and nothing says why.
 *   - reviews are filed under a fingerprint of the repository path, so a
 *     review written from the root is invisible from a subdirectory. The
 *     browser saves it, `reviewer export` run one directory down reports that
 *     no review exists, and the loop in the README quietly stops working.
 */

/**
 * The root of the working tree containing `dir`.
 *
 * Answers `null` rather than raising for every way this can fail — not a
 * repository, a bare repository with no working tree, git not installed, the
 * directory gone. Callers decide what an absent repository means; for some it
 * is an error and for others it is simply a directory they will use as given.
 *
 * The `simpleGit()` call is inside the `try` on purpose. It throws
 * *synchronously, at construction* when the directory does not exist, so a
 * `.catch()` on the returned promise never runs — the same trap documented at
 * `readGitPosition` in `lib/export.js`.
 *
 * @param {string} dir any directory inside the repository
 * @param {(dir: string) => import('simple-git').SimpleGit} [gitFactory]
 * @returns {Promise<string|null>} absolute path to the root, or null
 */
async function repoRoot(dir, gitFactory = simpleGit) {
  try {
    const top = await gitFactory(dir).revparse(['--show-toplevel']);
    const trimmed = String(top).trim();
    return trimmed === '' ? null : path.resolve(trimmed);
  } catch {
    return null;
  }
}

module.exports = { repoRoot };
