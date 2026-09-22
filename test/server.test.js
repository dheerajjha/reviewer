'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../server');
const { createTempRepo, createTempDir, writeFiles, commitFiles, cleanup, git } =
  require('./helpers/repo');
const { commentsFilename } = require('../lib/review');
const { RECENTS_FILE } = require('../lib/recents');

/**
 * End-to-end coverage of the HTTP surface, against real repositories.
 */

/**
 * Start the app on an ephemeral port with its own reviews directory.
 *
 * @returns {Promise<{url: string, reviewsDir: string, close: () => Promise<void>}>}
 */
async function startTestServer(options = {}) {
  const reviewsDir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'reviewer-reviews-'));
  const app = createApp({ reviewsDir, ...options });

  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.on('error', reject);
  });

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    reviewsDir,
    close: async () => {
      await new Promise(resolve => server.close(resolve));
      await cleanup(reviewsDir);
    }
  };
}

/**
 * @param {string} url
 * @param {string} repoPath
 * @returns {Promise<object>} the load-repo payload
 */
async function loadRepo(url, repoPath) {
  const response = await fetch(`${url}/api/load-repo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoPath })
  });
  assert.equal(response.status, 200);
  return response.json();
}

test('GET /api/health reports the server is up', async t => {
  const server = await startTestServer();
  t.after(() => server.close());

  const response = await fetch(`${server.url}/api/health`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', sessions: 0 });
});

test('POST /api/load-repo requires a path', async t => {
  const server = await startTestServer();
  t.after(() => server.close());

  const response = await fetch(`${server.url}/api/load-repo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /required/i);
});

test('POST /api/load-repo rejects a path that does not exist', async t => {
  const server = await startTestServer();
  t.after(() => server.close());

  const response = await fetch(`${server.url}/api/load-repo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoPath: '/no/such/place/at/all' })
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /does not exist/i);
});

test('POST /api/load-repo rejects a directory that is not a repository', async t => {
  const server = await startTestServer();
  const plainDir = await createTempDir();
  t.after(async () => {
    await server.close();
    await cleanup(plainDir);
  });

  const response = await fetch(`${server.url}/api/load-repo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoPath: plainDir })
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /not a valid git repository/i);
});

test('POST /api/load-repo lists working directory changes', async t => {
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoPath);
  });

  await commitFiles(repoPath, { 'app.js': 'const a = 1;\n' }, 'initial');
  await writeFiles(repoPath, { 'app.js': 'const a = 2;\n', 'new.js': 'fresh\n' });

  const body = await loadRepo(server.url, repoPath);

  assert.equal(body.mode, 'working');
  assert.match(body.message, /Found 2 changed file\(s\)/);
  assert.deepEqual(
    [...body.files].sort((a, b) => a.path.localeCompare(b.path)),
    [{ path: 'app.js', status: 'M' }, { path: 'new.js', status: 'A' }]
  );
});

test('POST /api/load-repo reports a deleted file', async t => {
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoPath);
  });

  await commitFiles(repoPath, { 'keep.js': 'a\n', 'gone.js': 'b\n' }, 'initial');
  await fs.rm(path.join(repoPath, 'gone.js'));

  const body = await loadRepo(server.url, repoPath);

  assert.deepEqual(body.files, [{ path: 'gone.js', status: 'D' }]);
});

test('POST /api/load-repo falls back to the last commit when the tree is clean', async t => {
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoPath);
  });

  await commitFiles(repoPath, { 'app.js': 'const a = 1;\n' }, 'first');
  await commitFiles(repoPath, { 'app.js': 'const a = 2;\n' }, 'second');

  const body = await loadRepo(server.url, repoPath);

  assert.equal(body.mode, 'lastCommit');
  assert.match(body.message, /No working directory changes/);
  assert.deepEqual(body.files, [{ path: 'app.js', status: 'M' }]);
});

test('POST /api/load-repo returns no files for a clean repository with a single commit', async t => {
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoPath);
  });

  // There is no HEAD~1 to diff against; the request must still succeed.
  await commitFiles(repoPath, { 'app.js': 'const a = 1;\n' }, 'only');

  const body = await loadRepo(server.url, repoPath);

  assert.equal(body.mode, 'working');
  assert.deepEqual(body.files, []);
});

test('GET /api/file returns parsed diff lines', async t => {
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoPath);
  });

  await commitFiles(repoPath, { 'app.js': 'one\ntwo\nthree\n' }, 'initial');
  await writeFiles(repoPath, { 'app.js': 'one\nTWO\nthree\n' });

  const { repoId } = await loadRepo(server.url, repoPath);
  const response = await fetch(`${server.url}/api/file/${repoId}/app.js`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.filePath, 'app.js');
  assert.deepEqual(
    body.diffLines.filter(line => line.type !== 'unchanged'),
    [
      { oldLine: 2, newLine: null, type: 'delete', content: 'two' },
      { oldLine: null, newLine: 2, type: 'add', content: 'TWO' }
    ]
  );
});

