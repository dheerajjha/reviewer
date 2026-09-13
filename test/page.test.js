'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * The contract between the page and the script that drives it.
 *
 * `public/app.js` reaches for elements by id, and nothing checks that the page
 * still contains them. Renaming or removing one is silent at load and shows up
 * later as a control that does nothing. Browser tests for the UI itself are #9;
 * this is the cheap half, and it is the half that catches an edit to the markup.
 */

const APP_JS = path.join(__dirname, '..', 'public', 'app.js');
const INDEX_HTML = path.join(__dirname, '..', 'public', 'index.html');

/** Ids the script creates at runtime, so the page is right not to declare them. */
const CREATED_BY_THE_SCRIPT = new Set(['commentInput', 'followupInput']);

test('every element the script looks up by id exists in the page', () => {
  const app = fs.readFileSync(APP_JS, 'utf-8');
  const html = fs.readFileSync(INDEX_HTML, 'utf-8');

  const wanted = new Set(
    [...app.matchAll(/getElementById\(['"]([\w-]+)['"]\)/g)].map(match => match[1])
  );
  const declared = new Set([...html.matchAll(/\bid="([\w-]+)"/g)].map(match => match[1]));

  const missing = [...wanted].filter(
    id => !declared.has(id) && !CREATED_BY_THE_SCRIPT.has(id)
  );

  assert.deepEqual(
    missing,
    [],
    `public/app.js looks up ${missing.join(', ')}, which public/index.html no longer declares`
  );
});

test('the path box survives, whatever the header looks like', () => {
  // The header leads with a button that opens the picker now, rather than with
  // a text box asking for a path typed from memory. The box is still there
  // behind the icon beside it -- pasting a path is a real thing to want -- and
  // a good deal of the script still reads it by name.
  const html = fs.readFileSync(INDEX_HTML, 'utf-8');

  assert.match(html, /id="repoPath"/);
  assert.match(html, /id="loadBtn"/);
  assert.match(html, /id="repoButton"/);
  assert.match(html, /id="pathToggle"/);
});

test('the picker declares the containers its listeners are attached to', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf-8');

  // Both lists work by delegation from these two containers. Without them the
  // rows render and nothing happens when they are clicked.
  for (const id of ['recentList', 'browseList', 'browsePath', 'browseUpBtn', 'pickerClose']) {
    assert.match(html, new RegExp(`id="${id}"`), `#${id} is missing from public/index.html`);
  }
});
