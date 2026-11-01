#!/usr/bin/env node
'use strict';

const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');

const { parseArgs, buildUrl, UsageError, usage, invokedAs } = require('../lib/cli');
const { homeRelative } = require('../lib/paths');
const { openInBrowser } = require('../lib/browser');
const { formatPrompt } = require('../lib/agent');
const { ReviewOwnershipError } = require('../lib/store');
const { reviewsDir, adoptLegacyReviews } = require('../lib/paths');
const { repoRoot, resolvesToCommit } = require('../lib/repo');
const {
  loadReviewDocument,
  NoReviewError,
  NoMatchingCommentsError
} = require('../lib/export');
const { startServer, DEFAULT_PORT, DEFAULT_HOST } = require('../server');
const { version } = require('../package.json');
const { updateSavedComments } = require('../lib/store');
const { watchComments } = require('../lib/watch');
const { announce } = require('../lib/presence');
const { mintKey } = require('../lib/comments');
const { appendReply, awaitingAnswer, newReviewerMessages, describeThread, lastAuthor } = require('../lib/threads');
const {
  findSessions, listClaudeSessions, findClaudeSession, sessionIdsStartingWith, relateToRepository, readsRepository
} = require('../lib/claude-sessions');
const { runChannel } = require('../lib/channel');
const { resolveClaudeCommand } = require('../lib/claude-command');

// What to call this command when it talks about itself: whatever the person
// typed, so a hint can be pasted back as-is. See invokedAs in lib/cli.js.
const NAME = invokedAs(process.env, process.argv[1]);

/** An expected export failure that needs no usage text. */
/**
 * A comparison or commit named on the command line that the repository
 * cannot open. Said in one line, like ExportError: usage text would bury it.
 */
class ScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScopeError';
  }
}

/**
 * Check that every end of a --range, --base, --commit or --last-commit names
 * a commit, before the server starts. The server would refuse a bad one too,
 * but its error would land on a page that has only just opened, while the
 * person who typed the ref is still looking at the terminal.
 *
 * @param {string|null} repoPath the repository about to be opened
 * @param {{flag: string, base?: string, head?: string, commit?: string}} scope
 */
async function checkScope(repoPath, scope) {
  const root = repoPath ? await repoRoot(repoPath) : null;
  if (!root) {
    throw new ScopeError(`${scope.flag} needs a git repository, and ${repoPath ?? process.cwd()} is not inside one.`);
  }
  if (scope.flag === '--last-commit') {
    if (!(await resolvesToCommit(root, 'HEAD'))) throw new ScopeError(`--last-commit: ${root} has no commits yet.`);
    return;
  }
  const ends = scope.commit !== undefined
    ? [['', scope.commit]]
    : [['the base ', scope.base], ['the head ', scope.head]];
  for (const [which, ref] of ends) {
    if (!(await resolvesToCommit(root, ref))) {
      throw new ScopeError(`${scope.flag}: ${which}"${ref}" is not a commit in ${root}.`);
    }
  }
}

class ExportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExportError';
  }
}

/**
 * The `reviewer` command: start the local server and open it in a browser.
 */

/**
 * Everything this command says to the person running it.
 *
 * stderr, not stdout, and that is the whole design. stdout carries the
 * finished review so it can be piped into a coding agent; a banner or a
 * progress line written there lands in the middle of it. Both streams go to
 * the same terminal when nothing is piping, so this is invisible until it
 * matters.
 *
 * @param {string} [line]
 */
function note(line = '') {
  process.stderr.write(`${line}\n`);
}

/**
 * Listen on `port`, falling back to any free port if it is taken.
 *
 * Someone reviewing two repositories at once should get a second window, not
 * an EADDRINUSE stack trace.
 *
 * @param {number} port
 * @param {object} [options] passed through to the server
 * @returns {Promise<import('http').Server>}
 */
async function listen(port, options = {}) {
  try {
    return await startServer({ ...options, port, host: DEFAULT_HOST, silent: true });
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;

    note(`Port ${port} is in use, picking another.`);
    return startServer({ ...options, port: 0, host: DEFAULT_HOST, silent: true });
  }
}

