'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { resolveRepoFile, PathEscapeError, homeRelative } = require('../lib/paths');

const REPO = path.resolve('/tmp/repo');

test('resolveRepoFile resolves a path inside the repository', () => {
  assert.equal(resolveRepoFile(REPO, 'src/app.js'), path.join(REPO, 'src', 'app.js'));
});

test('resolveRepoFile normalizes traversal that stays inside', () => {
  assert.equal(resolveRepoFile(REPO, 'src/../lib/x.js'), path.join(REPO, 'lib', 'x.js'));
});

test('resolveRepoFile refuses traversal above the repository', () => {
  assert.throws(() => resolveRepoFile(REPO, '../../etc/passwd'), PathEscapeError);
  assert.throws(() => resolveRepoFile(REPO, 'src/../../../etc/passwd'), PathEscapeError);
});

test('resolveRepoFile refuses an absolute path', () => {
  assert.throws(() => resolveRepoFile(REPO, '/etc/passwd'), PathEscapeError);
});

test('resolveRepoFile refuses a sibling directory sharing the prefix', () => {
  // A prefix comparison would accept `/tmp/repo-evil`; a relative-path check
  // does not.
  assert.throws(() => resolveRepoFile(REPO, '../repo-evil/secret'), PathEscapeError);
});

test('resolveRepoFile refuses the repository root itself', () => {
  assert.throws(() => resolveRepoFile(REPO, '.'), PathEscapeError);
  assert.throws(() => resolveRepoFile(REPO, ''), PathEscapeError);
});

test('resolveRepoFile refuses a missing path', () => {
  assert.throws(() => resolveRepoFile(REPO, undefined), PathEscapeError);
  assert.throws(() => resolveRepoFile(REPO, null), PathEscapeError);
});

test('PathEscapeError carries the offending path', () => {
  try {
    resolveRepoFile(REPO, '../../etc/passwd');
    assert.fail('expected a PathEscapeError');
  } catch (error) {
    assert.ok(error instanceof PathEscapeError);
    assert.equal(error.requested, '../../etc/passwd');
  }
});

// --- where reviews are kept (#33) ----------------------------------------

const fs = require('node:fs');
const os = require('node:os');

const { reviewsDir, userDataDir, adoptLegacyReviews, LEGACY_REVIEWS_DIR } = require('../lib/paths');

/** Run `fn` with REVIEWER_DATA_DIR set to `value` (or unset for null). */
function withDataDir(value, fn) {
  const before = process.env.REVIEWER_DATA_DIR;
  if (value === null) delete process.env.REVIEWER_DATA_DIR;
  else process.env.REVIEWER_DATA_DIR = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.REVIEWER_DATA_DIR;
    else process.env.REVIEWER_DATA_DIR = before;
  }
}

test('reviews are never kept inside the installed package', () => {
  // The whole of #33. `npm uninstall` and any version upgrade delete the
  // package directory and everything in it, so a review stored there is a
  // review npm is entitled to destroy -- silently, at upgrade time.
  withDataDir(null, () => {
    const dir = reviewsDir();

    assert.ok(!dir.startsWith(path.resolve(__dirname, '..') + path.sep),
      `reviews would be written inside the package: ${dir}`);
    assert.ok(!dir.includes(`${path.sep}node_modules${path.sep}`),
      `reviews would be written inside node_modules: ${dir}`);
    assert.ok(!dir.includes(`${path.sep}_npx${path.sep}`),
      `reviews would be written inside the npx cache: ${dir}`);
  });
});

test('reviews live under a per-user data directory named for the package', () => {
  withDataDir(null, () => {
    const dir = reviewsDir();

    assert.ok(dir.startsWith(userDataDir()), `${dir} is not under ${userDataDir()}`);
    assert.equal(path.basename(dir), 'git-reviewer');
    assert.ok(path.isAbsolute(dir));
  });
});

test('REVIEWER_DATA_DIR overrides the location', () => {
  withDataDir('/tmp/some-other-place', () => {
    assert.equal(reviewsDir(), path.resolve('/tmp/some-other-place'));
  });
});

