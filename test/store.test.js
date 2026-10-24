'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const { readSavedComments, ReviewOwnershipError } = require('../lib/store');
const { commentsFilename, legacyCommentsFilename } = require('../lib/review');

const COMMENT = { file: 'src/auth.js', line: 1, text: 'needs a null check' };

/** Comments as written, without the `key` every read now adds. */
const withoutKeys = comments => comments.map(({ key, ...comment }) => comment);

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

  assert.deepEqual(await readSavedComments(dir, '/work/api'), { comments: [], mode: null, range: null, adopted: false, lastUpdated: null });
});

test('comments are read back for the repository that saved them', async () => {
  const dir = await reviewsDir();
  await write(dir, commentsFilename('/work/api'), { repoPath: '/work/api', comments: [COMMENT] });

  const { comments, adopted } = await readSavedComments(dir, '/work/api');

  assert.deepEqual(withoutKeys(comments), [COMMENT]);
  assert.equal(adopted, false);
});

test('the lastUpdated stamp is read back, as the version token for a conditional save', async () => {
  const dir = await reviewsDir();
  await write(dir, commentsFilename('/work/api'), {
    repoPath: '/work/api',
    lastUpdated: '2026-10-22T00:00:00.000Z',
    comments: [COMMENT]
  });

  assert.equal((await readSavedComments(dir, '/work/api')).lastUpdated, '2026-10-22T00:00:00.000Z');
});

test('saved scope keeps only an explicit tracked-only working comparison, including adopted reviews', async t => {
  for (const nameOf of [commentsFilename, legacyCommentsFilename]) {
    for (const scope of [
      { mode: 'working', untracked: false },
      {}, { mode: 'working' }, { mode: 'working', untracked: true },
      { mode: 'working', untracked: 'false' }, { mode: 'working', untracked: 0 },
      { mode: 'working', untracked: null },
      { mode: 'staged', untracked: false }, { mode: 'range', untracked: false },
      { mode: 'lastCommit', untracked: false }, { untracked: false }
    ]) {
      const dir = await reviewsDir();
      t.after(() => fs.rm(dir, { recursive: true, force: true }));
      await write(dir, nameOf('/work/api'), { repoPath: '/work/api', comments: [COMMENT], ...scope });
      const saved = await readSavedComments(dir, '/work/api');
      assert.deepEqual(withoutKeys(saved.comments), [COMMENT]);
      if (scope.mode === 'working' && scope.untracked === false) {
        assert.equal(saved.untracked, false);
      } else {
        assert.equal('untracked' in saved, false);
      }
    }
  }
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

  assert.deepEqual(withoutKeys(comments), [COMMENT]);
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

  assert.deepEqual({ ...second, comments: withoutKeys(second.comments) }, { comments: [COMMENT], mode: null, range: null, adopted: false, lastUpdated: null });
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

  assert.deepEqual(withoutKeys(comments), [COMMENT]);
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
  await fs.symlink(real, link, 'dir');

  await write(dir, commentsFilename(real), { repoPath: real, comments: [COMMENT] });

  assert.deepEqual(withoutKeys((await readSavedComments(dir, link)).comments), [COMMENT]);
});

const { execFile } = require('child_process');
const { updateSavedComments, nextLastUpdated } = require('../lib/store');

test('an update writes keyed comments with a strictly later stamp, and null writes nothing', async t => {
  const dir = await reviewsDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await write(dir, commentsFilename('/work/api'), {
    repoPath: '/work/api', lastUpdated: '2026-10-24T00:00:00.000Z', mode: 'working', comments: [COMMENT]
  });

  const { comments: [current] } = await readSavedComments(dir, '/work/api');
  const written = await updateSavedComments(dir, '/work/api', state => ({
    comments: [{ ...state.comments[0], followUps: [{ key: 'f1', text: 'answer', by: 'claude' }] }]
  }));

  assert.equal(written.written, true);
  const onDisk = JSON.parse(await fs.readFile(path.join(dir, commentsFilename('/work/api')), 'utf-8'));
  assert.equal(onDisk.comments[0].key, current.key, 'the derived key is what gets persisted');
  assert.equal(onDisk.mode, 'working', 'a reply leaves the review\'s scope alone');
  assert.ok(onDisk.lastUpdated > '2026-10-24T00:00:00.000Z');

  const untouched = await updateSavedComments(dir, '/work/api', () => null);
  assert.equal(untouched.written, false);
  assert.equal(untouched.lastUpdated, onDisk.lastUpdated);
});