test('GET /api/file shows an untracked file as wholly added', async t => {
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoPath);
  });

  await commitFiles(repoPath, { 'app.js': 'a\n' }, 'initial');
  await writeFiles(repoPath, { 'new.js': 'x\ny\n' });

  const { repoId } = await loadRepo(server.url, repoPath);
  const body = await (await fetch(`${server.url}/api/file/${repoId}/new.js`)).json();

  assert.deepEqual(body.diffLines.map(line => line.type), ['add', 'add', 'add']);
  assert.deepEqual(body.diffLines.map(line => line.content), ['x', 'y', '']);
});

test('GET /api/file reads a nested path', async t => {
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoPath);
  });

  await commitFiles(repoPath, { 'src/deep/app.js': 'a\n' }, 'initial');
  await writeFiles(repoPath, { 'src/deep/app.js': 'b\n' });

  const { repoId } = await loadRepo(server.url, repoPath);
  const response = await fetch(`${server.url}/api/file/${repoId}/src/deep/app.js`);

  assert.equal(response.status, 200);
  assert.equal((await response.json()).filePath, 'src/deep/app.js');
});

test('GET /api/file shows a deleted file as its removed lines', async t => {
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoPath);
  });

  // The file is gone from disk, which is exactly why it is under review.
  await commitFiles(repoPath, { 'keep.js': 'k\n', 'gone.js': 'one\ntwo\n' }, 'initial');
  await fs.rm(path.join(repoPath, 'gone.js'));

  const { repoId } = await loadRepo(server.url, repoPath);
  const response = await fetch(`${server.url}/api/file/${repoId}/gone.js`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(
    body.diffLines.filter(line => line.type === 'delete').map(line => line.content),
    ['one', 'two']
  );
});

test('GET /api/file-full returns a deleted file from HEAD', async t => {
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoPath);
  });

  await commitFiles(repoPath, { 'keep.js': 'k\n', 'gone.js': 'one\ntwo\n' }, 'initial');
  await fs.rm(path.join(repoPath, 'gone.js'));

  const { repoId } = await loadRepo(server.url, repoPath);
  const response = await fetch(`${server.url}/api/file-full/${repoId}/gone.js`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.lines, ['one', 'two', '']);
});

test('GET /api/file rejects an unknown session', async t => {
  const server = await startTestServer();
  t.after(() => server.close());

  const response = await fetch(`${server.url}/api/file/deadbeef/app.js`);

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /invalid repository id/i);
});

test('GET /api/file refuses to read outside the repository', async t => {
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoPath);
  });

  await commitFiles(repoPath, { 'app.js': 'a\n' }, 'initial');
  const { repoId } = await loadRepo(server.url, repoPath);

  // Percent-encoded so the URL parser cannot collapse the traversal before it
  // reaches the server.
  const escaped = '%2e%2e%2f%2e%2e%2fetc%2fpasswd';
  for (const route of ['file', 'file-full']) {
    const response = await fetch(`${server.url}/api/${route}/${repoId}/${escaped}`);
    const body = await response.json();

    assert.equal(response.status, 400, `${route} should refuse traversal`);
    assert.match(body.error, /escapes the repository/i);
    assert.ok(!('lines' in body) && !('diffLines' in body));
  }
});

test('GET /api/file-full returns every line of the file', async t => {
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoPath);
  });

  await commitFiles(repoPath, { 'app.js': 'one\ntwo\n' }, 'initial');
  await writeFiles(repoPath, { 'app.js': 'one\ntwo\nthree\n' });

  const { repoId } = await loadRepo(server.url, repoPath);
  const body = await (await fetch(`${server.url}/api/file-full/${repoId}/app.js`)).json();

  assert.deepEqual(body.lines, ['one', 'two', 'three', '']);
});

test('GET /api/file-full reads committed content in lastCommit mode', async t => {
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoPath);
  });

  await commitFiles(repoPath, { 'app.js': 'first\n' }, 'first');
  await commitFiles(repoPath, { 'app.js': 'second\n' }, 'second');

  const { repoId, mode } = await loadRepo(server.url, repoPath);
  assert.equal(mode, 'lastCommit');

  const body = await (await fetch(`${server.url}/api/file-full/${repoId}/app.js`)).json();

  assert.deepEqual(body.lines, ['second', '']);
});

