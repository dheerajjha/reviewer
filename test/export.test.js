'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const {
  loadReviewDocument,
  listReviews,
  NoReviewError,
  NoMatchingCommentsError
} = require('../lib/export');
const { ReviewOwnershipError } = require('../lib/store');
const { commentsFilename } = require('../lib/review');
const { formatPrompt } = require('../lib/agent');
const { createTempRepo, writeFiles, commitAll, cleanup } = require('./helpers/repo');

const COMMENT = { file: 'src/auth.js', line: 1, text: 'needs a null check' };
const OTHER = { file: 'src/db.js', line: 4, text: 'unbounded query' };

/** @returns {Promise<string>} a fresh reviews directory */
async function reviewsDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'reviewer-export-'));
}

/**
 * @param {string} dir
 * @param {string} repoPath
 * @param {object[]} comments
 */
async function save(dir, repoPath, comments, mode) {
  const envelope = mode === undefined
    ? { repoPath, comments }
    : { repoPath, mode, comments };

  await fs.writeFile(
    path.join(dir, commentsFilename(repoPath)),
    JSON.stringify(envelope)
  );
}

// --- loadReviewDocument --------------------------------------------------

test('a saved review is returned as a code-review/v1 document', async () => {
  const dir = await reviewsDir();
  const repo = await createTempRepo();
  await writeFiles(repo, { 'src/auth.js': 'let a\n' });
  await commitAll(repo, 'init');
  await save(dir, repo, [COMMENT]);

  const document = await loadReviewDocument(dir, repo);

  assert.equal(document.schema, 'code-review/v1');
  assert.equal(document.summary.comments, 1);
  assert.equal(document.comments[0].body, 'needs a null check');
  assert.equal(document.repository.path, repo);

  await cleanup(repo);
});

test('the commit and branch of the working tree are recorded', async () => {
  const dir = await reviewsDir();
  const repo = await createTempRepo();
  await writeFiles(repo, { 'src/auth.js': 'let a\n' });
  await commitAll(repo, 'init');
  await save(dir, repo, [COMMENT]);

  const document = await loadReviewDocument(dir, repo);

  assert.match(document.repository.head, /^[0-9a-f]{40}$/);
  assert.equal(document.repository.branch, 'main');

  await cleanup(repo);
});

test('a directory git will not answer for still exports', async () => {
  // Not every consumer points this at a git repository, and failing to read
  // HEAD is not a reason to withhold the review.
  const dir = await reviewsDir();
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'reviewer-plain-'));
  await save(dir, plain, [COMMENT]);

  const document = await loadReviewDocument(dir, plain);

  assert.equal(document.repository.head, null);
  assert.equal(document.repository.branch, null);
  assert.equal(document.summary.comments, 1);
});

test('a repository that no longer exists on disk still exports', async () => {
  // `simpleGit()` throws *synchronously* at construction for a path that is
  // not there -- it never reaches the promise the `.catch` was guarding. The
  // CLI never hit this because `main()` runs an `fs.access` check first; a
  // library has no such guarantee, and an agent asking about a repository
  // that has since been moved would get a crash instead of an answer.
  const dir = await reviewsDir();
  await save(dir, '/definitely/not/here', [COMMENT]);

  const document = await loadReviewDocument(dir, '/definitely/not/here');

  assert.equal(document.repository.head, null);
  assert.equal(document.repository.branch, null);
  assert.equal(document.summary.comments, 1);
});

test('a repository with no saved review raises NoReviewError', async () => {
  const dir = await reviewsDir();

  await assert.rejects(() => loadReviewDocument(dir, '/work/api'), NoReviewError);
});

test('a file filter selects only that file, and keeps the summary honest', async () => {
  const dir = await reviewsDir();
  await save(dir, '/work/api', [COMMENT, OTHER]);

  const document = await loadReviewDocument(dir, '/work/api', { file: 'src/db.js' });

  assert.equal(document.comments.length, 1);
  assert.equal(document.comments[0].file, 'src/db.js');
  assert.equal(document.summary.comments, 1);
  assert.equal(document.summary.files, 1);
});

test('a filter matching nothing raises NoMatchingCommentsError, not an empty document', async () => {
  const dir = await reviewsDir();
  await save(dir, '/work/api', [COMMENT]);

  await assert.rejects(
    () => loadReviewDocument(dir, '/work/api', { file: 'src/nope.js' }),
    NoMatchingCommentsError
  );
});

test('a comment file naming another repository is refused, not exported', async () => {
  // The ownership rule store.js enforces has to survive the lift: a review is
  // served to the repository it was written for, or not at all.
  const dir = await reviewsDir();
  await fs.writeFile(
    path.join(dir, commentsFilename('/work/api')),
    JSON.stringify({ repoPath: '/work/other', comments: [COMMENT] })
  );

  await assert.rejects(() => loadReviewDocument(dir, '/work/api'), ReviewOwnershipError);
});

// --- listReviews ---------------------------------------------------------

