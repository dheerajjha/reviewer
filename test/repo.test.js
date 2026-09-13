'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const simpleGit = require('simple-git');

const { repoRoot } = require('../lib/repo');
const {
  createTempRepo,
  createTempDir,
  writeFiles,
  commitFiles,
  cleanup
} = require('./helpers/repo');

/**
 * Resolving a directory to the repository it belongs to.
 */

test('repoRoot answers the root of the working tree, from the root', async t => {
  const repoPath = await createTempRepo();
  t.after(() => cleanup(repoPath));
  await commitFiles(repoPath, { 'app.js': 'one\n' }, 'init');

  assert.equal(await repoRoot(repoPath), repoPath);
});

test('repoRoot answers the root from a subdirectory of the repository', async t => {
  const repoPath = await createTempRepo();
  t.after(() => cleanup(repoPath));
  await commitFiles(repoPath, { 'src/deep/app.js': 'one\n' }, 'init');

  assert.equal(await repoRoot(path.join(repoPath, 'src', 'deep')), repoPath);
});

test('repoRoot answers null for a directory that is not in a repository', async t => {
  const plain = await createTempDir();
  t.after(() => cleanup(plain));

  assert.equal(await repoRoot(plain), null);
});

test('repoRoot answers null for a directory that does not exist', async () => {
  // `simpleGit()` throws synchronously at construction for a missing path, so
  // a `.catch()` on the returned promise never runs. Asserting the answer
  // rather than the mechanism keeps this true if that is fixed upstream.
  assert.equal(await repoRoot('/no/such/place/at/all'), null);
});

test('a git rooted at a subdirectory cannot diff the paths git status reports', async t => {
  // This is the whole reason lib/repo.js exists, pinned so that removing the
  // resolution fails here with an explanation rather than somewhere distant
  // with an empty diff. `git status --porcelain` reports paths relative to the
  // repository root; a pathspec is resolved relative to the process directory.
  // Give one to the other and git answers with an empty string — not an error.
  const repoPath = await createTempRepo();
  t.after(() => cleanup(repoPath));
  await commitFiles(repoPath, { 'src/deep/app.js': 'one\n' }, 'init');
  await writeFiles(repoPath, { 'src/deep/app.js': 'one\ntwo\n' });

  const subdirectory = path.join(repoPath, 'src', 'deep');
  const fromSubdirectory = simpleGit(subdirectory);

  assert.equal(await fromSubdirectory.checkIsRepo(), true, 'a subdirectory looks like a repository');
  assert.deepEqual(
    (await fromSubdirectory.status()).files.map(file => file.path),
    ['src/deep/app.js'],
    'and reports the change under its root-relative path'
  );
  assert.equal(
    await fromSubdirectory.diff(['--', 'src/deep/app.js']),
    '',
    'but cannot diff that path: silently empty, which is what the UI showed'
  );

  const fromRoot = simpleGit(await repoRoot(subdirectory));
  assert.match(
    await fromRoot.diff(['--', 'src/deep/app.js']),
    /^diff --git/,
    'resolved to the root, the same pathspec produces the diff'
  );
});
