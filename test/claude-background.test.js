'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { BackgroundSession, questionFor } = require('../lib/claude-background');
const { Answerer } = require('../lib/answerer');
const { updateSavedComments, readSavedComments } = require('../lib/store');
const { announce } = require('../lib/presence');

const FAKE = path.join(__dirname, 'helpers', 'fake-claude');
const SESSION = '00000001-0000-4000-8000-000000000001';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reviewer-bg-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Run the fake in place of `claude`, with extra environment for it. */
function fakeSpawn(env = {}) {
  return (command, args, options) => spawn(process.execPath, [FAKE, ...args], { ...options, env: { ...process.env, ...env } });
}

const once = (emitter, event) => new Promise(resolve => emitter.once(event, resolve));
const until = async (check, ms = 10000) => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};

test('the session is resumed as a copy that can read and nothing more', () => {
  const session = new BackgroundSession({ sessionId: SESSION, cwd: '/work', name: 'Review answers: cart' });
  const args = session.args();

  assert.deepEqual(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2), ['--resume', SESSION]);
  assert.ok(args.includes('--fork-session'));
  assert.deepEqual(args.slice(args.indexOf('--name'), args.indexOf('--name') + 2), ['--name', 'Review answers: cart']);
  assert.ok(args.includes('--strict-mcp-config'), 'none of the user\'s MCP servers -- some of which can send mail');
  assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', 'Read,Grep,Glob']);
  assert.deepEqual(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2), ['--permission-mode', 'dontAsk']);

  assert.ok(!new BackgroundSession({ sessionId: SESSION, cwd: '/work', fork: false }).args().includes('--fork-session'));
});

test('questions are answered one at a time and each answer reaches its own thread', async t => {
  const session = new BackgroundSession({ sessionId: SESSION, cwd: os.tmpdir(), spawn: fakeSpawn() });
  t.after(() => session.stop());
  const answers = [];
  const partials = [];
  session.on('answer', answer => answers.push(answer));
  session.on('partial', partial => partials.push(partial));

  session.ask('k1', 'thread\nReviewer: first?');
  session.ask('k2', 'thread\nReviewer: second?');
  await until(() => answers.length === 2);

  assert.deepEqual(answers.map(a => [a.key, a.text]), [['k1', 'Answer 1 to "first?"'], ['k2', 'Answer 2 to "second?"']]);
  assert.notEqual(answers[0].session, SESSION, 'answered in the copy');
  assert.equal(session.answeringSession, answers[0].session);
  assert.ok(partials.some(p => p.key === 'k1' && p.text.startsWith('Answer 1')) && partials.length > 2, 'the words arrive before the answer does');
});

test('a session that dies mid-answer is restarted once, on the copy, with the same question', async t => {
  const dir = await tempDir(t);
  const argsFile = path.join(dir, 'args.jsonl');
  const session = new BackgroundSession({
    sessionId: SESSION, cwd: os.tmpdir(),
    spawn: fakeSpawn({ FAKE_CLAUDE_CRASH_ONCE: path.join(dir, 'crashed'), FAKE_CLAUDE_ARGS: argsFile })
  });
  t.after(() => session.stop());
  const answer = once(session, 'answer');

  session.ask('k1', 'thread\nReviewer: still there?');

  assert.equal((await answer).text, 'Answer 1 to "still there?"');
  const runs = (await fs.readFile(argsFile, 'utf-8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(runs.length, 2);
  assert.ok(runs[0].includes('--fork-session'));
  // It crashed before reporting a copy, so the retry forks again rather
  // than resuming a copy that was never made.
  assert.ok(runs[1].includes('--fork-session'));
});

test('an error result fails that question and leaves the next one to be asked', async t => {
  const session = new BackgroundSession({ sessionId: SESSION, cwd: os.tmpdir(), spawn: fakeSpawn({ FAKE_CLAUDE_FAIL: '1' }) });
  t.after(() => session.stop());
  const failed = once(session, 'failed');
  session.ask('k1', 'thread\nReviewer: ?');
  assert.deepEqual(await failed, { key: 'k1', message: 'fake failure' });
});

test('Claude Code missing from the PATH is said plainly', async t => {
  const session = new BackgroundSession({ sessionId: SESSION, cwd: os.tmpdir(), claude: 'no-such-claude-binary' });
  t.after(() => session.stop());
  const failed = once(session, 'failed');
  session.ask('k1', 'x');
  assert.match((await failed).message, /Could not run "no-such-claude-binary"/);
});

test('the question carries the thread and says how to answer', () => {
  const prompt = questionFor({ key: 'k1', file: 'src/a.js', line: 3, lineContent: 'x > y', text: 'Why?' });
  assert.match(prompt, /src\/a\.js, line 3/);
  assert.match(prompt, /Reviewer: Why\?/);
  assert.match(prompt, /Do not change any\s+files/);
});

test('an answerer puts every waiting thread to the session and writes each answer into it', async t => {
  const dir = await tempDir(t);
  const repo = '/work/shop';
  await updateSavedComments(dir, repo, () => ({
    comments: [
      { key: 'k1', file: 'a.js', line: 1, text: 'first?' },
      { key: 'k2', file: 'b.js', line: 2, text: 'answered already', followUps: [{ key: 'f0', text: 'yes', by: 'claude' }] }
    ]
  }));
  const session = new BackgroundSession({ sessionId: SESSION, cwd: os.tmpdir(), spawn: fakeSpawn() });
  const answerer = new Answerer({ reviewsDir: dir, repoPath: repo, session, claudeSession: { id: SESSION, title: 'Build the cart' } });
  t.after(() => answerer.stop());

  const answered = async key => {
    const { comments } = await readSavedComments(dir, repo);
    const thread = comments.find(c => c.key === key);
    return (thread.followUps ?? []).filter(f => f.by === 'claude');
  };
  await until(async () => (await answered('k1')).length === 1);

  const [reply] = await answered('k1');
  assert.equal(reply.text, 'Answer 1 to "first?"');
  assert.match(reply.session, /^[0-9a-f-]{36}$/);
  assert.equal((await answered('k2')).length, 1, 'a thread with an answer is not asked again');

  // The reviewer replies in the thread: the same session answers again.
  await updateSavedComments(dir, repo, state => ({
    comments: state.comments.map(c => (c.key === 'k1' ? { ...c, followUps: [...c.followUps, { key: 'f2', text: 'and then?' }] } : c))
  }));
  await until(async () => (await answered('k1')).length === 2);
  assert.equal((await answered('k1'))[1].text, 'Answer 2 to "and then?"');
});

test('an answerer leaves the threads to a session answering live', async t => {
  const dir = await tempDir(t);
  const repo = '/work/shop';
  const live = announce(dir, repo, { kind: 'channel', agent: 'claude', session: 'live' });
  await live.ready;
  t.after(() => live.close());
  await updateSavedComments(dir, repo, () => ({ comments: [{ key: 'k1', file: 'a.js', line: 1, text: 'first?' }] }));

  const asked = [];
  const session = Object.assign(new (require('events').EventEmitter)(), {
    fork: true, answeringSession: null, ask: key => asked.push(key), stop: async () => {}
  });
  const answerer = new Answerer({ reviewsDir: dir, repoPath: repo, session, claudeSession: { id: SESSION, title: null } });
  t.after(() => answerer.stop());
  await answerer.watcher.ready;
  await new Promise(resolve => setTimeout(resolve, 200));

  assert.deepEqual(asked, []);
});
