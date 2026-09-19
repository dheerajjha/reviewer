'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_JS = path.join(__dirname, '..', 'public', 'app.js');

function loadFileStatusClassFunction() {
  const code = fs.readFileSync(APP_JS, 'utf-8');
  const match = code.match(/function fileStatusClass\([^{]+\{([\s\S]*?\n\})/);
  if (!match) throw new Error('Could not find fileStatusClass in app.js');

  const fnContext = vm.createContext({});
  return vm.runInContext(match[0] + '\n\nfileStatusClass;', fnContext);
}

test('file status classes distinguish every git status', () => {
  const fileStatusClass = loadFileStatusClassFunction();
  const stylesheet = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf-8');

  for (const [status, className] of [
    ['A', 'file-status-added'],
    ['M', 'file-status-modified'],
    ['D', 'file-status-deleted'],
    ['R', 'file-status-renamed'],
    ['B', 'file-status-binary']
  ]) {
    assert.equal(fileStatusClass(status), className);
    assert.match(stylesheet, new RegExp(`\\.${className}\\s*\\{`));
  }
});
