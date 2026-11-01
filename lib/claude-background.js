'use strict';

const { spawn: spawnProcess } = require('child_process');
const { EventEmitter } = require('events');

const { describeThread } = require('./threads');

/**
 * A Claude Code session, resumed in the background to answer review comments.
 *
 * The session that wrote the code is the one worth asking about it, so this
 * resumes it -- by default as a copy, `--fork-session`, so the original
 * transcript is left exactly as it was and can still be opened in a terminal
 * while reviewer is using the copy. One `claude -p` process is kept running
 * with stream-json on both ends: each question is a user message written to
 * its stdin, and the answer streams back on stdout as it is written, which is
 * what lets the page show it arriving instead of a spinner and then a wall of
 * text.
 *
 * The copy can read and nothing else. `--tools` limits it to Read, Grep and
 * Glob, `--strict-mcp-config` keeps every MCP server the user has configured
 * out of it -- including ones that can send mail -- and `dontAsk` turns
 * anything that would need permission into a refusal, since nobody is there
 * to answer a prompt. Answering a question about code needs nothing more, and
 * a background process holding someone's credentials should not be able to
 * do more.
 *
 * What it reads without asking is the folder the session started in, as it
 * did when it ran -- the repository, or for a session started above it, that
 * whole folder. One started in a folder inside the repository, or somewhere
 * else entirely, is also given the repository with `--add-dir`: a question
 * about code it cannot open would be answered from memory alone, or refused.
 */

const TOOLS = 'Read,Grep,Glob';

// Generous: a question can send the session reading through several files.
const ANSWER_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The message a thread is put to the session as.
 *
 * The instructions travel with every question rather than as a system
 * prompt, because Claude Code records a session's system prompt once and
 * reuses it on resume: anything appended at resume time would be dropped.
 *
 * @param {import('./comments').Comment} comment
 * @param {string|null} [repoPath] the repository under review
 * @returns {string}
 */
function questionFor(comment, repoPath = null) {
  return [
    // Named, because the session may have started somewhere else -- a folder
    // above the repository, say -- and the thread's paths are relative to it.
    `A reviewer is going through the changes you made in ${repoPath ? `the repository at ${repoPath}` : 'this repository'},`,
    'in reviewer (a local code review tool), and has left a comment on your code. Here is the thread; its',
    'file paths are relative to the repository:',
    '',
    describeThread(comment),
    '',
    'Reply to the reviewer\'s latest message. Your reply is posted under their comment exactly as you',
    'write it, so write only the reply: short, direct, Markdown is fine. Answer from what you know about',
    'why the code is the way it is, and read files if you need to check something. Do not change any',
    'files; if a change is warranted, say what you would change.'
  ].join('\n');
}