test('comments survive a save and load round trip', async t => {
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoPath);
  });

  await commitFiles(repoPath, { 'app.js': 'a\n' }, 'initial');
  const { repoId } = await loadRepo(server.url, repoPath);

  const comments = [{
    file: 'app.js',
    line: 1,
    lineContent: 'a',
    text: 'rename this',
    selectedText: 'a',
    followUps: [{ text: 'still open', timestamp: '2026-08-10T09:00:00.000Z' }],
    clientOnlyField: 'dropped'
  }];

  const saved = await fetch(`${server.url}/api/save-comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoId, comments })
  });
  assert.equal(saved.status, 200);

  const loaded = await (await fetch(`${server.url}/api/load-comments/${repoId}`)).json();

  assert.equal(loaded.comments.length, 1);
  assert.equal(loaded.comments[0].text, 'rename this');
  assert.equal(loaded.comments[0].selectedText, 'a');
  assert.deepEqual(loaded.comments[0].followUps, [
    { text: 'still open', timestamp: '2026-08-10T09:00:00.000Z' }
  ]);
  assert.ok(!('clientOnlyField' in loaded.comments[0]));
});

test('GET /api/load-comments returns an empty list before anything is saved', async t => {
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoPath);
  });

  await commitFiles(repoPath, { 'app.js': 'a\n' }, 'initial');
  const { repoId } = await loadRepo(server.url, repoPath);

  const response = await fetch(`${server.url}/api/load-comments/${repoId}`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { comments: [] });
});

test('POST /api/save-comments rejects comments that are not a list', async t => {
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoPath);
  });

  await commitFiles(repoPath, { 'app.js': 'a\n' }, 'initial');
  const { repoId } = await loadRepo(server.url, repoPath);

  const response = await fetch(`${server.url}/api/save-comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoId, comments: 'not a list' })
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /must be an array/i);
});

test('POST /api/save-comments rejects a malformed comment and stores nothing', async t => {
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoPath);
  });

  await commitFiles(repoPath, { 'app.js': 'a\n' }, 'initial');
  const { repoId } = await loadRepo(server.url, repoPath);

  const response = await fetch(`${server.url}/api/save-comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoId, comments: [{ filePath: 'app.js', line: 1, body: 'hello' }] })
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /comments\[0\]\.file must be a non-empty string/);

  const loaded = await (await fetch(`${server.url}/api/load-comments/${repoId}`)).json();
  assert.deepEqual(loaded.comments, []);
});

test('POST /api/submit-review refuses when nothing has been saved', async t => {
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoPath);
  });

  await commitFiles(repoPath, { 'app.js': 'a\n' }, 'initial');
  const { repoId } = await loadRepo(server.url, repoPath);

  const response = await fetch(`${server.url}/api/submit-review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoId })
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /no comments found/i);
});

test('POST /api/submit-review writes a review file rendered from the saved comments', async t => {
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoPath);
  });

  await commitFiles(repoPath, { 'app.js': 'a\n' }, 'initial');
  const { repoId } = await loadRepo(server.url, repoPath);

  await fetch(`${server.url}/api/save-comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repoId,
      comments: [
        { file: 'app.js', line: 2, lineContent: 'b', text: 'second note' },
        { file: 'app.js', line: 1, lineContent: 'a', text: 'first note' }
      ]
    })
  });

  const response = await fetch(`${server.url}/api/submit-review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoId })
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.totalComments, 2);
  assert.match(body.filename, /^review_reviewer-test-.*\.txt$/);
  assert.ok(body.reviewContent.indexOf('first note') < body.reviewContent.indexOf('second note'));

  const onDisk = await fs.readFile(path.join(server.reviewsDir, body.filename), 'utf-8');
  assert.equal(onDisk, body.reviewContent);
});

test('review files are written only under the configured reviews directory', async t => {
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoPath);
  });

  await commitFiles(repoPath, { 'app.js': 'a\n' }, 'initial');
  const { repoId } = await loadRepo(server.url, repoPath);

  await fetch(`${server.url}/api/save-comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoId, comments: [{ file: 'app.js', line: 1, text: 'x' }] })
  });
  await fetch(`${server.url}/api/submit-review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoId })
  });

  const written = await fs.readdir(server.reviewsDir);

  // The human-readable review, the machine-readable one beside it, the live
  // comment state, and the list of repositories opened -- and nothing else,
  // here or outside this directory.
  assert.equal(written.filter(name => name.endsWith('.txt')).length, 1);
  assert.equal(written.filter(name => name.startsWith('review_') && name.endsWith('.json')).length, 1);
  assert.equal(written.filter(name => name.startsWith('.code-review-comments-')).length, 1);
  assert.equal(written.filter(name => name === RECENTS_FILE).length, 1);
  assert.equal(written.length, 4);
});

test('submitting also writes a machine-readable review beside the text one', async t => {
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoPath);
  });

  await commitFiles(repoPath, { 'app.js': 'const a = 1;\n' }, 'initial');
  const { repoId } = await loadRepo(server.url, repoPath);

  await fetch(`${server.url}/api/save-comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repoId,
      comments: [{ file: 'app.js', line: 1, lineContent: 'const a = 1;', text: 'name it' }]
    })
  });

  const body = await (await fetch(`${server.url}/api/submit-review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoId })
  })).json();

  assert.equal(body.documentFilename, body.filename.replace(/\.txt$/, '.json'));
  assert.equal(body.review.schema, 'code-review/v1');
  assert.match(body.review.repository.head, /^[0-9a-f]{40}$/);
  assert.equal(body.review.repository.branch, 'main');
  assert.equal(body.review.mode, 'working');
  assert.deepEqual(body.review.comments, [{
    id: 'app.js:1',
    file: 'app.js',
    line: 1,
    anchor: 'const a = 1;',
    body: 'name it'
  }]);

  const onDisk = JSON.parse(
    await fs.readFile(path.join(server.reviewsDir, body.documentFilename), 'utf-8')
  );
  assert.deepEqual(onDisk, body.review);
});