/**
 * Print the saved review of a repository to stdout.
 *
 * Reads the same JSON the UI writes on every edit, so a review can be handed
 * to another tool without submitting it or keeping the server running.
 *
 * @param {import('../lib/cli').CliOptions} options
 */
async function exportReview(options) {
  // Saved reviews are filed under the repository root, so exporting from a
  // subdirectory has to look there too — otherwise the browser saves a review
  // one directory up and this reports that none exists. Falling back to the
  // path as given keeps the case `lib/export.js` deliberately supports: a
  // review whose repository is no longer a repository is still exportable.
  const given = options.repoPath ?? process.cwd();
  const repoPath = (await repoRoot(given)) ?? given;
  const dataDir = reviewsDir();

  let document;
  try {
    document = await loadReviewDocument(dataDir, repoPath, { file: options.file });
  } catch (error) {
    // `lib/export` raises domain errors so that an MCP tool or an agent
    // handover can answer them its own way. These failures need a short
    // explanation in the terminal; usage text would bury that explanation.
    if (
      error instanceof NoReviewError ||
      error instanceof NoMatchingCommentsError ||
      error instanceof ReviewOwnershipError
    ) {
      if (error instanceof NoReviewError) {
        if (repoPath === given && !(await repoRoot(given))) {
          throw new ExportError(`${given} is not inside a git repository, and no review is saved for it in ${dataDir}.`);
        }
        throw new ExportError(`No saved review for ${repoPath} in ${dataDir}. Review it first, then export.`);
      }
      throw new ExportError(error.message);
    }
    throw error;
  }

  process.stdout.write(
    options.format === 'prompt'
      ? formatPrompt(document)
      : `${JSON.stringify(document, null, 2)}\n`
  );
}

/**
 * The root of the repository a command is about, or a usage error.
 *
 * @param {string|null} given the repository named on the command line
 * @returns {Promise<string>}
 */
async function requireRepository(given) {
  const target = given ?? process.cwd();
  const root = await repoRoot(target);
  if (!root) throw new UsageError(`${target} is not inside a git repository.`);
  return root;
}

/** How a session is shown in a list: its name, or what it was first asked. */
function sessionLabel(session) {
  return session.title ?? session.firstPrompt ?? '(no prompt)';
}

/**
 * Where a session started, against the repository, for a list: nothing at
 * the root unless every session is listed, where it marks this repository's.
 *
 * @param {import('../lib/claude-sessions').RelatedSession} session
 * @param {boolean} [all]
 */
function sessionPlace(session, all = false) {
  switch (session.relation) {
    case 'repo': return all ? 'this repository' : null;
    case 'subfolder': return `in ${session.place}`;
    case 'parent': return `${session.place}, ${session.above === 1 ? 'a folder' : `${session.above} folders`} above this repository`;
    default: return session.place;
  }
}

/**
 * The session `--session` names: by the start of its id, this repository's
 * first, then any session, wherever it ran.
 *
 * @param {string} repoPath
 * @param {string} prefix
 */
async function sessionNamed(repoPath, prefix) {
  const ambiguous = n => new UsageError(`${prefix} matches ${n} sessions; give more of the id.`);
  const mine = (await listClaudeSessions(repoPath, { limit: Infinity })).filter(session => session.id.startsWith(prefix));
  if (mine.length > 1) throw ambiguous(mine.length);
  if (mine.length === 1) return mine[0];

  const ids = await sessionIdsStartingWith(prefix);
  if (ids.length > 1) throw ambiguous(ids.length);
  const found = ids.length === 1 ? await findClaudeSession(ids[0]) : null;
  if (!found) {
    throw new UsageError(`No Claude Code session ${prefix} was found. ${NAME} connect --list --all shows every session.`);
  }
  return { ...found, ...relateToRepository(found, repoPath) };
}

