'use strict';

const express = require('express');
const cors = require('cors');
const { simpleGit } = require('simple-git');
const fs = require('fs').promises;
const path = require('path');

const { parseDiff } = require('./lib/diff');
const {
  reviewsDir: resolveReviewsDir,
  resolveRepoFile,
  PathEscapeError
} = require('./lib/paths');
const { collectWorkingTreeChanges, describeWorkingChanges, collectStagedChanges, collectCommitChanges, parseNameStatus } = require('./lib/changes');
const { SessionStore } = require('./lib/sessions');
const { normalizeComments, withKeys } = require('./lib/comments');
const { keepFollowUpsFrom } = require('./lib/threads');
const { formatReview, reviewFilename, commentsFilename } = require('./lib/review');
const { buildReviewDocument, describeScope } = require('./lib/agent');
const { readSavedComments, updateSavedComments, ReviewOwnershipError } = require('./lib/store');
const { repoRoot } = require('./lib/repo');
const { browse } = require('./lib/browse');
const { recordRecent, describeRecents } = require('./lib/recents');
const { listReviews } = require('./lib/export');
const { EventEmitter } = require('events');
const { watchComments } = require('./lib/watch');
const { watchAgents } = require('./lib/presence');
const { findSessions, findClaudeSession, relateToRepository, readsRepository } = require('./lib/claude-sessions');
const { BackgroundSession } = require('./lib/claude-background');
const { Answerer } = require('./lib/answerer');
const { resolveClaudeCommand } = require('./lib/claude-command');
const {
  buildMatcher, searchDiffs, grepRepository, definesName, summarizeReferences, SearchError, SCOPES, MAX_RESULTS
} = require('./lib/search');

const DEFAULT_PORT = 4500;
const DEFAULT_HOST = '127.0.0.1';

// Claude Code sessions listed at a time in the dialog that picks one.
const SESSION_PAGE = 20;

// Addresses that only this machine can reach. Bound to one of these, the
// server installs `loopbackHostOnly`.
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', 'localhost', '::1']);

// The names a browser puts in `Host` for a server it reached on loopback.
// An IPv6 address keeps its brackets there.
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The host name in a `Host` header, without the port. */
function hostnameOf(header) {
  const value = String(header || '').toLowerCase();
  if (value.startsWith('[')) return value.slice(0, value.indexOf(']') + 1);
  return value.split(':')[0];
}

/**
 * Refuse a request addressed to this server by any name but a loopback one.
 *
 * That is DNS rebinding: a page on the attacker's own domain whose name is
 * re-pointed at 127.0.0.1 after it loads. The browser then treats this server
 * as that site, so `Origin` and `Host` agree and `sameOriginOnly` lets the
 * request through. A server reachable only on loopback is only ever honestly
 * addressed by a loopback name. Bound anywhere else (`HOST=0.0.0.0`), its
 * owner has chosen to be reached by other names, and this is not installed.
 */
function loopbackHostOnly(req, res, next) {
  if (!LOOPBACK_HOSTNAMES.has(hostnameOf(req.headers.host))) {
    return res.status(403).json({ error: 'Not available under this host name' });
  }

  next();
}


/**
 * An agent's presence record, as the page is told about it.
 *
 * @param {import('./lib/presence').AgentPresence} agent
 */
function describeAgent({ id, kind, agent, session, title, startedAt, working }) {
  return { id, kind, agent, session, title, startedAt, working };
}

/** A path inside the repository that names nothing, on disk or at HEAD. */
class FileNotFoundError extends Error {
  /** @param {string} filePath */
  constructor(filePath) {
    super('File not found in this repository');
    this.name = 'FileNotFoundError';
    this.filePath = filePath;
  }
}

/**
 * Build the review server.
 *
 * Everything the server keeps — open sessions, where reviews are written — is
 * passed in rather than reached for, so a test can point one instance at a
 * temporary directory without disturbing another.
 *
 * @param {object} [options]
 * @param {string} [options.reviewsDir] where comment and review files are written
 * @param {SessionStore} [options.sessions]
 * @param {(path: string) => import('simple-git').SimpleGit} [options.git] git factory, injectable for tests
 * @param {(review: {document: object, reviewPath: string, documentPath: string,
 *   comments: object[]}) => void} [options.onReviewSubmitted] called after a
 *   review is written, so the process that started the server can act on it.
 *   This is what lets `reviewer` hand the finished review back to the terminal.
 * @param {boolean} [options.handoff] whether the caller is going to do
 *   something with a submitted review. Reported to the page so it can say
 *   where the review went instead of only offering a download.
 * @param {() => void} [options.onIdle] called once the last browser tab has
 *   been gone for `idleGraceMs`, so the process that started the server can
 *   stop. Omitted means never: a server with no one to tell keeps serving.
 * @param {number} [options.idleGraceMs] how long to wait after the last tab
 *   leaves before deciding it is not coming back.
 * @param {boolean} [options.loopbackOnly] refuse any request whose `Host` is
 *   not a loopback name. `startServer` turns it on when it binds to loopback.
 * @param {object} [options.claude] how Claude Code is found and run, for
 *   answering comments from a session: `command` (default `claude`, or
 *   `REVIEWER_CLAUDE`), `configDir` (where its sessions are kept) and
 *   `spawn`, all injectable for tests.
 * @returns {import('express').Express}
 */
// How far back the range picker offers to go. Long enough to cover the work
// someone is plausibly still reviewing, short enough that the list is a list
// rather than the whole history -- anything older is still reachable by
// typing a ref, which is what the text box is for.
const COMMIT_LIST_LIMIT = 30;

// Branches and tags offered per group. A repository with two hundred stale
// branches should still produce a list someone can scan; the ones past the
// cut are the least recently touched and are still reachable by typing.
const REF_LIST_LIMIT = 40;

// How many commits the commits list shows. A branch of more than this is a
// review nobody is doing commit by commit; the list says it is truncated
// rather than pretending the rest are not there.
const LOG_LIMIT = 200;

