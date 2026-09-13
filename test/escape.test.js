'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * The escaping the page depends on.
 *
 * `public/app.js` is a plain browser script rather than a module, so there is
 * nothing here to require. Lifting the one function out by name and evaluating
 * it is not elegant, but the alternative is either a DOM dependency for what is
 * a pure string function, or leaving the rule checked by hand exactly once.
 * Browser tests for the UI as a whole are #9.
 */

const APP_JS = path.join(__dirname, '..', 'public', 'app.js');

/**
 * @param {string} name a top-level `function name(...)` in public/app.js
 * @returns {Function}
 */
function loadFunction(name) {
  const source = fs.readFileSync(APP_JS, 'utf-8');
  const declaration = source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'));

  assert.ok(declaration, `no top-level function ${name} in public/app.js`);
  return new Function(`${declaration[0]}; return ${name};`)();
}

const escapeHtml = loadFunction('escapeHtml');

test('escapeHtml escapes both quote characters, not only the markup ones', () => {
  // Most callers put the result inside an attribute. The DOM's own escaping
  // leaves quotes alone, so a name containing one used to end the attribute
  // and turn the rest of the name into markup.
  assert.equal(escapeHtml('a"b'), 'a&quot;b');
  assert.equal(escapeHtml("a'b"), 'a&#39;b');
});

test('escapeHtml escapes the markup characters', () => {
  assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
});

test('escapeHtml escapes the ampersand first, so nothing is escaped twice', () => {
  // Getting this order wrong turns `&` into `&amp;` and then into
  // `&amp;amp;`, which displays the entity rather than the character.
  assert.equal(escapeHtml('&lt;'), '&amp;lt;');
  assert.equal(escapeHtml('&quot;'), '&amp;quot;');
});

test('escapeHtml leaves an ordinary filename alone', () => {
  assert.equal(escapeHtml('src/routes/checkout.js'), 'src/routes/checkout.js');
});

test('escapeHtml answers with a string for values that are not strings', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(42), '42');
});

test('a directory name cannot break out of the attribute it is written into', () => {
  // The picker writes paths into `data-open` and `title`. This is the payload
  // shape that mattered: close the attribute, open a new one.
  const hostile = '/tmp/a" onmouseover="steal()" x="';

  assert.doesNotMatch(escapeHtml(hostile), /" /);
  assert.equal(
    escapeHtml(hostile),
    '/tmp/a&quot; onmouseover=&quot;steal()&quot; x=&quot;'
  );
});
