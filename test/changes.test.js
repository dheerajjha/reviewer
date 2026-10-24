'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  collectWorkingChanges,
  describeWorkingChanges,
  collectCommitChanges,
  classifyCommitFile,
  unquoteGitPath,
  parseCommitFilePath,
  parseNameStatus
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
    { path: 'edited.js', status: 'M' },
    { path: 'untracked.js', status: 'A' }
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
  // Ordering must not change which bucket wins a duplicate classification.
  assert.deepEqual(collectWorkingChanges({
    not_added: ['shared.js'], modified: ['shared.js', 'tracked.js']
  }), [{ path: 'tracked.js', status: 'M' }, { path: 'shared.js', status: 'A' }]);
});

test('collectWorkingChanges handles a clean tree', () => {
  assert.deepEqual(collectWorkingChanges({}), []);
  assert.deepEqual(collectWorkingChanges(undefined), []);
});

test('working summaries count file rows separately from files inside folded folders', () => {
  const folders = [
    { path: 'dd/', directory: true, fileCount: 3000 },
    { path: 'b201/', directory: true, fileCount: 201 },
    { path: 'ios/DerivedData/', directory: true, fileCount: 250 },
    { path: '<folder>/', directory: true, fileCount: 201 }
  ];
  const files = Array.from({ length: 204 }, (_, i) => ({ path: `file-${i}` }));
  const summary = describeWorkingChanges([...files, ...folders]);
  assert.ok(summary.startsWith('Found 204 changed files; 4 folders folded (3,652 untracked files). '));
  assert.match(summary, /<folder>\/ holds 201 untracked files/);
  assert.equal(describeWorkingChanges([]), 'Found 0 changed files');
  assert.equal(describeWorkingChanges(files.slice(0, 1)), 'Found 1 changed file');
  assert.equal(describeWorkingChanges(files.slice(0, 3)), 'Found 3 changed files');
  assert.equal(describeWorkingChanges([], false), 'No tracked changes — untracked files hidden');
  assert.equal(describeWorkingChanges(files.slice(0, 1), false), 'Found 1 changed file — untracked files hidden');
  assert.ok(describeWorkingChanges([folders[0]]).startsWith('Found 0 changed files; 1 folder folded (3,000 untracked files). '));
});

test('collectWorkingChanges folds a large untracked directory without hiding tracked changes', () => {
  const changes = collectWorkingChanges({
    not_added: [
      ...Array.from({ length: 3000 }, (_, i) => `output/nested/file-${i}.txt`),
      'output-neighbor/keep.js', 'small/one.js', 'small/two.js'
    ],
    modified: ['app.js', 'output/tracked.js']
  }, ['output/', 'output-neighbor/', 'small/']);

  assert.deepEqual(changes, [
    { path: 'app.js', status: 'M' },
    { path: 'output/tracked.js', status: 'M' },
    { path: 'output/', status: 'A', directory: true, fileCount: 3000 },
    { path: 'output-neighbor/keep.js', status: 'A' },
    { path: 'small/one.js', status: 'A' },
    { path: 'small/two.js', status: 'A' }
  ]);
});

test('collectWorkingChanges leaves 200 untracked files individual and folds 201', () => {
  const files = Array.from({ length: 201 }, (_, i) => `folder/file-${i}.txt`);
  assert.equal(collectWorkingChanges({ not_added: files.slice(0, 200) }, ['folder/']).length, 200);
  assert.deepEqual(collectWorkingChanges({ not_added: files }, ['folder/']), [
    { path: 'folder/', status: 'A', directory: true, fileCount: 201 }
  ]);
});

test('collectWorkingChanges only folds directories identified as wholly untracked by Git', () => {
  const files = Array.from({ length: 201 }, (_, i) => `mixed/file-${i}.txt`);
  const changes = collectWorkingChanges({ not_added: files, modified: ['mixed/tracked.js'] }, []);
  assert.equal(changes.length, 202);
  assert.equal(changes.some(file => file.directory), false);
  assert.deepEqual(changes[0], { path: 'mixed/tracked.js', status: 'M' });
});

test('collectWorkingChanges counts each untracked path once in a folded directory', () => {
  const files = Array.from({ length: 201 }, (_, i) => `folder/file-${i}.txt`);
  assert.deepEqual(collectWorkingChanges({ not_added: [...files, ...files] }, ['folder/']), [
    { path: 'folder/', status: 'A', directory: true, fileCount: 201 }
  ]);
});

test('collectWorkingChanges folds quoted Unicode directory paths with their decoded names', () => {
  const files = Array.from({ length: 201 }, (_, i) => `"caf\\303\\251 \\"output\\"/file-${i}.txt"`);
  assert.deepEqual(collectWorkingChanges({ not_added: files }, ['"caf\\303\\251 \\"output\\"/"']), [
    { path: 'café "output"/', status: 'A', directory: true, fileCount: 201 }
  ]);
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
      { file: 'dir/{ => nested}/file.txt', insertions: 0, deletions: 0 },
      { file: '{sub => }/file.txt', insertions: 0, deletions: 0 }
    ]
  });

  assert.deepEqual(changes, [
    { path: 'new.txt', status: 'R' },
    { path: 'src/deep/new.js', status: 'R' },
    { path: 'dest/other.js', status: 'R' },
    { path: 'dir/file.txt', status: 'R' },
    { path: 'dir/nested/file.txt', status: 'R' },
    { path: 'file.txt', status: 'R' }
  ]);
});