test('DELETE /api/cleanup ends the session', async t => {
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoPath);
  });

  await commitFiles(repoPath, { 'app.js': 'a\n' }, 'initial');
  const { repoId } = await loadRepo(server.url, repoPath);

  const cleaned = await fetch(`${server.url}/api/cleanup/${repoId}`, { method: 'DELETE' });
  assert.equal(cleaned.status, 200);

  const afterwards = await fetch(`${server.url}/api/file/${repoId}/app.js`);
  assert.equal(afterwards.status, 400);
});

test('DELETE /api/cleanup is safe to call twice', async t => {
  const server = await startTestServer();
  t.after(() => server.close());

  const first = await fetch(`${server.url}/api/cleanup/never-existed`, { method: 'DELETE' });

  assert.equal(first.status, 200);
});

test('two sessions review different repositories independently', async t => {
  const server = await startTestServer();
  const repoA = await createTempRepo();
  const repoB = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoA);
    await cleanup(repoB);
  });

  await commitFiles(repoA, { 'a.js': 'a\n' }, 'initial');
  await writeFiles(repoA, { 'a.js': 'aa\n' });
  await commitFiles(repoB, { 'b.js': 'b\n' }, 'initial');
  await writeFiles(repoB, { 'b.js': 'bb\n' });

  const sessionA = await loadRepo(server.url, repoA);
  const sessionB = await loadRepo(server.url, repoB);

  assert.notEqual(sessionA.repoId, sessionB.repoId);
  assert.deepEqual(sessionA.files, [{ path: 'a.js', status: 'M' }]);
  assert.deepEqual(sessionB.files, [{ path: 'b.js', status: 'M' }]);

  // A path that exists in the other repository is still not readable here.
  const crossed = await fetch(`${server.url}/api/file-full/${sessionA.repoId}/b.js`);
  assert.equal(crossed.status, 404);
  assert.match((await crossed.json()).error, /not found/i);
});

test('GET /api/file 404s for a path that exists nowhere', async t => {
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoPath);
  });

  await commitFiles(repoPath, { 'app.js': 'a\n' }, 'initial');
  const { repoId } = await loadRepo(server.url, repoPath);

  const response = await fetch(`${server.url}/api/file/${repoId}/nope.js`);

  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /not found/i);
});

test('the static UI is served', async t => {
  const server = await startTestServer();
  t.after(() => server.close());

  const response = await fetch(`${server.url}/`);

  assert.equal(response.status, 200);
  assert.match(await response.text(), /<title>Code Reviewer<\/title>/);
});

test('a renamed file is listed under its new path', async t => {
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoPath);
  });

  await commitFiles(repoPath, { 'old.js': 'const value = 1;\n'.repeat(10) }, 'initial');
  await git(repoPath, ['mv', 'old.js', 'new.js']);
  await git(repoPath, ['add', '-A']);

  const body = await loadRepo(server.url, repoPath);

  assert.ok(body.files.some(file => file.path === 'new.js'), `got ${JSON.stringify(body.files)}`);
});

test('a renamed file in lastCommit mode is listed under its new path with status R and diffable', async t => {
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoPath);
  });

  await commitFiles(repoPath, { 'old.js': 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n' }, 'initial');
  await git(repoPath, ['mv', 'old.js', 'new.js']);
  await writeFiles(repoPath, { 'new.js': 'line1\nline2 CHANGED\nline3\nline4\nline5\nline6\nline7\nline8\n' });
  await git(repoPath, ['add', '-A']);
  await git(repoPath, ['commit', '-m', 'renamed and edited']);

  const body = await loadRepo(server.url, repoPath);
  assert.equal(body.mode, 'lastCommit');
  assert.ok(body.files.some(file => file.path === 'new.js' && file.status === 'R'), `got ${JSON.stringify(body.files)}`);

  const res = await fetch(`${server.url}/api/file/${body.repoId}/new.js`);
  assert.equal(res.status, 200);
  const fileData = await res.json();
  assert.ok(fileData.diffLines.length > 0, 'diffLines should not be empty');
});

test('a non-ASCII filename in lastCommit mode is unquoted and diffable', async t => {
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoPath);
  });

  const unicodeFile = 'unicode-café-日本.txt';
  await commitFiles(repoPath, { [unicodeFile]: 'initial content\n' }, 'initial');
  await writeFiles(repoPath, { [unicodeFile]: 'updated content\n' });
  await git(repoPath, ['add', '-A']);
  await git(repoPath, ['commit', '-m', 'second commit']);

  const body = await loadRepo(server.url, repoPath);
  assert.equal(body.mode, 'lastCommit');
  assert.ok(body.files.some(file => file.path === unicodeFile && file.status === 'M'), `got ${JSON.stringify(body.files)}`);

  const res = await fetch(`${server.url}/api/file/${body.repoId}/${encodeURIComponent(unicodeFile)}`);
  assert.equal(res.status, 200);
  const fileData = await res.json();
  assert.ok(fileData.diffLines.length > 0, 'diffLines should not be empty');
});

