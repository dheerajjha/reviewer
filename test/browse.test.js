'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { browse } = require('../lib/browse');
const { createTempRepo, createTempDir, writeFiles, cleanup } = require('./helpers/repo');

/**
 * Listing directories for the picker.
 */

/** @param {string} parent @param {string[]} names */
async function makeDirs(parent, names) {
  for (const name of names) await fs.mkdir(path.join(parent, name), { recursive: true });
}

/** Entry names, in the order they were listed. */
const names = listing => listing.entries.map(entry => entry.name);

test('browse lists directories and leaves files out of it', async t => {
  const dir = await createTempDir();
  t.after(() => cleanup(dir));
  await makeDirs(dir, ['alpha', 'beta']);
  await writeFiles(dir, { 'README.md': '#\n', 'notes.txt': 'x\n' });

  assert.deepEqual(names(await browse(dir)), ['alpha', 'beta']);
});

test('browse marks which directories are repositories', async t => {
  const dir = await createTempDir();
  t.after(() => cleanup(dir));
  await makeDirs(dir, ['plain']);
  const repoPath = await createTempRepo();
  t.after(() => cleanup(repoPath));
  await fs.symlink(repoPath, path.join(dir, 'checkout'));

  const listing = await browse(dir);

  assert.deepEqual(
    listing.entries.map(entry => [entry.name, entry.isRepository]),
    [['checkout', true], ['plain', false]]
  );
});

test('browse sorts case-insensitively, so a listing reads like a listing', async t => {
  const dir = await createTempDir();
  t.after(() => cleanup(dir));
  await makeDirs(dir, ['Zebra', 'apple', 'Banana']);

  assert.deepEqual(names(await browse(dir)), ['apple', 'Banana', 'Zebra']);
});

test('browse hides hidden directories, except the ones that are repositories', async t => {
  const dir = await createTempDir();
  t.after(() => cleanup(dir));
  await makeDirs(dir, ['.cache', 'work']);
  // `~/.dotfiles` is one of the most commonly reviewed repositories there is,
  // so the hidden rule cannot be allowed to swallow it.
  await makeDirs(dir, ['.dotfiles/.git']);

  assert.deepEqual(names(await browse(dir)), ['.dotfiles', 'work']);
});

test('browse never offers .git or node_modules', async t => {
  const repoPath = await createTempRepo();
  t.after(() => cleanup(repoPath));
  await makeDirs(repoPath, ['node_modules/express', 'src']);

  assert.deepEqual(names(await browse(repoPath)), ['src']);
});

test('browse follows a symlink to a directory and skips a dangling one', async t => {
  const dir = await createTempDir();
  const target = await createTempDir();
  t.after(async () => {
    await cleanup(dir);
    await cleanup(target);
  });

  await fs.symlink(target, path.join(dir, 'elsewhere'));
  await fs.symlink(path.join(target, 'gone'), path.join(dir, 'broken'));

  assert.deepEqual(names(await browse(dir)), ['elsewhere']);
});

test('browse reports the parent, and reports none at the filesystem root', async t => {
  const dir = await createTempDir();
  t.after(() => cleanup(dir));

  assert.equal((await browse(dir)).parent, path.dirname(dir));
  assert.equal((await browse('/')).parent, null);
});

test('browse says whether the directory it listed is itself a repository', async t => {
  const repoPath = await createTempRepo();
  const plain = await createTempDir();
  t.after(async () => {
    await cleanup(repoPath);
    await cleanup(plain);
  });

  assert.equal((await browse(repoPath)).isRepository, true);
  assert.equal((await browse(plain)).isRepository, false);
});

test('browse starts at the home directory when asked for nothing', async () => {
  const home = await fs.realpath(os.homedir());

  for (const asked of [undefined, '', '   ']) {
    assert.equal(await fs.realpath((await browse(asked)).path), home);
  }
});

test('browse refuses a path that is missing or is not a directory', async t => {
  const dir = await createTempDir();
  t.after(() => cleanup(dir));
  await writeFiles(dir, { 'file.txt': 'x\n' });

  await assert.rejects(() => browse('/no/such/place/at/all'), { code: 'ENOENT' });
  await assert.rejects(() => browse(path.join(dir, 'file.txt')), { code: 'ENOTDIR' });
});

test('browse survives a directory it is not allowed to read into', async t => {
  const dir = await createTempDir();
  t.after(async () => {
    await fs.chmod(path.join(dir, 'locked'), 0o755).catch(() => {});
    await cleanup(dir);
  });
  await makeDirs(dir, ['locked', 'readable']);
  await fs.chmod(path.join(dir, 'locked'), 0o000);

  // An unreadable directory is still a directory and still worth offering --
  // it is reported as not a repository, because that question cannot be
  // answered. What must not happen is the listing failing because of it.
  assert.deepEqual(names(await browse(dir)), ['locked', 'readable']);
});
