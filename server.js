'use strict';

const express = require('express');
const cors = require('cors');
const simpleGit = require('simple-git');
const fs = require('fs').promises;
const path = require('path');

const { parseDiff } = require('./lib/diff');
const {
  reviewsDir: resolveReviewsDir,
  resolveRepoFile,
  PathEscapeError
} = require('./lib/paths');
const { collectWorkingChanges, collectCommitChanges } = require('./lib/changes');
const { SessionStore } = require('./lib/sessions');
const { normalizeComments } = require('./lib/comments');
const { formatReview, reviewFilename, commentsFilename } = require('./lib/review');
const { buildReviewDocument } = require('./lib/agent');
const { readSavedComments, ReviewOwnershipError } = require('./lib/store');
const { repoRoot } = require('./lib/repo');
const { browse } = require('./lib/browse');
const { recordRecent, describeRecents } = require('./lib/recents');
const { listReviews } = require('./lib/export');

const DEFAULT_PORT = 4500;
const DEFAULT_HOST = '127.0.0.1';


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
 * @returns {import('express').Express}
 */
function createApp(options = {}) {
  const {
    reviewsDir = resolveReviewsDir(),
    sessions = new SessionStore(),
    git: gitFactory = simpleGit,
    onReviewSubmitted = null,
    handoff = false,
    onIdle = null,
    idleGraceMs = 5000
  } = options;

  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  app.locals.sessions = sessions;
  app.locals.reviewsDir = reviewsDir;

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

    if (session.range) {
      try {
        return await git.show([`${session.range.head}:${filePath}`]);
      } catch {
        return await fs.readFile(absolutePath, 'utf-8').catch(() => '');
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
    if (session.range) {
      return git.diff([session.range.base, session.range.head, '--', filePath]);
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

    const resolve = async (label, ref) => {
      try {
        return (await git.revparse([`${ref}^{commit}`])).trim();
      } catch {
        throw new Error(`No commit or branch called "${ref}" in this repository.`);
      }
    };

    const baseSha = await resolve('base', base);
    const headSha = await resolve('head', head);

    // `base..head` counts what head has and base does not, which is the
    // number a reviewer means by "how many commits am I looking at". It is
    // not symmetric, and it is not the same as the file count -- a range
    // whose changes cancel out has commits and no files, which is the whole
    // reason this number is reported.
    const commits = Number(
      (await git.raw(['rev-list', '--count', `${baseSha}..${headSha}`])).trim()
    );

    return { base: baseSha, head: headSha, commits: Number.isFinite(commits) ? commits : 0 };
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
    const commits = `${range.commits} commit${range.commits === 1 ? '' : 's'}`;

    if (fileCount === 0) {
      return range.commits === 0
        ? 'Those two commits are the same, so there is nothing between them.'
        : `${commits}, and no net change between the two ends — every change in them was undone again inside the range.`;
    }

    return `${commits}, ${fileCount} changed file${fileCount === 1 ? '' : 's'} between the two ends`;
  }

  /** Liveness probe, and a count of how many repositories are open. */
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', sessions: sessions.size });
  });

  /**
   * Refuse a request a browser has marked as coming from somewhere else.
   *
   * `cors()` above is open, deliberately, and that is a settled decision this
   * does not reopen. It is a rule for the two endpoints below, which differ
   * from every other one in kind: they enumerate directories and name
   * projects, rather than answering about a repository whose path the caller
   * already had. A browser sends `Origin` on exactly the requests where that
   * distinction matters and omits it on same-origin GETs, so the page keeps
   * working and a page on another site does not. Anything that is not a
   * browser can read these directories without asking this server anyway.
   */
  function sameOriginOnly(req, res, next) {
    const origin = req.get('origin');

    if (origin && origin !== `http://${req.headers.host}`) {
      return res.status(403).json({ error: 'Not available to another origin' });
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
   * clears. `sameOriginOnly` is here for the same reason it is on the two
   * below: without it a page on another site could hold this open and keep a
   * server alive that its owner had finished with.
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
  app.get('/api/alive', sameOriginOnly, (req, res) => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    watching += 1;

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    // A comment frame, which EventSource ignores. Sending it now is what
    // flushes the headers, so the client is connected rather than pending.
    res.write(': watching\n\n');

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
  });

  /** List the directories inside one, so a repository can be found by looking. */
  app.get('/api/browse', sameOriginOnly, async (req, res) => {
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
  app.get('/api/recent', sameOriginOnly, async (req, res) => {
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
      const { base, head } = req.body ?? {};
      const root = await repoRoot(repoPath, gitFactory);
      if (!root) {
        return res.status(400).json({ error: 'Not a valid git repository' });
      }

      const git = gitFactory(root);

      let files;
      let mode;
      let range = null;
      let message;

      if (base !== undefined && base !== null && `${base}`.trim() !== '') {
        // An explicit range. Nothing falls back to anything here: someone who
        // asked for x1..x3 and is silently shown their working tree instead
        // has been told a lie about what they are reviewing.
        try {
          range = await resolveRange(git, `${base}`.trim(), `${head ?? 'HEAD'}`.trim());
        } catch (error) {
          return res.status(400).json({ error: error.message });
        }

        files = collectCommitChanges(await git.diffSummary([range.base, range.head]));
        mode = 'range';
        message = describeRange(range, files.length);
      } else {
        files = collectWorkingChanges(await git.status());
        mode = 'working';
        message = `Found ${files.length} changed file(s)`;

        // A clean tree has nothing to review, so fall back to the last commit.
        if (files.length === 0) {
          try {
            const lastCommit = await resolveRange(git, 'HEAD~1', 'HEAD');
            const commitFiles = collectCommitChanges(
              await git.diffSummary([lastCommit.base, lastCommit.head])
            );
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

      const repoId = sessions.create(root, mode, range);
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
      res.json({ repoId, files, repoPath: root, mode, range, message });
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

  /** Persist the current comments. Called on every edit. */
  app.post('/api/save-comments', async (req, res) => {
    try {
      const { repoId, comments } = req.body ?? {};
      const session = requireSession(res, repoId);
      if (!session) return;

      let normalized;
      try {
        normalized = normalizeComments(comments);
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }

      await fs.mkdir(reviewsDir, { recursive: true });

      // `mode` is on the envelope rather than on each comment: it describes
      // the review, not any one remark in it, and it is what lets `reviewer
      // export` say what was compared. Without it an exported review could
      // only report where HEAD is, which says nothing about whether the
      // comments are about committed work or uncommitted work.
      const data = {
        repoPath: session.repoPath,
        lastUpdated: new Date().toISOString(),
        mode: session.mode,
        range: session.range,
        comments: normalized
      };

      const target = path.join(reviewsDir, commentsFilename(session.repoPath));
      await fs.writeFile(target, `${JSON.stringify(data, null, 2)}\n`);

      res.json({ message: 'Comments saved successfully' });
    } catch (error) {
      console.error('Save comments error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /** Restore comments saved by an earlier session. */
  app.get('/api/load-comments/:repoId', async (req, res) => {
    try {
      const session = requireSession(res, req.params.repoId);
      if (!session) return;

      const { comments } = await readSavedComments(reviewsDir, session.repoPath);
      res.json({ comments });
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
      const { comments } = await readSavedComments(reviewsDir, session.repoPath);

      if (comments.length === 0) {
        return res.status(400).json({
          error: 'No comments found. Please add comments before submitting review.'
        });
      }

      const generatedAt = new Date();
      const reviewContent = formatReview({ repoPath: session.repoPath, comments, generatedAt });
      const filename = reviewFilename(session.repoPath, generatedAt);

      // The commit is worth recording for anything acting on the review later:
      // it is how a consumer tells whether the tree has moved on since.
      const git = gitFactory(session.repoPath);
      const head = await git.revparse(['HEAD']).then(sha => sha.trim()).catch(() => null);
      const branch = await git.revparse(['--abbrev-ref', 'HEAD']).then(name => name.trim()).catch(() => null);

      const document = buildReviewDocument({
        repoPath: session.repoPath,
        comments,
        generatedAt,
        head,
        branch,
        mode: session.mode,
        range: session.range
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
  // onReviewSubmitted -- goes through to the app.
  const app = createApp(appOptions);

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      if (!silent) {
        console.error(`Code Reviewer server running on http://${host}:${server.address().port}`);
      }
      resolve(server);
    });
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
