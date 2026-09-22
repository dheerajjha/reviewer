'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const { readSavedComments, ReviewOwnershipError } = require('../lib/store');
const { commentsFilename, legacyCommentsFilename } = require('../lib/review');

const COMMENT = { file: 'src/auth.js', line: 1, text: 'needs a null check' };

/** @returns {Promise<string>} a fresh reviews directory */
async function reviewsDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'reviewer-store-'));
}

/**
 * @param {string} dir
 * @param {string} name
 * @param {object} data
 */
async function write(dir, name, data) {
  await fs.writeFile(path.join(dir, name), JSON.stringify(data));
}

test('a repository with no saved review reads as empty', async () => {
  const dir = await reviewsDir();

  assert.deepEqual(await readSavedComments(dir, '/work/api'), { comments: [], mode: null, adopted: false });
});

test('comments are read back for the repository that saved them', async () => {
  const dir = await reviewsDir();
  await write(dir, commentsFilename('/work/api'), { repoPath: '/work/api', comments: [COMMENT] });

  const { comments, adopted } = await readSavedComments(dir, '/work/api');

  assert.deepEqual(comments, [COMMENT]);
  assert.equal(adopted, false);
});

test('two repositories with the same name keep separate reviews', async () => {
  // The regression this file exists for. Before the fingerprint, the second
  // save destroyed the first and both repositories read back the survivor.
  const dir = await reviewsDir();
  const a = '/work/one/api-service';
  const b = '/work/two/api-service';

  await write(dir, commentsFilename(a), { repoPath: a, comments: [{ ...COMMENT, text: 'from A' }] });
  await write(dir, commentsFilename(b), { repoPath: b, comments: [{ ...COMMENT, text: 'from B' }] });

  assert.equal((await readSavedComments(dir, a)).comments[0].text, 'from A');
  assert.equal((await readSavedComments(dir, b)).comments[0].text, 'from B');
});

test('a review saved under the legacy name is adopted by its own repository', async () => {
  const dir = await reviewsDir();
  await write(dir, legacyCommentsFilename('/work/api'), { repoPath: '/work/api', comments: [COMMENT] });

  const { comments, adopted } = await readSavedComments(dir, '/work/api');

  assert.deepEqual(comments, [COMMENT]);
  assert.equal(adopted, true);
  // Adopting moves it, so the old name stops shadowing another checkout.
  await assert.rejects(fs.access(path.join(dir, legacyCommentsFilename('/work/api'))));
  await fs.access(path.join(dir, commentsFilename('/work/api')));
});

test('an adopted review is read straight from the new name afterwards', async () => {
  const dir = await reviewsDir();
  await write(dir, legacyCommentsFilename('/work/api'), { repoPath: '/work/api', comments: [COMMENT] });

  await readSavedComments(dir, '/work/api');
  const second = await readSavedComments(dir, '/work/api');

  assert.deepEqual(second, { comments: [COMMENT], mode: null, adopted: false });
});

test('a legacy review belonging to another checkout is not adopted', async () => {
  // Two repositories shared the legacy name, so exactly one of them owns the
  // file. Handing it to the other is the original bug.
  const dir = await reviewsDir();
  await write(dir, legacyCommentsFilename('/work/one/api-service'), {
    repoPath: '/work/one/api-service',
    comments: [COMMENT]
  });

  const { comments } = await readSavedComments(dir, '/work/two/api-service');

  assert.deepEqual(comments, []);
});

test('a legacy review with no recorded owner is adopted', async () => {
  // Files written before `repoPath` was stored, and by older tests. There is
  // nothing to contradict, and the legacy name is the only evidence of owner.
  const dir = await reviewsDir();
  await write(dir, legacyCommentsFilename('/work/api'), { comments: [COMMENT] });

  const { comments, adopted } = await readSavedComments(dir, '/work/api');

  assert.deepEqual(comments, [COMMENT]);
  assert.equal(adopted, true);
});

test('a comment file naming another repository is refused, not served', async () => {
  // The fingerprint should make this unreachable; it is the second lock on a
  // door that already has one, because the failure it prevents is silent.
  const dir = await reviewsDir();
  await write(dir, commentsFilename('/work/api'), {
    repoPath: '/somewhere/else',
    comments: [COMMENT]
  });

  await assert.rejects(
    () => readSavedComments(dir, '/work/api'),
    error => {
      assert.ok(error instanceof ReviewOwnershipError);
      assert.equal(error.owner, '/somewhere/else');
      assert.match(error.message, /Refusing to serve/);
      return true;
    }
  );
});

test('a symlinked checkout reads the same review as its real path', async () => {
  const dir = await reviewsDir();
  const real = await fs.mkdtemp(path.join(os.tmpdir(), 'reviewer-real-'));
  const link = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'reviewer-link-')), 'api');
  await fs.symlink(real, link);

  await write(dir, commentsFilename(real), { repoPath: real, comments: [COMMENT] });

  assert.deepEqual((await readSavedComments(dir, link)).comments, [COMMENT]);
});
