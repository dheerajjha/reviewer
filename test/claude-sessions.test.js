'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  findSessions,
  listClaudeSessions,
  findClaudeSession,
  sessionIdsStartingWith,
  homeRelative,
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
const read = file => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: file } }] } });

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

test('a session is found by id wherever it ran, and only by a whole id with a transcript', async t => {
  const { configDir, repo, root } = await setup(t);
  await transcript(configDir, repo, ID(1), [user('Build the cart')]);
  await transcript(configDir, path.join(root, 'notes'), ID(2), [user('Elsewhere')]);

  assert.equal((await findClaudeSession(ID(1), { configDir })).id, ID(1));
  assert.equal((await findClaudeSession(ID(2), { configDir })).cwd, path.join(root, 'notes'));
  assert.equal((await findClaudeSession(ID(2).toUpperCase(), { configDir })).id, ID(2));
  assert.equal(await findClaudeSession(ID(3), { configDir }), null);
  assert.equal(await findClaudeSession('--dangerously-skip-permissions', { configDir }), null);
  assert.equal(await findClaudeSession(ID(1).slice(0, 8), { configDir }), null);
  assert.equal(await findClaudeSession(`../${ID(1)}`, { configDir }), null);
});

test('ids are matched by their start across every folder', async t => {
  const { configDir, repo, root } = await setup(t);
  await transcript(configDir, repo, ID(1), [user('Build the cart')]);
  await transcript(configDir, path.join(root, 'notes'), ID(2), [user('Elsewhere')]);

  assert.deepEqual(await sessionIdsStartingWith('00000002', { configDir }), [ID(2)]);
  assert.deepEqual((await sessionIdsStartingWith('0000000', { configDir })).sort(), [ID(1), ID(2)]);
  assert.deepEqual(await sessionIdsStartingWith('', { configDir }), []);
});

test('a session started in a folder above the repository is listed once it is seen working inside', async t => {
  const { configDir, repo, root } = await setup(t);
  const work = path.dirname(repo);
  // Moved into the repository: Claude Code records the new working directory.
  await transcript(configDir, work, ID(1), [user('Tidy up the workspace'), { type: 'user', cwd: repo, message: { content: 'now the shop' } }],
    new Date('2026-10-23T10:00:00Z'));
  // Never moved, but read a file inside it.
  await transcript(configDir, root, ID(2), [user('Compare the two shops'), read(path.join(repo, 'src', 'cart.js'))],
    new Date('2026-10-22T10:00:00Z'));
  // Above it, and never anywhere near it.
  await transcript(configDir, work, ID(3), [user('Unrelated chores'), read(path.join(work, 'notes.md'))]);
  // Read a neighbour whose name starts the same: not inside.
  await transcript(configDir, work, ID(4), [user('The other shop'), read(`${repo}-old/cart.js`)]);

  const sessions = await listClaudeSessions(repo, { configDir });

  assert.deepEqual(sessions.map(s => [s.id, s.relation, s.above]), [[ID(1), 'parent', 1], [ID(2), 'parent', 2]]);
  assert.equal(sessions[0].cwd, work, 'it is still resumed from where it started');
});

test('where a session started is said against the repository, and shown under ~ when under home', async t => {
  const { configDir, repo, root } = await setup(t);
  await transcript(configDir, repo, ID(1), [user('At the root')]);
  await transcript(configDir, path.join(repo, 'src'), ID(2), [user('In a folder inside')]);
  await transcript(configDir, path.dirname(repo), ID(3), [user('Above'), read(path.join(repo, 'a.js'))]);

  const { sessions } = await findSessions({ repoPath: repo, configDir, home: root });
  const byId = Object.fromEntries(sessions.map(s => [s.id, s]));

  assert.deepEqual([byId[ID(1)].relation, byId[ID(1)].place], ['repo', null]);
  assert.deepEqual([byId[ID(2)].relation, byId[ID(2)].place], ['subfolder', 'src/']);
  assert.deepEqual([byId[ID(3)].relation, byId[ID(3)].place, byId[ID(3)].above], ['parent', '~/work', 1]);

  assert.equal(homeRelative(root, root), '~');
  assert.equal(homeRelative(path.join(root, 'a', 'b'), root), '~/a/b');
  assert.equal(homeRelative('/elsewhere/x', root), path.resolve('/elsewhere/x'));
});

