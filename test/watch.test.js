'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { watchComments } = require('../lib/watch');
const { updateSavedComments } = require('../lib/store');
const { announce, listAgents, watchAgents, agentsDir } = require('../lib/presence');

const REPO = '/work/api';
const until = async (check, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reviewer-live-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('a watch hears the state at the start and every write after it, whoever wrote it', async t => {
  const dir = await tempDir(t);
  const seen = [];
  const watch = watchComments(dir, REPO, state => seen.push(state.comments.map(c => c.text)));
  t.after(() => watch.close());
  await watch.ready;
  assert.deepEqual(seen, [[]]);

  await updateSavedComments(dir, REPO, () => ({ comments: [{ key: 'k1', file: 'a.js', line: 1, text: 'first' }] }));
  await until(() => seen.length === 2);
  await updateSavedComments(dir, REPO, state => ({ comments: [...state.comments, { key: 'k2', file: 'a.js', line: 2, text: 'second' }] }));
  await until(() => seen.length === 3);

  assert.deepEqual(seen, [[], ['first'], ['first', 'second']]);
});

test('a closed watch hears nothing more', async t => {
  const dir = await tempDir(t);
  let calls = 0;
  const watch = watchComments(dir, REPO, () => { calls++; }, { pollMs: 50 });
  await watch.ready;
  watch.close();
  await updateSavedComments(dir, REPO, () => ({ comments: [{ key: 'k1', file: 'a.js', line: 1, text: 'x' }] }));
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(calls, 1);
});

test('an agent is listed while it is connected and gone once it closes', async t => {
  const dir = await tempDir(t);
  const presence = announce(dir, REPO, { kind: 'channel', agent: 'claude', session: 'sess-1', title: 'Build the cart' });
  await presence.ready;

  let [agent] = await listAgents(dir, REPO);
  assert.equal(agent.kind, 'channel');
  assert.equal(agent.session, 'sess-1');
  assert.deepEqual(agent.working, []);

  await presence.update({ working: ['k1'] });
  [agent] = await listAgents(dir, REPO);
  assert.deepEqual(agent.working, ['k1']);

  await presence.close();
  assert.deepEqual(await listAgents(dir, REPO), []);
});

test('an agent whose process died is dropped, and so is one that stopped beating', async t => {
  const dir = await tempDir(t);
  const folder = agentsDir(dir, REPO);
  await fs.mkdir(folder, { recursive: true });

  const child = spawn(process.execPath, ['-e', '']);
  await new Promise(resolve => child.on('exit', resolve));
  const now = new Date().toISOString();
  await fs.writeFile(path.join(folder, 'dead.json'), JSON.stringify({ id: 'dead', pid: child.pid, startedAt: now, heartbeatAt: now, working: [] }));
  await fs.writeFile(path.join(folder, 'quiet.json'), JSON.stringify({ id: 'quiet', pid: process.pid, startedAt: now, heartbeatAt: '2026-01-01T00:00:00.000Z', working: [] }));

  assert.deepEqual(await listAgents(dir, REPO), []);
  await assert.rejects(fs.stat(path.join(folder, 'dead.json')), { code: 'ENOENT' }, 'a dead process\'s file is cleaned up');
});

test('watching agents reports connects and disconnects', async t => {
  const dir = await tempDir(t);
  const reports = [];
  const watch = watchAgents(dir, REPO, agents => reports.push(agents.map(a => a.kind)), { pollMs: 50 });
  t.after(() => watch.close());
  await watch.ready;

  const presence = announce(dir, REPO, { kind: 'background', agent: 'claude', session: 's' });
  await presence.ready;
  await until(() => reports.length === 2);
  await presence.close();
  await until(() => reports.length === 3);

  assert.deepEqual(reports, [[], ['background'], []]);
});
