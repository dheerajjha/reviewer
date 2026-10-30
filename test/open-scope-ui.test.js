'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * What the page opens on, read from its URL: --range, --base, --commit and
 * --last-commit put it there, and a copied link carries it to someone else.
 * Lifted out of public/app.js the way commits-ui.test.js lifts orderedRun.
 */

const APP_JS = path.join(__dirname, '..', 'public', 'app.js');

function lift(name) {
  const code = fs.readFileSync(APP_JS, 'utf-8');
  const match = code.match(new RegExp(`function ${name}\\([^{]*\\{([\\s\\S]*?\\n\\})`));
  if (!match) throw new Error(`Could not find ${name} in app.js`);
  return vm.runInContext(`${match[0]}\n\n${name};`, vm.createContext({ URLSearchParams }));
}

const scopeFromSearch = lift('scopeFromSearch');
// Objects made in another context have their own prototypes, and strict
// deepEqual compares prototypes, so compare plain copies.
const plain = value => JSON.parse(JSON.stringify(value));

test('a base opens a comparison against HEAD unless the link names a head', () => {
  assert.deepEqual(plain(scopeFromSearch('?repo=/w&base=origin/main')), { base: 'origin/main', head: 'HEAD' });
  assert.deepEqual(plain(scopeFromSearch('?repo=/w&base=main&head=feature/auth')), { base: 'main', head: 'feature/auth' });
});

test('a commit opens that commit on its own, as clicking it in the list does', () => {
  assert.deepEqual(plain(scopeFromSearch('?repo=/w&commit=06d0837')), { commits: { from: '06d0837', to: '06d0837' } });
  assert.deepEqual(plain(scopeFromSearch('?repo=/w&commit=HEAD')), { commits: { from: 'HEAD', to: 'HEAD' } });
});

test('a ref keeps its slashes and decodes what was encoded', () => {
  assert.deepEqual(plain(scopeFromSearch('?base=feature/a%20b')), { base: 'feature/a b', head: 'HEAD' });
});

test('with neither, the page opens its usual view', () => {
  assert.deepEqual(plain(scopeFromSearch('?repo=/w')), {});
  assert.deepEqual(plain(scopeFromSearch('')), {});
});