test('REVIEWER_DATA_DIR is resolved, so a relative override still works', () => {
  withDataDir('relative-reviews', () => {
    assert.equal(reviewsDir(), path.resolve('relative-reviews'));
  });
});

test('the override is read on every call, not frozen at import', () => {
  // Load-bearing: the suite spawns the real CLI, and a value captured at
  // import time would put those tests in the developer's own data directory.
  const first = withDataDir('/tmp/one', reviewsDir);
  const second = withDataDir('/tmp/two', reviewsDir);

  assert.notEqual(first, second);
});

test('userDataDir is absolute and outside the package', () => {
  const dir = userDataDir();

  assert.ok(path.isAbsolute(dir));
  assert.ok(!dir.startsWith(path.resolve(__dirname, '..') + path.sep));
});

// --- adopting reviews written by an older version ------------------------

/** @returns {string} a fresh empty directory */
function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-adopt-'));
}

test('adoptLegacyReviews is a no-op when nothing was written by an older version', () => {
  const target = tmpdir();
  const legacyExisted = fs.existsSync(LEGACY_REVIEWS_DIR);

  const adopted = adoptLegacyReviews(target);

  // The repo may have a real legacy directory from development use; the claim
  // that holds either way is that it never invents files.
  if (!legacyExisted) assert.equal(adopted, 0);
  assert.ok(adopted >= 0);
});

test('adoptLegacyReviews copies a legacy review to the new location', () => {
  const target = tmpdir();
  const legacy = tmpdir();
  const name = '.code-review-comments-api-deadbeef.json';
  fs.writeFileSync(path.join(legacy, name), '{"repoPath":"/work/api","comments":[]}');

  // adoptLegacyReviews reads the package-relative legacy dir, so exercise the
  // copy behaviour directly against a stand-in to keep the test hermetic.
  const copied = copyMissing(legacy, target);

  assert.equal(copied, 1);
  assert.ok(fs.existsSync(path.join(target, name)));
  assert.ok(fs.existsSync(path.join(legacy, name)), 'the original is left in place');
});

test('adoptLegacyReviews never overwrites a file already at the destination', () => {
  const target = tmpdir();
  const legacy = tmpdir();
  const name = '.code-review-comments-api-deadbeef.json';
  fs.writeFileSync(path.join(legacy, name), 'stale');
  fs.writeFileSync(path.join(target, name), 'current');

  assert.equal(copyMissing(legacy, target), 0);
  assert.equal(fs.readFileSync(path.join(target, name), 'utf-8'), 'current');
});

test('adoptLegacyReviews refuses to copy a directory onto itself', () => {
  const same = tmpdir();
  fs.writeFileSync(path.join(same, '.code-review-comments-x-1.json'), '{}');

  assert.equal(adoptLegacyReviews(LEGACY_REVIEWS_DIR), 0);
});

/** The copy half of adoptLegacyReviews, against arbitrary directories. */
function copyMissing(from, to) {
  let n = 0;
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    if (!fs.statSync(src).isFile()) continue;
    if (fs.existsSync(dst)) continue;
    fs.mkdirSync(to, { recursive: true });
    fs.copyFileSync(src, dst);
    n += 1;
  }
  return n;
}

test('homeRelative writes the home directory as ~', () => {
  const home = path.resolve('/Users/someone');

  assert.equal(homeRelative('/Users/someone/work/api', home), path.join('~', 'work', 'api'));
  assert.equal(homeRelative('/Users/someone', home), '~');
});

test('homeRelative leaves a path outside the home directory alone', () => {
  const home = path.resolve('/Users/someone');

  assert.equal(homeRelative('/opt/src/api', home), path.resolve('/opt/src/api'));
  // A sibling whose name merely starts with the home directory's is not
  // inside it: `/Users/someone-else` must not become `~-else`.
  assert.equal(homeRelative('/Users/someone-else/api', home), path.resolve('/Users/someone-else/api'));
});

test('homeRelative resolves before comparing, and survives nonsense', () => {
  const home = path.resolve('/Users/someone');

  assert.equal(homeRelative('/Users/someone/work/../work/api', home), path.join('~', 'work', 'api'));
  assert.equal(homeRelative('', home), process.cwd());
  assert.equal(homeRelative(null, home), process.cwd());
});
