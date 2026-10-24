'use strict';

const { updateSavedComments, readSavedComments } = require('./store');
const { watchComments } = require('./watch');
const { announce } = require('./presence');
const { mintKey, isKey } = require('./comments');
const { awaitingAnswer, newReviewerMessages, appendReply, describeThread, lastAuthor } = require('./threads');

/**
 * `reviewer channel`: a Claude Code channel for one repository's review.
 *
 * Claude Code runs this as an MCP server over stdio, and with channels
 * enabled for it (`--dangerously-load-development-channels server:reviewer`
 * during the research preview) it may push messages into the running
 * session. Every comment the reviewer writes, and every reply they add in a
 * thread, is pushed as one; the session answers by calling `reply`, which
 * writes the answer into the thread, where the page shows it within a
 * second. The session is the one the reviewer chose -- `reviewer connect`
 * resumes the session that wrote the code -- so the answers come from the
 * agent that knows why it wrote what it wrote.
 *
 * The protocol is spoken directly: MCP is JSON-RPC 2.0, one message per line,
 * and this server needs four methods of it. The SDK would bring seventeen
 * dependencies and a second major of express into a package that has three
 * (#4).
 */

const PROTOCOL_VERSION = '2025-11-25';

// At most this many waiting threads are pushed one by one when the session
// connects; the rest are summarised, so connecting to an old review with
// fifty open threads does not bury the session.
const BACKLOG_ONE_BY_ONE = 8;

/** @param {string} repoPath */
function instructionsFor(repoPath) {
  return [
    `reviewer is a local code review tool. While this server is connected, every comment a reviewer leaves on`,
    `the changes in ${repoPath}, and every reply they add to a thread, arrives as a`,
    '<channel source="reviewer" key="..." file="..." line="..."> message holding the thread so far.',
    '',
    'Answer each one by calling the reply tool with its key. Your reply is shown under the reviewer\'s',
    'comment exactly as written: keep it short and direct; Markdown is fine. Answer from what you know about',
    'why the code is the way it is, and read files when you need to check. Do not change files because of a',
    'comment unless it explicitly asks you to make the change now; otherwise say what you would change. If',
    'several arrive together, answer each one separately. list_comments shows what is still waiting.'
  ].join('\n');
}

const TOOLS = [
  {
    name: 'reply',
    description: 'Post a reply in a review comment thread. The reviewer sees it under their comment straight away.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The key of the comment, from the channel message or list_comments' },
        text: { type: 'string', description: 'The reply, in Markdown' }
      },
      required: ['key', 'text']
    }
  },
  {
    name: 'list_comments',
    description: 'List the review\'s comment threads: by default only those whose last word is the reviewer\'s.',
    inputSchema: {
      type: 'object',
      properties: {
        all: { type: 'boolean', description: 'Include threads that already have an answer' }
      }
    }
  }
];

/**
 * A thread as the session is told about it.
 *
 * @param {import('./comments').Comment} comment
 * @param {boolean} followUp whether this is a new reply in a thread rather than a new comment
 */
function channelMessage(comment, followUp) {
  return {
    content: [
      followUp ? 'The reviewer replied in a comment thread:' : 'New review comment:',
      '',
      describeThread(comment),
      '',
      `Answer with the reply tool, key "${comment.key}".`
    ].join('\n'),
    meta: { key: comment.key, file: comment.file, line: String(comment.line) }
  };
}

/**
 * Run the channel until its input closes.
 *
 * @param {object} options
 * @param {string} options.repoPath repository whose review this serves
 * @param {string} options.reviewsDir
 * @param {NodeJS.ReadableStream} [options.input]
 * @param {NodeJS.WritableStream} [options.output]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.version]
 * @param {string|null} [options.title] what the connected session is about, for the page
 * @param {(line: string) => void} [options.log] diagnostics; stdout belongs to the protocol
 * @returns {Promise<void>} settles when the input ends
 */
