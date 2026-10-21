'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * Whether the first-run help opens, lifted out of public/app.js the way
 * commits-ui.test.js lifts orderedRun. The page has no module system, and
 * this decision is pure enough to run without a browser.
 */

const APP_JS = path.join(__dirname, '..', 'public', 'app.js');

function lift(name) {
  const code = fs.readFileSync(APP_JS, 'utf-8');
  const match = code.match(new RegExp(`function ${name}\\([^{]*\\{([\\s\\S]*?\\n\\})`));
  if (!match) throw new Error(`Could not find ${name} in app.js`);
  // An empty vm context has the language builtins and not the host ones, so
  // the page's URLSearchParams has to be handed in. The browser already has it.
  return vm.runInContext(`${match[0]}\n\n${name};`, vm.createContext({ URLSearchParams }));
}

const shouldOfferHelp = lift('shouldOfferHelp');

test('intro=0 keeps the first-run help closed, even in a browser that has never seen it', () => {
  assert.equal(shouldOfferHelp('?intro=0', false), false);
  assert.equal(shouldOfferHelp('?repo=/work/api&intro=0', false), false);
  assert.equal(shouldOfferHelp('intro=0', true), false);
});

test('without intro=0 the help still opens once, and only until it has been seen', () => {
  assert.equal(shouldOfferHelp('?repo=/work/api', false), true);
  assert.equal(shouldOfferHelp('', false), true);
  assert.equal(shouldOfferHelp('?repo=/work/api', true), false);
  assert.equal(shouldOfferHelp('?intro=1', false), true);
});
