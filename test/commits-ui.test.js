'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * The commits list's arithmetic, lifted out of public/app.js the way
 * shortcuts.test.js lifts getKeyboardShortcut: the page has no module system,
 * and these three are pure enough to run on their own.
 */

const APP_JS = path.join(__dirname, '..', 'public', 'app.js');

function lift(name) {
  const code = fs.readFileSync(APP_JS, 'utf-8');
  const match = code.match(new RegExp(`function ${name}\\([^{]*\\{([\\s\\S]*?\\n\\})`));
  if (!match) throw new Error(`Could not find ${name} in app.js`);
  return vm.runInContext(`${match[0]}\n\n${name};`, vm.createContext({}));
}

const orderedRun = lift('orderedRun');
const stepIndex = lift('stepIndex');
const compactWhen = lift('compactWhen');
const chronologicalCommits = lift('chronologicalCommits');

const OLDEST_FIRST = [{ sha: 'a' }, { sha: 'b' }, { sha: 'c' }, { sha: 'd' }];

// Arrays made inside the vm context carry that realm's Array prototype, and
// strict deepEqual compares prototypes -- so identical values fail. Bring
// them into this realm before comparing.
const plain = value => JSON.parse(JSON.stringify(value));

test('a run is the same whichever end was clicked first', () => {
  assert.deepEqual(plain(orderedRun(OLDEST_FIRST, 'b', 'd')), ['b', 'd']);
  assert.deepEqual(plain(orderedRun(OLDEST_FIRST, 'd', 'b')), ['b', 'd'], 'shift-click upwards');
  assert.deepEqual(plain(orderedRun(OLDEST_FIRST, 'c', 'c')), ['c', 'c']);
});

test('a run with an end the list does not have is refused rather than guessed', () => {
  assert.equal(orderedRun(OLDEST_FIRST, 'a', 'zzz'), null);
});

test('stepping from all commits starts at the beginning of the story, or the end', () => {
  assert.equal(stepIndex(4, -1, 1), 0, 'forward from "all" is the oldest');
  assert.equal(stepIndex(4, -1, -1), 3, 'back from "all" is the newest');
});

test('stepping moves one commit and stops at the ends instead of wrapping', () => {
  assert.equal(stepIndex(4, 1, 1), 2);
  assert.equal(stepIndex(4, 1, -1), 0);
  assert.equal(stepIndex(4, 3, 1), -1, 'no wrapping past the newest');
  assert.equal(stepIndex(4, 0, -1), -1, 'no wrapping past the oldest');
  assert.equal(stepIndex(0, -1, 1), -1, 'nothing to step through');
});

test('a history list shown newest first is still stepped in time order', () => {
  const history = { order: 'newest-first', commits: [{ sha: 'd' }, { sha: 'c' }, { sha: 'b' }] };
  assert.deepEqual(plain(chronologicalCommits(history).map(c => c.sha)), ['b', 'c', 'd']);
  assert.deepEqual(plain(chronologicalCommits({ order: 'oldest-first', commits: OLDEST_FIRST })), OLDEST_FIRST);
  assert.deepEqual(plain(chronologicalCommits(null)), []);
});

test('git relative dates are shortened for the list, and anything odd is left alone', () => {
  assert.equal(compactWhen('2 seconds ago'), '2s');
  assert.equal(compactWhen('1 minute ago'), '1m');
  assert.equal(compactWhen('5 hours ago'), '5h');
  assert.equal(compactWhen('3 days ago'), '3d');
  assert.equal(compactWhen('2 weeks ago'), '2w');
  assert.equal(compactWhen('4 months ago'), '4mo');
  assert.equal(compactWhen('1 year, 2 months ago'), '1y');
  assert.equal(compactWhen('in the future'), 'in the future', 'not recognised, not guessed');
});