function runChannel({
  repoPath,
  reviewsDir,
  input = process.stdin,
  output = process.stdout,
  env = process.env,
  version = '0.0.0',
  title = null,
  log = line => process.stderr.write(`reviewer channel: ${line}\n`)
}) {
  const session = env.CLAUDE_CODE_SESSION_ID || null;
  const send = message => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const notify = (method, params) => send({ method, params });

  /** @type {import('./comments').Comment[]|null} */
  let known = null;
  let watcher = null;
  let presence = null;
  const working = new Set();

  const setWorking = () => presence?.update({ working: [...working] });

  const push = (comment, followUp) => {
    notify('notifications/claude/channel', channelMessage(comment, followUp));
    working.add(comment.key);
  };

  const start = () => {
    if (watcher) return;
    presence = announce(reviewsDir, repoPath, { kind: 'channel', agent: 'claude', session, title });
    watcher = watchComments(reviewsDir, repoPath, state => {
      const comments = state.comments;
      if (known === null) {
        const waiting = awaitingAnswer(comments);
        waiting.slice(0, BACKLOG_ONE_BY_ONE).forEach(comment => push(comment, (comment.followUps ?? []).length > 0));
        if (waiting.length > BACKLOG_ONE_BY_ONE) {
          notify('notifications/claude/channel', {
            content: `${waiting.length - BACKLOG_ONE_BY_ONE} more comment threads in this review are waiting for an answer. ` +
              'Call list_comments to see them, and answer each with the reply tool.',
            meta: { waiting: String(waiting.length - BACKLOG_ONE_BY_ONE) }
          });
        }
      } else {
        for (const { comment, followUp } of newReviewerMessages(known, comments)) push(comment, followUp !== null);
      }
      // A thread answered from somewhere else is no longer this session's to answer.
      for (const key of working) {
        const thread = comments.find(comment => comment.key === key);
        if (!thread || lastAuthor(thread) !== null) working.delete(key);
      }
      known = comments;
      setWorking();
    }, { onError: error => log(`could not read the review: ${error.message}`) });
  };

  const tools = {
    async reply({ key, text } = {}) {
      if (!isKey(key)) return failure('key must be the key of a comment, from the channel message or list_comments.');
      if (typeof text !== 'string' || text.trim() === '') return failure('text must be the reply to post.');

      let found = false;
      await updateSavedComments(reviewsDir, repoPath, current => {
        const updated = appendReply(current.comments, key, {
          key: mintKey(),
          text: text.trim(),
          timestamp: new Date().toISOString(),
          by: 'claude',
          ...(session ? { session } : {})
        });
        found = updated !== null;
        return updated ? { comments: updated } : null;
      });

      // An unknown key fails out loud: a reply that silently went nowhere
      // would read, to the session, exactly like one the reviewer received.
      if (!found) return failure(`No comment with key "${key}" in this review. Call list_comments for the current ones.`);
      working.delete(key);
      setWorking();
      return success('Posted. The reviewer can see it under their comment now.');
    },

    async list_comments({ all = false } = {}) {
      const { comments } = await readSavedComments(reviewsDir, repoPath);
      const shown = all ? comments : awaitingAnswer(comments);
      const threads = shown.map(comment => ({
        key: comment.key,
        file: comment.file,
        line: comment.line,
        waiting: lastAuthor(comment) === null,
        thread: describeThread(comment)
      }));
      return success(threads.length === 0
        ? (all ? 'This review has no comments yet.' : 'Nothing is waiting for an answer.')
        : JSON.stringify(threads, null, 2));
    }
  };

  const handle = async message => {
    const { id, method, params } = message;
    const isRequest = id !== undefined && id !== null;

    switch (method) {
      case 'initialize':
        return send({
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
            serverInfo: { name: 'reviewer', title: 'reviewer', version },
            instructions: instructionsFor(repoPath)
          }
        });
      case 'notifications/initialized':
        return start();
      case 'ping':
        return send({ id, result: {} });
      case 'tools/list':
        return send({ id, result: { tools: TOOLS } });
      case 'tools/call': {
        const tool = tools[params?.name];
        if (!tool) return send({ id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } });
        try {
          return send({ id, result: await tool(params.arguments ?? {}) });
        } catch (error) {
          return send({ id, result: failure(error.message) });
        }
      }
      default:
        // Including `server/discover`, the 2026-07-28 revision's replacement
        // for `initialize`. Claude Code tries it first and, answered "method
        // not found", falls back to `initialize` -- the handshake channels
        // are documented against.
        if (isRequest) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
        return undefined;
    }
  };

  return new Promise(resolve => {
    let buffered = '';
    let pending = Promise.resolve();
    input.setEncoding?.('utf-8');
    input.on('data', chunk => {
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          send({ id: null, error: { code: -32700, message: 'Parse error' } });
          continue;
        }
        // In order: a reply must not overtake the list it was based on.
        pending = pending.then(() => handle(message)).catch(error => log(error.message));
      }
    });
    input.on('end', async () => {
      await pending;
      watcher?.close();
      await presence?.close();
      resolve();
    });
  });
}

/** @param {string} text */
function success(text) {
  return { content: [{ type: 'text', text }] };
}

/** @param {string} text */
function failure(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

module.exports = { runChannel, channelMessage, instructionsFor, TOOLS, PROTOCOL_VERSION };
