'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeComment, normalizeComments, groupByFile } = require('../lib/comments');

test('normalizeComment keeps only the persisted fields', () => {
  const normalized = normalizeComment({
    file: 'app.js',
    line: 12,
    lineContent: 'const a = 1;',
    text: 'rename this',
    id: 'client-only',
    collapsed: true
  });

  assert.deepEqual(normalized, {
    file: 'app.js',
    line: 12,
    lineContent: 'const a = 1;',
    text: 'rename this'
  });
});

test('normalizeComment omits an empty selection rather than storing null', () => {
  for (const selectedText of [null, undefined, '']) {
    const normalized = normalizeComment({ file: 'a.js', line: 1, text: 'x', selectedText });
    assert.ok(!('selectedText' in normalized), `expected no selectedText for ${selectedText}`);
  }
});

test('normalizeComment keeps a non-empty selection', () => {
  const normalized = normalizeComment({
    file: 'a.js',
    line: 1,
    text: 'x',
    selectedText: 'const a = 1;'
  });

  assert.equal(normalized.selectedText, 'const a = 1;');
});

test('normalizeComment omits an empty follow-up list', () => {
  assert.ok(!('followUps' in normalizeComment({ file: 'a.js', line: 1, text: 'x', followUps: [] })));
  assert.ok(!('followUps' in normalizeComment({ file: 'a.js', line: 1, text: 'x' })));
});

test('normalizeComment reduces follow-ups to their stored fields', () => {
  const normalized = normalizeComment({
    file: 'a.js',
    line: 1,
    text: 'x',
    followUps: [
      { text: 'first', timestamp: '2026-01-01T00:00:00.000Z', id: 9 },
      { text: 'second' }
    ]
  });

  assert.deepEqual(normalized.followUps, [
    { text: 'first', timestamp: '2026-01-01T00:00:00.000Z' },
    { text: 'second' }
  ]);
});

test('normalizeComments rejects a non-array', () => {
  assert.throws(() => normalizeComments(undefined), TypeError);
  assert.throws(() => normalizeComments({ file: 'a.js' }), TypeError);
});

test('normalizeComments rejects a comment with no file or text instead of storing undefined', () => {
  // Posting another shape (e.g. filePath/body) used to be saved as { line } and
  // exported as a comment on a file called "undefined".
  assert.throws(
    () => normalizeComments([{ filePath: 'f.txt', line: 2, body: 'hello' }]),
    { name: 'TypeError', message: 'comments[0].file must be a non-empty string' }
  );
  assert.throws(() => normalizeComments([{}]), TypeError);
});

test('normalizeComments names the malformed field and its index', () => {
  const valid = { file: 'a.js', line: 1, text: 'ok' };
  const cases = [
    [null, 'comments[1] must be an object'],
    [[], 'comments[1] must be an object'],
    [{ ...valid, file: '   ' }, 'comments[1].file must be a non-empty string'],
    [{ ...valid, line: 0 }, 'comments[1].line must be a positive integer'],
    [{ ...valid, line: '3' }, 'comments[1].line must be a positive integer'],
    [{ ...valid, line: 1.5 }, 'comments[1].line must be a positive integer'],
    [{ ...valid, text: '' }, 'comments[1].text must be a non-empty string'],
    [{ file: 'a.js', line: 1 }, 'comments[1].text must be a non-empty string']
  ];
  for (const [comment, message] of cases) {
    assert.throws(() => normalizeComments([valid, comment]), { name: 'TypeError', message });
  }
});

test('normalizeComments accepts an empty list', () => {
  assert.deepEqual(normalizeComments([]), []);
});

test('groupByFile sorts each file by line number', () => {
  const grouped = groupByFile([
    { file: 'a.js', line: 30, text: 'third' },
    { file: 'a.js', line: 10, text: 'first' },
    { file: 'a.js', line: 20, text: 'second' }
  ]);

  assert.deepEqual(grouped[0][1].map(comment => comment.text), ['first', 'second', 'third']);
});

