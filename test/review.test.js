'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatReview,
  reviewFilename,
  commentsFilename,
  legacyCommentsFilename,
  repoSlug,
  repoKey
} = require('../lib/review');

const AT = new Date('2026-08-10T12:30:45.678Z');

test('formatReview writes a header with the repository and count', () => {
  const review = formatReview({
    repoPath: '/work/my-app',
    comments: [{ file: 'a.js', line: 1, text: 'x' }],
    generatedAt: AT
  });

  assert.match(review, /^# Code Review\n/);
  assert.match(review, /Repository: \/work\/my-app\n/);
  assert.match(review, /Generated: 2026-08-10T12:30:45\.678Z\n/);
  assert.match(review, /Total Comments: 1\n/);
});

test('formatReview groups comments under a heading per file', () => {
  const review = formatReview({
    repoPath: '/work/my-app',
    comments: [
      { file: 'b.js', line: 5, text: 'in b' },
      { file: 'a.js', line: 1, text: 'in a' }
    ],
    generatedAt: AT
  });

  assert.ok(review.indexOf('## b.js') < review.indexOf('## a.js'));
  assert.match(review, /## a\.js\n/);
});

test('formatReview fences the anchored line and the selection', () => {
  const review = formatReview({
    repoPath: '/r',
    comments: [{
      file: 'a.js',
      line: 12,
      lineContent: 'const a = 1;',
      selectedText: 'a = 1',
      text: 'rename'
    }],
    generatedAt: AT
  });

  assert.match(review, /\*\*Line 12:\*\*\n```\nconst a = 1;\n```\n/);
  assert.match(review, /\*\*Selected code:\*\*\n```\na = 1\n```\n/);
  assert.match(review, /rename/);
});

test('formatReview widens the fence around code that contains one', () => {
  // A snippet of Markdown would otherwise close the block early and the rest
  // of the review would render as prose.
  const review = formatReview({
    repoPath: '/r',
    comments: [{ file: 'README.md', line: 1, lineContent: '```js\ncode\n```', text: 'x' }],
    generatedAt: AT
  });

  assert.match(review, /````\n```js\ncode\n```\n````/);
});

test('formatReview numbers follow-ups and stamps them in ISO 8601', () => {
  // Never a locale format: a review is committed and read on other machines.
  const review = formatReview({
    repoPath: '/r',
    comments: [{
      file: 'a.js',
      line: 1,
      text: 'x',
      followUps: [
        { text: 'still wrong', timestamp: '2026-08-10T09:00:00.000Z' },
        { text: 'no stamp' }
      ]
    }],
    generatedAt: AT
  });

  assert.match(review, /\*\*Follow-ups:\*\*\n {2}1\. still wrong \(2026-08-10T09:00:00\.000Z\)\n {2}2\. no stamp\n/);
});

test('formatReview drops an unparseable follow-up timestamp', () => {
  const review = formatReview({
    repoPath: '/r',
    comments: [{ file: 'a.js', line: 1, text: 'x', followUps: [{ text: 'y', timestamp: 'not a date' }] }],
    generatedAt: AT
  });

  assert.match(review, / {2}1\. y\n/);
  assert.doesNotMatch(review, /Invalid Date/);
});

test('formatReview omits optional blocks that are absent', () => {
  const review = formatReview({
    repoPath: '/r',
    comments: [{ file: 'a.js', line: 1, text: 'plain' }],
    generatedAt: AT
  });

  assert.doesNotMatch(review, /Selected code/);
  assert.doesNotMatch(review, /Follow-ups/);
});

test('formatReview handles a review with no comments', () => {
  const review = formatReview({ repoPath: '/r', comments: [], generatedAt: AT });

  assert.match(review, /Total Comments: 0/);
  assert.doesNotMatch(review, /^## /m);
});

test('repoSlug takes the last path segment', () => {
  assert.equal(repoSlug('/work/my-app'), 'my-app');
  assert.equal(repoSlug('/work/my-app/'), 'my-app');
});

test('repoSlug replaces characters that are not filename-safe', () => {
  assert.equal(repoSlug('/work/my app (v2)'), 'my_app__v2_');
});

test('repoSlug never yields a leading dot or an empty name', () => {
  // `.` and `..` would name a directory rather than a file.
  assert.equal(repoSlug('/work/..'), 'repo');
  assert.equal(repoSlug('/'), 'repo');
  assert.equal(repoSlug(''), 'repo');
  assert.equal(repoSlug(undefined), 'repo');
});

test('commentsFilename leads with the repository name and ends in a fingerprint', () => {
  assert.match(commentsFilename('/work/my-app'), /^\.code-review-comments-my-app-[0-9a-f]{12}\.json$/);
});

test('two repositories with the same name get different comment files', () => {
  // The bug this guards: both checkouts named the same file, so the second
  // review overwrote the first and every later read served the survivor under
  // whichever repository asked.
  assert.notEqual(
    commentsFilename('/work/a/api-service'),
    commentsFilename('/work/b/api-service')
  );
});

test('a path names the same file however it is written', () => {
  assert.equal(commentsFilename('/work/my-app'), commentsFilename('/work/my-app/'));
  assert.equal(commentsFilename('/work/my-app'), commentsFilename('/work/./my-app'));
  assert.equal(commentsFilename('/work/my-app'), commentsFilename('/work/other/../my-app'));
});

test('repoKey keeps the readable name in front of the fingerprint', () => {
  assert.match(repoKey('/work/my app (v2)'), /^my_app__v2_-[0-9a-f]{12}$/);
});

test('legacyCommentsFilename is the pre-fingerprint name, for migration', () => {
  assert.equal(legacyCommentsFilename('/work/my-app'), '.code-review-comments-my-app.json');
});

test('reviewFilename embeds a sortable timestamp with no shell-hostile characters', () => {
  assert.match(
    reviewFilename('/work/my-app', AT),
    /^review_my-app-[0-9a-f]{12}_2026-08-10_12-30-45-678Z\.txt$/
  );
});

test('reviewFilename orders chronologically as plain text', () => {
  const earlier = reviewFilename('/r/app', new Date('2026-08-10T09:00:00.000Z'));
  const later = reviewFilename('/r/app', new Date('2026-08-10T10:00:00.000Z'));

  assert.ok(earlier < later);
});
