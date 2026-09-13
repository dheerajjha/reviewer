'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { parseArgs, buildUrl, UsageError, USAGE } = require('../lib/cli');

const CWD = path.resolve('/work');

test('parseArgs defaults to serving, with no repository and an automatic browser', () => {
  assert.deepEqual(parseArgs([], CWD), {
    command: 'serve',
    repoPath: null,
    port: null,
    open: true,
    format: 'json',
    file: null,
    help: false,
    version: false
  });
});

test('parseArgs recognises the export subcommand', () => {
  const options = parseArgs(['export', 'api'], CWD);

  assert.equal(options.command, 'export');
  assert.equal(options.repoPath, path.join(CWD, 'api'));
});

test('parseArgs treats export as a subcommand only in first position', () => {
  // A directory named `export` stays reviewable as `reviewer ./export`.
  const options = parseArgs(['./export'], CWD);

  assert.equal(options.command, 'serve');
  assert.equal(options.repoPath, path.join(CWD, 'export'));
});

test('parseArgs reads the export format as a flag or inline', () => {
  assert.equal(parseArgs(['export', '--format', 'prompt'], CWD).format, 'prompt');
  assert.equal(parseArgs(['export', '-f', 'prompt'], CWD).format, 'prompt');
  assert.equal(parseArgs(['export', '--format=prompt'], CWD).format, 'prompt');
  assert.equal(parseArgs(['export'], CWD).format, 'json');
});

test('parseArgs rejects an unknown export format', () => {
  assert.throws(() => parseArgs(['export', '--format', 'yaml'], CWD), UsageError);
  assert.throws(() => parseArgs(['export', '--format'], CWD), UsageError);
});

test('parseArgs reads an export file filter as a flag or inline', () => {
  assert.equal(parseArgs(['export', '--file', 'src/auth.js'], CWD).file, 'src/auth.js');
  assert.equal(parseArgs(['export', '--file=src/auth.js'], CWD).file, 'src/auth.js');
});

test('parseArgs requires a non-empty file filter on export', () => {
  assert.throws(() => parseArgs(['export', '--file'], CWD), UsageError);
  assert.throws(() => parseArgs(['export', '--file='], CWD), UsageError);
  assert.throws(() => parseArgs(['--file', 'src/auth.js'], CWD), UsageError);
});

test('parseArgs resolves a relative repository against the working directory', () => {
  assert.equal(parseArgs(['.'], CWD).repoPath, CWD);
  assert.equal(parseArgs(['api'], CWD).repoPath, path.join(CWD, 'api'));
  assert.equal(parseArgs(['../api'], CWD).repoPath, path.resolve('/api'));
});

test('parseArgs keeps an absolute repository path', () => {
  const absolute = path.resolve('/elsewhere/api');
  assert.equal(parseArgs([absolute], CWD).repoPath, absolute);
});

test('parseArgs reads a port as a flag or inline', () => {
  assert.equal(parseArgs(['--port', '8080'], CWD).port, 8080);
  assert.equal(parseArgs(['-p', '8080'], CWD).port, 8080);
  assert.equal(parseArgs(['--port=8080'], CWD).port, 8080);
});

test('parseArgs accepts port 0, meaning any free port', () => {
  assert.equal(parseArgs(['--port', '0'], CWD).port, 0);
});

test('parseArgs rejects a port that is not a whole number in range', () => {
  for (const bad of ['80x', '-1', '70000', '', 'abc', '80.5']) {
    assert.throws(() => parseArgs(['--port', bad], CWD), UsageError, `expected "${bad}" to be rejected`);
  }
});

test('parseArgs rejects a port flag with nothing after it', () => {
  assert.throws(() => parseArgs(['--port'], CWD), UsageError);
});

test('parseArgs turns off opening a browser', () => {
  assert.equal(parseArgs(['--no-open'], CWD).open, false);
});

test('parseArgs recognises help and version', () => {
  assert.equal(parseArgs(['--help'], CWD).help, true);
  assert.equal(parseArgs(['-h'], CWD).help, true);
  assert.equal(parseArgs(['--version'], CWD).version, true);
  assert.equal(parseArgs(['-v'], CWD).version, true);
});

test('parseArgs rejects an unknown option', () => {
  assert.throws(() => parseArgs(['--frobnicate'], CWD), UsageError);
});

test('parseArgs rejects a second repository path', () => {
  // Two paths almost certainly means a typo, not an intent worth guessing at.
  assert.throws(() => parseArgs(['one', 'two'], CWD), UsageError);
});

test('parseArgs combines a path with options in any order', () => {
  const expected = { repoPath: path.join(CWD, 'api'), port: 9000, open: false };

  for (const argv of [
    ['api', '--port', '9000', '--no-open'],
    ['--port', '9000', 'api', '--no-open'],
    ['--no-open', '--port=9000', 'api']
  ]) {
    const options = parseArgs(argv, CWD);
    assert.equal(options.repoPath, expected.repoPath, argv.join(' '));
    assert.equal(options.port, expected.port, argv.join(' '));
    assert.equal(options.open, expected.open, argv.join(' '));
  }
});

test('buildUrl returns the bare origin when no repository was named', () => {
  assert.equal(buildUrl('http://127.0.0.1:4500', null), 'http://127.0.0.1:4500');
});

test('buildUrl passes the repository as an encoded query parameter', () => {
  assert.equal(
    buildUrl('http://127.0.0.1:4500', '/work/my api'),
    'http://127.0.0.1:4500/?repo=/work/my%20api'
  );
});

test('buildUrl leaves slashes alone, so the printed URL is readable', () => {
  // This URL is the most prominent thing the command prints. Percent-encoding
  // every separator made it %2F soup for no benefit: a slash is legal in a
  // query value.
  const url = buildUrl('http://127.0.0.1:4500', '/Users/you/work/api');

  assert.equal(url, 'http://127.0.0.1:4500/?repo=/Users/you/work/api');
  assert.doesNotMatch(url, /%2F/i);
  assert.equal(new URL(url).searchParams.get('repo'), '/Users/you/work/api');
});

test('buildUrl encodes characters that would otherwise split the query', () => {
  const url = buildUrl('http://127.0.0.1:4500', '/work/a&b=c?d');

  assert.equal(url, 'http://127.0.0.1:4500/?repo=/work/a%26b%3Dc%3Fd');
  assert.equal(new URL(url).searchParams.get('repo'), '/work/a&b=c?d');
});

test('the usage text documents every option the parser accepts', () => {
  for (const flag of ['--port', '--no-open', '--file', '--help', '--version']) {
    assert.ok(USAGE.includes(flag), `usage should mention ${flag}`);
  }
});

test('the usage names both commands the package installs', () => {
  assert.match(USAGE, /reviewer and git-reviewer/);
  assert.match(USAGE, /git reviewer/);
});

test('the usage promise about the default is the one the command keeps', () => {
  // This text claimed the current directory long before anything implemented
  // it. Pinning it here means the claim and the behaviour are changed
  // together or not at all.
  assert.match(USAGE, /Defaults to the current\s+directory/);
});
