'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatStatus } = require('../lib/status');
const { homeRelative } = require('../lib/paths');

function example(overrides = {}) {
  return {
    repository: process.cwd(),
    saved: true,
    comments: 1,
    files: 1,
    lastUpdated: '2026-10-22T10:00:00.000Z',
    submitted: false,
    lastSubmitted: null,
    mode: 'working',
    range: null,
    ...overrides
  };
}

test('formatStatus handles a missing review', () => {
  const result = formatStatus(example({ saved: false }));
  assert.equal(result, `${homeRelative(process.cwd())}: No review saved yet\n`);
});

test('formatStatus uses singular nouns and readable working scope', () => {
  const result = formatStatus(example());

  assert.match(result, /1 comment on 1 file,/);
  assert.match(result, /uncommitted changes/);
  assert.match(result, /not submitted since last save/);
  assert.ok(result.startsWith(homeRelative(process.cwd()) + ':'));
});

test('formatStatus pluralizes counts', () => {
  const result = formatStatus(example({ comments: 2, files: 3 }));

  assert.match(result, /2 comments on 3 files,/);
});

test('formatStatus describes staged and committed scopes', () => {
  assert.match(
    formatStatus(example({ mode: 'staged' })),
    /staged changes/
  );

  assert.match(
    formatStatus(example({ mode: 'commit' })),
    /the last commit/
  );
});

test('formatStatus describes submitted state', () => {
  const result = formatStatus(example({ submitted: true }));

  assert.match(result, /, submitted/);
  assert.doesNotMatch(result, /not submitted since last save/);
});

test('formatStatus describes comparison ranges', () => {
  const result = formatStatus(example({
    mode: 'range',
    comments: 2,
    files: 2,
    range: {
      baseName: 'main',
      headName: 'feature/auth',
      commits: 3
    }
  }));

  assert.match(result, /reviewing main → feature\/auth, 3 commits/);
});