function createApp(options = {}) {
  const {
    reviewsDir = resolveReviewsDir(),
    sessions = new SessionStore(),
    git: gitFactory = simpleGit,
    onReviewSubmitted = null,
    handoff = false,
    onIdle = null,
    idleGraceMs = 5000,
    loopbackOnly = false,
    claude = {}
  } = options;
  const claudeCommand = claude.command ?? process.env.REVIEWER_CLAUDE ?? 'claude';

  const app = express();

  if (loopbackOnly) app.use(loopbackHostOnly);
  app.use(cors());
  app.use('/api', sameOriginOnly);
  app.use(express.json({ limit: '10mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  app.locals.sessions = sessions;
  app.locals.reviewsDir = reviewsDir;

  // Background Claude Code sessions answering comments, one per repository
  // at most, and the feed their answers-in-progress go out on. An answer is
  // only written to the review once it is finished; until then the words
  // arriving are sent to the page directly, not written to disk word by word.
  /** @type {Map<string, Answerer>} */
  const answerers = new Map();
  const live = new EventEmitter();
  live.setMaxListeners(0);

  // Connecting and disconnecting a repository's background session happen
  // one at a time. Two connects racing would each stop the session they
  // found -- none -- and both start one, and the first would be left
  // running with nothing to stop it.
  /** @type {Map<string, Promise<void>>} */
  const agentLocks = new Map();
  const withAgentLock = (repoPath, task) => {
    const previous = agentLocks.get(repoPath) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.then(() => {}, () => {});
    agentLocks.set(repoPath, tail);
    tail.then(() => {
      if (agentLocks.get(repoPath) === tail) agentLocks.delete(repoPath);
    });
    return run;
  };

  app.locals.stopAgents = async () => {
    const running = [...answerers.values()];
    answerers.clear();
    await Promise.all(running.map(answerer => answerer.stop()));
  };

  // How many tabs are currently holding `/api/alive` open, and the timer that
  // starts when that reaches zero. See the route for why it is a timer.
  let watching = 0;
  let idleTimer = null;

  /**
   * Look up the session for a request, or answer 400.
   *
   * @param {import('express').Response} res
   * @param {string} repoId
   * @returns {{repoPath: string, mode: import('./lib/sessions').ReviewMode}|null}
   */
  function requireSession(res, repoId) {
    const session = sessions.get(repoId);
    if (!session) {
      res.status(400).json({ error: 'Invalid repository ID' });
      return null;
    }
    return session;
  }

  /**
   * Read one file as of the session's review mode.
   *
   * In `lastCommit` mode the committed text is authoritative; a file added by
   * that commit is not in its parent, so the working copy is the fallback.
   *
   * In `working` mode the working copy is authoritative — except for a file
   * the review is about precisely because it was deleted, which is no longer
   * on disk. Its content at HEAD is what the reviewer needs to see.
   *
   * @param {{repoPath: string, mode: string}} session
   * @param {string} filePath repo-relative, already confined by the caller
   * @returns {Promise<string>}
   */
  async function readFileForMode(session, filePath) {
    const git = gitFactory(session.repoPath);
    const absolutePath = resolveRepoFile(session.repoPath, filePath);

    if (session.mode === 'staged') {
      try {
        // `:0:` names the stage outright. A bare `:` reads a file called
        // `0:foo` as stage 0 of `foo`, and shows the wrong file's text.
        return await git.show([`:0:${filePath}`]);
      } catch {
        // A staged deletion has no index entry. Its old content comes from
        // HEAD, even if a replacement now exists in the working tree.
        return git.show([`HEAD:${filePath}`]).catch(() => { throw new FileNotFoundError(filePath); });
      }
    }

    if (session.range) {
      // A range is two commits, and the working tree is neither of them. It
      // used to be the fallback here, which was merely odd while the head of
      // every range was HEAD and is wrong now that it can be another branch:
      // Full Context on feature/billing, opened from a checkout of
      // feature/auth, would show auth's copy of the file under billing's name.
      //
      // A path missing at the head was deleted inside the range, and the text
      // worth showing is the text that was deleted.
      try {
        return await git.show([`${session.range.head}:${filePath}`]);
      } catch {
        return git.show([`${session.range.from}:${filePath}`]).catch(() => '');
      }
    }

    try {
      return await fs.readFile(absolutePath, 'utf-8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // Missing from disk means deleted — if HEAD has it. If HEAD does not
      // either, the path simply names nothing and saying so beats answering
      // with an empty file.
      try {
        return await git.show([`HEAD:${filePath}`]);
      } catch {
        throw new FileNotFoundError(filePath);
      }
    }
  }

  /**
   * Whether the repository has any commit yet.
   *
   * A freshly `git init`ed repository has an unborn HEAD, and every command
   * that names `HEAD` fails against it.
   *
   * @param {import('simple-git').SimpleGit} git
   * @returns {Promise<boolean>}
   */
  async function hasCommits(git) {
    try {
      await git.raw(['rev-parse', '--verify', 'HEAD']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Diff text for one file, as of the session's review mode.
   *
   * With no commit to compare against there is nothing to diff, and an empty
   * diff is what tells the parser to present the file as wholly new — which
   * is exactly what it is.
   *
   * @param {import('simple-git').SimpleGit} git
   * @param {{mode: string}} session
   * @param {string} filePath
   * @returns {Promise<string>}
   */
  /**
   * Whether git considers this file binary.
   *
   * Asking git rather than sniffing the bytes ourselves, because git's
   * answer is the one that produced the diff we are about to render, and a
   * second opinion that disagreed would be worse than no opinion. It says
   * so in the diff itself: `Binary files a/x and b/x differ` for the
   * default format, `GIT binary patch` when binary patches are enabled.
   *
   * This matters beyond the mojibake. `lib/changes.js` already classifies
   * these as `B` and the sidebar renders that letter, but the file endpoint
   * never consulted it -- so a 2 KB PNG came back as ten `add` lines that
   * were ~45% U+FFFD, and a comment left on one of them exported an
   * `anchor` that can never match the file. docs/agent-format.md tells a
   * consumer to locate comments by that anchor.
   *
   * @param {string} diffText
   * @returns {boolean}
   */
  function isBinaryDiff(diffText) {
    return /^Binary files .* differ$/m.test(diffText) || /^GIT binary patch$/m.test(diffText);
  }

  async function diffForFile(git, session, filePath) {
    if (session.mode === 'staged') {
      return git.diff(['--cached', '--', filePath]);
    }
    if (session.range) {
      return git.diff([session.range.from, session.range.head, '--', filePath]);
    }
    if (!(await hasCommits(git))) {
      return '';
    }
    return git.diff(['HEAD', '--', filePath]);
  }

  /**
   * A ref safe to hand to git as an argument.
   *
   * simple-git passes arguments as an array rather than through a shell, so
   * there is no quoting to get wrong -- but a value beginning with `-` is
   * still read by git as an option rather than as a ref, and
   * `--output=/somewhere` is a real thing to hand `git diff`. Refs do not
   * begin with a dash, so refusing one costs nothing.
   *
   * @param {string} ref
   * @returns {boolean}
   */
  function looksLikeRef(ref) {
    return ref.length > 0 && ref.length <= 255 && !ref.startsWith('-');
  }

  /**
   * Turn two refs into the range a review is of.
   *
   * Both are resolved to commit SHAs here, once, and the session carries
   * those rather than the names. A branch that moves under a review in
   * progress would otherwise change what the review is of halfway through,
   * and the comments already written would silently be about a diff that no
   * longer exists.
   *
   * @param {import('simple-git').SimpleGit} git
   * @param {string} base
   * @param {string} head
   * @returns {Promise<import('./lib/sessions').ReviewRange>}
   * @throws {Error} with a message meant for the page, when a ref will not resolve
   */
  async function resolveRange(git, base, head) {
    for (const [label, ref] of [['base', base], ['head', head]]) {
      if (!looksLikeRef(ref)) {
        throw new Error(`That ${label} does not look like a commit or branch.`);
      }
    }

    const resolve = async ref => {
      try {
        return (await git.revparse([`${ref}^{commit}`])).trim();
      } catch {
        throw new Error(`No commit or branch called "${ref}" in this repository.`);
      }
    };

    const baseSha = await resolve(base);
    const headSha = await resolve(head);

    // The diff starts at the merge base, not at `base` itself -- what a pull
    // request shows, and for the same reason. Compare feature/auth against a
    // main that has moved on since the branch was cut, and a plain
    // `git diff main feature/auth` includes main's newer commits *reversed*:
    // the review then shows the feature author "undoing" a change they never
    // touched, and a reviewer comments on it. On straight-line history the
    // merge base of an ancestor and its descendant is the ancestor, so this
    // changes nothing for x1..x5.
    //
    // Unrelated histories have no merge base; the plain two-ended diff is the
    // only answer there, and it is the one given.
    const from = await git.raw(['merge-base', baseSha, headSha])
      .then(out => out.trim() || baseSha)
      .catch(() => baseSha);

    // `base..head` is what head has and base does not -- exactly the commits
    // whose changes are in the diff. `head..base` is the other direction: what
    // base has moved on by, which the merge-base diff deliberately leaves out
    // and which the page has to say it left out, or someone will go looking
    // for main's change and conclude the tool lost it.
    const count = async range => Number(
      (await git.raw(['rev-list', '--count', range])).trim()
    );
    const commits = await count(`${baseSha}..${headSha}`);
    const behind = await count(`${headSha}..${baseSha}`);

    // What the person asked for, kept alongside the SHAs. Nobody chose
    // `3eb57959`; they chose `main`, and a scope bar that answers in SHAs has
    // translated their question into one they did not ask.
    const nameOf = async ref => {
      if (ref !== 'HEAD') return ref;
      const branch = await git.revparse(['--abbrev-ref', 'HEAD']).then(b => b.trim()).catch(() => 'HEAD');
      return branch === 'HEAD' ? headSha.slice(0, 8) : branch;
    };

    return {
      base: baseSha,
      head: headSha,
      from,
      commits: Number.isFinite(commits) ? commits : 0,
      behind: Number.isFinite(behind) ? behind : 0,
      baseName: await nameOf(base),
      headName: await nameOf(head)
    };
  }

  /**
   * The range for reviewing commits themselves: one, or an unbroken run.
   *
   * Different from comparing two refs. `from` and `to` are both *in* the
   * review -- clicking one commit means that commit's changes, and
   * shift-clicking a second means everything from the first through the
   * second -- so the diff starts at the parent of `from`, not at `from`.
   * That is what GitHub does when you pick commits inside a pull request, and
   * what "review commit 3 of 5" has to mean.
   *
   * `from` has to come before `to` on one line of history. Two commits on
   * different branches have no run between them; that is a comparison, and
   * the compare pickers exist for it.
   *
   * @throws {Error} with a message meant for the page
   */
  async function resolveCommitRun(git, fromRef, toRef) {
    for (const [label, ref] of [['first commit', fromRef], ['last commit', toRef]]) {
      if (!looksLikeRef(ref)) throw new Error(`That ${label} does not look like a commit.`);
    }

    const resolve = async ref => {
      try {
        return (await git.revparse([`${ref}^{commit}`])).trim();
      } catch {
        throw new Error(`No commit called "${ref}" in this repository.`);
      }
    };
    const first = await resolve(fromRef);
    const last = await resolve(toRef);

    // Ancestry through output, not exit code: `merge-base --is-ancestor`
    // answers only by exiting 1, and simple-git resolves a silent non-zero
    // exit -- so it reported every pair as ordered, including main before a
    // branch that main was not an ancestor of. The merge base of an ancestor
    // and its descendant is the ancestor, and that is checkable.
    const mergeBase = (await git.raw(['merge-base', first, last]).catch(() => '')).trim();
    if (mergeBase !== first) {
      throw new Error(
        `${first.slice(0, 7)} does not come before ${last.slice(0, 7)} on one line of history, ` +
        'so there is no run of commits between them. Use Compare to diff two unrelated points.'
      );
    }

    // A root commit has no parent. Its "before" is the empty tree, which is
    // also how `git show` presents a root commit: every file added.
    let from;
    let hasParent = true;
    try {
      from = (await git.revparse([`${first}^`])).trim();
    } catch {
      hasParent = false;
      from = (await git.raw(['hash-object', '-t', 'tree', '/dev/null'])).trim();
    }

    const count = Number((await git.raw(['rev-list', '--count', hasParent ? `${from}..${last}` : last, '--'])).trim());
    const subject = first === last
      ? (await git.raw(['log', '-1', '--format=%s', last, '--']).catch(() => '')).trim()
      : null;

    return {
      kind: 'commits',
      first,
      last,
      base: from,
      head: last,
      from,
      commits: Number.isFinite(count) ? count : 1,
      behind: 0,
      baseName: first.slice(0, 7),
      headName: last.slice(0, 7),
      ...(subject ? { subject } : {})
    };
  }

  /** What to say about a commit or a run of them once loaded. */
  function describeCommitRun(range, fileCount) {
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const files = fileCount === 0 ? 'no files changed' : plural(fileCount, 'changed file');
    return range.first === range.last
      ? `Commit ${range.headName}${range.subject ? `: ${range.subject}` : ''} — ${files}`
      : `${plural(range.commits, 'commit')}, ${range.baseName} through ${range.headName} — ${files}`;
  }

  /**
   * The changed files of a range, with the status git gives each one.
   *
   * @param {import('simple-git').SimpleGit} git
   * @param {{from: string, head: string}} range
   */
  async function collectRangeChanges(git, range) {
    const [summary, nameStatus] = await Promise.all([
      git.diffSummary([range.from, range.head]),
      git.raw(['diff', '--name-status', '-z', '-M', range.from, range.head])
    ]);
    return collectCommitChanges(summary, parseNameStatus(nameStatus));
  }

  /**
   * What to tell the reviewer about a range they just opened.
   *
   * The empty case is the one that matters. `git diff x3 x5` over a file
   * added in x4 and deleted in x5 is correctly empty, and an interface that
   * renders that as "no changes" is saying something false about two commits
   * of real work. So the commit count leads, and the absence of files is
   * described rather than left as a blank screen.
   *
   * @param {import('./lib/sessions').ReviewRange} range
   * @param {number} fileCount
   * @returns {string}
   */
  function describeRange(range, fileCount) {
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const ends = `${range.baseName ?? range.base.slice(0, 8)} \u2192 ${range.headName ?? range.head.slice(0, 8)}`;

    if (fileCount > 0) {
      return `${ends}: ${plural(range.commits, 'commit')}, ${plural(fileCount, 'changed file')}`;
    }

    if (range.commits === 0) {
      return range.behind === 0
        ? `${ends}: both point at the same commit, so there is nothing between them.`
        : `${ends}: ${range.headName ?? 'the head'} has no commits that ${range.baseName ?? 'the base'} does not already have.`;
    }

    return `${ends}: ${plural(range.commits, 'commit')}, and no net change \u2014 every change in them was undone again inside the range.`;
  }

  /**
   * Recent commits, so a range can be picked instead of typed.
   *
   * Nobody knows the SHA of the commit they want to review back to, and
   * asking for one is asking the reviewer to go and run `git log` in another
   * window to use a tool whose whole point is not having to.
   *
   * Each entry is what a person recognises a commit by -- the subject line
   * and when it landed -- with the SHA carried alongside rather than being
   * the thing they have to read.
   *
   * `%x00` separates the fields because a commit subject can contain
   * anything a person can type, including whatever delimiter looked safe.
   *
   * @param {import('simple-git').SimpleGit} git
   * @param {number} limit
   */
  async function recentCommits(git, limit, head = 'HEAD') {
    const raw = await git.raw([
      'log', `--max-count=${limit}`, '--format=%H%x00%h%x00%s%x00%cr', head, '--'
    ]);

    return raw
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => {
        const [sha, short, subject, when] = line.split('\u0000');
        return { sha, short, subject, when };
      });
  }

  /**
   * Everything the compare pickers offer: branches, tags and recent commits.
   *
   * Branches come first in the page because comparing branches is what people
   * reach for -- "what does my branch change against main" -- and a picker
   * that only lists commits of the current branch makes that the one
   * comparison you cannot pick. Remote-tracking branches are included because
   * `origin/main` is the base most reviews actually want, and a local `main`
   * that has not been pulled in a week is a quietly wrong one.
   *
   * Sorted by most recent activity, so the branch you are working on and the
   * one you branched from are near the top rather than alphabetised into the
   * middle of forty others.
   */
  app.get('/api/refs/:repoId', async (req, res) => {
    const session = requireSession(res, req.params.repoId);
    if (!session) return;

    const git = gitFactory(session.repoPath);
    const refList = async (pattern, limit) => {
      try {
        const raw = await git.raw([
          'for-each-ref', `--count=${limit}`, '--sort=-committerdate',
          '--format=%(refname:short)%00%(objectname)%00%(committerdate:relative)%00%(subject)%00%(symref)',
          pattern
        ]);
        return raw.split('\n').filter(Boolean).map(line => {
          const [name, sha, when, subject, symref] = line.split('\u0000');
          return { name, sha, when, subject, symref };
        })
          // A symbolic ref points at another ref rather than being one --
          // `origin/HEAD` in every clone. It cannot be filtered by name:
          // `refname:short` abbreviates it to plain `origin`, which is how it
          // first slipped into the list as a "branch".
          .filter(ref => !ref.symref)
          .map(({ symref, ...ref }) => ref);
      } catch {
        return [];
      }
    };

    const current = await git.revparse(['--abbrev-ref', 'HEAD']).then(b => b.trim()).catch(() => null);

    // The commits offered are the history of whatever is being compared, not
    // always of the checkout: comparing main against feature/billing from a
    // checkout of feature/auth should offer billing's commits to pick from.
    const requested = typeof req.query.head === 'string' ? req.query.head.trim() : '';
    const head = requested && looksLikeRef(requested) ? requested : 'HEAD';

    const [branches, remotes, tags, commits] = await Promise.all([
      refList('refs/heads', REF_LIST_LIMIT),
      refList('refs/remotes', REF_LIST_LIMIT),
      refList('refs/tags', REF_LIST_LIMIT),
      recentCommits(git, COMMIT_LIST_LIMIT, head).catch(() => [])
    ]);

    // A remote's symbolic HEAD records its default branch. It is not a branch
    // itself, so refList deliberately excludes it; report the target separately
    // for the compare picker without changing the refs offered to the user.
    const remoteNames = [...new Set(remotes.map(ref => ref.name.split('/')[0]))];
    const defaults = {};
    await Promise.all(remoteNames.map(async remote => {
      try {
        const target = (await git.raw([
          'symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`
        ])).trim();
        if (target.startsWith(`${remote}/`) && target.split('/').length > 1) {
          defaults[remote] = target;
        }
      } catch {
        // A remote added by hand and fetched may not have a recorded HEAD.
      }
    }));

    res.json({
      // `HEAD` from --abbrev-ref means detached; say so rather than pretend
      // there is a branch called HEAD.
      current: current === 'HEAD' ? null : current,
      branches,
      remotes,
      defaults,
      tags,
      commits
    });
  });

  /**
   * The commits a review can be narrowed to, one at a time or as a run.
   *
   * With a base: the commits the comparison is made of -- what `base..head`
   * has -- oldest first, because a branch reads as a story in the order it
   * was written, and stepping through it commit by commit is the point.
   * Without one: the recent history of `head`, newest first, the way `git
   * log` reads, because there is no story there, only "how far back".
   *
   * Each commit carries its full message. The subject is what fits in a
   * list, but the body is often where the author explains the change, and a
   * reviewer looking at one commit should not have to leave the tool to read
   * why it was made.
   *
   * Records are split on %x1e rather than on newlines, because a commit body
   * is made of newlines.
   */
  app.get('/api/log/:repoId', async (req, res) => {
    const session = requireSession(res, req.params.repoId);
    if (!session) return;

    const git = gitFactory(session.repoPath);
    const pick = name => (typeof req.query[name] === 'string' ? req.query[name].trim() : '');
    const head = pick('head') || 'HEAD';
    const base = pick('base');

    for (const ref of base ? [base, head] : [head]) {
      if (!looksLikeRef(ref)) {
        return res.status(400).json({ error: 'That does not look like a commit or branch.' });
      }
    }

    try {
      const range = base ? `${base}..${head}` : head;
      const total = Number((await git.raw(['rev-list', '--count', range, '--'])).trim()) || 0;
      const raw = await git.raw([
        'log', `--max-count=${LOG_LIMIT}`, ...(base ? ['--reverse'] : []),
        '--format=%H%x00%h%x00%s%x00%an%x00%cr%x00%P%x00%b%x1e', range, '--'
      ]);

      const commits = raw.split('\u001e').map(record => record.replace(/^\n/, '')).filter(Boolean).map(record => {
        const [sha, short, subject, author, when, parents, body] = record.split('\u0000');
        return {
          sha, short, subject, author, when,
          body: (body ?? '').trim(),
          // A merge is shown against its first parent when reviewed alone --
          // what it brought in -- and the list says it is one, because that
          // diff can be surprisingly large.
          merge: (parents ?? '').trim().split(/\s+/).filter(Boolean).length > 1
        };
      });

      res.json({
        order: base ? 'oldest-first' : 'newest-first',
        total,
        truncated: total > commits.length,
        commits
      });
    } catch {
      res.status(400).json({ error: `Could not read the history of "${base ? `${base}..${head}` : head}".` });
    }
  });

  /**
   * The commits of an open repository, newest first. Kept for 2.11 callers;
   * the page itself uses /api/refs and /api/log.
   *
   * Behind a session id like the file endpoints rather than taking a path:
   * this reads history out of a repository, and the session is what says
   * which repository the caller has already been granted.
   */
  app.get('/api/commits/:repoId', async (req, res) => {
    try {
      const session = requireSession(res, req.params.repoId);
      if (!session) return;

      const commits = await recentCommits(gitFactory(session.repoPath), COMMIT_LIST_LIMIT);
      res.json({ commits });
    } catch (error) {
      // A repository with no commits is not an error, it is an empty list.
      console.error('Commit list error:', error.message);
      res.json({ commits: [] });
    }
  });

  /** Liveness probe, and a count of how many repositories are open. */
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', sessions: sessions.size });
  });

  /**
   * Refuse a request a browser has marked as coming from somewhere else.
   *
   * Every `/api` route goes through this (#66). Until 2.14.1 only the routes
   * that enumerate directories did, on the reasoning that the rest answer
   * about a repository whose path the caller already had. A path is easy to
   * guess, though, and `cors()` is open, so a page on another site could read
   * any file in a guessed repository. Worse, it could save a comment into the
   * review, which `reviewer export` then hands to the coding agent as an
   * instruction.
   *
   * A browser sends `Origin` on every cross-origin request that could do
   * either, and leaves it out of the page's own same-origin GETs, so the page
   * keeps working. A client that is not a browser sends no `Origin` and gets
   * through: it could read these files without asking this server anyway.
   * Only the host is compared, not the scheme, so the page still works behind
   * a proxy that terminates TLS.
   *
   * This cannot catch DNS rebinding, where `Origin` and `Host` both name the
   * attacker's domain. `loopbackHostOnly` does.
   */
  function sameOriginOnly(req, res, next) {
    const origin = req.get('origin');

    if (origin) {
      let originHost = null;
      try {
        originHost = new URL(origin).host;
      } catch {
        // `Origin: null` (a sandboxed frame, a file:// page) names no host.
      }
      if (originHost !== req.headers.host) {
        return res.status(403).json({ error: 'Not available to another origin' });
      }
    }

    next();
  }

  /**
   * Held open for as long as a tab is watching, so the server can tell when
   * the last one has gone.
   *
   * The connection *is* the signal. An open page holds this response open and
   * closing the page closes it, so there is no heartbeat interval to tune, and
   * two tabs are two connections rather than one flag that either close
   * clears. Like every `/api` route it goes through `sameOriginOnly`, which
   * matters here too: without it a page on another site could hold this open
   * and keep alive a server its owner had finished with.
   *
   * Nothing happens at the moment a watcher leaves. A reload closes and
   * reopens within milliseconds, and a dropped connection reopens when
   * EventSource retries -- at the instant it happens neither is
   * distinguishable from someone closing the tab for good. So the last one
   * leaving starts a timer and the next to arrive cancels it. Guessing wrong
   * ends a review somebody is in the middle of, which is worth five seconds.
   *
   * A server nobody ever opened is not idle. `watching` only falls to zero
   * after having been above it, so `reviewer` whose browser never launched
   * keeps serving rather than exiting into an empty terminal.
   */
  /**
   * Count a tab as watching for as long as `res` stays open.
   *
   * Shared by `/api/alive` and `/api/events`: a tab holds exactly one of
   * them, the first before a repository is open and the second after.
   * Browsers allow six connections to one host, and a tab holding two would
   * leave three tabs nothing to save with.
   *
   * @param {import('express').Response} res
   */
  function countWatcher(res) {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    watching += 1;

    res.on('close', () => {
      watching -= 1;
      if (watching > 0 || !onIdle) return;

      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (watching === 0) onIdle();
      }, idleGraceMs);
      // The listening socket is what holds the process open; this timer
      // should not be able to on its own, or a closed server would sit
      // waiting out the grace period before the process could exit.
      idleTimer.unref();
    });
  }

  app.get('/api/alive', (req, res) => {
    countWatcher(res);

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    // A comment frame, which EventSource ignores. Sending it now is what
    // flushes the headers, so the client is connected rather than pending.
    res.write(': watching\n\n');
  });

  /** List the directories inside one, so a repository can be found by looking. */
  app.get('/api/browse', async (req, res) => {
    try {
      res.json(await browse(req.query.path));
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        return res.status(400).json({ error: 'No such directory' });
      }
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        return res.status(403).json({ error: 'Not allowed to read that directory' });
      }

      console.error('Browse error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /** Repositories opened before now, newest first. */
  app.get('/api/recent', async (req, res) => {
    try {
      // Annotated with what is saved against each, because "3 comments" is
      // what tells you which of two checkouts you were in the middle of.
      const counts = new Map(
        (await listReviews(reviewsDir)).map(review => [review.repoPath, review.comments])
      );

      res.json({ projects: await describeRecents(reviewsDir, counts) });
    } catch (error) {
      console.error('Recent projects error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /** Open a repository and list what changed. */
  app.post('/api/load-repo', async (req, res) => {
    try {
      const { repoPath } = req.body ?? {};

      if (!repoPath) {
        return res.status(400).json({ error: 'Repository path is required' });
      }

      try {
        await fs.access(repoPath);
      } catch {
        return res.status(400).json({ error: 'Path does not exist' });
      }

      // Resolve to the root of the working tree before anything is keyed on
      // this path. A subdirectory passes `checkIsRepo()` quite happily and
      // then produces a file list whose diffs are all empty; see lib/repo.js.
      const { base, head, commits: run, staged = false, untracked = true } = req.body ?? {};
      if (typeof untracked !== 'boolean') {
        return res.status(400).json({ error: 'The untracked option must be a boolean.' });
      }
      if (typeof staged !== 'boolean' || (staged && (base != null || head != null || run != null))) {
        return res.status(400).json({ error: 'Choose staged changes or a commit comparison, not both.' });
      }
      const root = await repoRoot(repoPath, gitFactory);
      if (!root) {
        return res.status(400).json({ error: 'Not a valid git repository' });
      }

      const git = gitFactory(root);
      // Pin HEAD when the review opens; subsequent saves must retain this
      // baseline even if the repository moves before the review is exported.
      const reviewHead = await git.revparse(['HEAD']).then(sha => sha.trim()).catch(() => null);

      let files;
      let mode;
      let range = null;
      let message;

      if (staged) {
        try {
          files = await collectStagedChanges(git);
        } catch (error) {
          return res.status(400).json({ error: error.message });
        }
        mode = 'staged';
        message = files.length ? `Found ${files.length} staged file(s)` : 'No staged changes';
      } else if (run && typeof run === 'object') {
        // Commits themselves, one or a run: see resolveCommitRun.
        try {
          range = await resolveCommitRun(git, `${run.from ?? ''}`.trim(), `${run.to ?? run.from ?? ''}`.trim());
        } catch (error) {
          return res.status(400).json({ error: error.message });
        }

        files = await collectRangeChanges(git, range);
        mode = 'range';
        message = describeCommitRun(range, files.length);
      } else if (base !== undefined && base !== null && `${base}`.trim() !== '') {
        // An explicit range. Nothing falls back to anything here: someone who
        // asked for x1..x3 and is silently shown their working tree instead
        // has been told a lie about what they are reviewing.
        try {
          range = await resolveRange(git, `${base}`.trim(), `${head ?? 'HEAD'}`.trim());
        } catch (error) {
          return res.status(400).json({ error: error.message });
        }

        files = await collectRangeChanges(git, range);
        mode = 'range';
        message = describeRange(range, files.length);
      } else {
        files = await collectWorkingTreeChanges(git, untracked);
        mode = 'working';
        message = describeWorkingChanges(files, untracked);

        // A clean tree has nothing to review, so fall back to the last commit.
        // Hiding untracked files is an explicit working-tree scope. An empty
        // tracked review must not silently become a review of committed work.
        if (files.length === 0 && untracked) {
          try {
            const lastCommit = await resolveRange(git, 'HEAD~1', 'HEAD');
            const commitFiles = await collectRangeChanges(git, lastCommit);
            if (commitFiles.length > 0) {
              files = commitFiles;
              mode = 'lastCommit';
              range = lastCommit;
              message = `No working directory changes. Loaded last commit with ${files.length} changed file(s)`;
            }
          } catch (error) {
            // A repository with no commits, or only one, has no parent to diff
            // against. An empty file list is the correct answer there.
            console.error('Error loading last commit:', error.message);
          }
        }
      }

      const repoId = sessions.create(root, mode, range, untracked);
      sessions.get(repoId).head = reviewHead;
      sessions.get(repoId).foldedDirectories = new Map(
        files.filter(file => file.directory).map(file => [file.path, file.fileCount])
      );
      // What a search of the review looks through: the files it shows, less
      // folded directories and binaries, which have no lines to match.
      sessions.get(repoId).files = files
        .filter(file => !file.directory && file.status !== 'B')
        .map(file => file.path);
      // stderr, not stdout. `reviewer | claude -p ...` puts the finished
      // review on stdout, and anything else written there lands in the middle
      // of it. Progress is for the person watching; stdout is for the pipe.
      console.error(`Loaded repository: ${root} (mode: ${mode})`);

      try {
        await recordRecent(reviewsDir, root);
      } catch (error) {
        // Being unable to remember this must not stop you opening it.
        console.error('Could not record recent project:', error.message);
      }

      // `repoPath` in the response is the resolved root, not what was asked
      // for, so the page can show which repository it actually opened.
      res.json({ repoId, files, repoPath: root, mode, range, message, untracked });
    } catch (error) {
      console.error('Load repo error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /** Diff of one file, as structured lines. */
  app.get('/api/file/:repoId/:filePath(*)', async (req, res) => {
    try {
      const { repoId, filePath } = req.params;
      const session = requireSession(res, repoId);
      if (!session) return;

      // Confine the path first, explicitly. It used to be confined as a
      // side effect of `readFileForMode` calling `resolveRepoFile`, so
      // moving the read below the binary check silently turned a 400 into a
      // 500 and let the traversal reach git. A containment check that only
      // works because of statement order is not a containment check.
      resolveRepoFile(session.repoPath, filePath);

      if (session.foldedDirectories?.has(filePath)) {
        return res.json({ filePath, directory: true, fileCount: session.foldedDirectories.get(filePath), binary: false, diffLines: [] });
      }

      const git = gitFactory(session.repoPath);
      const diffText = await diffForFile(git, session, filePath);

      // Answered before the file is read: decoding a PNG as UTF-8 to then
      // throw the result away is how the mojibake got served in the first
      // place.
      if (isBinaryDiff(diffText)) {
        return res.json({ filePath, binary: true, diffLines: [] });
      }

      const content = await readFileForMode(session, filePath);

      res.json({ filePath, binary: false, diffLines: parseDiff(diffText, content) });
    } catch (error) {
      if (error instanceof PathEscapeError) {
        return res.status(400).json({ error: error.message });
      }
      if (error instanceof FileNotFoundError) {
        return res.status(404).json({ error: error.message });
      }
      console.error('File read error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /** Whole file, for showing context around a comment. */
  app.get('/api/file-full/:repoId/:filePath(*)', async (req, res) => {
    try {
      const { repoId, filePath } = req.params;
      const session = requireSession(res, repoId);
      if (!session) return;

      resolveRepoFile(session.repoPath, filePath);
      if (session.foldedDirectories?.has(filePath)) {
        return res.json({ filePath, directory: true, fileCount: session.foldedDirectories.get(filePath), lines: [] });
      }

      const content = await readFileForMode(session, filePath);
      res.json({ filePath, lines: content.split('\n') });
    } catch (error) {
      if (error instanceof PathEscapeError) {
        return res.status(400).json({ error: error.message });
      }
      if (error instanceof FileNotFoundError) {
        return res.status(404).json({ error: error.message });
      }
      console.error('File read error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * Persist the current comments. Called on every edit.
   *
   * A caller that sends the `lastUpdated` it loaded saves conditionally
   * (#107): if the file has moved on since -- another tab, `reviewer
   * resolve`, an agent -- the save is refused with 409 and the current
   * comments and stamp ride along, so the caller can merge and retry
   * instead of silently overwriting what it never saw. A caller that
   * sends no `lastUpdated` at all keeps the old unconditional behaviour:
   * scripts written against the original route are not tabs racing each
   * other, and breaking them would not protect anyone.
   */
  app.post('/api/save-comments', async (req, res) => {
    try {
      const { repoId, comments } = req.body ?? {};
      const session = requireSession(res, repoId);
      if (!session) return;

      const conditional = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'lastUpdated');
      const expected = req.body?.lastUpdated ?? null;
      if (conditional && expected !== null && typeof expected !== 'string') {
        return res.status(400).json({ error: 'lastUpdated must be a string or null' });
      }

      let normalized;
      try {
        normalized = normalizeComments(comments);
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }

      // Comments posted without keys -- older pages, scripts -- get the key
      // their content derives, so re-posting the same list keeps each
      // comment's identity, and the follow-ups below can find their thread.
      const incoming = withKeys(normalized);

      let refusal = null;
      const saved = await updateSavedComments(reviewsDir, session.repoPath, current => {
        if (conditional && (current.lastUpdated ?? null) !== expected) {
          refusal = {
            error: 'Comments have changed since they were loaded. Reload, merge and retry.',
            comments: current.comments,
            lastUpdated: current.lastUpdated ?? null
          };
          return null;
        }

        // `mode` is on the envelope rather than on each comment: it describes
        // the review, not any one remark in it, and it is what lets `reviewer
        // export` say what was compared. Without it an exported review could
        // only report where HEAD is, which says nothing about whether the
        // comments are about committed work or uncommitted work.
        //
        // Follow-ups already on disk are kept for every comment the save
        // still holds: an agent may have answered in a thread since this tab
        // last heard from the server, and a whole-list save must not erase it.
        return {
          comments: keepFollowUpsFrom(incoming, current.comments),
          // The baseline is immutable after the first comment save. A legacy
          // review with comments but no baseline remains unknown.
          scope: {
            mode: session.mode,
            range: session.range,
            untracked: session.untracked,
            head: current.comments.length === 0 ? session.head ?? null : current.head ?? null
          }
        };
      });

      const outcome = refusal
        ? { status: 409, body: refusal }
        // What was written, which can be more than what was sent -- the
        // follow-ups kept from disk -- so the page can show it at once.
        : { status: 200, body: { message: 'Comments saved successfully', lastUpdated: saved.lastUpdated, comments: saved.comments } };
      res.status(outcome.status).json(outcome.body);
    } catch (error) {
      if (error instanceof ReviewOwnershipError) {
        return res.status(409).json({ error: error.message });
      }
      console.error('Save comments error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /** Restore comments saved by an earlier session. */
  app.get('/api/load-comments/:repoId', async (req, res) => {
    try {
      const session = requireSession(res, req.params.repoId);
      if (!session) return;

      const { comments, lastUpdated } = await readSavedComments(reviewsDir, session.repoPath);
      res.json({ comments, lastUpdated: lastUpdated ?? null });
    } catch (error) {
      if (error instanceof ReviewOwnershipError) {
        return res.status(409).json({ error: error.message });
      }
      console.error('Load comments error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /** Render the saved comments into a timestamped review file. */
  app.post('/api/submit-review', async (req, res) => {
    try {
      const { repoId } = req.body ?? {};
      const session = requireSession(res, repoId);
      if (!session) return;

      // The JSON file is the source of truth, not whatever the client holds:
      // submitting renders exactly what was last saved.
      const { comments, head: savedHead } = await readSavedComments(reviewsDir, session.repoPath);

      if (comments.length === 0) {
        return res.status(400).json({
          error: 'No comments found. Please add comments before submitting review.'
        });
      }

      const generatedAt = new Date();
      const filename = reviewFilename(session.repoPath, generatedAt);

      // Use the saved baseline, not live HEAD: reading it here would make
      // every export appear fresh even after the repository has moved on.
      const git = gitFactory(session.repoPath);
      const head = savedHead ?? null;
      const branch = await git.revparse(['--abbrev-ref', 'HEAD']).then(name => name.trim()).catch(() => null);

      const document = buildReviewDocument({
        repoPath: session.repoPath,
        comments,
        generatedAt,
        head,
        branch,
        mode: session.mode,
        range: session.range,
        untracked: session.untracked
      });
      const reviewContent = formatReview({
        repoPath: session.repoPath, comments, generatedAt,
        scope: document.untracked === false ? describeScope(document) : null
      });
      const documentFilename = filename.replace(/\.txt$/, '.json');

      await fs.mkdir(reviewsDir, { recursive: true });
      await fs.writeFile(path.join(reviewsDir, filename), reviewContent);
      // Written alongside the .txt so a review is available to a tool without
      // anyone having to re-run anything.
      await fs.writeFile(
        path.join(reviewsDir, documentFilename),
        `${JSON.stringify(document, null, 2)}\n`
      );

      console.error(`Review generated: ${filename} (${comments.length} comments)`);

      const reviewPath = path.join(reviewsDir, filename);

      res.json({
        message: 'Review submitted successfully',
        reviewContent,
        filename,
        documentFilename,
        reviewPath,
        // The page has no other way to know whether anything is waiting for
        // this on the other side, and "download it" is the wrong thing to say
        // to someone whose terminal is about to be handed the same review.
        handoff,
        review: document,
        totalComments: comments.length
      });

      // After the response, so a slow or throwing consumer cannot make the
      // browser think the submit failed. The review is already on disk by now
      // and the caller is told where.
      if (onReviewSubmitted) {
        try {
          onReviewSubmitted({
            document,
            reviewPath,
            documentPath: path.join(reviewsDir, documentFilename),
            comments
          });
        } catch (error) {
          console.error('Review handoff failed:', error.message);
        }
      }
    } catch (error) {
      if (error instanceof ReviewOwnershipError) {
        return res.status(409).json({ error: error.message });
      }
      console.error('Submit error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * The live feed for one open review.
   *
   * `comments` whenever the saved comments change -- whoever changed them:
   * another tab, an agent answering in a thread, `reviewer reply` -- and once
   * on connecting; `agents` whenever an agent connects, leaves, or starts on
   * a thread; and, while a background session here is answering, `partial`
   * with the answer as far as it has got. The page applies `comments` the way
   * it applies a refused save, so nothing it is holding is lost.
   */
  app.get('/api/events/:repoId', (req, res) => {
    const session = requireSession(res, req.params.repoId);
    if (!session) return;

    // The page's one long-lived connection once a repository is open, so it
    // is also how the server knows the tab is still there (see /api/alive).
    countWatcher(res);

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write(': events\n\n');

    const send = (event, data) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const comments = watchComments(reviewsDir, session.repoPath, state => {
      send('comments', { comments: state.comments, lastUpdated: state.lastUpdated ?? null });
    }, { onError: error => console.error('Review events:', error.message) });
    const agents = watchAgents(reviewsDir, session.repoPath, list => {
      send('agents', { agents: list.map(describeAgent) });
    });
    const onLive = (repoPath, event, data) => {
      if (repoPath === session.repoPath) send(event, data);
    };
    live.on('event', onLive);
    send('answerer', answerers.get(session.repoPath)?.status() ?? null);

    // Proxies close a connection that has been quiet for a minute or two.
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);
    keepAlive.unref();

    res.on('close', () => {
      comments.close();
      agents.close();
      live.off('event', onLive);
      clearInterval(keepAlive);
    });
  });

  /**
   * Claude Code sessions to choose the one that should answer from, newest
   * first, a page at a time: by default those that worked in this
   * repository -- normally the one that wrote the code under review is
   * among them -- and with `scope=all`, every session on the machine. `q`
   * keeps those whose name, first prompt, folder, branch or id has every
   * word of it.
   */
  app.get('/api/agent/sessions/:repoId', async (req, res) => {
    const session = requireSession(res, req.params.repoId);
    if (!session) return;
    try {
      const scope = req.query.scope === 'all' ? 'all' : 'repository';
      const query = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
      const offset = Math.min(Math.max(Number.parseInt(req.query.offset, 10) || 0, 0), 100000);
      const { sessions, more } = await findSessions({
        repoPath: session.repoPath, scope, query, offset, limit: SESSION_PAGE, configDir: claude.configDir
      });
      res.json({
        sessions,
        more,
        scope,
        repoPath: session.repoPath,
        answerer: answerers.get(session.repoPath)?.status() ?? null
      });
    } catch (error) {
      console.error('Session list error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * Have a Claude Code session answer this review's comments.
   *
   * Resumes the session in the background -- as a copy unless `fork` is
   * false -- and puts every thread waiting for an answer to it, then every
   * comment and reply the reviewer writes from now on. Any session Claude
   * Code has can be named, wherever it ran, but only by a whole id with a
   * transcript of its own: the id goes on a command line.
   */
  app.post('/api/agent/connect', async (req, res) => {
    try {
      const { repoId, sessionId, fork = true } = req.body ?? {};
      const session = requireSession(res, repoId);
      if (!session) return;
      if (typeof fork !== 'boolean') {
        return res.status(400).json({ error: 'fork must be true or false' });
      }

      const found = await findClaudeSession(sessionId, { configDir: claude.configDir });
      if (!found) {
        return res.status(404).json({ error: 'Claude Code has no session with that id.' });
      }

      const answerer = await withAgentLock(session.repoPath, async () => {
        await answerers.get(session.repoPath)?.stop();
        answerers.delete(session.repoPath);
        return startAnswerer(session, found, fork);
      });

      console.error(`Answering comments from Claude Code session ${found.id}${fork ? ' (in a copy)' : ''}`);
      live.emit('event', session.repoPath, 'answerer', answerer.status());
      res.json({ answerer: answerer.status() });
    } catch (error) {
      console.error('Agent connect error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * Start a background session answering a repository's comments.
   *
   * @param {{repoPath: string}} session
   * @param {import('./lib/claude-sessions').ClaudeSession} found
   * @param {boolean} fork
   * @returns {Promise<Answerer>}
   */
  async function startAnswerer(session, found, fork) {
    const about = found.title ?? found.firstPrompt ?? found.id;
    const { relation, place } = relateToRepository(found, session.repoPath);
    // Claude Code finds a session by the directory it ran in. If that has
    // since been removed, the repository root is the next best place to
    // run from, rather than a spawn error that reads like a missing binary.
    const cwd = await fs.access(found.cwd).then(() => found.cwd, () => session.repoPath);
    const background = new BackgroundSession({
      sessionId: found.id,
      cwd,
      fork,
      name: fork ? `Review answers: ${about}`.slice(0, 80) : null,
      // Started inside the repository or away from it, a session cannot read
      // all of it unless it is given it.
      addDirs: readsRepository(relation) || cwd === session.repoPath ? [] : [session.repoPath],
      claude: claude.spawn ? claudeCommand : resolveClaudeCommand(claudeCommand),
      spawn: claude.spawn
    });
    const answerer = new Answerer({
      reviewsDir,
      repoPath: session.repoPath,
      session: background,
      claudeSession: { id: found.id, title: about, relation, place }
    });
    answerer.on('partial', data => live.emit('event', session.repoPath, 'partial', data));
    answerer.on('failed', data => live.emit('event', session.repoPath, 'agent-error', data));
    answerer.on('status', status => live.emit('event', session.repoPath, 'answerer', status));
    answerer.on('stopped', () => {
      if (answerers.get(session.repoPath) === answerer) answerers.delete(session.repoPath);
      live.emit('event', session.repoPath, 'answerer', null);
    });
    answerers.set(session.repoPath, answerer);
    background.start();
    return answerer;
  }

  /** Stop the background session answering this review, if there is one. */
  app.post('/api/agent/disconnect', async (req, res) => {
    const { repoId } = req.body ?? {};
    const session = requireSession(res, repoId);
    if (!session) return;

    const answerer = await withAgentLock(session.repoPath, async () => {
      const running = answerers.get(session.repoPath);
      answerers.delete(session.repoPath);
      await running?.stop();
      return running;
    });
    live.emit('event', session.repoPath, 'answerer', null);
    res.json({ disconnected: Boolean(answerer) });
  });

  // A review's diffs are built once and searched as the reviewer types; this
  // long is long enough for a burst of typing and short enough to notice an
  // edit made since.
  const SEARCH_CACHE_MS = 15000;

  /**
   * Every changed file's diff, as the page draws it, for searching.
   *
   * @param {object} session
   * @returns {Promise<Array<{path: string, lines: object[]}>>}
   */
  async function diffsForSearch(session) {
    const cached = session.searchCache;
    if (cached && Date.now() - cached.at < SEARCH_CACHE_MS) return cached.files;

    const git = gitFactory(session.repoPath);
    const paths = session.files ?? [];
    const files = [];
    // A few at a time: a review of two hundred files should not start two
    // hundred git processes at once.
    for (let i = 0; i < paths.length; i += 8) {
      const batch = await Promise.all(paths.slice(i, i + 8).map(async filePath => {
        try {
          const diffText = await diffForFile(git, session, filePath);
          if (isBinaryDiff(diffText)) return null;
          const content = await readFileForMode(session, filePath);
          return { path: filePath, lines: parseDiff(diffText, content) };
        } catch {
          return null; // gone since the review was opened
        }
      }));
      files.push(...batch.filter(Boolean));
    }

    session.searchCache = { at: Date.now(), files };
    return files;
  }

  /**
   * Search the review: every changed file at once, and with `scope=repo` the
   * rest of the repository at the tree under review.
   *
   * `q` is the text; `mode` is contains, word, prefix, suffix or regex;
   * `case=1` matches case; `scope` is changes (lines the change added or
   * deleted), files (every line of the changed files) or repo. `symbol=1`
   * is a references search: whole word, case-sensitive, and each result is
   * marked as a definition or a use. Results say which side of the change
   * they are on, and `diffIndex` is the line's position in the diff the
   * page draws for that file.
   */
  app.get('/api/search/:repoId', async (req, res) => {
    const session = requireSession(res, req.params.repoId);
    if (!session) return;

    const pick = name => (typeof req.query[name] === 'string' ? req.query[name] : '');
    const query = pick('q');
    const symbol = pick('symbol') === '1';
    const scope = pick('scope') || 'files';
    const match = { mode: symbol ? 'word' : (pick('mode') || 'contains'), caseSensitive: symbol || pick('case') === '1' };
    if (!SCOPES.includes(scope)) {
      return res.status(400).json({ error: `Unknown scope "${scope}".` });
    }

    let matcher;
    try {
      matcher = buildMatcher(query, match);
    } catch (error) {
      if (error instanceof SearchError) return res.status(400).json({ error: error.message });
      throw error;
    }

    try {
      const started = Date.now();
      const files = await diffsForSearch(session);
      const found = searchDiffs(files, matcher, { changedOnly: scope === 'changes' });
      let { results, truncated } = found;

      if (scope === 'repo' && results.length < MAX_RESULTS) {
        const elsewhere = await grepRepository({
          repoPath: session.repoPath,
          session,
          query,
          match,
          matcher,
          exclude: new Set(files.map(file => file.path)),
          limit: MAX_RESULTS - results.length
        });
        results = results.concat(elsewhere.results);
        truncated = truncated || elsewhere.truncated;
      }

      let summary = null;
      if (symbol) {
        for (const result of results) result.role = definesName(result.text, query) ? 'definition' : 'reference';
        summary = summarizeReferences(results);
      }

      res.json({
        query,
        scope,
        mode: match.mode,
        caseSensitive: match.caseSensitive,
        symbol,
        results,
        truncated,
        files: new Set(results.map(result => result.file)).size,
        searched: files.length,
        ms: Date.now() - started,
        summary
      });
    } catch (error) {
      console.error('Search error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /** Drop a session. Saved comments on disk are left alone. */
  app.delete('/api/cleanup/:repoId', (req, res) => {
    sessions.delete(req.params.repoId);
    res.json({ message: 'Session cleaned up' });
  });

  return app;
}

/**
 * Start the server.
 *
 * Binds to loopback unless told otherwise. The server reads any file in the
 * repository under review, so reaching it should require being on the machine
 * running it; set `HOST=0.0.0.0` to opt out deliberately.
 *
 * @param {object} [options] forwarded to {@link createApp}, plus `port` and `host`
 * @returns {Promise<import('http').Server>} a listening server
 */
function startServer(options = {}) {
  const {
    port = process.env.PORT || DEFAULT_PORT,
    host = process.env.HOST || DEFAULT_HOST,
    silent = false,
    ...appOptions
  } = options;
  // Everything else in `options` -- reviewsDir, sessions, git, handoff and
  // onReviewSubmitted -- goes through to the app. Bound to loopback, the app
  // also refuses any Host but a loopback name (see `loopbackHostOnly`).
  const app = createApp({ loopbackOnly: LOOPBACK_ADDRESSES.has(host), ...appOptions });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      if (!silent) {
        console.error(`Code Reviewer server running on http://${host}:${server.address().port}`);
      }
      resolve(server);
    });
    // A background session must not outlive the server that started it.
    server.stopAgents = app.locals.stopAgents;
    server.on('close', () => { app.locals.stopAgents(); });
    server.on('error', reject);
  });
}

// Only listen when run directly; `require`ing this file just builds the app.
if (require.main === module) {
  startServer().catch(error => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
}

module.exports = { createApp, startServer, DEFAULT_PORT, DEFAULT_HOST };

// Re-exported as a getter so existing callers keep working and still see
// REVIEWER_DATA_DIR. See lib/paths.js.
Object.defineProperty(module.exports, 'REVIEWS_DIR', {
  get: resolveReviewsDir,
  enumerable: true
});
