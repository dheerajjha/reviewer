'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * The merge the page runs when a save is refused as stale (#107).
 *
 * Like the escaping tests, this lifts the functions out of
 * `public/app.js` by name: the script is not a module, and the merge is a
 * pure function of three lists, so it can be checked without a DOM.
 */

const APP_JS = path.join(__dirname, '..', 'public', 'app.js');

/**
 * @param {string[]} names top-level `function name(...)`s in public/app.js
 * @returns {Function} the last function named, with the earlier ones in scope
 */
function loadFunctions(names) {
  const source = fs.readFileSync(APP_JS, 'utf-8');
  const declarations = names.map(name => {
    const declaration = source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'));
    assert.ok(declaration, `no top-level function ${name} in public/app.js`);
    return declaration[0];
  });
  return new Function(`${declarations.join('\n')}; return ${names[names.length - 1]};`)();
}

const mergeCommentsForRetry = loadFunctions(['commentKey', 'followUpIdentity', 'unionFollowUps', 'toPersistedComment', 'mergeCommentsForRetry']);

const comment = (text, extra = {}) => ({ file: 'app.js', line: 1, lineContent: 'a', text, ...extra });
const texts = comments => comments.map(entry => entry.text);

test('a merge keeps both the comment that arrived and the local one', () => {
  const merged = mergeCommentsForRetry(
    [comment('from this tab')],
    [],
    [comment('from the other tab')]
  );

  assert.deepEqual(texts(merged), ['from the other tab', 'from this tab']);
});

test('a merge does not duplicate a comment both sides hold', () => {
  const shared = comment('shared');

  const merged = mergeCommentsForRetry([shared], [shared], [shared]);

  assert.deepEqual(texts(merged), ['shared']);
});

test('a comment deleted in this tab stays deleted when the other side still holds it', () => {
  const doomed = comment('deleted here');
  const kept = comment('kept');

  const merged = mergeCommentsForRetry([kept], [doomed, kept], [doomed, kept]);

  assert.deepEqual(texts(merged), ['kept']);
});

test('a comment deleted elsewhere stays deleted when this tab did not touch it', () => {
  const doomed = comment('deleted there');
  const kept = comment('kept');

  const merged = mergeCommentsForRetry([doomed, kept], [doomed, kept], [kept]);

  assert.deepEqual(texts(merged), ['kept']);
});

test('a follow-up added here survives a merge against the older remote copy', () => {
  const base = comment('noted');
  const edited = comment('noted', { followUps: [{ text: 'still open' }] });

  const merged = mergeCommentsForRetry([edited], [base], [base]);

  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].followUps, [{ text: 'still open' }]);
});

test('a comment changed here is not dropped when it was deleted elsewhere', () => {
  const base = comment('noted');
  const edited = comment('noted', { followUps: [{ text: 'still open' }] });

  const merged = mergeCommentsForRetry([edited], [base], []);

  assert.deepEqual(texts(merged), ['noted']);
  assert.deepEqual(merged[0].followUps, [{ text: 'still open' }]);
});

// Agents answer in threads by adding follow-ups from outside the page. The
// merge is what puts those answers in front of the reviewer, and what must
// never let a save from this tab take one back out.

const keyed = (key, text, extra = {}) => ({ key, file: 'app.js', line: 1, lineContent: 'a', text, ...extra });
const answer = { key: 'f-answer', text: 'It is inclusive on purpose.', timestamp: '2026-10-24T10:00:05.000Z', by: 'claude' };
const question = { key: 'f-question', text: 'Why inclusive?', timestamp: '2026-10-24T10:00:00.000Z' };

test('an answer added elsewhere to a thread this tab has not touched is taken as it stands', () => {
  const base = keyed('k1', 'expiry check');
  const remote = keyed('k1', 'expiry check', { followUps: [answer] });

  const merged = mergeCommentsForRetry([{ ...base, diffLineIndex: 4 }], [base], [remote]);

  assert.deepEqual(merged[0].followUps, [answer]);
  assert.equal(merged[0].diffLineIndex, 4, 'where this tab drew the comment is kept');
});

test('an answer added elsewhere survives a follow-up added here to the same thread', () => {
  const base = keyed('k1', 'expiry check', { followUps: [question] });
  const mine = { key: 'f-mine', text: 'Also, what about time zones?', timestamp: '2026-10-24T10:00:09.000Z' };
  const local = keyed('k1', 'expiry check', { followUps: [question, mine] });
  const remote = keyed('k1', 'expiry check', { followUps: [question, answer] });

  const merged = mergeCommentsForRetry([local], [base], [remote]);

  assert.deepEqual(merged[0].followUps.map(f => f.key), ['f-question', 'f-answer', 'f-mine'],
    'both are kept, in the order they were written');
});

test('an edit made here keeps its text and still picks up the answer', () => {
  const base = keyed('k1', 'expiry chek');
  const local = keyed('k1', 'expiry check');
  const remote = keyed('k1', 'expiry chek', { followUps: [answer] });

  const merged = mergeCommentsForRetry([local], [base], [remote]);

  assert.equal(merged[0].text, 'expiry check');
  assert.deepEqual(merged[0].followUps, [answer]);
});

test('two comments with the same text on one line stay two comments', () => {
  const one = keyed('k1', 'same');
  const two = keyed('k2', 'same');

  const merged = mergeCommentsForRetry([one], [one], [one, two]);

  assert.deepEqual(merged.map(c => c.key), ['k1', 'k2']);
});
