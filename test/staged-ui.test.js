'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// As in commits-ui.test.js, run the browser functions with a small DOM stand-in.
function lift(name, context) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  const end = source.indexOf('\n}', start) + 2;
  const prefix = source.slice(start - 6, start) === 'async ' ? 'async ' : '';
  return vm.runInNewContext(`${prefix}${source.slice(start, end)}\n${name}`, context);
}

function element() {
  return {
    textContent: '', value: '/work/repo',
    classList: { add() {}, remove() {}, toggle() {} },
    replaceChildren() { this.textContent = ''; },
    append(...parts) { this.textContent += parts.join(''); }
  };
}

function dom() {
  const elements = new Map();
  return {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    createElement: element
  };
}

test('the scope bar distinguishes staged changes from all uncommitted work', () => {
  const document = dom();
  const render = lift('renderScope', {
    document, currentRefs: null, commitContext: null, plural: (n, word) => `${n} ${word}`
  });
  render({ mode: 'staged', files: [{ path: 'app.js' }] });
  assert.equal(document.getElementById('scopeLabel').textContent, 'Staged changes');
  assert.match(document.getElementById('scopeNote').textContent, /diff excludes unstaged changes/);
  assert.match(document.getElementById('scopeNote').textContent, /Saved comments are shared between views/);
  render({ mode: 'working', files: [{ path: 'app.js' }] });
  assert.equal(document.getElementById('scopeLabel').textContent, 'Uncommitted changes');
  assert.equal(document.getElementById('scopeNote').textContent, '');
});

test('loading an empty staged view clears the previous file without falling back', async () => {
  const document = dom();
  let request;
  let emptied = false;
  let message;
  const load = lift('loadRepo', {
    document, stagedByDefault: true, API_BASE: '/api',
    fetch: async (url, options) => {
      request = JSON.parse(options.body);
      return { ok: true, json: async () => ({ repoId: 'one', mode: 'staged', files: [] }) };
    },
    showStatus() {}, clearStatus() {}, hidePicker() {},
    refreshCommitContext: async () => {}, loadRefs: async () => {},
    renderScope() {}, renderCommitList() {}, updateCommentsSidebar() {},
    displayFiles: files => assert.equal(files.length, 0),
    showEmptyFileList: text => { message = text; },
    clearCodePane: () => { emptied = true; },
    commitContext: null
  });
  await load();
  assert.deepEqual(request, { repoPath: '/work/repo', staged: true });
  assert.equal(message, 'No staged changes.');
  assert.equal(emptied, true);
});