/**
 * `reviewer connect`: open the Claude Code session that worked here, with
 * reviewer attached as a channel.
 *
 * Every comment the reviewer writes then arrives in that session as it is
 * written, and the session answers in the thread with the `reply` tool. This
 * is the session in a terminal, live: the person can watch it work and step
 * in. During the channels research preview Claude Code asks once, at
 * startup, to confirm a development channel; that is expected.
 *
 * @param {import('../lib/cli').CliOptions} options
 */
async function connectCommand(options) {
  const repoPath = await requireRepository(options.repoPath);

  if (options.list) {
    const sessions = options.all
      ? (await findSessions({ repoPath, scope: 'all', limit: Infinity })).sessions
      : await listClaudeSessions(repoPath, { limit: 50 });
    if (sessions.length === 0) {
      note(options.all
        ? 'Claude Code has no sessions on this machine yet.'
        : `No Claude Code session has worked in ${repoPath} yet. ${NAME} connect --list --all shows every session.`);
      return;
    }
    for (const session of sessions) {
      const place = sessionPlace(session, options.all);
      process.stdout.write(`${session.id}  ${session.updatedAt.slice(0, 16).replace('T', ' ')}  ${sessionLabel(session)}${place ? `  [${place}]` : ''}\n`);
    }
    return;
  }

  let chosen = null;
  if (options.session) {
    chosen = await sessionNamed(repoPath, options.session);
  } else {
    // The most recent session that is not one of reviewer's own copies:
    // asking a copy made to answer an earlier review is asking second-hand.
    const sessions = await listClaudeSessions(repoPath, { limit: 50 });
    chosen = sessions.find(session => !session.title?.startsWith('Review answers:')) ?? sessions[0] ?? null;
  }

  const title = chosen ? sessionLabel(chosen) : null;
  const mcpConfig = {
    mcpServers: {
      reviewer: {
        command: process.execPath,
        args: [path.resolve(__filename), 'channel', repoPath],
        ...(title ? { env: { REVIEWER_SESSION_TITLE: title } } : {})
      }
    }
  };
  const args = [
    ...(chosen ? ['--resume', chosen.id] : []),
    ...(chosen && options.fork ? ['--fork-session'] : []),
    // Started inside the repository or away from it, the session is given it
    // to read; it would otherwise have to ask for every file.
    ...(chosen && !readsRepository(chosen.relation) ? ['--add-dir', repoPath] : []),
    '--mcp-config', JSON.stringify(mcpConfig),
    '--dangerously-load-development-channels', 'server:reviewer'
  ];

  const place = chosen ? sessionPlace(chosen) : null;
  note(chosen
    ? `\n  Resuming Claude Code session ${chosen.id}${options.fork ? ' as a copy' : ''}\n  ${title}\n${place ? `  Started ${chosen.relation === 'subfolder' ? place : `in ${place}`}\n` : ''}`
    : `\n  No Claude Code session has worked in ${repoPath} yet; starting a new one.\n`);
  note('  Claude Code will ask you to confirm the reviewer channel (it is a research preview).');
  note(`  Then every comment you write in reviewer arrives here, and the answers appear under them.\n`);

  const claude = process.env.REVIEWER_CLAUDE || 'claude';
  // A session whose directory has since been removed is resumed from the
  // repository root rather than failing to spawn at all.
  const cwd = chosen ? await fs.access(chosen.cwd).then(() => chosen.cwd, () => repoPath) : repoPath;
  const child = spawn(resolveClaudeCommand(claude), args, { cwd, stdio: 'inherit' });

  // Ctrl+C belongs to Claude Code while it runs -- it interrupts a turn, it
  // does not quit -- and the terminal delivers it to both processes. This one
  // only waits, so it must not die of the same keypress and leave Claude Code
  // running on a terminal the shell has already taken back. A request to
  // stop that comes from outside is passed on instead.
  const ignore = () => {};
  const forward = signal => child.kill(signal);
  process.on('SIGINT', ignore);
  process.on('SIGQUIT', ignore);
  process.on('SIGTERM', forward);
  process.on('SIGHUP', forward);
  try {
    await new Promise((resolve, reject) => {
      child.on('error', error => reject(['ENOENT', 'EINVAL'].includes(error.code)
        ? new Error(`Could not run "${claude}". Is Claude Code installed and on your PATH? Set REVIEWER_CLAUDE to its path otherwise` +
          `${process.platform === 'win32' ? ' (the full path of claude.exe)' : ''}.`)
        : error));
      child.on('exit', (code, signal) => {
        process.exitCode = code ?? (signal ? 1 : 0);
        resolve();
      });
    });
  } finally {
    process.off('SIGINT', ignore);
    process.off('SIGQUIT', ignore);
    process.off('SIGTERM', forward);
    process.off('SIGHUP', forward);
  }
}