test('an absent reviews directory lists as empty, not as an error', async () => {
  assert.deepEqual(await listReviews('/nonexistent/reviews'), []);
});

test('an empty reviews directory lists as empty', async () => {
  assert.deepEqual(await listReviews(await reviewsDir()), []);
});

test('every repository with a saved review is listed', async () => {
  const dir = await reviewsDir();
  await save(dir, '/work/api', [COMMENT]);
  await save(dir, '/work/web', [COMMENT, OTHER]);

  const listed = await listReviews(dir);

  assert.equal(listed.length, 2);
  assert.deepEqual(
    listed.map(r => r.repoPath).sort(),
    ['/work/api', '/work/web']
  );
  assert.equal(listed.find(r => r.repoPath === '/work/web').comments, 2);
  assert.equal(listed.find(r => r.repoPath === '/work/api').name, 'api');
});

test('listings are newest first', async () => {
  const dir = await reviewsDir();
  await save(dir, '/work/old', [COMMENT]);
  await new Promise(resolve => setTimeout(resolve, 10));
  await save(dir, '/work/new', [COMMENT]);

  const listed = await listReviews(dir);

  assert.equal(listed[0].repoPath, '/work/new');
});

test('two checkouts of the same name are listed separately', async () => {
  const dir = await reviewsDir();
  await save(dir, '/a/api', [COMMENT]);
  await save(dir, '/b/api', [COMMENT]);

  const listed = await listReviews(dir);

  assert.equal(listed.length, 2);
  assert.deepEqual(listed.map(r => r.name), ['api', 'api']);
});

test('an unrelated file in the reviews directory is ignored', async () => {
  const dir = await reviewsDir();
  await save(dir, '/work/api', [COMMENT]);
  await fs.writeFile(path.join(dir, 'review-2026-01-01.txt'), 'a submitted review');
  await fs.writeFile(path.join(dir, 'notes.json'), '{}');

  assert.equal((await listReviews(dir)).length, 1);
});

test('a damaged comment file is skipped rather than failing the listing', async () => {
  // One corrupt file in the directory must not make the whole surface
  // unusable -- discovery is the first thing an agent does.
  const dir = await reviewsDir();
  await save(dir, '/work/api', [COMMENT]);
  await fs.writeFile(path.join(dir, commentsFilename('/work/bad')), 'not json at all');

  const listed = await listReviews(dir);

  assert.equal(listed.length, 1);
  assert.equal(listed[0].repoPath, '/work/api');
});

test('a file recording a repository that disagrees with its own name is not listed', async () => {
  // store.js would refuse to serve this. Listing it would advertise a review
  // that cannot be opened.
  const dir = await reviewsDir();
  await fs.writeFile(
    path.join(dir, commentsFilename('/work/api')),
    JSON.stringify({ repoPath: '/work/other', comments: [COMMENT] })
  );

  assert.deepEqual(await listReviews(dir), []);
});

test('a review emptied of comments is not listed', async () => {
  const dir = await reviewsDir();
  await save(dir, '/work/api', []);

  assert.deepEqual(await listReviews(dir), []);
});

test('a symlinked checkout is listed under its real path', async () => {
  const real = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'reviewer-real-')));
  const dir = await reviewsDir();
  await save(dir, real, [COMMENT]);

  const listed = await listReviews(dir);

  assert.equal(listed[0].repoPath, real);
});

test('updatedAt is an ISO timestamp', async () => {
  const dir = await reviewsDir();
  await save(dir, '/work/api', [COMMENT]);

  const [{ updatedAt }] = await listReviews(dir);

  assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(new Date(updatedAt).toISOString(), updatedAt);
});

// --- the exported document remembers what was compared -------------------

test('an exported review carries the mode it was written in', async () => {
  // This used to be impossible: `mode` lived on the session, which `reviewer
  // export` does not have, so every exported review reported `mode: null` no
  // matter what it was a review of. docs/agent-format.md documented that as a
  // property of the format. It is now on the comments file instead.
  const dir = await reviewsDir();
  const repo = await createTempRepo();
  await writeFiles(repo, { 'src/auth.js': 'let a\n' });
  await commitAll(repo, 'init');
  await save(dir, repo, [COMMENT], 'lastCommit');

  const document = await loadReviewDocument(dir, repo);

  assert.equal(document.mode, 'lastCommit');
  assert.match(formatPrompt(document), /against its parent\./);

  await cleanup(repo);
  await cleanup(dir);
});

test('a review file written before the mode was recorded still exports', async () => {
  const dir = await reviewsDir();
  const repo = await createTempRepo();
  await writeFiles(repo, { 'src/auth.js': 'let a\n' });
  await commitAll(repo, 'init');
  await save(dir, repo, [COMMENT]);

  const document = await loadReviewDocument(dir, repo);

  assert.equal(document.mode, null, 'nothing on disk says what was compared');
  assert.doesNotMatch(formatPrompt(document), /working tree|against its parent/);

  await cleanup(repo);
  await cleanup(dir);
});
