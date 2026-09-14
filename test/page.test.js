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

test('the picker and the help modal declare the elements the script reaches for', () => {
  const html = fs.readFileSync(INDEX_HTML, 'utf-8');

  // Both lists work by delegation from these two containers. Without them the
  // rows render and nothing happens when they are clicked.
  for (const id of ['recentList', 'browseList', 'browsePath', 'browseUpBtn', 'pickerClose',
                    'helpModal', 'helpButton']) {
    assert.match(html, new RegExp(`id="${id}"`), `#${id} is missing from public/index.html`);
  }
});

/**
 * Nothing but a number goes into an attribute the browser evaluates as code.
 *
 * `public/app.js` builds its markup as strings, and the click handlers in that
 * markup are JavaScript source. A value interpolated into one is not a value,
 * it is code: a file name carrying a quote ended the string literal it was
 * written into and the rest of the name ran on click (#46). HTML escaping does
 * not help, because a browser decodes the entities in an attribute *before*
 * handing what is left to the JavaScript parser -- `&#39;` is a quote again by
 * then. The sites were found by hand once; this is what keeps them found.
 *
 * A number cannot carry a quote, so the rule is that a handler takes indices
 * and looks the strings up in the page's own state, and anything that is not
 * an index travels in a `data-` attribute instead and is read from the DOM
 * when the handler runs.
 */

/**
 * Every `on<event>="..."` attribute written by the script.
 *
 * Handler bodies here quote with `'`, so an attribute ends at the next `"` --
 * which also means a handler that needs a double quote inside it is reported
 * truncated rather than skipped. Erring towards reporting is the right way
 * round for this one.
 *
 * @param {string} source
 * @returns {{line: number, attribute: string, body: string}[]}
 */
function inlineHandlers(source) {
  return [...source.matchAll(/\bon[a-z]+="([^"]*)"/g)].map(match => ({
    line: source.slice(0, match.index).split('\n').length,
    attribute: match[0],
    body: match[1]
  }));
}

test('no string is interpolated into an inline handler', () => {
  const app = fs.readFileSync(APP_JS, 'utf-8');

  const offenders = inlineHandlers(app)
    .filter(handler => /'\$\{|`\$\{/.test(handler.body))
    .map(handler => `public/app.js:${handler.line}  ${handler.attribute}`);

  assert.deepEqual(
    offenders,
    [],
    `A quoted string is built inside a handler attribute:\n${offenders.join('\n')}\n` +
      'Whatever goes in there is parsed as JavaScript when the handler runs, ' +
      'and escaping cannot make it safe -- the entities are decoded first. ' +
      'Pass an index instead and look the string up inside the handler, or ' +
      'put it in a `data-` attribute on the element and read it from the DOM.'
  );
});

test('every value interpolated into an inline handler is coerced to a number', () => {
  // The rule holds by construction rather than by provenance: `${Number(i)}`
  // is a number whatever `i` turns out to be, and a reader of the markup does
  // not have to go and find out where `i` came from to know that. It also
  // catches the case the test above cannot see -- an unquoted `${name}` is
  // still an expression the browser will run.
  const app = fs.readFileSync(APP_JS, 'utf-8');

  const offenders = [];
  for (const handler of inlineHandlers(app)) {
    for (const interpolation of handler.body.matchAll(/\$\{\s*([^}]*)/g)) {
      if (!/^Number\(/.test(interpolation[1])) {
        offenders.push(`public/app.js:${handler.line}  \${${interpolation[1]}...`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Uncoerced interpolation inside a handler attribute:\n${offenders.join('\n')}\n` +
      'Wrap it in `Number(...)` where it is written, so the attribute cannot ' +
      'carry anything but a number. If the value is not a number, it does not ' +
      'belong in the handler at all -- see the note above this test.'
  );
});
