'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

const { createTempRepo, cleanup } = require('./helpers/repo');
const { updateSavedComments, readSavedComments } = require('../lib/store');
const { projectDirName } = require('../lib/claude-sessions');

/** `reviewer reply`, `watch` and `connect`, run as a person or an agent would run them. */

const BIN = path.join(__dirname, '..', 'bin', 'reviewer.js');
const FAKE = path.join(__dirname, 'helpers', 'fake-claude');
const SESSION = '00000004-0000-4000-8000-000000000004';

async function setup(t) {
  const base = await fs.realpath(os.tmpdir());
  const repoPath = await createTempRepo();
  const reviewsDir = await fs.mkdtemp(path.join(base, 'reviewer-cli-'));
  const configDir = await fs.mkdtemp(path.join(base, 'reviewer-cli-claude-'));
  t.after(async () => {
    await cleanup(repoPath);
    await fs.rm(reviewsDir, { recursive: true, force: true });
    await fs.rm(configDir, { recursive: true, force: true });
  });
  const env = { ...process.env, REVIEWER_DATA_DIR: reviewsDir, CLAUDE_CONFIG_DIR: configDir };
  delete env.CLAUDE_CODE_SESSION_ID;
  const run = (args, extra = {}) => new Promise(resolve => {
    execFile(process.execPath, [BIN, ...args], { env: { ...env, ...extra }, timeout: 20000 }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
  return { repoPath, reviewsDir, configDir, env, run };
}

test('reply posts in the thread as an agent, signed by Claude inside Claude Code', async t => {
  const { repoPath, reviewsDir, run } = await setup(t);
  await updateSavedComments(reviewsDir, repoPath, () => ({ comments: [{ key: 'k1', file: 'a.js', line: 4, text: 'why?' }] }));

  const plain = await run(['reply', 'k1', 'Because', 'of', 'the', 'spec.', '--repo', repoPath]);
  assert.equal(plain.code, 0);
  assert.match(plain.stderr, /Replied on a\.js:4 as agent/);
  assert.equal(plain.stdout, '');

  const inside = await run(['reply', 'k1', 'And the tests pin it.', '--repo', repoPath], { CLAUDE_CODE_SESSION_ID: SESSION });
  assert.equal(inside.code, 0);
  const named = await run(['reply', 'k1', 'Agreed.', '--repo', repoPath, '--as', 'codex']);
  assert.equal(named.code, 0);

  const { comments: [thread] } = await readSavedComments(reviewsDir, repoPath);
  assert.deepEqual(thread.followUps.map(f => [f.text, f.by, f.session ?? null]), [
    ['Because of the spec.', 'agent', null],
    ['And the tests pin it.', 'claude', SESSION],
    ['Agreed.', 'codex', null]
  ]);
});

test('a reply to a key that is not in the review fails with exit 1 and says where to look', async t => {
  const { repoPath, run } = await setup(t);
  const result = await run(['reply', 'nope', 'hello', '--repo', repoPath]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /no comment with key nope/);
  assert.doesNotMatch(result.stderr, /Usage:/, 'one line of error, not the whole help');
});

test('watch prints what is waiting, then each new comment, one JSON line each', async t => {
  const { repoPath, reviewsDir, env } = await setup(t);
  await updateSavedComments(reviewsDir, repoPath, () => ({ comments: [{ key: 'k1', file: 'a.js', line: 1, text: 'waiting' }] }));

  const child = spawn(process.execPath, [BIN, 'watch', repoPath], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.on('exit', resolve));
  t.after(async () => {
    child.kill();
    await exited;
  });
  const lines = [];
  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', chunk => lines.push(...chunk.split('\n').filter(Boolean).map(line => JSON.parse(line))));
  const until = async check => {
    const deadline = Date.now() + 10000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error('timed out');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };

  await until(() => lines.length === 1);
  assert.deepEqual({ ...lines[0], thread: undefined }, { key: 'k1', file: 'a.js', line: 1, text: 'waiting', thread: undefined });

  await updateSavedComments(reviewsDir, repoPath, state => ({
    comments: [...state.comments, { key: 'k2', file: 'b.js', line: 2, text: 'new one' }]
  }));
  await until(() => lines.length === 2);
  assert.equal(lines[1].key, 'k2');
  assert.match(lines[1].thread, /Reviewer: new one/);
});

async function fileSession(configDir, repoPath, title) {
  const dir = path.join(configDir, 'projects', projectDirName(repoPath));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${SESSION}.jsonl`), [
    { type: 'user', cwd: repoPath, sessionId: SESSION, message: { content: 'Build the cart' } },
    ...(title ? [{ type: 'custom-title', customTitle: title, sessionId: SESSION }] : [])
  ].map(r => JSON.stringify(r)).join('\n'));
}

test('connect --list shows the sessions that worked in the repository', async t => {
  const { repoPath, configDir, run } = await setup(t);
  assert.match((await run(['connect', repoPath, '--list'])).stderr, /No Claude Code session has worked/);

  await fileSession(configDir, repoPath, 'cart work');
  const listed = await run(['connect', repoPath, '--list']);
  assert.equal(listed.code, 0);
  assert.match(listed.stdout, new RegExp(`^${SESSION}  .*  cart work$`, 'm'));
});

/** File a session somewhere other than the repository, as Claude Code would. */
async function fileSessionIn(configDir, cwd, id, prompt, extra = []) {
  const dir = path.join(configDir, 'projects', projectDirName(cwd));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${id}.jsonl`), [
    { type: 'user', cwd, sessionId: id, message: { content: prompt } },
    ...extra.map(record => ({ cwd, sessionId: id, ...record }))
  ].map(r => JSON.stringify(r)).join('\n'));
}

test('connect --list includes a session started in a folder above that worked here, and --all lists every session', async t => {
  const { repoPath, configDir, run } = await setup(t);
  const elsewhere = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'reviewer-cli-elsewhere-')));
  t.after(() => fs.rm(elsewhere, { recursive: true, force: true }));
  const ABOVE = '00000007-0000-4000-8000-000000000007';
  const OTHER = '00000008-0000-4000-8000-000000000008';
  await fileSession(configDir, repoPath, 'cart work');
  await fileSessionIn(configDir, path.dirname(repoPath), ABOVE, 'Work across the checkouts', [
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: path.join(repoPath, 'a.js') } }] } }
  ]);
  await fileSessionIn(configDir, elsewhere, OTHER, 'Write the blog post');

  const listed = await run(['connect', repoPath, '--list']);
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, new RegExp(`^${SESSION}  .*  cart work$`, 'm'));
  assert.match(listed.stdout, new RegExp(`^${ABOVE}  .*  Work across the checkouts  \\[.*, a folder above this repository\\]$`, 'm'));
  assert.doesNotMatch(listed.stdout, new RegExp(OTHER));

  const all = await run(['connect', repoPath, '--list', '--all']);
  assert.equal(all.code, 0, all.stderr);
  assert.match(all.stdout, new RegExp(`^${SESSION}  .*  cart work  \\[this repository\\]$`, 'm'));
  assert.match(all.stdout, new RegExp(`^${OTHER}  .*  Write the blog post  \\[.*${path.basename(elsewhere)}\\]$`, 'm'));
});