test('a renamed file moved from subdirectory to repo root in lastCommit mode is diffable', async t => {
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoPath);
  });

  const lines = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n';
  await commitFiles(repoPath, { 'nested/root-dest.txt': lines }, 'initial');
  await git(repoPath, ['mv', 'nested/root-dest.txt', 'root-dest.txt']);
  await writeFiles(repoPath, { 'root-dest.txt': 'line1\nline2 edited\nline3\nline4\nline5\nline6\nline7\nline8\n' });
  await git(repoPath, ['add', '-A']);
  await git(repoPath, ['commit', '-m', 'moved to root']);

  const body = await loadRepo(server.url, repoPath);
  assert.equal(body.mode, 'lastCommit');
  assert.ok(body.files.some(file => file.path === 'root-dest.txt' && file.status === 'R'), `got ${JSON.stringify(body.files)}`);

  const res = await fetch(`${server.url}/api/file/${body.repoId}/root-dest.txt`);
  assert.equal(res.status, 200);
  const fileData = await res.json();
  assert.ok(fileData.diffLines.length > 0, 'diffLines should not be empty');
});

test('an emoji filename in lastCommit mode is unquoted without corruption and diffable', async t => {
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoPath);
  });

  const emojiFile = 'feature-🚀-rocket.txt';
  await commitFiles(repoPath, { [emojiFile]: 'line 1\nline 2\n' }, 'initial');
  await writeFiles(repoPath, { [emojiFile]: 'line 1\nline 2 modified\n' });
  await git(repoPath, ['add', '-A']);
  await git(repoPath, ['commit', '-m', 'emoji commit']);

  const body = await loadRepo(server.url, repoPath);
  assert.equal(body.mode, 'lastCommit');
  assert.ok(body.files.some(file => file.path === emojiFile && file.status === 'M'), `got ${JSON.stringify(body.files)}`);

  const res = await fetch(`${server.url}/api/file/${body.repoId}/${encodeURIComponent(emojiFile)}`);
  assert.equal(res.status, 200);
  const fileData = await res.json();
  assert.ok(fileData.diffLines.length > 0, 'diffLines should not be empty');
});

test('a repository with no commits at all loads without error', async t => {
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoPath);
  });

  await writeFiles(repoPath, { 'app.js': 'a\n' });

  const body = await loadRepo(server.url, repoPath);

  assert.deepEqual(body.files, [{ path: 'app.js', status: 'A' }]);
});

test('a file in a repository with no commits is diffed as wholly added', async t => {
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoPath);
  });

  await writeFiles(repoPath, { 'app.js': 'x\ny\n' });
  const { repoId } = await loadRepo(server.url, repoPath);

  const response = await fetch(`${server.url}/api/file/${repoId}/app.js`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.diffLines.map(line => line.content), ['x', 'y', '']);
});

test('an empty commit history plus a staged file still reports the file', async t => {
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoPath);
  });

  await writeFiles(repoPath, { 'app.js': 'a\n' });
  await git(repoPath, ['add', 'app.js']);

  const body = await loadRepo(server.url, repoPath);

  assert.deepEqual(body.files, [{ path: 'app.js', status: 'A' }]);
});

test('session count is reflected in the health probe', async t => {
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoPath);
  });

  await commitFiles(repoPath, { 'app.js': 'a\n' }, 'initial');
  await loadRepo(server.url, repoPath);

  const health = await (await fetch(`${server.url}/api/health`)).json();

  assert.equal(health.sessions, 1);
});

// --- binary files are not decoded as text (#23) --------------------------

test('a binary file is reported as binary, not served as mojibake', async t => {
  // `lib/changes.js` already classified these as `B` and the sidebar showed
  // the letter, but the file endpoint decoded the blob as UTF-8 anyway: a
  // 2 KB PNG came back as ten `add` lines, roughly 45% of the characters
  // being U+FFFD. The second-order damage is worse than the mojibake — a
  // comment left on one of those lines exports an `anchor` that can never
  // match the file, and docs/agent-format.md tells consumers to locate
  // comments by that anchor.
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(() => Promise.all([server.close(), cleanup(repoPath)]));

  const png = Buffer.alloc(2048);
  for (let i = 0; i < png.length; i++) png[i] = i % 256;
  await fsSync.promises.writeFile(path.join(repoPath, 'logo.png'), png);
  await commitFiles(repoPath, { 'keep.txt': 'x\n' }, 'initial');

  png[0] = 0xff;
  await fsSync.promises.writeFile(path.join(repoPath, 'logo.png'), png);
  await git(repoPath, ['add', '-A']);
  await git(repoPath, ['commit', '-q', '-m', 'regenerate logo']);

  const { repoId } = await loadRepo(server.url, repoPath);
  const body = await (await fetch(`${server.url}/api/file/${repoId}/logo.png`)).json();

  assert.equal(body.binary, true, 'the endpoint should report the file as binary');
  assert.deepEqual(body.diffLines, [], 'a binary file has no lines to review');

  const served = body.diffLines.map(line => line.content).join('');
  assert.equal(served.includes('�'), false, 'no replacement characters should be served');
});