test('collectCommitChanges unquotes git octal-escaped non-ASCII filenames', () => {
  const changes = collectCommitChanges({
    files: [
      { file: '"unicode-caf\\303\\251-\\346\\227\\245\\346\\234\\254.txt"', insertions: 3, deletions: 1 },
      { file: '"caf\\303\\251-old.txt" => "caf\\303\\251-new.txt"', insertions: 0, deletions: 0 },
      { file: '"old.txt" => "🚀.txt"', insertions: 0, deletions: 0 }
    ]
  });

  assert.deepEqual(changes, [
    { path: 'unicode-café-日本.txt', status: 'M' },
    { path: 'café-new.txt', status: 'R' },
    { path: '🚀.txt', status: 'R' }
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
  assert.equal(unquoteGitPath('"hello 🚀 world.txt"'), 'hello 🚀 world.txt');
  assert.equal(unquoteGitPath('"file \\"quoted\\" 🚀 test.txt"'), 'file "quoted" 🚀 test.txt');
  assert.equal(unquoteGitPath(null), null);
  assert.equal(unquoteGitPath(undefined), undefined);
});

test('parseCommitFilePath parses rename and non-rename patterns', () => {
  assert.deepEqual(parseCommitFilePath('a.js'), { isRename: false, path: 'a.js' });
  assert.deepEqual(parseCommitFilePath('old => new'), { isRename: true, path: 'new' });
  assert.deepEqual(parseCommitFilePath('src/{old => new}.js'), { isRename: true, path: 'src/new.js' });
  assert.deepEqual(parseCommitFilePath('"{old\\303\\251 => new\\303\\251}.txt"'), { isRename: true, path: 'newé.txt' });
  assert.deepEqual(parseCommitFilePath('{sub => }/file.txt'), { isRename: true, path: 'file.txt' });
  assert.deepEqual(parseCommitFilePath('{ => dir}/file.txt'), { isRename: true, path: 'dir/file.txt' });
});


// --- what git says happened to a file, not a guess from line counts --------

test('parseNameStatus reads the plain statuses', () => {
  const raw = 'M\0src/a.js\0A\0src/new.js\0D\0src/gone.js\0';
  const statuses = parseNameStatus(raw);

  assert.equal(statuses.get('src/a.js'), 'M');
  assert.equal(statuses.get('src/new.js'), 'A');
  assert.equal(statuses.get('src/gone.js'), 'D');
});

test('parseNameStatus keys a rename by where the file lives now', () => {
  const statuses = parseNameStatus('R100\0old/name.js\0new/name.js\0M\0other.js\0');

  assert.equal(statuses.get('new/name.js'), 'R');
  assert.equal(statuses.has('old/name.js'), false, 'the old path is not a file in the review');
  assert.equal(statuses.get('other.js'), 'M', 'and the field after a rename is not swallowed');
});

test('parseNameStatus treats a copy as an addition and a type change as a modification', () => {
  const statuses = parseNameStatus('C75\0src/a.js\0src/b.js\0T\0bin/tool\0');

  assert.equal(statuses.get('src/b.js'), 'A');
  assert.equal(statuses.get('bin/tool'), 'M');
});

test('parseNameStatus takes non-ASCII paths as they are, with nothing to unquote', () => {
  // With -z git neither quotes nor octal-escapes. Without it, this name
  // arrives as "caf\303\251.js" -- which was #20 the first time.
  assert.equal(parseNameStatus('M\0café.js\0').get('café.js'), 'M');
});

test('an edit that only adds lines is Modified, not Added', () => {
  // The bug: the count-based guess called any insertion-only change "A",
  // so a one-line addition to an existing file was badged as a new file.
  const summary = { files: [{ file: 'src/auth.js', insertions: 1, deletions: 0, binary: false }] };

  assert.deepEqual(collectCommitChanges(summary), [{ path: 'src/auth.js', status: 'A' }], 'what the guess says');
  assert.deepEqual(
    collectCommitChanges(summary, parseNameStatus('M\0src/auth.js\0')),
    [{ path: 'src/auth.js', status: 'M' }],
    'what git says'
  );
});

test('an edit that only removes lines is Modified, not Deleted', () => {
  // Worse than the other direction: a reviewer shown "D" is told the file
  // is gone.
  const summary = { files: [{ file: 'src/auth.js', insertions: 0, deletions: 1, binary: false }] };

  assert.deepEqual(
    collectCommitChanges(summary, parseNameStatus('M\0src/auth.js\0')),
    [{ path: 'src/auth.js', status: 'M' }]
  );
});

test('renames and binaries keep their own badges whatever name-status says', () => {
  const summary = {
    files: [
      { file: 'src/{old.js => new.js}', insertions: 0, deletions: 0, binary: false },
      { file: 'logo.png', before: 10, after: 12, binary: true }
    ]
  };
  const statuses = parseNameStatus('R100\0src/old.js\0src/new.js\0M\0logo.png\0');

  assert.deepEqual(collectCommitChanges(summary, statuses), [
    { path: 'src/new.js', status: 'R' },
    { path: 'logo.png', status: 'B' }
  ]);
});