test('groupByFile preserves the order files were first commented on', () => {
  const grouped = groupByFile([
    { file: 'z.js', line: 1, text: 'a' },
    { file: 'a.js', line: 1, text: 'b' },
    { file: 'z.js', line: 2, text: 'c' }
  ]);

  assert.deepEqual(grouped.map(([file]) => file), ['z.js', 'a.js']);
});

test('groupByFile does not mutate its input', () => {
  const comments = [
    { file: 'a.js', line: 30, text: 'third' },
    { file: 'a.js', line: 10, text: 'first' }
  ];

  groupByFile(comments);

  assert.deepEqual(comments.map(comment => comment.line), [30, 10]);
});

const { withKeys, mintKey, isKey } = require('../lib/comments');

test('a comment keeps the key it was written with, and a malformed one is refused', () => {
  assert.equal(normalizeComment({ key: 'aB3_-x9Z', file: 'a.js', line: 1, text: 'x' }).key, 'aB3_-x9Z');
  assert.ok(!('key' in normalizeComment({ file: 'a.js', line: 1, text: 'x' })));
  for (const key of ['', 'has space', 'a/b', 'x'.repeat(65), 12]) {
    assert.throws(() => normalizeComment({ key, file: 'a.js', line: 1, text: 'x' }), TypeError, `expected ${JSON.stringify(key)} to be refused`);
  }
});

test('a follow-up keeps its key, author and session, and nothing else', () => {
  const [followUp] = normalizeComment({
    file: 'a.js', line: 1, text: 'x',
    followUps: [{ key: 'f1', text: 'answer', timestamp: '2026-10-24T00:00:00.000Z', by: 'claude', session: 'abc-123', extra: 1 }]
  }).followUps;

  assert.deepEqual(followUp, { key: 'f1', text: 'answer', timestamp: '2026-10-24T00:00:00.000Z', by: 'claude', session: 'abc-123' });
});

test('a follow-up from the reviewer stores no author, and a bad author or missing text is refused', () => {
  const [followUp] = normalizeComment({ file: 'a.js', line: 1, text: 'x', followUps: [{ text: 'mine', by: '' }] }).followUps;
  assert.deepEqual(followUp, { text: 'mine' });

  assert.throws(() => normalizeComment({ file: 'a.js', line: 1, text: 'x', followUps: [{ text: 'y', by: '<script>' }] }), TypeError);
  assert.throws(() => normalizeComment({ file: 'a.js', line: 1, text: 'x', followUps: [{ by: 'claude' }] }), /followUps\[0\]\.text/);
});

test('two comments claiming one key are refused', () => {
  assert.throws(
    () => normalizeComments([{ key: 'k', file: 'a.js', line: 1, text: 'x' }, { key: 'k', file: 'b.js', line: 2, text: 'y' }]),
    /comments\[1\]\.key "k" is used by another comment/
  );
});

test('comments without keys get the same derived key on every read, and duplicates get two', () => {
  const legacy = [
    { file: 'a.js', line: 1, text: 'same' },
    { file: 'a.js', line: 1, text: 'same', followUps: [{ text: 'f', timestamp: 't' }] },
    { key: 'kept1234', file: 'b.js', line: 2, text: 'keyed' }
  ];

  const first = withKeys(legacy);
  const second = withKeys(JSON.parse(JSON.stringify(legacy)));

  assert.deepEqual(first.map(c => c.key), second.map(c => c.key));
  assert.notEqual(first[0].key, first[1].key);
  assert.equal(first[2].key, 'kept1234');
  assert.ok(isKey(first[1].followUps[0].key));
  assert.equal(legacy[0].key, undefined, 'the input is left alone');
});

test('a minted key is eight URL-safe characters', () => {
  const keys = new Set(Array.from({ length: 200 }, mintKey));
  assert.equal(keys.size, 200);
  for (const key of keys) assert.match(key, /^[A-Za-z0-9_-]{8}$/);
});