test('a text file is still served as lines', async t => {
  // The binary check must not swallow ordinary files; that would be a much
  // worse bug than the one it fixes.
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(() => Promise.all([server.close(), cleanup(repoPath)]));

  await commitFiles(repoPath, { 'app.js': 'const a = 1;\n' }, 'initial');
  await writeFiles(repoPath, { 'app.js': 'const a = 2;\n' });

  const { repoId } = await loadRepo(server.url, repoPath);
  const body = await (await fetch(`${server.url}/api/file/${repoId}/app.js`)).json();

  assert.equal(body.binary, false);
  assert.ok(body.diffLines.length > 0, 'a changed text file still has diff lines');
});

test('POST /api/load-repo opens the repository a subdirectory belongs to', async t => {
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoPath);
  });

  await commitFiles(repoPath, { 'src/deep/app.js': 'one\n' }, 'init');
  await writeFiles(repoPath, { 'src/deep/app.js': 'one\ntwo\n' });

  const response = await fetch(`${server.url}/api/load-repo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoPath: path.join(repoPath, 'src', 'deep') })
  });
  const data = await response.json();

  assert.equal(response.status, 200);
  // Answered with the root, not with what was asked for, so the page can show
  // which repository it actually opened.
  assert.equal(data.repoPath, repoPath);
  assert.deepEqual(data.files.map(file => file.path), ['src/deep/app.js']);

  // The reason any of this matters: the file listed above used to open to
  // nothing, because its diff was fetched from a git rooted one directory
  // down and the pathspec matched nothing there.
  const diff = await (
    await fetch(`${server.url}/api/file/${data.repoId}/src/deep/app.js`)
  ).json();

  assert.deepEqual(
    diff.diffLines.filter(line => line.type !== 'unchanged'),
    [{ oldLine: null, newLine: 2, type: 'add', content: 'two' }]
  );
});

test('GET /api/browse lists the directories inside one and marks repositories', async t => {
  const server = await startTestServer();
  const dir = await createTempDir();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(dir);
    await cleanup(repoPath);
  });

  await fs.mkdir(path.join(dir, 'notes'), { recursive: true });
  await writeFiles(dir, { 'a-file.txt': 'x\n' });
  await fs.symlink(repoPath, path.join(dir, 'checkout'));

  const listing = await (
    await fetch(`${server.url}/api/browse?path=${encodeURIComponent(dir)}`)
  ).json();

  assert.equal(listing.path, dir);
  assert.equal(listing.parent, path.dirname(dir));
  assert.equal(listing.isRepository, false);
  assert.deepEqual(
    listing.entries.map(entry => [entry.name, entry.isRepository]),
    [['checkout', true], ['notes', false]]
  );
});

test('GET /api/browse starts at the home directory when given no path', async t => {
  const server = await startTestServer();
  t.after(() => server.close());

  const listing = await (await fetch(`${server.url}/api/browse`)).json();

  assert.equal(await fs.realpath(listing.path), await fs.realpath(os.homedir()));
});

test('GET /api/browse refuses a path that is missing or is not a directory', async t => {
  const server = await startTestServer();
  const dir = await createTempDir();
  t.after(async () => {
    await server.close();
    await cleanup(dir);
  });
  await writeFiles(dir, { 'file.txt': 'x\n' });

  for (const target of ['/no/such/place/at/all', path.join(dir, 'file.txt')]) {
    const response = await fetch(`${server.url}/api/browse?path=${encodeURIComponent(target)}`);

    assert.equal(response.status, 400, target);
    assert.match((await response.json()).error, /No such directory/);
  }
});

test('GET /api/recent is empty until a repository has been opened', async t => {
  const server = await startTestServer();
  t.after(() => server.close());

  assert.deepEqual(await (await fetch(`${server.url}/api/recent`)).json(), { projects: [] });
});

test('opening a repository records it, newest first and without duplicates', async t => {
  const server = await startTestServer();
  const first = await createTempRepo();
  const second = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(first);
    await cleanup(second);
  });

  await commitFiles(first, { 'app.js': 'a\n' }, 'initial');
  await commitFiles(second, { 'app.js': 'b\n' }, 'initial');
  await writeFiles(first, { 'app.js': 'a\nchanged\n' });
  await writeFiles(second, { 'app.js': 'b\nchanged\n' });

  await loadRepo(server.url, first);
  await loadRepo(server.url, second);
  await loadRepo(server.url, first);

  const { projects } = await (await fetch(`${server.url}/api/recent`)).json();

  assert.deepEqual(projects.map(project => project.path), [first, second]);
  assert.deepEqual(projects.map(project => project.exists), [true, true]);
});

test('a repository opened from a subdirectory is remembered by its root', async t => {
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoPath);
  });

  await commitFiles(repoPath, { 'src/deep/app.js': 'a\n' }, 'initial');
  await writeFiles(repoPath, { 'src/deep/app.js': 'a\nchanged\n' });

  await loadRepo(server.url, path.join(repoPath, 'src', 'deep'));

  // Otherwise the same repository accumulates one recent entry per directory
  // you happened to be standing in when you opened it.
  const { projects } = await (await fetch(`${server.url}/api/recent`)).json();
  assert.deepEqual(projects.map(project => project.path), [repoPath]);
});

test('GET /api/recent reports how many comments are saved against each', async t => {
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoPath);
  });

  await commitFiles(repoPath, { 'app.js': 'a\n' }, 'initial');
  await writeFiles(repoPath, { 'app.js': 'a\nchanged\n' });

  const { repoId } = await loadRepo(server.url, repoPath);
  await fetch(`${server.url}/api/save-comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repoId,
      comments: [
        { file: 'app.js', line: 2, text: 'one' },
        { file: 'app.js', line: 1, text: 'two' }
      ]
    })
  });

  const { projects } = await (await fetch(`${server.url}/api/recent`)).json();

  assert.equal(projects[0].comments, 2);
  assert.equal(projects[0].name, path.basename(repoPath));
});

