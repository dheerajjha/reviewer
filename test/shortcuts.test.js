'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_JS = path.join(__dirname, '..', 'public', 'app.js');

function loadShortcutFunction() {
    const code = fs.readFileSync(APP_JS, 'utf-8');

    // We use VM to evaluate getKeyboardShortcut from public/app.js.
    // Instead of evaluating the whole file, we can extract just the function definition string.
    // This avoids reference errors for 'window' or 'document'.
    const match = code.match(/function getKeyboardShortcut\([^{]+\{([\s\S]*?\n\})/);
    if (!match) throw new Error('Could not find getKeyboardShortcut in app.js');

    const fnContext = vm.createContext({});
    return vm.runInContext(match[0] + '\n\ngetKeyboardShortcut;', fnContext);
}

const getKeyboardShortcut = loadShortcutFunction();

test('keyboard navigation shortcuts map to expected actions', () => {
    assert.equal(getKeyboardShortcut('ArrowDown', 'DIV'), 'nextFile');
    assert.equal(getKeyboardShortcut('j', 'DIV'), 'nextFile');
    assert.equal(getKeyboardShortcut('ArrowUp', 'DIV'), 'prevFile');
    assert.equal(getKeyboardShortcut('k', 'DIV'), 'prevFile');

    assert.equal(getKeyboardShortcut('n', 'DIV'), 'nextComment');
    assert.equal(getKeyboardShortcut('p', 'DIV'), 'prevComment');
    assert.equal(getKeyboardShortcut('c', 'DIV'), 'commentFocus');
    assert.equal(getKeyboardShortcut('?', 'DIV'), 'help');
    assert.equal(getKeyboardShortcut('Escape', 'DIV'), 'escape');
});

test('keyboard navigation is ignored in inputs and textareas', () => {
    // If the target is an input or textarea, the function should return null for shortcuts
    assert.equal(getKeyboardShortcut('j', 'INPUT'), null);
    assert.equal(getKeyboardShortcut('j', 'TEXTAREA'), null);
    assert.equal(getKeyboardShortcut('?', 'INPUT'), null);
    assert.equal(getKeyboardShortcut('Escape', 'INPUT'), 'escape');
    assert.equal(getKeyboardShortcut('Escape', 'TEXTAREA'), 'escape');
});

test('modifier keys prevent shortcuts from firing', () => {
    // Ctrl+P should not trigger prevComment — it should print
    assert.equal(getKeyboardShortcut('p', 'DIV', { ctrl: true }), null);
    assert.equal(getKeyboardShortcut('j', 'DIV', { ctrl: true }), null);
    assert.equal(getKeyboardShortcut('n', 'DIV', { meta: true }), null);
    assert.equal(getKeyboardShortcut('k', 'DIV', { alt: true }), null);
    // Even Escape is suppressed with a modifier
    assert.equal(getKeyboardShortcut('Escape', 'DIV', { ctrl: true }), null);
    // Without modifiers, shortcuts still work
    assert.equal(getKeyboardShortcut('p', 'DIV'), 'prevComment');
    assert.equal(getKeyboardShortcut('p', 'DIV', {}), 'prevComment');
});

test('[ and ] step to the older and newer commit', () => {
    assert.equal(getKeyboardShortcut('[', 'DIV'), 'prevCommit');
    assert.equal(getKeyboardShortcut(']', 'DIV'), 'nextCommit');
});

test('shortcuts are ignored while a picker has focus', () => {
    // A letter typed into a <select> is the browser's type-ahead: "c" jumps
    // to the first option starting with c. It also opened a comment box,
    // because only INPUT and TEXTAREA were excluded when the compare pickers
    // arrived in 2.12.
    assert.equal(getKeyboardShortcut('c', 'SELECT'), null);
    assert.equal(getKeyboardShortcut('j', 'SELECT'), null);
    assert.equal(getKeyboardShortcut(']', 'SELECT'), null);
    assert.equal(getKeyboardShortcut('Escape', 'SELECT'), 'escape', 'Escape still means never mind');
});