test('stamps move forward even when two saves land in the same millisecond', () => {
  const later = new Date(Date.now() + 60000).toISOString();
  assert.ok(nextLastUpdated(later) > later);
  assert.ok(nextLastUpdated(null));
});

test('writers in separate processes do not lose each other\'s replies', async t => {
  const dir = await reviewsDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await write(dir, commentsFilename('/work/api'), { repoPath: '/work/api', comments: [{ ...COMMENT, key: 'k1' }] });

  // Each process appends twenty replies, one read-modify-write at a time.
  // Without the lock the two interleave and the file ends up with fewer.
  const writer = `
    const { updateSavedComments } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'store'))});
    (async () => {
      for (let i = 0; i < 20; i++) {
        await updateSavedComments(process.argv[1], '/work/api', state => ({
          comments: state.comments.map(c => ({ ...c, followUps: [...(c.followUps || []), { key: process.argv[2] + i, text: 'reply ' + i, by: 'claude' }] }))
        }));
      }
    })();
  `;
  const run = name => new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', writer, dir, name], { timeout: 30000 }, error => (error ? reject(error) : resolve()));
  });
  await Promise.all([run('a'), run('b')]);

  const { comments } = await readSavedComments(dir, '/work/api');
  assert.equal(comments[0].followUps.length, 40);
});

test('a lock left behind by a writer that died is taken over', async t => {
  const dir = await reviewsDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, commentsFilename('/work/api'));
  await write(dir, commentsFilename('/work/api'), { repoPath: '/work/api', comments: [COMMENT] });
  await fs.writeFile(`${file}.lock`, '99999\n');
  const old = new Date(Date.now() - 60000);
  await fs.utimes(`${file}.lock`, old, old);

  const started = Date.now();
  const result = await updateSavedComments(dir, '/work/api', state => ({ comments: state.comments }));

  assert.equal(result.written, true);
  assert.ok(Date.now() - started < 3000);
  await assert.rejects(fs.stat(`${file}.lock`), { code: 'ENOENT' }, 'and released afterwards');
});

test('two writers finding the same abandoned lock still take turns', async t => {
  // Each store module instance has its own in-process queue, as two
  // processes would; only the file lock keeps them apart.
  const freshStore = () => {
    for (const id of Object.keys(require.cache)) if (id.includes(`${path.sep}lib${path.sep}`)) delete require.cache[id];
    return require('../lib/store');
  };
  const storeA = freshStore();
  const storeB = freshStore();

  for (let trial = 0; trial < 10; trial++) {
    const dir = await reviewsDir();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, commentsFilename('/work/api'));
    await write(dir, commentsFilename('/work/api'), { repoPath: '/work/api', comments: [{ ...COMMENT, key: 'k1' }] });
    await fs.writeFile(`${file}.lock`, '99999999\n');
    const old = new Date(Date.now() - 60000);
    await fs.utimes(`${file}.lock`, old, old);

    let inside = 0;
    let overlapped = false;
    const append = (store, who) => store.updateSavedComments(dir, '/work/api', async state => {
      inside += 1;
      overlapped ||= inside > 1;
      await new Promise(resolve => setTimeout(resolve, 20));
      inside -= 1;
      return { comments: state.comments.map(c => ({ ...c, followUps: [...(c.followUps || []), { key: who, text: who, by: 'claude' }] })) };
    });
    await Promise.all([append(storeA, 'A'), append(storeB, 'B')]);

    assert.equal(overlapped, false, `trial ${trial}: both writers held the lock at once`);
    assert.equal((await storeA.readSavedComments(dir, '/work/api')).comments[0].followUps.length, 2);
  }
});

test('a lock held by a writer that is still running is waited for, not broken', async t => {
  const dir = await reviewsDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, commentsFilename('/work/api'));
  await write(dir, commentsFilename('/work/api'), { repoPath: '/work/api', comments: [COMMENT] });
  await fs.writeFile(`${file}.lock`, `${process.pid}\n`);

  let finished = false;
  const update = updateSavedComments(dir, '/work/api', state => ({ comments: state.comments })).then(() => { finished = true; });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(finished, false, 'still waiting while its owner is alive');

  await fs.rm(`${file}.lock`);
  await update;
  assert.equal(finished, true);
});