test('browse and recent are not answered to another origin', async t => {
  const server = await startTestServer();
  t.after(() => server.close());

  // These two differ in kind from the rest of the surface: they enumerate
  // directories and name projects, rather than answering about a repository
  // whose path the caller already had.
  for (const endpoint of ['/api/browse', '/api/recent']) {
    const refused = await fetch(`${server.url}${endpoint}`, {
      headers: { Origin: 'https://somewhere.example' }
    });
    assert.equal(refused.status, 403, endpoint);

    const allowed = await fetch(`${server.url}${endpoint}`, {
      headers: { Origin: server.url }
    });
    assert.equal(allowed.status, 200, endpoint);
  }
});

test('submitting tells the caller, so the process that started the server can act', async t => {
  const handed = [];
  const reviewsDir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'reviewer-handoff-'));
  const app = createApp({
    reviewsDir,
    handoff: true,
    onReviewSubmitted: review => handed.push(review)
  });
  const listening = await new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
  const url = `http://127.0.0.1:${listening.address().port}`;

  const repoPath = await createTempRepo();
  t.after(async () => {
    await new Promise(resolve => listening.close(resolve));
    await cleanup(reviewsDir);
    await cleanup(repoPath);
  });

  await commitFiles(repoPath, { 'app.js': 'one\n' }, 'initial');
  await writeFiles(repoPath, { 'app.js': 'one\ntwo\n' });

  const { repoId } = await loadRepo(url, repoPath);
  await fetch(`${url}/api/save-comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoId, comments: [{ file: 'app.js', line: 2, text: 'Needs a test.' }] })
  });

  const submitted = await (await fetch(`${url}/api/submit-review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoId })
  })).json();

  // The page is told where the review went and whether anything is waiting for
  // it, because "download it" is the wrong thing to offer someone whose
  // terminal already has it.
  assert.equal(submitted.handoff, true);
  assert.equal(submitted.reviewPath, path.join(reviewsDir, submitted.filename));

  assert.equal(handed.length, 1);
  assert.equal(handed[0].document.summary.comments, 1);
  assert.equal(handed[0].reviewPath, submitted.reviewPath);
  assert.deepEqual(handed[0].comments.map(comment => comment.text), ['Needs a test.']);
});

test('a handoff that throws does not fail the submit', async t => {
  const reviewsDir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'reviewer-handoff-'));
  const app = createApp({
    reviewsDir,
    onReviewSubmitted: () => {
      throw new Error('the consumer fell over');
    }
  });
  const listening = await new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
  const url = `http://127.0.0.1:${listening.address().port}`;

  const repoPath = await createTempRepo();
  t.after(async () => {
    await new Promise(resolve => listening.close(resolve));
    await cleanup(reviewsDir);
    await cleanup(repoPath);
  });

  await commitFiles(repoPath, { 'app.js': 'one\n' }, 'initial');
  await writeFiles(repoPath, { 'app.js': 'one\ntwo\n' });

  const { repoId } = await loadRepo(url, repoPath);
  await fetch(`${url}/api/save-comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoId, comments: [{ file: 'app.js', line: 2, text: 'x' }] })
  });

  // The review is on disk before the caller is told about it. Whatever the
  // caller then does with it, the person in the browser has submitted
  // successfully and must be told so.
  const response = await fetch(`${url}/api/submit-review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoId })
  });

  assert.equal(response.status, 200);
  const written = await fs.readdir(reviewsDir);
  assert.equal(written.filter(name => name.endsWith('.txt')).length, 1);
});