/**
 * `reviewer channel`: the MCP server `connect` asks Claude Code to run.
 *
 * @param {import('../lib/cli').CliOptions} options
 */
async function channelCommand(options) {
  const repoPath = await requireRepository(options.repoPath);
  await runChannel({
    repoPath,
    reviewsDir: reviewsDir(),
    version,
    title: process.env.REVIEWER_SESSION_TITLE || null
  });
}

/**
 * `reviewer reply <key> <text>`: answer in a thread from the command line.
 *
 * For an agent following a review with `reviewer watch`, and anything else
 * that can run a command. Inside Claude Code the reply is signed `claude`
 * and carries the session's id; elsewhere it is from `agent` unless `--as`
 * says who.
 *
 * @param {import('../lib/cli').CliOptions} options
 */
async function replyCommand(options) {
  const repoPath = await requireRepository(options.repoPath);
  if (options.textFromStdin) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    options.text = Buffer.concat(chunks).toString('utf-8').trim();
    if (options.text === '') throw new UsageError('reply - read nothing from stdin');
  }
  const session = process.env.CLAUDE_CODE_SESSION_ID || null;
  const by = options.as ?? (session ? 'claude' : 'agent');

  let thread = null;
  await updateSavedComments(reviewsDir(), repoPath, current => {
    thread = current.comments.find(comment => comment.key === options.key) ?? null;
    if (!thread) return null;
    return {
      comments: appendReply(current.comments, options.key, {
        key: mintKey(),
        text: options.text,
        timestamp: new Date().toISOString(),
        by,
        ...(session ? { session } : {})
      })
    };
  });

  // Loudly: a reply that went nowhere and exited 0 would look, to whatever
  // ran it, exactly like one the reviewer can read.
  if (!thread) {
    console.error(`error: no comment with key ${options.key} in the review of ${repoPath}.`);
    console.error(`  ${NAME} export ${homeRelative(repoPath)} lists the comments and their keys.`);
    process.exitCode = 1;
    return;
  }
  note(`Replied on ${thread.file}:${thread.line} as ${by}.`);
}

/**
 * `reviewer watch`: one JSON line per thing the reviewer says, as they say it.
 *
 * Threads already waiting for an answer come first, then each new comment
 * and each reply the reviewer adds in a thread. Made for an agent that can
 * follow a command's output -- Claude Code's Monitor tool turns each line
 * into a message -- and answer with `reviewer reply`.
 *
 * @param {import('../lib/cli').CliOptions} options
 */
async function watchCommand(options) {
  const repoPath = await requireRepository(options.repoPath);
  const dir = reviewsDir();
  const session = process.env.CLAUDE_CODE_SESSION_ID || null;
  const presence = announce(dir, repoPath, { kind: 'watch', agent: session ? 'claude' : 'agent', session, title: null });
  const working = new Set();

  const emit = comment => {
    const followUps = (comment.followUps ?? []).filter(followUp => !followUp.by);
    const latest = followUps.length > 0 ? followUps[followUps.length - 1].text : comment.text;
    process.stdout.write(`${JSON.stringify({
      key: comment.key,
      file: comment.file,
      line: comment.line,
      text: latest,
      thread: describeThread(comment)
    })}\n`);
    working.add(comment.key);
  };

  let known = null;
  const watcher = watchComments(dir, repoPath, state => {
    if (known === null) {
      awaitingAnswer(state.comments).forEach(emit);
    } else {
      for (const { comment } of newReviewerMessages(known, state.comments)) emit(comment);
    }
    for (const key of working) {
      const thread = state.comments.find(comment => comment.key === key);
      if (!thread || lastAuthor(thread) !== null) working.delete(key);
    }
    presence.update({ working: [...working] });
    known = state.comments;
  });

  note(`Watching the review of ${repoPath}. Reply with: ${NAME} reply <key> "<text>"`);

  await new Promise(resolve => {
    const finish = () => resolve();
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
    process.stdout.on('error', finish); // whatever was reading has gone
  });
  watcher.close();
  await presence.close();
}

