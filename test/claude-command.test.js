'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveClaudeCommand } = require('../lib/claude-command');

/**
 * Windows is simulated: these run on every platform, with the filesystem
 * replaced by a set of paths that exist.
 */

const windows = (files, env = { PATH: 'C:\\Windows;C:\\Users\\me\\AppData\\Roaming\\npm' }, shims = {}) => ({
  platform: 'win32',
  env,
  exists: file => files.includes(file),
  read: file => {
    if (!(file in shims)) throw new Error('ENOENT');
    return shims[file];
  }
});

const NPM = 'C:\\Users\\me\\AppData\\Roaming\\npm';

test('everywhere but Windows the name is left to spawn', () => {
  assert.equal(resolveClaudeCommand('claude', { platform: 'linux' }), 'claude');
  assert.equal(resolveClaudeCommand('/opt/claude', { platform: 'darwin' }), '/opt/claude');
});

test('a native claude.exe on the PATH is used as it is', () => {
  const exe = 'C:\\Users\\me\\.local\\bin\\claude.exe';
  const options = windows([exe], { PATH: 'C:\\Users\\me\\.local\\bin' });
  assert.equal(resolveClaudeCommand('claude', options), exe);
});

test('npm\'s claude.cmd shim is replaced by the claude.exe its package carries', () => {
  const native = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
  assert.equal(resolveClaudeCommand('claude', windows([`${NPM}\\claude.cmd`, native])), native);
  assert.equal(resolveClaudeCommand(`${NPM}\\claude.cmd`, windows([`${NPM}\\claude.cmd`, native])), native,
    'and so is REVIEWER_CLAUDE pointing at the shim');
});

test('otherwise the shim is read for the executable it starts', () => {
  const shim = 'D:\\tools\\claude.cmd';
  const target = 'D:\\tools\\vendor\\claude\\claude.exe';
  const options = windows([shim, target], { PATH: 'D:\\tools' }, {
    [shim]: '@ECHO off\r\nSETLOCAL\r\n"%dp0%\\vendor\\claude\\claude.exe"   %*\r\n'
  });
  assert.equal(resolveClaudeCommand('claude', options), target);
});

test('with nothing runnable found, the name is handed back for spawn to report', () => {
  assert.equal(resolveClaudeCommand('claude', windows([`${NPM}\\claude.cmd`])), 'claude');
  assert.equal(resolveClaudeCommand('claude', windows([])), 'claude');
});
