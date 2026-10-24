'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { createApp } = require('../server');
const { createTempRepo, commitFiles, writeFiles, cleanup } = require('./helpers/repo');
const { updateSavedComments, readSavedComments } = require('../lib/store');
const { projectDirName } = require('../lib/claude-sessions');

/**
 * The server's side of agents answering in threads: the live feed, saves
 * that cannot erase an answer, and a background Claude Code session -- the
 * fake one in test/helpers, never the real thing.
 */

const FAKE = path.join(__dirname, 'helpers', 'fake-claude');
const SESSION = '00000003-0000-4000-8000-000000000003';

async function setup(t, { spawnEnv = {} } = {}) {
  const base = await fs.realpath(os.tmpdir());
  const reviewsDir = await fs.mkdtemp(path.join(base, 'reviewer-agent-'));
  const configDir = await fs.mkdtemp(path.join(base, 'reviewer-claude-config-'));
  const repoPath = await createTempRepo();
  await commitFiles(repoPath, { 'cart.js': 'const a = 1;\n' }, 'initial');
  await writeFiles(repoPath, { 'cart.js': 'const a = 2;\n' });

  // The session that "wrote" the change, as Claude Code would have filed it.
  const projectDir = path.join(configDir, 'projects', projectDirName(repoPath));
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, `${SESSION}.jsonl`), `${JSON.stringify({
    type: 'user', cwd: repoPath, sessionId: SESSION, gitBranch: 'main', message: { role: 'user', content: 'Change a to 2' }
  })}\n`);

  const app = createApp({
    reviewsDir,
    claude: {
      configDir,
      spawn: (command, args, options) => spawn(process.execPath, [FAKE, ...args], { ...options, env: { ...process.env, ...spawnEnv } })
    }
  });
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const open = [];

  t.after(async () => {
    for (const controller of open) controller.abort();
    await app.locals.stopAgents();
    const closed = new Promise(resolve => server.close(resolve));
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await closed;
    await cleanup(repoPath);
    await fs.rm(reviewsDir, { recursive: true, force: true });
    await fs.rm(configDir, { recursive: true, force: true });
  });

  const post = async (route, body) => {
    const response = await fetch(`${url}/api/${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  const { body: { repoId } } = await post('load-repo', { repoPath });

  /** Read the live feed; `events` fills as they arrive. */
  const feed = async () => {
    const controller = new AbortController();
    open.push(controller);
    const response = await fetch(`${url}/api/events/${repoId}`, { signal: controller.signal });
    const events = [];
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffered += decoder.decode(value, { stream: true });
          let end;
          while ((end = buffered.indexOf('\n\n')) >= 0) {
            const frame = buffered.slice(0, end);
            buffered = buffered.slice(end + 2);
            const event = frame.match(/^event: (.*)$/m)?.[1];
            const data = frame.match(/^data: (.*)$/m)?.[1];
            if (event) events.push({ event, data: JSON.parse(data) });
          }
        }
      } catch {
        /* aborted at the end of the test */
      }
    })();
    // Held by the caller so the response is not collected while streaming (CLAUDE.md, #83).
    return { events, response };
  };

  return { url, repoPath, reviewsDir, repoId, post, feed };
}

const until = async (check, ms = 10000) => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};

test('the live feed carries a reply written by another process to an open page', async t => {
  const { feed, post, repoId, repoPath, reviewsDir } = await setup(t);
  const { events } = await feed();
  await until(() => events.some(e => e.event === 'comments'));

  const saved = await post('save-comments', {
    repoId, lastUpdated: null, comments: [{ key: 'k1', file: 'cart.js', line: 1, lineContent: 'const a = 2;', text: 'Why 2?' }]
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.comments[0].key, 'k1', 'a save answers with what it wrote');

  await updateSavedComments(reviewsDir, repoPath, state => ({
    comments: state.comments.map(c => ({ ...c, followUps: [{ key: 'a1', text: 'Because the spec says so.', by: 'claude' }] }))
  }));

  await until(() => events.some(e => e.event === 'comments' && e.data.comments[0]?.followUps?.[0]?.by === 'claude'));
});

test('a save from a tab that never saw an answer does not erase it', async t => {
  const { post, repoId, repoPath, reviewsDir } = await setup(t);
  await post('save-comments', { repoId, comments: [{ key: 'k1', file: 'cart.js', line: 1, text: 'Why 2?' }] });
  await updateSavedComments(reviewsDir, repoPath, state => ({
    comments: state.comments.map(c => ({ ...c, followUps: [{ key: 'a1', text: 'Because.', by: 'claude' }] }))
  }));

  // An old page or a script: whole list, no lastUpdated, no follow-ups.
  const saved = await post('save-comments', {
    repoId, comments: [{ key: 'k1', file: 'cart.js', line: 1, text: 'Why 2, exactly?' }]
  });

  assert.equal(saved.status, 200);
  const { comments: [thread] } = await readSavedComments(reviewsDir, repoPath);
  assert.equal(thread.text, 'Why 2, exactly?');
  assert.deepEqual(thread.followUps.map(f => f.key), ['a1']);
});

test('the sessions that worked in the repository are offered, and only those can be connected', async t => {
  const { url, repoId, post } = await setup(t);

  const listed = await (await fetch(`${url}/api/agent/sessions/${repoId}`)).json();
  assert.deepEqual(listed.sessions.map(s => [s.id, s.firstPrompt]), [[SESSION, 'Change a to 2']]);
  assert.equal(listed.answerer, null);

  const refused = await post('agent/connect', { repoId, sessionId: '00000009-0000-4000-8000-000000000009' });
  assert.equal(refused.status, 404);
  const malformed = await post('agent/connect', { repoId, sessionId: SESSION, fork: 'yes' });
  assert.equal(malformed.status, 400);
});

test('a connected session answers each comment in its thread, and the page sees it being written', async t => {
  const { feed, post, repoId, repoPath, reviewsDir } = await setup(t);
  const { events } = await feed();
  await post('save-comments', { repoId, comments: [{ key: 'k1', file: 'cart.js', line: 1, lineContent: 'const a = 2;', text: 'Why 2?' }] });

  const connected = await post('agent/connect', { repoId, sessionId: SESSION });
  assert.equal(connected.status, 200);
  assert.equal(connected.body.answerer.session, SESSION);
  assert.equal(connected.body.answerer.forked, true);

  const answered = async () => {
    const { comments } = await readSavedComments(reviewsDir, repoPath);
    return comments[0].followUps?.find(f => f.by === 'claude');
  };
  await until(answered);
  assert.equal((await answered()).text, 'Answer 1 to "Why 2?"');
  assert.ok(events.some(e => e.event === 'partial' && e.data.key === 'k1'), 'the answer streamed to the page before it was saved');
  await until(() => events.some(e => e.event === 'agents' && e.data.agents.some(a => a.kind === 'background')));

  const stopped = await post('agent/disconnect', { repoId });
  assert.deepEqual(stopped.body, { disconnected: true });
  await until(() => events.some(e => e.event === 'answerer' && e.data === null));
});

test('a background session that cannot answer reports why on the feed', async t => {
  const { feed, post, repoId } = await setup(t, { spawnEnv: { FAKE_CLAUDE_FAIL: '1' } });
  const { events } = await feed();
  await post('save-comments', { repoId, comments: [{ key: 'k1', file: 'cart.js', line: 1, text: 'Why 2?' }] });
  await post('agent/connect', { repoId, sessionId: SESSION });

  await until(() => events.some(e => e.event === 'agent-error'));
  assert.equal(events.find(e => e.event === 'agent-error').data.message, 'fake failure');
});
