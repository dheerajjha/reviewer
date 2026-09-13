'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const os = require('node:os');

// Point the whole process -- and every CLI it spawns, which inherit this env
// -- at a throwaway directory. These tests write real review files, and since
// #33 the default location is the developer's own data directory. Set before
// `../server` is required, and read on every access, so both this file and the
// child processes resolve to the same throwaway.
process.env.REVIEWER_DATA_DIR = fsSync.mkdtempSync(path.join(os.tmpdir(), 'reviewer-bin-'));

const { createTempRepo, createTempDir, writeFiles, commitFiles, cleanup } =
  require('./helpers/repo');
const { commentsFilename } = require('../lib/review');
const { REVIEWS_DIR } = require('../server');

/**
 * Smoke tests for the `reviewer` command itself.
 *
 * The unit tests cover argument parsing without loading this file, so nothing
 * else would notice if the entry point stopped starting — a syntax error in it
 * once slipped through exactly that gap.
 */

const BIN = path.join(__dirname, '..', 'bin', 'reviewer.js');

/**
 * Run the command and capture how it exited.
 *
 * @param {string[]} args
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function run(args, { cwd } = {}) {
  return new Promise(resolve => {
    execFile(process.execPath, [BIN, ...args], { timeout: 20000, cwd }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

/**
 * Start the command on a free port and wait for its banner.
 *
 * The banner is read from **stderr**, which is where everything this command
 * says to a person goes. stdout carries the finished review, so that a review
 * can be piped straight into a coding agent -- see the handoff tests below.
 *
 * Resolves on the last line of the banner rather than the first match for a
 * URL, so the whole of it is readable by the caller without a race.
 *
 * @param {string[]} args
 * @param {object} [options]
 * @param {string} [options.cwd] directory to run from
 * @returns {Promise<{url: string, output: string, stdout: () => string,
 *   child: import('node:child_process').ChildProcess}>}
 */
function serve(args, { cwd } = {}) {
  const child = require('node:child_process').spawn(
    process.execPath,
    [BIN, ...args, '--no-open', '--port', '0'],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let piped = '';
  child.stdout.on('data', chunk => { piped += chunk; });

  return new Promise((resolve, reject) => {
    let output = '';
    const ready = /Press Ctrl\+C|written here/;
    const timer = setTimeout(() => reject(new Error(`no banner in output: ${output}`)), 15000);

    child.stderr.on('data', chunk => {
      output += chunk;
      if (!ready.test(output)) return;

      clearTimeout(timer);
      resolve({
        url: output.match(/http:\/\/127\.0\.0\.1:\d+\S*/)[0],
        output,
        stdout: () => piped,
        child
      });
    });
    child.on('error', reject);
  });
}

/**
 * Save the comment state consumed by `reviewer export`.
 *
 * @param {string} repoPath
 * @param {object[]} comments
 * @returns {Promise<string>} file to remove after the test
 */
async function saveComments(repoPath, comments) {
  await fs.mkdir(REVIEWS_DIR, { recursive: true });
  const target = path.join(REVIEWS_DIR, commentsFilename(repoPath));
  await fs.writeFile(target, JSON.stringify({ comments }));
  return target;
}

test('--help prints usage and exits cleanly', async () => {
  const { code, stdout } = await run(['--help']);

  assert.equal(code, 0);
  assert.match(stdout, /Usage:\s+reviewer/);
  assert.match(stdout, /--no-open/);
});

test('--version prints the version from package.json', async () => {
  const { version } = require('../package.json');
  const { code, stdout } = await run(['--version']);

  assert.equal(code, 0);
  assert.equal(stdout.trim(), version);
});

test('an unknown option exits 2 with usage on stderr', async () => {
  const { code, stderr } = await run(['--frobnicate']);

  assert.equal(code, 2);
  assert.match(stderr, /Unknown option: --frobnicate/);
  assert.match(stderr, /Usage:/);
});

test('a bad port exits 2', async () => {
  const { code, stderr } = await run(['--port', 'abc']);

  assert.equal(code, 2);
  assert.match(stderr, /must be a number/);
});

test('a repository path that does not exist exits 2', async () => {
  const { code, stderr } = await run([path.join('/no', 'such', 'directory'), '--no-open']);

  assert.equal(code, 2);
  assert.match(stderr, /No such directory/);
});

test('export refuses when the repository has no saved review', async t => {
  const repoPath = await createTempRepo();
  t.after(() => cleanup(repoPath));

  const { code, stderr } = await run(['export', repoPath]);

  assert.equal(code, 2);
  assert.match(stderr, /No saved review/);
});

test('export --file emits only that file and recounts the summary', async t => {
  const repoPath = await createTempRepo();
  t.after(() => cleanup(repoPath));

  const saved = await saveComments(repoPath, [
    { file: 'src/auth.js', line: 3, lineContent: 'const token = read();', text: 'Check this.' },
    { file: 'src/cache.js', line: 8, lineContent: 'cache.clear();', text: 'Why here?' }
  ]);
  t.after(() => fs.rm(saved, { force: true }));

  const { code, stdout, stderr } = await run([
    'export',
    repoPath,
    '--file',
    'src/auth.js'
  ]);

  assert.equal(code, 0, stderr);
  const document = JSON.parse(stdout);
  assert.deepEqual(document.summary, { comments: 1, files: 1 });
  assert.deepEqual(document.comments.map(comment => comment.file), ['src/auth.js']);
  assert.doesNotMatch(stdout, /src\/cache\.js/);
});

test('export --file refuses when that file has no comments', async t => {
  const repoPath = await createTempRepo();
  t.after(() => cleanup(repoPath));

  const saved = await saveComments(repoPath, [
    { file: 'src/auth.js', line: 3, lineContent: 'const token = read();', text: 'Check this.' }
  ]);
  t.after(() => fs.rm(saved, { force: true }));

  const { code, stdout, stderr } = await run([
    'export',
    repoPath,
    '--file',
    'src/missing.js'
  ]);

  assert.equal(code, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /no comments for src\/missing\.js/);
});

test('it serves the repository it was pointed at, then stops on SIGINT', async t => {
  const repoPath = await createTempRepo();
  t.after(() => cleanup(repoPath));

  await commitFiles(repoPath, { 'app.js': 'a\n' }, 'initial');

  // Port 0 keeps concurrent test runs from colliding.
  const child = require('node:child_process').spawn(
    process.execPath,
    [BIN, repoPath, '--no-open', '--port', '0'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  t.after(() => child.kill('SIGKILL'));

  const url = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`no URL in output: ${output}`)), 15000);

    // stderr: stdout is reserved for the review itself.
    child.stderr.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\S*/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.on('error', reject);
  });

  // The URL carries the repository, so the page loads it without being typed.
  assert.equal(new URL(url).searchParams.get('repo'), repoPath);

  const health = await fetch(`${new URL(url).origin}/api/health`);
  assert.equal(health.status, 200);

  const exited = new Promise(resolve => child.on('exit', resolve));
  child.kill('SIGINT');
  await exited;
});

