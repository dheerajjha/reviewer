'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
test('diff lines use syntax highlighting without changing line wrappers or gutters', () => {
  assert.match(APP, /function highlightDiffLine\(content, filePath\)/);
  assert.match(APP, /highlightDiffLine\(diffLine\.content, filePath\)/);
  assert.match(APP, /class="line-numbers"/);
  assert.match(APP, /class="line-content"/);
});
test('common extensions are mapped and unknown files retain escaped plain text', () => {
  for (const extension of ['js', 'ts', 'tsx', 'json', 'py', 'java', 'go', 'rs', 'css', 'sh']) {
    assert.match(APP, new RegExp(`\\b${extension}: `));
  }
  assert.match(APP, /if \(!language\) return escapeHtml\(content\)/);
});
test('syntax token styles coexist with diff row backgrounds', () => {
  for (const token of ['keyword', 'string', 'number', 'comment', 'function']) {
    assert.match(CSS, new RegExp(`\\.syntax-${token}\\s*\\{`));
  }
  assert.match(CSS, /\.diff-add\s*\{/);
  assert.match(CSS, /\.diff-delete\s*\{/);
});