// --- #73: the server notices when the last tab has gone -------------------
//
// Driven by opening and aborting requests rather than by a browser. There is
// no browser in CI, and a test that needs one to prove a five-second timer did
// *not* fire is a test nobody runs. What the server actually decides on is the
// lifetime of a connection, so that is what these drive.

const GRACE = 60;

/** Open `/api/alive` and return a handle that closes it the way a tab does. */
async function openTab(url) {
  const controller = new AbortController();
  await fetch(`${url}/api/alive`, { signal: controller.signal });
  return { close: () => controller.abort() };
}

/** Long enough for an abort to reach the server, or for GRACE to elapse. */
const settle = (ms) => new Promise(resolve => setTimeout(resolve, ms));

test('the last tab closing stops the server, after the grace period', async () => {
  let idle = 0;
  const server = await startTestServer({ onIdle: () => { idle += 1; }, idleGraceMs: GRACE });

  try {
    const tab = await openTab(server.url);
    await settle(GRACE * 2);
    assert.equal(idle, 0, 'a tab that is still open is not idle');

    tab.close();
    await settle(GRACE / 2);
    assert.equal(idle, 0, 'nothing happens at the moment the tab goes');

    await settle(GRACE * 3);
    assert.equal(idle, 1);
  } finally {
    await server.close();
  }
});

test('a reload does not stop the server', async () => {
  // The whole reason the grace period exists. A refresh closes the connection
  // and opens a new one milliseconds later, and at the instant of the close it
  // is indistinguishable from someone leaving.
  let idle = 0;
  const server = await startTestServer({ onIdle: () => { idle += 1; }, idleGraceMs: GRACE });

  try {
    const first = await openTab(server.url);
    first.close();
    await settle(GRACE / 3);
    const second = await openTab(server.url);

    await settle(GRACE * 3);
    assert.equal(idle, 0, 'the tab came back inside the window');

    second.close();
    await settle(GRACE * 3);
    assert.equal(idle, 1, 'and stopping still works afterwards');
  } finally {
    await server.close();
  }
});

test('closing one of two tabs leaves the other reviewing', async () => {
  let idle = 0;
  const server = await startTestServer({ onIdle: () => { idle += 1; }, idleGraceMs: GRACE });

  try {
    const first = await openTab(server.url);
    const second = await openTab(server.url);

    first.close();
    await settle(GRACE * 3);
    assert.equal(idle, 0, 'the second tab is still watching');

    second.close();
    await settle(GRACE * 3);
    assert.equal(idle, 1);
  } finally {
    await server.close();
  }
});

test('a server no browser ever opened keeps serving', async () => {
  // `reviewer` whose browser failed to launch prints the URL and waits. Zero
  // tabs is the state it starts in, not a signal that everyone has left.
  let idle = 0;
  const server = await startTestServer({ onIdle: () => { idle += 1; }, idleGraceMs: GRACE });

  try {
    await settle(GRACE * 4);
    assert.equal(idle, 0);
  } finally {
    await server.close();
  }
});

test('without an onIdle there is nothing to tell, and nothing breaks', async () => {
  // The piped form passes no onIdle on purpose: submitting is what hands the
  // review over there, and a closed tab is not a submitted review.
  const server = await startTestServer({ idleGraceMs: GRACE });

  try {
    const tab = await openTab(server.url);
    tab.close();
    await settle(GRACE * 3);

    const health = await fetch(`${server.url}/api/health`);
    assert.equal(health.status, 200, 'still serving');
  } finally {
    await server.close();
  }
});

test('another origin cannot hold the server open', async () => {
  // Same reasoning as /api/browse and /api/recent: a page on another site
  // holding this connection would keep a server alive its owner had finished
  // with. Browsers omit Origin on same-origin GETs, so the real page is
  // unaffected.
  const server = await startTestServer({ onIdle: () => {}, idleGraceMs: GRACE });

  try {
    const response = await fetch(`${server.url}/api/alive`, {
      headers: { Origin: 'http://evil.example' }
    });
    assert.equal(response.status, 403);
    await response.json();
  } finally {
    await server.close();
  }
});

test('saving comments records which mode the review was written in', async t => {
  // The mode is what lets `reviewer export` say whether the comments are
  // about committed or uncommitted work. It lives on the session, which the
  // export path does not have, so it has to reach the file.
  const server = await startTestServer();
  const repoPath = await createTempRepo();
  t.after(async () => {
    await server.close();
    await cleanup(repoPath);
  });

  await commitFiles(repoPath, { 'app.js': 'a\n' }, 'initial');
  await writeFiles(repoPath, { 'app.js': 'b\n' });
  const { repoId, mode } = await loadRepo(server.url, repoPath);
  assert.equal(mode, 'working', 'a dirty tree opens in working mode');

  await fetch(`${server.url}/api/save-comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repoId,
      comments: [{ file: 'app.js', line: 1, lineContent: 'b', text: 'why' }]
    })
  });

  const envelope = JSON.parse(
    await fs.readFile(path.join(server.reviewsDir, commentsFilename(repoPath)), 'utf-8')
  );
  assert.equal(envelope.mode, 'working');
});
