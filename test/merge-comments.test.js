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

const mergeCommentsForRetry = loadFunctions(['commentKey', 'toPersistedComment', 'mergeCommentsForRetry']);

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