class BackgroundSession extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.sessionId Claude Code session to resume
   * @param {string} options.cwd the directory that session ran in
   * @param {boolean} [options.fork] answer in a copy of the session (the default) rather than in it
   * @param {string} [options.name] display name for the copy, shown in Claude Code's /resume
   * @param {string[]} [options.addDirs] directories it may read besides the one it ran in
   * @param {string} [options.claude] the Claude Code executable
   * @param {typeof spawnProcess} [options.spawn]
   * @param {number} [options.answerTimeoutMs]
   */
  constructor({ sessionId, cwd, fork = true, name = null, addDirs = [], claude = 'claude', spawn = spawnProcess, answerTimeoutMs = ANSWER_TIMEOUT_MS }) {
    super();
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.fork = fork;
    this.name = name;
    this.addDirs = addDirs;
    this.claude = claude;
    this.spawnProcess = spawn;
    this.answerTimeoutMs = answerTimeoutMs;

    /** The session answering: the copy's id once Claude Code reports it. */
    this.answeringSession = fork ? null : sessionId;
    /** @type {Array<{key: string, prompt: string}>} */
    this.queue = [];
    /** @type {{key: string, text: string, timer: NodeJS.Timeout, restarted: boolean}|null} */
    this.current = null;
    this.child = null;
    this.stopped = false;
    this.stderr = '';
  }

  /** The arguments `claude` is run with, so they can be shown and tested. */
  args() {
    const resume = this.answeringSession ?? this.sessionId;
    return [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--resume', resume,
      // Fork only the first time. Once the copy exists, a restart resumes
      // the copy, so the answers so far stay in one conversation.
      ...(this.fork && !this.answeringSession ? ['--fork-session'] : []),
      ...(this.name && this.fork && !this.answeringSession ? ['--name', this.name] : []),
      ...this.addDirs.flatMap(dir => ['--add-dir', dir]),
      '--strict-mcp-config',
      '--tools', TOOLS,
      '--permission-mode', 'dontAsk'
    ];
  }

  start() {
    if (this.child || this.stopped) return;
    this.stderr = '';
    let child;
    try {
      child = this.spawnProcess(this.claude, this.args(), {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
        windowsHide: true
      });
    } catch (error) {
      // Some failures are thrown rather than emitted -- on Windows, a .cmd
      // given without a shell is refused with EINVAL. Thrown from here, it
      // would escape through `ask` into whatever called it; reported on the
      // next tick it fails the same way an emitted one does.
      process.nextTick(() => this.failToStart(error));
      return;
    }
    this.child = child;

    let buffered = '';
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', chunk => {
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.trim()) this.onLine(line);
      }
    });
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', chunk => {
      // Kept for the error message if it exits; bounded, because a session
      // can be chatty on stderr and this lives as long as the review.
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    child.stdin.on('error', () => {}); // EPIPE when it has already gone; 'exit' reports why
    child.on('error', error => this.onExit(null, null, error));
    child.on('exit', (code, signal) => this.onExit(code, signal, null));
  }

  /** @param {string} line */
  onLine(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return; // not ours to understand
    }

    if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
      if (this.answeringSession !== event.session_id) {
        this.answeringSession = event.session_id;
        this.emit('session', { session: event.session_id, model: event.model ?? null });
      }
      return;
    }

    if (!this.current) return;

    if (event.type === 'stream_event') {
      const inner = event.event;
      if (inner?.type === 'message_start') {
        // A turn that reads a file first produces text, a tool call, then
        // more text. What is shown is the message being written now.
        this.current.text = '';
      } else if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
        this.current.text += inner.delta.text;
        this.emit('partial', { key: this.current.key, text: this.current.text });
      }
      return;
    }

    if (event.type === 'result') {
      const { key, timer } = this.current;
      clearTimeout(timer);
      this.current = null;
      const text = typeof event.result === 'string' ? event.result.trim() : '';
      if (event.is_error || event.subtype !== 'success' || text === '') {
        this.emit('failed', { key, message: text || `Claude Code could not answer (${event.subtype ?? 'error'}).` });
      } else {
        this.emit('answer', { key, text, session: event.session_id ?? this.answeringSession });
      }
      this.next();
    }
  }

  /** @param {Error & {code?: string}} error */
  describeSpawnError(error) {
    const where = process.platform === 'win32' ? ' (the full path of claude.exe)' : '';
    return ['ENOENT', 'EINVAL'].includes(error.code)
      ? `Could not run "${this.claude}": is Claude Code installed and on your PATH? Set REVIEWER_CLAUDE to its path otherwise${where}.`
      : `Could not run "${this.claude}": ${error.message}`;
  }

  /** It could not be started: everything waiting fails, once, with why. */
  failToStart(error) {
    const message = this.describeSpawnError(error);
    for (const { key } of this.queue.splice(0)) this.emit('failed', { key, message });
    this.emit('exit', { code: null, signal: null, stderr: '', message, fatal: true });
  }

  onExit(code, signal, error) {
    if (!this.child) return;
    this.child = null;
    const current = this.current;
    if (current) clearTimeout(current.timer);
    this.current = null;

    if (this.stopped) {
      this.emit('exit', { code, signal, stderr: this.stderr });
      return;
    }

    const message = error
      ? this.describeSpawnError(error)
      : (this.stderr.trim().split('\n').slice(-3).join('\n') || `Claude Code exited (${signal ?? `code ${code}`}).`);

    // A process that dies mid-answer gets one more go with the same
    // question; one that cannot even start reports why and stops trying.
    if (current && !current.restarted && !error) {
      this.queue.unshift({ key: current.key, prompt: current.prompt, restarted: true });
      this.start();
      this.next();
      return;
    }
    if (current) this.emit('failed', { key: current.key, message });
    // `fatal`: it could not be started at all, so asking again would only
    // fail the same way. Whoever owns this session should give up on it.
    if (error) {
      for (const { key } of this.queue.splice(0)) this.emit('failed', { key, message });
    }
    this.emit('exit', { code, signal, stderr: this.stderr, message, fatal: Boolean(error) });
  }

  /**
   * Put a thread to the session. Questions are answered one at a time, in
   * order: a turn's answer is matched to its question by being the next to
   * finish, so a second question is not written until the first is done.
   *
   * @param {string} key comment key the answer belongs to
   * @param {string} prompt
   */
  ask(key, prompt) {
    if (this.stopped) return;
    this.queue.push({ key, prompt, restarted: false });
    this.start();
    this.next();
  }

  next() {
    if (this.current || !this.child || this.queue.length === 0) return;
    const { key, prompt, restarted } = this.queue.shift();
    const timer = setTimeout(() => {
      // Nothing came back. Stop this process; the question fails, and the
      // next one starts a fresh process on the same conversation.
      if (this.current?.key !== key) return;
      this.current = null;
      this.emit('failed', { key, message: 'No answer after ten minutes; gave up on this one.' });
      this.child?.kill();
    }, this.answerTimeoutMs);
    timer.unref();
    this.current = { key, prompt, text: '', timer, restarted };
    this.emit('working', { key });
    this.child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`);
  }

  /** Whether it is answering something or has questions waiting. */
  get busy() {
    return Boolean(this.current) || this.queue.length > 0;
  }

  /** Keys of the threads being answered or waiting, in order. */
  get pending() {
    return [...(this.current ? [this.current.key] : []), ...this.queue.map(item => item.key)];
  }

  /**
   * Stop the process, now.
   *
   * Nothing it is in the middle of is wanted any more, and a turn can run
   * for minutes -- left to finish, it would outlive the reviewer that started
   * it. It is asked to stop straight away, and killed if it has not gone in
   * three seconds.
   *
   * @returns {Promise<void>}
   */
  stop() {
    this.stopped = true;
    this.queue = [];
    if (this.current) clearTimeout(this.current.timer);
    const child = this.child;
    if (!child) return Promise.resolve();
    return new Promise(resolve => {
      child.once('exit', () => resolve());
      child.stdin.end();
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
      // Never hold up a shutdown on a process that will not say it is gone.
      setTimeout(resolve, 5000).unref();
    });
  }
}

module.exports = { BackgroundSession, questionFor, TOOLS };
