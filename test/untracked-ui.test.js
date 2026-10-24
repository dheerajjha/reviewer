'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { collectWorkingChanges } = require('../lib/changes');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

// As in staged-ui.test.js, exercise the page's functions with a small DOM.
function lift(name, context) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  const end = source.indexOf('\n}', start) + 2;
  const prefix = source.slice(start - 6, start) === 'async ' ? 'async ' : '';
  return vm.runInNewContext(`${prefix}${source.slice(start, end)}\n${name}`, context);
}

function element() {
  return {
    textContent: '', innerHTML: '', value: '/work/repo', style: {}, disabled: false,
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
    querySelector() { return this.getElementById('fullContext'); },
    querySelectorAll() { return []; },
    createElement: element
  };
}

function loadContext(data) {
  const document = dom();
  const context = {
    document, stagedByDefault: false, untrackedByDefault: false, API_BASE: '/api',
    currentFile: null, currentFiles: [], commitContext: null, comments: [],
    showStatus() {}, clearStatus() {}, hidePicker() {}, showPicker() {}, setRepoButton() {},
    refreshCommitContext: async () => {}, loadRefs: async () => {},
    renderScope() {}, renderCommitList() {}, updateCommentsSidebar() {},
    displayFiles() {}, showEmptyFileList() {}, clearCodePane() {}, offerHelpOnce() {},
    loadCommentsFromBackend: async () => [], loadFile() {},
    plural: (n, word) => `${n} ${word}`,
    fetch: async (url, options) => {
      context.request = JSON.parse(options.body);
      return { ok: true, json: async () => data };
    }
  };
  return context;
}

test('the page carries untracked=0 into its load request and clears an empty tracked view', async () => {
  const configured = vm.runInNewContext(
    source.slice(0, source.indexOf('let currentRepoId')) + '\nuntrackedByDefault',
    { window: { location: { origin: 'http://localhost', search: '?untracked=0' } }, URLSearchParams }
  );
  assert.equal(configured, false);
  const context = loadContext({ repoId: 'one', mode: 'working', untracked: false, files: [] });
  let emptied = false;
  let message;
  context.clearCodePane = () => { emptied = true; };
  context.showEmptyFileList = text => { message = text; };
  await lift('loadRepo', context)();
  assert.equal(context.request.untracked, false);
  assert.equal(message, 'No tracked changes.');
  assert.equal(emptied, true);
});

test('the scope note keeps the names and counts of folded directories visible', () => {
  const document = dom();
  const render = lift('renderScope', {
    document, currentRefs: null, commitContext: null, plural: (n, word) => `${n} ${word}`
  });
  const message = 'Found 1 changed file; 1 folder folded (3,000 untracked files). dd/ holds 3,000 untracked files; individual files are not listed.';
  render({ mode: 'working', files: [
    { path: 'dd/', directory: true, fileCount: 3000 }, { path: 'app.js' }
  ], message });
  assert.equal(document.getElementById('scopeNote').textContent, message);
});

