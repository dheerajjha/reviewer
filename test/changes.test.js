'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  collectWorkingChanges,
  collectCommitChanges,
  classifyCommitFile,
  unquoteGitPath,
  parseCommitFilePath
} = require('../lib/changes');

test('collectWorkingChanges labels each bucket', () => {
  const changes = collectWorkingChanges({
    modified: ['edited.js'],
    created: ['staged.js'],
    not_added: ['untracked.js'],
    deleted: ['gone.js'],
    renamed: [{ from: 'old.js', to: 'new.js' }]
  });

  assert.deepEqual(changes, [
    { path: 'new.js', status: 'R' },
    { path: 'gone.js', status: 'D' },
    { path: 'staged.js', status: 'A' },
    { path: 'untracked.js', status: 'A' },
    { path: 'edited.js', status: 'M' }
  ]);
});

test('collectWorkingChanges reports a deleted file', () => {
  // Deletions used to be dropped entirely, so a review could not comment on
  // a removed file.
  const changes = collectWorkingChanges({ deleted: ['gone.js'] });

  assert.deepEqual(changes, [{ path: 'gone.js', status: 'D' }]);
});

test('collectWorkingChanges lists a path once when several buckets claim it', () => {
  // A file staged and then edited again is both created and modified.
  const changes = collectWorkingChanges({
    created: ['both.js'],
    modified: ['both.js']
  });

  assert.deepEqual(changes, [{ path: 'both.js', status: 'A' }]);
});

test('collectWorkingChanges handles a clean tree', () => {
  assert.deepEqual(collectWorkingChanges({}), []);
  assert.deepEqual(collectWorkingChanges(undefined), []);
});

test('classifyCommitFile reads insertion and deletion counts', () => {
  assert.equal(classifyCommitFile({ insertions: 5, deletions: 2 }), 'M');
  assert.equal(classifyCommitFile({ insertions: 5, deletions: 0 }), 'A');
  assert.equal(classifyCommitFile({ insertions: 0, deletions: 5 }), 'D');
});

test('classifyCommitFile marks a binary file before counting lines', () => {
  assert.equal(classifyCommitFile({ binary: true, insertions: 0, deletions: 0 }), 'B');
});

test('classifyCommitFile falls back to modified when counts say nothing', () => {
  assert.equal(classifyCommitFile({ insertions: 0, deletions: 0 }), 'M');
  assert.equal(classifyCommitFile({}), 'M');
});

test('collectCommitChanges maps a diff summary', () => {
  const changes = collectCommitChanges({
    files: [
      { file: 'a.js', insertions: 3, deletions: 1 },
      { file: 'logo.png', binary: true }
    ]
  });

  assert.deepEqual(changes, [
    { path: 'a.js', status: 'M' },
    { path: 'logo.png', status: 'B' }
  ]);
});

test('collectCommitChanges handles an empty summary', () => {
  assert.deepEqual(collectCommitChanges({}), []);
  assert.deepEqual(collectCommitChanges(undefined), []);
});

test('collectCommitChanges resolves renamed files with status R', () => {
  const changes = collectCommitChanges({
    files: [
      { file: 'old.txt => new.txt', insertions: 0, deletions: 0 },
      { file: 'src/deep/{old.js => new.js}', insertions: 2, deletions: 1 },
      { file: '{src => dest}/other.js', insertions: 10, deletions: 0 },
      { file: 'dir/{sub => }/file.txt', insertions: 0, deletions: 0 },
      { file: 'dir/{ => nested}/file.txt', insertions: 0, deletions: 0 }
    ]
  });

  assert.deepEqual(changes, [
    { path: 'new.txt', status: 'R' },
    { path: 'src/deep/new.js', status: 'R' },
    { path: 'dest/other.js', status: 'R' },
    { path: 'dir/file.txt', status: 'R' },
    { path: 'dir/nested/file.txt', status: 'R' }
  ]);
});

test('collectCommitChanges unquotes git octal-escaped non-ASCII filenames', () => {
  const changes = collectCommitChanges({
    files: [
      { file: '"unicode-caf\\303\\251-\\346\\227\\245\\346\\234\\254.txt"', insertions: 3, deletions: 1 },
      { file: '"caf\\303\\251-old.txt" => "caf\\303\\251-new.txt"', insertions: 0, deletions: 0 }
    ]
  });

  assert.deepEqual(changes, [
    { path: 'unicode-café-日本.txt', status: 'M' },
    { path: 'café-new.txt', status: 'R' }
  ]);
});

test('classifyCommitFile classifies renames as R', () => {
  assert.equal(classifyCommitFile({ file: 'old.txt => new.txt', insertions: 1, deletions: 1 }), 'R');
  assert.equal(classifyCommitFile({ file: 'src/{a => b}.js', insertions: 0, deletions: 0 }), 'R');
});

test('unquoteGitPath decodes git octal and escape sequences', () => {
  assert.equal(unquoteGitPath('plain.txt'), 'plain.txt');
  assert.equal(unquoteGitPath('"plain.txt"'), 'plain.txt');
  assert.equal(unquoteGitPath('"unicode-caf\\303\\251-\\346\\227\\245\\346\\234\\254.txt"'), 'unicode-café-日本.txt');
  assert.equal(unquoteGitPath('"quote\\"and\\\\slash.txt"'), 'quote"and\\slash.txt');
  assert.equal(unquoteGitPath('"tab\\tnewline\\n.txt"'), 'tab\tnewline\n.txt');
  assert.equal(unquoteGitPath(null), null);
  assert.equal(unquoteGitPath(undefined), undefined);
});

test('parseCommitFilePath parses rename and non-rename patterns', () => {
  assert.deepEqual(parseCommitFilePath('a.js'), { isRename: false, path: 'a.js' });
  assert.deepEqual(parseCommitFilePath('old => new'), { isRename: true, path: 'new' });
  assert.deepEqual(parseCommitFilePath('src/{old => new}.js'), { isRename: true, path: 'src/new.js' });
  assert.deepEqual(parseCommitFilePath('"{old\\303\\251 => new\\303\\251}.txt"'), { isRename: true, path: 'newé.txt' });
});
