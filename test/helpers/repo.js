'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);

/**
 * Throwaway git repositories for tests.
 *
 * These exercise the server against real `git` output rather than a stub —
 * diff text and status parsing are exactly where a stub would be wrong in the
 * same way the code is.
 */

// Git for Windows accepts NUL, but rejects Node's \\.\nul device-path spelling.
const GIT_CONFIG_NULL = process.platform === 'win32' ? 'NUL' : os.devNull;

/** Deterministic identity and settings, so a developer's global config cannot change a result. */
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Reviewer Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Reviewer Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: GIT_CONFIG_NULL,
  GIT_CONFIG_SYSTEM: GIT_CONFIG_NULL
};

/**
 * @param {string} cwd
 * @param {string[]} args
 */
async function git(cwd, args) {
  return run('git', args, { cwd, env: GIT_ENV });
}

/**
 * Create an initialized repository in a fresh temporary directory.
 *
 * @returns {Promise<string>} absolute path of the repository
 */
async function createTempRepo() {
  // macOS reports /var as a symlink to /private/var; resolve it so paths the
  // test computes match the paths the server resolves.
  const base = await fs.realpath(os.tmpdir());
  const repoPath = await fs.mkdtemp(path.join(base, 'reviewer-test-'));

  await git(repoPath, ['init', '-b', 'main']);
  await git(repoPath, ['config', 'commit.gpgsign', 'false']);

  return repoPath;
}

/**
 * Write files relative to the repository, creating directories as needed.
 *
 * @param {string} repoPath
 * @param {Record<string, string>} files path -> contents
 */
async function writeFiles(repoPath, files) {
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(repoPath, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }
}

/**
 * Stage everything and commit.
 *
 * @param {string} repoPath
 * @param {string} message
 */
async function commitAll(repoPath, message) {
  await git(repoPath, ['add', '-A']);
  await git(repoPath, ['commit', '-m', message]);
}

/**
 * Write files and commit them in one step.
 *
 * @param {string} repoPath
 * @param {Record<string, string>} files
 * @param {string} message
 */
async function commitFiles(repoPath, files, message) {
  await writeFiles(repoPath, files);
  await commitAll(repoPath, message);
}

/**
 * Remove a directory tree, ignoring failures.
 *
 * @param {string} target
 */
async function cleanup(target) {
  await fs.rm(target, { recursive: true, force: true }).catch(() => {});
}

/**
 * Create an empty temporary directory that is not a repository.
 *
 * @returns {Promise<string>}
 */
async function createTempDir() {
  const base = await fs.realpath(os.tmpdir());
  return fs.mkdtemp(path.join(base, 'reviewer-test-plain-'));
}

module.exports = { createTempRepo, createTempDir, writeFiles, commitAll, commitFiles, cleanup, git };
