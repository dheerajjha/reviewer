'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/**
 * The README carries a hand-maintained test-count badge, and a hand-maintained
 * number in a published artifact goes stale. It already has: the most recent
 * commit on `main` before this one exists solely to correct it after #13.
 *
 * The count here is of `test(...)` declarations, which is what a reader of the
 * badge means by "tests". Note that `node --test` reports one *more* than this,
 * because it treats every `.js` file under `test/` as a test file and scores
 * `test/helpers/repo.js` — a helper with no assertions in it — as a passing
 * test. Copying that number into the badge would advertise a test that does not
 * exist, so the badge tracks declarations and this test explains the gap rather
 * than encoding it.
 */

const TEST_DIR = __dirname;
const README = path.join(__dirname, '..', 'README.md');

/**
 * Count the tests declared across the suite.
 *
 * Declarations start a line, which is the house style throughout `test/`. A
 * declaration written some other way is undercounted and this test fails —
 * noisily, and in the direction that gets looked at, rather than silently
 * blessing a wrong badge.
 *
 * @returns {number}
 */
function countDeclaredTests() {
  return fs
    .readdirSync(TEST_DIR)
    .filter(entry => entry.endsWith('.test.js'))
    .reduce((total, entry) => {
      const source = fs.readFileSync(path.join(TEST_DIR, entry), 'utf-8');
      return total + (source.match(/^test\(/gm)?.length ?? 0);
    }, 0);
}

test('the README test-count badge matches the suite', () => {
  const readme = fs.readFileSync(README, 'utf-8');
  const badge = readme.match(/badge\/tests-(\d+)-/);

  assert.ok(badge, 'README has no tests badge for this test to check');

  const declared = countDeclaredTests();
  assert.equal(
    Number(badge[1]),
    declared,
    `README badge says ${badge[1]} tests, the suite declares ${declared}. ` +
      'Update the badge in README.md to match. Use this number, not the count ' +
      '`node --test` prints — that one is one higher, because it counts ' +
      'test/helpers/repo.js as a test.'
  );
});