/**
 * Which repository the page should open.
 *
 * `reviewer` with no argument reviews the repository you are standing in.
 * `--help` has promised that since the first release and the code never did
 * it, so the page opened on an empty path box instead.
 *
 * Naming a directory and defaulting to one are answered differently on
 * purpose. Name one, and you are told when it is not a repository, because
 * you asked about it. Nobody asked for the current directory in particular —
 * so when that is not inside a repository the page opens on its picker
 * exactly as it always has, rather than greeting you with an error.
 *
 * @param {string|null} given the repository named on the command line
 * @returns {Promise<string|null>} repository to open, or null for the picker
 */
async function repositoryToOpen(given) {
  if (given) return (await repoRoot(given)) ?? given;
  return repoRoot(process.cwd());
}

async function main() {
  // Whoever was reading has stopped -- `reviewer connect --list --all | head`,
  // say, once it has its ten lines. Node reports that as an EPIPE error on
  // the next write, which crashed with a stack trace; there is simply nobody
  // left to tell anything, which is not a failure.
  process.stdout.on('error', error => {
    if (error.code === 'EPIPE') process.exit(0);
    throw error;
  });

  const options = parseArgs(process.argv.slice(2));

  // Reviews written by a version that kept them inside the package directory
  // are moved out before anything reads them. Once, synchronously, so no read
  // can start against a half-populated directory. See #33.
  const adopted = adoptLegacyReviews();
  if (adopted > 0) {
    note(
      `  Copied ${adopted} saved review${adopted === 1 ? '' : 's'} out of the ` +
        `install directory to\n  ${reviewsDir()}\n  so that upgrading or ` +
        'reinstalling this package can no longer delete them.\n' +
        '  The originals are left where they were.'
    );
  }

  if (options.help) {
    process.stdout.write(usage(NAME));
    return;
  }

  if (options.version) {
    console.log(version);
    return;
  }

  if (options.repoPath) {
    try {
      await fs.access(options.repoPath);
    } catch {
      throw new UsageError(`No such directory: ${options.repoPath}`);
    }
  }

  if (options.command === 'export') {
    return exportReview(options);
  }
  if (options.command === 'connect') return connectCommand(options);
  if (options.command === 'channel') return channelCommand(options);
  if (options.command === 'reply') return replyCommand(options);
  if (options.command === 'watch') return watchCommand(options);

  const repoPath = await repositoryToOpen(options.repoPath);
  if (options.scope) await checkScope(repoPath, options.scope);

  // Is anything reading our stdout? If so, the review goes there when it is
  // submitted and the command finishes -- which is what turns the whole loop
  // into one line:
  //
  //     reviewer | claude -p "Apply this review."
  //
  // On a terminal there is nothing waiting, so submitting is not the end of
  // anything: you may have more to review. It says where the review went and
  // what to run next, and keeps serving.
  const handingOff = !process.stdout.isTTY;

  // One newline, now, before anything else happens.
  //
  // This looks pointless and is not. A reader on the other end of the pipe may
  // give up waiting for the first byte long before there is a review to send —
  // `claude -p` waits three seconds and then proceeds without stdin at all,
  // printing a warning and exiting 0, so the whole thing fails silently and
  // the agent is asked to apply a review it never received. Reviewing takes
  // minutes, not seconds. A single byte at startup holds the stream open; the
  // rest arrives whenever the review is submitted.
  //
  // Measured against claude 2.1.270: producer silent for 8s then sending the
  // instruction, the instruction was ignored and the file left unchanged; the
  // same producer emitting one newline first had it applied. It is a
  // first-byte timeout, not a total one.
  //
  // A leading blank line costs nothing — the review is Markdown, and every
  // other consumer of a pipe is indifferent to it.
  if (handingOff) process.stdout.write('\n');

  let handedOff = false;
  const stop = () => {
    // A background Claude Code session answering comments stops with us:
    // asked to straight away, and waited for before the process exits.
    Promise.resolve(server.stopAgents?.()).catch(() => {}).then(() => {
      server.close(() => process.exit(0));
    });
    // Don't wait forever on a browser holding the connection open.
    setTimeout(() => process.exit(0), 2000).unref();
  };

  /**
   * A review has just been written. Say so, or hand it over.
   *
   * @param {{document: object, reviewPath: string}} submitted
   */
  const onReviewSubmitted = ({ document, reviewPath }) => {
    const { comments, files } = document.summary;
    const count = `${comments} comment${comments === 1 ? '' : 's'} on ` +
      `${files} file${files === 1 ? '' : 's'}`;

    if (!handingOff) {
      note(`\n  Review saved    ${homeRelative(reviewPath)}`);
      note(`  ${count}\n`);
      note('  Hand it to an agent with:');
      note(`    ${NAME} export ${repoPath ? homeRelative(repoPath) : '.'} --format prompt | claude -p "Apply this review."\n`);
      return;
    }

    // Once is enough: the first submitted review is what the pipe is waiting
    // for, and a second would arrive after the process has gone.
    if (handedOff) return;
    handedOff = true;

    note(`\n  ${count} — handing the review back to your terminal.\n`);
    process.stdout.write(formatPrompt(document));
    stop();
  };

  /**
   * The last tab closed and did not come back.
   *
   * Only on a terminal. In the piped form, submitting is what hands the
   * review over, and a closed tab is not a submitted review -- wiring this to
   * the handoff would send a half-written review to something that starts
   * editing files, which is a worse outcome by a wide margin than the Ctrl+C
   * this saves.
   */
  const onIdle = handingOff
    ? null
    : () => {
      note('\n  Browser closed. Stopping.\n');
      stop();
    };

  const server = await listen(
    options.port ?? (Number(process.env.PORT) || DEFAULT_PORT),
    { onReviewSubmitted, handoff: handingOff, onIdle }
  );
  const port = server.address().port;
  const url = buildUrl(
    `http://${DEFAULT_HOST}:${port}`,
    repoPath,
    options.staged,
    options.noIntro,
    options.untracked,
    options.scope
  );

  if (options.json) {
    // One machine-readable line instead of the banner, so an agent can read
    // the URL without a regex that breaks the day the banner is reworded.
    // stderr, like everything else here: stdout is reserved for the review.
    // No repoId: none exists yet. The page creates one via POST /api/load-repo.
    note(JSON.stringify({
      url,
      port,
      repository: repoPath,
      pid: process.pid,
      version
    }));
  } else {
    note(`\n  Code Reviewer  ${url}`);
    if (repoPath) note(`  reviewing      ${repoPath}`);
    note(handingOff
      ? '\n  Submit the review in the browser and it will be written here.\n'
      : '\n  Close the tab when you are done, or press Ctrl+C.\n');
  }

  if (options.open && !(await openInBrowser(url))) {
    note('  Could not open a browser — open the URL above yourself.\n');
  }

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch(error => {
  if (error instanceof ExportError || error instanceof ScopeError) {
    console.error(`error: ${error.message}`);
    process.exit(2);
  }

  if (error instanceof UsageError) {
    console.error(`error: ${error.message}\n`);
    process.stderr.write(usage(NAME));
    process.exit(2);
  }

  console.error(error);
  process.exit(1);
});