test('all sessions are every session on the machine, each said how it stands to the repository', async t => {
  const { configDir, repo, root } = await setup(t);
  await transcript(configDir, repo, ID(1), [user('Build the cart')], new Date('2026-10-20T10:00:00Z'));
  await transcript(configDir, path.dirname(repo), ID(2), [user('Workspace chores')], new Date('2026-10-21T10:00:00Z'));
  await transcript(configDir, path.join(root, 'blog'), ID(3), [user('Write a post')], new Date('2026-10-22T10:00:00Z'));

  assert.deepEqual((await findSessions({ repoPath: repo, configDir })).sessions.map(s => s.id), [ID(1)],
    'a folder above that never worked here is not this repository\'s');

  const { sessions, more } = await findSessions({ repoPath: repo, configDir, scope: 'all', home: root });
  assert.deepEqual(sessions.map(s => [s.id, s.relation, s.place]), [
    [ID(3), 'other', '~/blog'],
    [ID(2), 'parent', '~/work'],
    [ID(1), 'repo', null]
  ]);
  assert.equal(more, false);
});

test('a search needs every word, found in the name, the first prompt, the folder, the branch or the id', async t => {
  const { configDir, repo, root } = await setup(t);
  await transcript(configDir, path.join(root, 'blog'), ID(1), [user('Write a post about carts')]);
  await transcript(configDir, path.join(root, 'api'), ID(2), [{ ...user('Fix the login'), gitBranch: 'auth-rework' }]);
  await transcript(configDir, repo, ID(3), [user('Build the cart'), { type: 'custom-title', customTitle: 'Checkout' }]);

  const search = async query => (await findSessions({ repoPath: repo, configDir, scope: 'all', query, home: root })).sessions.map(s => s.id).sort();
  assert.deepEqual(await search('cart'), [ID(1), ID(3)]);
  assert.deepEqual(await search('POST carts'), [ID(1)]);
  assert.deepEqual(await search('checkout'), [ID(3)]);
  assert.deepEqual(await search('auth-rework'), [ID(2)]);
  assert.deepEqual(await search('blog'), [ID(1)]);
  assert.deepEqual(await search('shop'), [ID(3)], 'the repository\'s own folder, though its sessions show none');
  assert.deepEqual(await search(path.basename(root)), [], 'not the path to the home directory, which every one has');
  assert.deepEqual(await search('00000002'), [ID(2)]);
  assert.deepEqual(await search('cart login'), []);
  assert.deepEqual(await search('  '), [ID(1), ID(2), ID(3)]);
});

test('sessions come a page at a time, and a page says whether another follows', async t => {
  const { configDir, repo } = await setup(t);
  for (let n = 1; n <= 5; n += 1) {
    await transcript(configDir, repo, ID(n), [user(`Task ${n}`)], new Date(Date.UTC(2026, 9, 20 + n)));
  }

  const first = await findSessions({ repoPath: repo, configDir, limit: 2 });
  const second = await findSessions({ repoPath: repo, configDir, limit: 2, offset: 2 });
  const last = await findSessions({ repoPath: repo, configDir, limit: 2, offset: 4 });

  assert.deepEqual([first.sessions.map(s => s.id), first.more], [[ID(5), ID(4)], true]);
  assert.deepEqual([second.sessions.map(s => s.id), second.more], [[ID(3), ID(2)], true]);
  assert.deepEqual([last.sessions.map(s => s.id), last.more], [[ID(1)], false]);
});

test('a transcript that has changed since it was read is read again', async t => {
  const { configDir, repo } = await setup(t);
  const file = await transcript(configDir, repo, ID(1), [user('Build the cart')]);
  assert.equal((await listClaudeSessions(repo, { configDir }))[0].title, null);

  await fs.appendFile(file, `${JSON.stringify({ type: 'custom-title', customTitle: 'cart, renamed', sessionId: ID(1) })}\n`);
  assert.equal((await listClaudeSessions(repo, { configDir }))[0].title, 'cart, renamed');
});

test('no Claude Code config at all is an empty list, not an error', async t => {
  const { repo, root } = await setup(t);
  assert.deepEqual(await listClaudeSessions(repo, { configDir: path.join(root, 'missing') }), []);
});

test('a session filed under two folders is listed once, by its most recent transcript', async t => {
  const { configDir, repo } = await setup(t);
  await transcript(configDir, repo, ID(1), [user('Build the cart')], new Date('2026-10-20T10:00:00Z'));
  await transcript(configDir, path.join(repo, 'src'), ID(1), [user('Build the cart'), { type: 'custom-title', customTitle: 'cart, later' }],
    new Date('2026-10-21T10:00:00Z'));

  const sessions = await listClaudeSessions(repo, { configDir });
  assert.deepEqual(sessions.map(s => [s.id, s.title]), [[ID(1), 'cart, later']]);
});