test('the package installs the command under both of its names', () => {
  // The package is published as `git-reviewer`, so `git-reviewer` is what a
  // reader of the install line types next — and until this entry existed, that
  // was a command not found. The second name also makes git dispatch to it, so
  // `git reviewer` works the way any other git subcommand does.
  assert.deepEqual(require('../package.json').bin, {
    reviewer: 'bin/reviewer.js',
    'git-reviewer': 'bin/reviewer.js'
  });
});

test('with no repository it reviews the one you are standing in', async t => {
  const repoPath = await createTempRepo();
  t.after(() => cleanup(repoPath));
  await commitFiles(repoPath, { 'app.js': 'a\n' }, 'initial');

  const { url, output, child } = await serve([], { cwd: repoPath });
  t.after(() => child.kill('SIGKILL'));

  // `--help` had promised this since the first release. What actually
  // happened was a page with an empty path box waiting to be typed into.
  assert.equal(new URL(url).searchParams.get('repo'), repoPath);
  assert.ok(output.includes(repoPath), `banner does not name the repository: ${output}`);
});

test('from a subdirectory it reviews the repository, not the subdirectory', async t => {
  const repoPath = await createTempRepo();
  t.after(() => cleanup(repoPath));
  await commitFiles(repoPath, { 'src/deep/app.js': 'a\n' }, 'initial');

  const { url, child } = await serve([], { cwd: path.join(repoPath, 'src', 'deep') });
  t.after(() => child.kill('SIGKILL'));

  assert.equal(new URL(url).searchParams.get('repo'), repoPath);
});

test('outside a repository it opens the page on its picker', async t => {
  const plain = await createTempDir();
  t.after(() => cleanup(plain));

  const { url, child } = await serve([], { cwd: plain });
  t.after(() => child.kill('SIGKILL'));

  // Naming a directory and defaulting to one are answered differently. Nobody
  // asked for this directory in particular, so there is nothing to report as
  // an error: the page opens where it always did.
  assert.equal(new URL(url).searchParams.get('repo'), null);
});