test('connect --session takes a session from anywhere, and gives it the repository to read', { skip: process.platform === 'win32' && 'runs the fake claude as an executable' }, async t => {
  const { repoPath, configDir, run } = await setup(t);
  const elsewhere = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'reviewer-cli-elsewhere-')));
  t.after(() => fs.rm(elsewhere, { recursive: true, force: true }));
  const OTHER = '00000008-0000-4000-8000-000000000008';
  await fileSessionIn(configDir, elsewhere, OTHER, 'Plan the API');
  const argsFile = path.join(configDir, 'args.jsonl');

  const result = await run(['connect', repoPath, '--session', '00000008'], { REVIEWER_CLAUDE: FAKE, FAKE_CLAUDE_ARGS: argsFile });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, new RegExp(`Started in .*${path.basename(elsewhere)}`));

  const [args] = (await fs.readFile(argsFile, 'utf-8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(args.slice(0, 2), ['--resume', OTHER]);
  assert.equal(args[args.indexOf('--add-dir') + 1], repoPath);
  const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
  assert.deepEqual(config.mcpServers.reviewer.args.slice(-2), ['channel', repoPath], 'the channel is still this repository\'s');
});

test('connect resumes the session with reviewer attached as a development channel', { skip: process.platform === 'win32' && 'runs the fake claude as an executable' }, async t => {
  const { repoPath, configDir, run } = await setup(t);
  await fileSession(configDir, repoPath, 'cart work');
  const argsFile = path.join(configDir, 'args.jsonl');

  const result = await run(['connect', repoPath], { REVIEWER_CLAUDE: FAKE, FAKE_CLAUDE_ARGS: argsFile });
  assert.equal(result.code, 0, result.stderr);

  const [args] = (await fs.readFile(argsFile, 'utf-8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(args.slice(0, 2), ['--resume', SESSION]);
  assert.ok(!args.includes('--add-dir'), 'started in the repository, it can read it already');
  assert.deepEqual(args.slice(-2), ['--dangerously-load-development-channels', 'server:reviewer']);
  const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
  assert.deepEqual(config.mcpServers.reviewer.args.slice(-2), ['channel', repoPath]);
  assert.equal(config.mcpServers.reviewer.env.REVIEWER_SESSION_TITLE, 'cart work');

  const unknown = await run(['connect', repoPath, '--session', 'ffff'], { REVIEWER_CLAUDE: FAKE });
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /No Claude Code session ffff/);
});

test('Ctrl+C reaches Claude Code, not reviewer: connect waits for it and exits with its code', { skip: process.platform === 'win32' && 'POSIX signals' }, async t => {
  const { repoPath, configDir, env } = await setup(t);
  await fileSession(configDir, repoPath, null);
  // Stands in for Claude Code: ignores Ctrl+C, as an interactive session
  // does (it interrupts a turn), then finishes on its own.
  const fake = path.join(configDir, 'patient-claude');
  await fs.writeFile(fake, '#!/bin/sh\ntrap "" INT\nsleep 1\nexit 7\n');
  await fs.chmod(fake, 0o755);

  const child = spawn(process.execPath, [BIN, 'connect', repoPath], { env: { ...env, REVIEWER_CLAUDE: fake }, stdio: 'ignore' });
  await new Promise(resolve => setTimeout(resolve, 400));
  child.kill('SIGINT');
  const code = await new Promise(resolve => child.on('exit', resolve));

  assert.equal(code, 7, 'reviewer outlived the keypress and reported Claude Code\'s own exit');
});
