'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { createTempRepo, cleanup } = require('./helpers/repo');
const { updateSavedComments, readSavedComments } = require('../lib/store');
const { listAgents } = require('../lib/presence');

/**
 * `reviewer channel`, driven the way Claude Code drives it: over stdio, one
 * JSON-RPC message per line. Nothing here runs Claude Code itself.
 */

const BIN = path.join(__dirname, '..', 'bin', 'reviewer.js');
const SESSION = '00000002-0000-4000-8000-000000000002';

async function startChannel(t) {
  const repoPath = await createTempRepo();
  const reviewsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reviewer-channel-'));
  const child = spawn(process.execPath, [BIN, 'channel', repoPath], {
    env: { ...process.env, REVIEWER_DATA_DIR: reviewsDir, CLAUDE_CODE_SESSION_ID: SESSION, REVIEWER_SESSION_TITLE: 'Build the cart' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const messages = [];
  const waiters = [];
  let buffered = '';
  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', chunk => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      messages.push(message);
      for (const waiter of [...waiters]) {
        if (waiter.match(message)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    }
  });
  let id = 0;
  const next = match => {
    const found = messages.find(match);
    if (found) {
      messages.splice(messages.indexOf(found), 1);
      return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no such message within 10s')), 10000);
      waiters.push({ match: m => (match(m) ? (messages.splice(messages.indexOf(m), 1), clearTimeout(timer), true) : false), resolve });
    });
  };
  const request = async (method, params) => {
    const requestId = ++id;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
    return next(m => m.id === requestId);
  };
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  const exited = new Promise(resolve => child.on('exit', resolve));

  t.after(async () => {
    child.stdin.end();
    await exited;
    await cleanup(repoPath);
    await fs.rm(reviewsDir, { recursive: true, force: true });
  });

  return { child, repoPath, reviewsDir, request, notify, next, exited };
}

const isChannel = m => m.method === 'notifications/claude/channel';

test('it answers discovery with "not found", so Claude Code falls back to initialize, and declares a channel', async t => {
  const { request } = await startChannel(t);

  const discover = await request('server/discover', {});
  assert.equal(discover.error.code, -32601);

  const { result } = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test' } });
  assert.deepEqual(result.capabilities.experimental, { 'claude/channel': {} });
  assert.ok(result.capabilities.tools);
  assert.match(result.instructions, /reply tool/);

  const { result: { tools } } = await request('tools/list', {});
  assert.deepEqual(tools.map(tool => tool.name), ['reply', 'list_comments']);
});

test('every comment the reviewer writes is pushed into the session, and its reply lands in the thread', async t => {
  const { request, notify, next, repoPath, reviewsDir } = await startChannel(t);
  await request('initialize', { protocolVersion: '2025-11-25', capabilities: {} });
  notify('notifications/initialized');
  await new Promise(resolve => setTimeout(resolve, 300));

  await updateSavedComments(reviewsDir, repoPath, () => ({
    comments: [{ key: 'k1', file: 'src/cart.js', line: 28, lineContent: "throw new Error('price mismatch')", text: 'Why throw here?' }]
  }));
  const pushed = await next(isChannel);
  assert.deepEqual(pushed.params.meta, { key: 'k1', file: 'src/cart.js', line: '28' });
  assert.match(pushed.params.content, /Reviewer: Why throw here\?/);
  assert.match(pushed.params.content, /key "k1"/);

  // The presence file is written just after the push, so give it a moment.
  let agent;
  for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
    [agent] = await listAgents(reviewsDir, repoPath);
    if (agent?.working?.length) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(agent.kind, 'channel');
  assert.equal(agent.session, SESSION);
  assert.equal(agent.title, 'Build the cart');
  assert.deepEqual(agent.working, ['k1'], 'the page can show the thread is being answered');

  const reply = await request('tools/call', { name: 'reply', arguments: { key: 'k1', text: 'A silent reprice would hide a bug.' } });
  assert.equal(reply.result.isError, undefined);

  const { comments: [thread] } = await readSavedComments(reviewsDir, repoPath);
  assert.equal(thread.followUps.length, 1);
  assert.equal(thread.followUps[0].by, 'claude');
  assert.equal(thread.followUps[0].session, SESSION);
  assert.equal(thread.followUps[0].text, 'A silent reprice would hide a bug.');

  // A reply from the reviewer in the thread is pushed too; the session's own is not.
  await updateSavedComments(reviewsDir, repoPath, state => ({
    comments: state.comments.map(c => ({ ...c, followUps: [...c.followUps, { key: 'f9', text: 'Even for a sale price?' }] }))
  }));
  const again = await next(isChannel);
  assert.match(again.params.content, /replied in a comment thread/);
  assert.match(again.params.content, /Reviewer: Even for a sale price\?/);
});

test('a reply to a key that does not exist fails out loud', async t => {
  const { request } = await startChannel(t);
  await request('initialize', { protocolVersion: '2025-11-25', capabilities: {} });

  const reply = await request('tools/call', { name: 'reply', arguments: { key: 'missing', text: 'hello' } });
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /No comment with key "missing"/);
});

test('threads already waiting when the session connects are pushed, and listed on request', async t => {
  const { request, notify, next, repoPath, reviewsDir } = await startChannel(t);
  await updateSavedComments(reviewsDir, repoPath, () => ({
    comments: [
      { key: 'k1', file: 'a.js', line: 1, text: 'waiting' },
      { key: 'k2', file: 'a.js', line: 2, text: 'answered', followUps: [{ key: 'f', text: 'yes', by: 'claude' }] }
    ]
  }));
  await request('initialize', { protocolVersion: '2025-11-25', capabilities: {} });
  notify('notifications/initialized');

  const pushed = await next(isChannel);
  assert.equal(pushed.params.meta.key, 'k1');

  const listed = await request('tools/call', { name: 'list_comments', arguments: {} });
  const threads = JSON.parse(listed.result.content[0].text);
  assert.deepEqual(threads.map(thread => thread.key), ['k1']);
  const all = JSON.parse((await request('tools/call', { name: 'list_comments', arguments: { all: true } })).result.content[0].text);
  assert.deepEqual(all.map(thread => [thread.key, thread.waiting]), [['k1', true], ['k2', false]]);
});

test('when Claude Code closes the pipe the channel exits and stops claiming to be connected', async t => {
  const { request, notify, child, exited, repoPath, reviewsDir } = await startChannel(t);
  await request('initialize', { protocolVersion: '2025-11-25', capabilities: {} });
  notify('notifications/initialized');
  // The presence file appears once the channel has announced itself, which on
  // a slow runner (Windows, Node 18) can take longer than any fixed pause.
  let agents = [];
  for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
    agents = await listAgents(reviewsDir, repoPath);
    if (agents.length) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(agents.length, 1);

  child.stdin.end();
  assert.equal(await exited, 0);
  assert.deepEqual(await listAgents(reviewsDir, repoPath), []);
});