test('the scope bar counts files and folded folders separately and clears old totals', () => {
  const document = dom();
  const render = lift('renderScope', {
    document, currentRefs: null, commitContext: null,
    plural: (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
  });
  const folders = [3000, 201, 250, 201].map((fileCount, i) => ({ path: `fold-${i}/`, directory: true, fileCount }));
  const files = Array.from({ length: 204 }, (_, i) => ({ path: `file-${i}` }));
  render({ mode: 'working', files: [...files, ...folders], message: 'Folder details' });
  const meta = document.getElementById('scopeMeta');
  assert.equal(meta.textContent, '204 files changed; 4 folders folded (3,652 untracked files)');
  render({ mode: 'working', files: [folders[0]], message: 'Folder details' });
  assert.equal(meta.textContent, '0 files changed; 1 folder folded (3,000 untracked files)');
  for (const mode of ['working', 'staged']) {
    for (const count of [0, 1, 3]) {
      render({ mode, files: files.slice(0, count) });
      assert.equal(meta.textContent, `${count} file${count === 1 ? '' : 's'} changed`);
      assert.doesNotMatch(document.getElementById('scopeNote').textContent, /Folder details/);
    }
  }
  render({ mode: 'lastCommit', files: files.slice(0, 1) });
  assert.equal(meta.textContent, '');
  assert.equal(document.getElementById('scopeNote').textContent, '');
});

test('working loads open tracked edits first and preserve an explicitly selected untracked file', async () => {
  const cases = [
    [{ modified: ['app.js'], not_added: ['scratch.js'] }, null, 'app.js'],
    [{ created: ['staged.js'], not_added: ['scratch.js'] }, null, 'staged.js'],
    [{ modified: ['app.js'], not_added: ['scratch.js'] }, 'scratch.js', 'scratch.js'],
    [{ not_added: ['scratch.js', 'other.js'] }, null, 'scratch.js']
  ];
  for (const [status, selected, expected] of cases) {
    const files = collectWorkingChanges(status);
    const context = loadContext({ repoId: 'one', mode: 'working', files });
    context.currentFile = selected;
    let opened;
    context.loadFile = file => { opened = file; };
    await lift('loadRepo', context)();
    assert.equal(opened, expected);
  }
});

test('a folded directory row shows its count and escapes the folder name', () => {
  const document = dom();
  const display = lift('displayFiles', {
    document, updateCommentsSidebar() {}, fileStatusClass: () => 'status-added',
    FILE_STATUS_NAMES: { A: 'Added' },
    escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
  });
  display([{ path: 'café<folder>/', status: 'A', directory: true, fileCount: 3000 }]);
  const html = document.getElementById('filesList').innerHTML;
  assert.match(html, /3,000 files/);
  assert.match(html, /café&lt;folder>/);
  assert.doesNotMatch(html, /café<folder>/);
  assert.equal(document.getElementById('fileCount').textContent, '0 files · 1 folder');
  display([
    ...Array.from({ length: 204 }, (_, i) => ({ path: `file-${i}`, status: 'A' })),
    ...[3000, 201, 250, 201].map((fileCount, i) => ({ path: `folder-${i}/`, status: 'A', directory: true, fileCount }))
  ]);
  assert.equal(document.getElementById('fileCount').textContent, '204 files · 4 folders');
  for (const count of [0, 1, 3]) {
    display(Array.from({ length: count }, (_, i) => ({ path: `file-${i}`, status: 'M' })));
    assert.equal(document.getElementById('fileCount').textContent, `${count} file${count === 1 ? '' : 's'}`);
  }
});

test('opening a folded directory shows an explanation without requesting a diff or full context', async () => {
  const document = dom();
  const context = {
    document, currentRepoId: 'one', currentFiles: [{ path: 'dd/', directory: true, fileCount: 3000 }],
    currentDiffLines: [{ content: 'old diff' }], comments: [],
    escapeHtml: String, updateFullContextButton() {},
    showStatus(message) { assert.fail(message); },
    fetch() { assert.fail('a folded directory must not be read as a file'); }
  };
  await lift('loadFile', context)('dd/', 0);
  assert.equal(document.getElementById('currentFile').textContent, 'dd/');
  assert.match(document.getElementById('codeViewer').innerHTML, /3,000 untracked files/);
  assert.equal(context.currentDiffLines.length, 0);
  await lift('showFullContext', context)();
});

test('a folded first row does not hide the first reviewable file on load', async () => {
  for (const file of [{ path: 'app.js', status: 'M' }, { path: 'scratch.js', status: 'A' }, null]) {
    const context = loadContext({ repoId: 'one', mode: 'working', files: [
      { path: 'dd/', directory: true, fileCount: 3000 }, ...(file ? [file] : [])
    ] });
    let opened;
    context.loadFile = path => { opened = path; };
    await lift('loadRepo', context)();
    assert.equal(opened, file?.path ?? 'dd/');
  }
});

test('a pending file response cannot replace a newly selected folded directory', async () => {
  const results = [];
  for (const kind of ['diff', 'full context']) {
    const document = dom();
    let finish;
    const response = new Promise(resolve => { finish = resolve; });
    const context = {
      document, API_BASE: '/api', currentRepoId: 'one', currentFile: 'app.js',
      currentFiles: [{ path: 'app.js', status: 'M' }, { path: 'dd/', directory: true, fileCount: 3000 }],
      currentDiffLines: [{ content: 'old diff' }], comments: [], isFullContextMode: false,
      updateFullContextButton() {},
      showStatus(message) { assert.fail(message); },
      fetch: () => response,
      displayCode(filePath, lines) {
        document.getElementById('currentFile').textContent = filePath;
        document.getElementById('codeViewer').innerHTML = 'file diff';
        context.currentDiffLines = lines;
      },
      displayFullContext(filePath) {
        document.getElementById('currentFile').textContent = filePath;
        document.getElementById('codeViewer').innerHTML = 'full file';
      }
    };
    const loadFile = lift('loadFile', context);
    const pending = kind === 'diff'
      ? loadFile('app.js', 0)
      : lift('showFullContext', context)();
    await loadFile('dd/', 1);
    finish({ ok: true, json: async () => ({
      filePath: 'app.js', diffLines: [{ content: 'tracked line' }], lines: ['tracked line']
    }) });
    await pending;
    results.push({
      kind,
      selected: context.currentFile,
      displayed: document.getElementById('currentFile').textContent,
      folderNotice: document.getElementById('codeViewer').innerHTML.includes('3,000 untracked files'),
      diffLines: context.currentDiffLines.length,
      fullContext: context.isFullContextMode
    });
  }
  assert.deepEqual(results, ['diff', 'full context'].map(kind => ({
    kind, selected: 'dd/', displayed: 'dd/', folderNotice: true, diffLines: 0, fullContext: false
  })));
});