test('export run from a subdirectory finds the repository review', async t => {
  const repoPath = await createTempRepo();
  t.after(() => cleanup(repoPath));
  await commitFiles(repoPath, { 'src/deep/app.js': 'a\n' }, 'initial');

  const saved = await saveComments(repoPath, [
    { file: 'src/deep/app.js', line: 1, lineContent: 'a', text: 'Check this.' }
  ]);
  t.after(() => fs.rm(saved, { force: true }));

  // Reviews are filed under the repository root. Exporting from one directory
  // down used to report that the repository had no review at all, which broke
  // the loop the README leads with.
  const { code, stdout, stderr } = await run(['export'], {
    cwd: path.join(repoPath, 'src', 'deep')
  });

  assert.equal(code, 0, stderr);
  assert.equal(JSON.parse(stdout).repository.path, repoPath);
});

/**
 * Handing a finished review back to the terminal.
 *
 * The point of all of this is one line:
 *
 *     reviewer | claude -p "Apply this review."
 *
 * which only works if stdout carries the review and nothing else. Everything
 * the command says to a person goes to stderr, and a spawned child's stdout is
 * always a pipe, so these tests are in the handing-off case by construction.
 */

/**
 * Submit a review through the running server, the way the browser does.
 *
 * @param {string} origin
 * @param {string} repoPath
 * @param {object[]} comments
 */
async function submitThrough(origin, repoPath, comments) {
  const { repoId } = await (await fetch(`${origin}/api/load-repo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoPath })
  })).json();

  await fetch(`${origin}/api/save-comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoId, comments })
  });

  return (await fetch(`${origin}/api/submit-review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoId })
  })).json();
}

test('submitting a review writes it to stdout and the command exits', async t => {
  const repoPath = await createTempRepo();
  t.after(() => cleanup(repoPath));
  await commitFiles(repoPath, { 'app.js': 'one\n' }, 'initial');
  await writeFiles(repoPath, { 'app.js': 'one\ntwo\n' });

  const { url, child, stdout } = await serve([repoPath]);
  t.after(() => child.kill('SIGKILL'));

  const exited = new Promise(resolve => child.on('exit', resolve));
  await submitThrough(new URL(url).origin, repoPath, [
    { file: 'app.js', line: 2, lineContent: 'two', text: 'Needs a test.' }
  ]);

  assert.equal(await exited, 0, 'the command finishes once the review is out');

  const piped = stdout();
  assert.match(piped, /^# Code review to address/);
  assert.match(piped, /Needs a test\./);
  assert.match(piped, /app\.js/);
});

test('nothing but the review reaches stdout', async t => {
  const repoPath = await createTempRepo();
  t.after(() => cleanup(repoPath));
  await commitFiles(repoPath, { 'app.js': 'one\n' }, 'initial');
  await writeFiles(repoPath, { 'app.js': 'one\ntwo\n' });

  const { url, child, stdout, output } = await serve([repoPath]);
  t.after(() => child.kill('SIGKILL'));

  const exited = new Promise(resolve => child.on('exit', resolve));
  await submitThrough(new URL(url).origin, repoPath, [
    { file: 'app.js', line: 2, lineContent: 'two', text: 'Needs a test.' }
  ]);
  await exited;

  // Every one of these used to be written to stdout, and each would have
  // landed in the middle of whatever the review was piped into.
  for (const chatter of ['Code Reviewer', 'reviewing ', 'Loaded repository', 'Review generated']) {
    assert.doesNotMatch(stdout(), new RegExp(chatter), `stdout carries "${chatter}"`);
  }

  // They are not lost, just addressed to the person rather than to the pipe.
  assert.match(output + '', /Code Reviewer/);
});

test('the banner says the review will be written out, when something is reading', async t => {
  const repoPath = await createTempRepo();
  t.after(() => cleanup(repoPath));
  await commitFiles(repoPath, { 'app.js': 'a\n' }, 'initial');

  const { output, child } = await serve([repoPath]);
  t.after(() => child.kill('SIGKILL'));

  // "Press Ctrl+C to stop" is the wrong thing to say to someone who is waiting
  // for a pipe to deliver: stopping is exactly what they must not do.
  assert.match(output, /written here/);
  assert.doesNotMatch(output, /Press Ctrl\+C/);
});

test('stopping without submitting leaves stdout empty rather than half a review', async t => {
  const repoPath = await createTempRepo();
  t.after(() => cleanup(repoPath));
  await commitFiles(repoPath, { 'app.js': 'a\n' }, 'initial');

  const { child, stdout } = await serve([repoPath]);
  const exited = new Promise(resolve => child.on('exit', resolve));
  child.kill('SIGINT');
  await exited;

  assert.equal(stdout(), '');
});
