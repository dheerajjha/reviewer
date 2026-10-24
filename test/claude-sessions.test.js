'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  listClaudeSessions,
  findClaudeSession,
  projectDirName,
  promptText
} = require('../lib/claude-sessions');

/**
 * Transcripts here are written by the test, record by record, in the shape
 * Claude Code writes them. None is copied from a real session: real ones
 * carry the user's account details.
 */

const ID = n => `0000000${n}-0000-4000-8000-00000000000${n}`;

async function setup(t) {
  const base = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(base, 'reviewer-claude-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configDir = path.join(root, 'config');
  const repo = path.join(root, 'work', 'shop');
  await fs.mkdir(repo, { recursive: true });
  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  return { configDir, repo, root };
}

async function transcript(configDir, cwd, id, records, mtime) {
  const dir = path.join(configDir, 'projects', projectDirName(cwd));
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  await fs.writeFile(file, `${records.map(r => JSON.stringify({ sessionId: id, cwd, ...r })).join('\n')}\n`);
  if (mtime) await fs.utimes(file, mtime, mtime);
  return file;
}

const user = text => ({ type: 'user', message: { role: 'user', content: text }, gitBranch: 'main' });

test('the directory name is the path with everything but letters and digits as dashes', () => {
  assert.equal(projectDirName('/home/you/work/api'), '-home-you-work-api');
  assert.equal(projectDirName('/home/you/.config/my_app'), '-home-you--config-my-app');
});

test('sessions that ran in the repository or below it are listed, newest first', async t => {
  const { configDir, repo } = await setup(t);
  await transcript(configDir, repo, ID(1), [user('Build the cart')], new Date('2026-10-20T10:00:00Z'));
  await transcript(configDir, path.join(repo, 'src'), ID(2), [user('Fix the discount rounding')], new Date('2026-10-22T10:00:00Z'));

  const sessions = await listClaudeSessions(repo, { configDir });

  assert.deepEqual(sessions.map(s => [s.id, s.firstPrompt]), [
    [ID(2), 'Fix the discount rounding'],
    [ID(1), 'Build the cart']
  ]);
  assert.equal(sessions[1].branch, 'main');
  assert.equal(sessions[1].cwd, repo);
});

test('a neighbour whose name starts the same is not this repository', async t => {
  const { configDir, repo } = await setup(t);
  await transcript(configDir, `${repo}2`, ID(3), [user('Another project')]);
  await transcript(configDir, `${repo}-old`, ID(4), [user('An older copy')]);

  assert.deepEqual(await listClaudeSessions(repo, { configDir }), []);
});

test('a session goes by the name it was given last, else its summary, else its first prompt', async t => {
  const { configDir, repo } = await setup(t);
  await transcript(configDir, repo, ID(5), [
    user('Build the cart'),
    { type: 'custom-title', customTitle: 'cart v1' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    { type: 'custom-title', customTitle: 'cart, final' }
  ]);
  await transcript(configDir, repo, ID(6), [{ type: 'summary', summary: 'Discount codes' }, user('Add discount codes')]);

  const sessions = await listClaudeSessions(repo, { configDir });
  const byId = Object.fromEntries(sessions.map(s => [s.id, s]));

  assert.equal(byId[ID(5)].title, 'cart, final');
  assert.equal(byId[ID(6)].title, 'Discount codes');
  assert.equal(byId[ID(6)].firstPrompt, 'Add discount codes');
});

test('the first prompt skips tool results, meta messages and command wrappers', async t => {
  const { configDir, repo } = await setup(t);
  await transcript(configDir, repo, ID(7), [
    { type: 'user', isMeta: true, message: { content: 'Caveat: local commands below' } },
    { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'output' }] } },
    { type: 'user', message: { content: [{ type: 'text', text: '  Write the\n  checkout flow  ' }] } }
  ]);

  const [session] = await listClaudeSessions(repo, { configDir });
  assert.equal(session.firstPrompt, 'Write the checkout flow');
  assert.equal(promptText('<system-reminder>x</system-reminder>'), null);
  assert.equal(promptText('x'.repeat(300)).length, 240);
});

test('files that are not session transcripts are ignored', async t => {
  const { configDir, repo } = await setup(t);
  await transcript(configDir, repo, 'not-a-session', [user('hello')]);
  await transcript(configDir, repo, ID(8), [{ type: 'summary', summary: 'no cwd anywhere', cwd: undefined }]);

  assert.deepEqual(await listClaudeSessions(repo, { configDir }), []);
});

test('a session is found by id only when it worked in this repository', async t => {
  const { configDir, repo } = await setup(t);
  await transcript(configDir, repo, ID(1), [user('Build the cart')]);
  await transcript(configDir, `${repo}2`, ID(2), [user('Elsewhere')]);

  assert.equal((await findClaudeSession(repo, ID(1), { configDir })).id, ID(1));
  assert.equal(await findClaudeSession(repo, ID(2), { configDir }), null);
  assert.equal(await findClaudeSession(repo, '--dangerously-skip-permissions', { configDir }), null);
  assert.equal(await findClaudeSession(repo, ID(1).slice(0, 8), { configDir }), null);
});

test('no Claude Code config at all is an empty list, not an error', async t => {
  const { repo, root } = await setup(t);
  assert.deepEqual(await listClaudeSessions(repo, { configDir: path.join(root, 'missing') }), []);
});
