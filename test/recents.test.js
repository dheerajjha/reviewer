'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  readRecents,
  recordRecent,
  describeRecents,
  RECENTS_FILE,
  LIMIT
} = require('../lib/recents');
const { createTempRepo, createTempDir, cleanup } = require('./helpers/repo');

/**
 * Remembering which repositories have been opened.
 */

/** @returns {Promise<string>} a throwaway data directory */
async function dataDir() {
  return fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'reviewer-recents-'));
}

/** Recorded paths, newest first. */
const paths = list => list.map(project => project.path);

test('readRecents answers an empty list before anything has been opened', async t => {
  const dir = await dataDir();
  t.after(() => cleanup(dir));

  assert.deepEqual(await readRecents(dir), []);
});

test('recordRecent puts the newest first', async t => {
  const dir = await dataDir();
  t.after(() => cleanup(dir));

  await recordRecent(dir, '/work/one');
  await recordRecent(dir, '/work/two');

  assert.deepEqual(paths(await readRecents(dir)), ['/work/two', '/work/one']);
});

test('reopening a repository moves it to the front instead of duplicating it', async t => {
  const dir = await dataDir();
  t.after(() => cleanup(dir));

  await recordRecent(dir, '/work/one');
  await recordRecent(dir, '/work/two');
  await recordRecent(dir, '/work/one');

  assert.deepEqual(paths(await readRecents(dir)), ['/work/one', '/work/two']);
});

test('the list is capped, dropping the least recently opened', async t => {
  const dir = await dataDir();
  t.after(() => cleanup(dir));

  for (let i = 0; i < LIMIT + 5; i++) await recordRecent(dir, `/work/repo-${i}`);

  const recorded = await readRecents(dir);
  assert.equal(recorded.length, LIMIT);
  assert.equal(recorded[0].path, `/work/repo-${LIMIT + 4}`);
  assert.doesNotMatch(JSON.stringify(recorded), /repo-0"/);
});

test('a damaged recents file costs the convenience, not the repository', async t => {
  const dir = await dataDir();
  t.after(() => cleanup(dir));

  for (const damage of ['', 'not json at all', '{}', '{"projects":"nope"}', '[]']) {
    await fs.writeFile(path.join(dir, RECENTS_FILE), damage);
    assert.deepEqual(await readRecents(dir), [], `on ${JSON.stringify(damage)}`);
  }

  // And recording over the damage repairs it rather than throwing.
  await recordRecent(dir, '/work/one');
  assert.deepEqual(paths(await readRecents(dir)), ['/work/one']);
});

test('entries of the wrong shape are dropped, the rest of the list survives', async t => {
  const dir = await dataDir();
  t.after(() => cleanup(dir));

  await fs.writeFile(
    path.join(dir, RECENTS_FILE),
    JSON.stringify({
      version: 1,
      projects: [
        { path: '/work/good', openedAt: '2026-09-13T00:00:00.000Z' },
        { path: '', openedAt: '2026-09-13T00:00:00.000Z' },
        { path: '/work/undated' },
        null,
        'not an object'
      ]
    })
  );

  assert.deepEqual(paths(await readRecents(dir)), ['/work/good']);
});

test('describeRecents says which repositories are still there', async t => {
  const dir = await dataDir();
  const repoPath = await createTempRepo();
  const gone = await createTempDir();
  t.after(async () => {
    await cleanup(dir);
    await cleanup(repoPath);
  });

  await recordRecent(dir, gone);
  await recordRecent(dir, repoPath);
  await cleanup(gone);

  const described = await describeRecents(dir);

  assert.deepEqual(
    described.map(project => [project.name, project.exists]),
    [[path.basename(repoPath), true], [path.basename(gone), false]]
  );
});

test('describeRecents reports how many comments are saved against each', async t => {
  const dir = await dataDir();
  t.after(() => cleanup(dir));

  await recordRecent(dir, '/work/api');
  await recordRecent(dir, '/work/web');

  const described = await describeRecents(dir, new Map([['/work/api', 3]]));

  assert.deepEqual(
    described.map(project => [project.path, project.comments]),
    [['/work/web', 0], ['/work/api', 3]]
  );
});
