'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { buildReviewDocument, filterReviewDocument, formatPrompt, SCHEMA } = require('../lib/agent');

const AT = new Date('2026-08-10T12:30:45.678Z');

const COMMENTS = [
  {
    file: 'src/auth.js',
    line: 10,
    lineContent: '  if (scheme !== SCHEME) return null;',
    text: 'Reject an empty token too.',
    followUps: [{ text: 'Still open', timestamp: '2026-08-10T14:00:00.000Z' }]
  },
  { file: 'src/auth.js', line: 2, lineContent: 'const A = 1;', text: 'Name this.' },
  { file: 'src/cache.js', line: 5, lineContent: 'store.clear();', text: 'Why here?' }
];

/** @returns {import('../lib/agent').ReviewDocument} */
function build(comments = COMMENTS, extra = {}) {
  return buildReviewDocument({
    repoPath: '/work/api-service',
    comments,
    generatedAt: AT,
    ...extra
  });
}

test('buildReviewDocument stamps the schema and generation time', () => {
  const document = build();

  assert.equal(document.schema, SCHEMA);
  assert.equal(document.generatedAt, '2026-08-10T12:30:45.678Z');
});

test('buildReviewDocument records the repository and the commit reviewed', () => {
  const document = build(COMMENTS, { head: 'abc1234', branch: 'main', mode: 'working' });

  assert.deepEqual(document.repository, {
    path: '/work/api-service',
    name: 'api-service',
    head: 'abc1234',
    branch: 'main'
  });
  assert.equal(document.mode, 'working');
});

test('buildReviewDocument leaves the commit null when git would not say', () => {
  const document = build();

  assert.equal(document.repository.head, null);
  assert.equal(document.repository.branch, null);
});

test('buildReviewDocument counts comments and the files they touch', () => {
  assert.deepEqual(build().summary, { comments: 3, files: 2 });
});

test('buildReviewDocument groups by file and orders by line', () => {
  const document = build();

  assert.deepEqual(document.comments.map(comment => comment.id), [
    'src/auth.js:2',
    'src/auth.js:10',
    'src/cache.js:5'
  ]);
});

test('filterReviewDocument emits one file and recounts its summary', () => {
  const document = build();
  const filtered = filterReviewDocument(document, { file: 'src/auth.js' });

  assert.deepEqual(filtered.summary, { comments: 2, files: 1 });
  assert.deepEqual(filtered.comments.map(comment => comment.id), [
    'src/auth.js:2',
    'src/auth.js:10'
  ]);
  assert.match(formatPrompt(filtered), /2 comment\(s\) across 1 file\(s\)/);
  assert.doesNotMatch(formatPrompt(filtered), /Why here\?/);
  assert.deepEqual(document.summary, { comments: 3, files: 2 });
});

test('filterReviewDocument reports an empty result without mutating the document', () => {
  const document = build();
  const filtered = filterReviewDocument(document, { file: 'src/missing.js' });

  assert.deepEqual(filtered.summary, { comments: 0, files: 0 });
  assert.deepEqual(filtered.comments, []);
  assert.equal(document.comments.length, 3);
});

test('filterReviewDocument matches a ./-prefixed path from shell tab-completion', () => {
  const filtered = filterReviewDocument(build(), { file: './src/auth.js' });

  assert.deepEqual(filtered.summary, { comments: 2, files: 1 });
});

test('filterReviewDocument matches a path with duplicate separators', () => {
  const filtered = filterReviewDocument(build(), { file: 'src//auth.js' });

  assert.deepEqual(filtered.summary, { comments: 2, files: 1 });
});

test('filterReviewDocument matches a path typed with backslashes', () => {
  const filtered = filterReviewDocument(build(), { file: 'src\\auth.js' });

  assert.deepEqual(filtered.summary, { comments: 2, files: 1 });
});

test('filterReviewDocument matches an absolute path under the repository', () => {
  const repoPath = path.resolve('work', 'api-service');
  const document = build(COMMENTS, { repoPath });
  const filtered = filterReviewDocument(document, { file: path.join(repoPath, 'src', 'auth.js') });

  assert.deepEqual(filtered.summary, { comments: 2, files: 1 });
});

test('filterReviewDocument leaves unfiltered exports unchanged', () => {
  const document = build();

  assert.equal(filterReviewDocument(document), document);
});

test('every comment carries the source line as an anchor', () => {
  // The anchor is the whole point: an agent's own edits shift line numbers, so
  // the text of the line is what survives to locate the comment again.
  const document = build();

  assert.equal(document.comments[1].anchor, '  if (scheme !== SCHEME) return null;');
});

test('a comment with no recorded line content has a null anchor', () => {
  const document = build([{ file: 'a.js', line: 1, text: 'x' }]);

  assert.equal(document.comments[0].anchor, null);
});

test('follow-ups are carried across, with their timestamps', () => {
  const document = build();
  const withFollowUp = document.comments.find(comment => comment.id === 'src/auth.js:10');

  assert.deepEqual(withFollowUp.followUps, [
    { body: 'Still open', at: '2026-08-10T14:00:00.000Z' }
  ]);
});

test('optional fields are omitted rather than null', () => {
  const document = build([{ file: 'a.js', line: 1, lineContent: 'x', text: 'y' }]);

  assert.ok(!('selection' in document.comments[0]));
  assert.ok(!('followUps' in document.comments[0]));
});

test('a highlighted selection is carried across', () => {
  const document = build([
    { file: 'a.js', line: 1, lineContent: 'x', text: 'y', selectedText: 'const a = 1' }
  ]);

  assert.equal(document.comments[0].selection, 'const a = 1');
});

test('the document round-trips through JSON unchanged', () => {
  // It is written to a file and read by another process; nothing in it may
  // depend on being the same objects.
  const document = build(COMMENTS, { head: 'abc', branch: 'main' });

  assert.deepEqual(JSON.parse(JSON.stringify(document)), document);
});

test('formatPrompt leads with the instruction before the data', () => {
  const prompt = formatPrompt(build());

  assert.match(prompt, /^# Code review to address/);
  assert.ok(
    prompt.indexOf('Work through every comment') < prompt.indexOf('src/auth.js:2'),
    'the instruction must come before the comments it governs'
  );
});

test('formatPrompt tells the agent to locate comments by anchor, not line number', () => {
  const prompt = formatPrompt(build());

  assert.match(prompt, /locate each comment by its `anchor` line/);
  assert.match(prompt, /Anchor line:/);
});

test('formatPrompt includes every comment body and follow-up', () => {
  const prompt = formatPrompt(build());

  for (const expected of ['Reject an empty token too.', 'Name this.', 'Why here?', 'Still open']) {
    assert.ok(prompt.includes(expected), `prompt should contain ${expected}`);
  }
});

test('formatPrompt writes one heading per file', () => {
  const prompt = formatPrompt(build());
  const headings = prompt.match(/^## .+$/gm);

  assert.deepEqual(headings, ['## src/auth.js', '## src/cache.js']);
});

test('formatPrompt reports the commit when there is one', () => {
  assert.match(formatPrompt(build(COMMENTS, { head: 'abc1234' })), /Reviewed at commit: abc1234/);
  assert.doesNotMatch(formatPrompt(build()), /Reviewed at commit/);
});

test('formatPrompt handles a review with a single comment and no extras', () => {
  const prompt = formatPrompt(build([{ file: 'a.js', line: 1, text: 'fix' }]));

  assert.match(prompt, /1 comment\(s\) across 1 file\(s\)/);
  assert.match(prompt, /fix/);
  assert.doesNotMatch(prompt, /Selected code/);
  assert.doesNotMatch(prompt, /Follow-ups/);
});

/**
 * Read the fenced block that follows `label`, and the lines after it.
 *
 * Returns the opening marker, the block's contents, and everything between the
 * closing marker and the next blank-line-delimited section, so a test can say
 * both "the anchor is inside the block" and "the comment body is not".
 *
 * @param {string} prompt
 * @param {string} label
 * @returns {{marker: string, content: string[], after: string[]}}
 */
function readFencedBlock(prompt, label) {
  const lines = prompt.split('\n');
  const start = lines.indexOf(label) + 2;
  const marker = lines[start];
  const end = lines.indexOf(marker, start + 1);
  return {
    marker,
    content: lines.slice(start + 1, end),
    after: lines.slice(end + 1)
  };
}

/**
 * An anchor that is itself a Markdown fence must not be wrapped in a fence of
 * the same length: the anchor closes the block early, and everything after it
 * — the comment body the agent is told to act on, and the next comment's
 * heading — is swallowed into a code block. See #22.
 *
 * `lib/review.js` already picks a marker longer than anything in the content
 * for the `.txt` review; these pin the prompt format to the same rule.
 */
test('formatPrompt fences an anchor that is itself a fence with a longer marker', () => {
  const prompt = formatPrompt(
    build([{ file: 'GUIDE.md', line: 7, lineContent: '```', text: 'Close the fence here.' }])
  );
  const { marker, content, after } = readFencedBlock(prompt, 'Anchor line:');

  assert.equal(marker, '````');
  assert.deepEqual(content, ['```']);
  assert.ok(
    after.includes('Close the fence here.'),
    'the comment body must land outside the fenced anchor, not inside it'
  );
});

test('formatPrompt fences a selection that is itself a fence with a longer marker', () => {
  const prompt = formatPrompt(
    build([
      {
        file: 'GUIDE.md',
        line: 7,
        lineContent: 'text',
        text: 'Selection case.',
        selectedText: '```'
      }
    ])
  );
  const { marker, content, after } = readFencedBlock(prompt, 'Selected code:');

  assert.equal(marker, '````');
  assert.deepEqual(content, ['```']);
  assert.ok(after.includes('Selection case.'));
});

test('formatPrompt keeps the next comment a heading when an anchor is a fence', () => {
  const prompt = formatPrompt(
    build([
      { file: 'GUIDE.md', line: 7, lineContent: '```', text: 'Close the fence here.' },
      { file: 'GUIDE.md', line: 9, lineContent: 'Done.', text: 'Add troubleshooting.' }
    ])
  );
  const lines = prompt.split('\n');
  const start = lines.indexOf('Anchor line:');

  // Asserted as the exact emitted sequence rather than "the heading appears
  // somewhere after the block": with a same-length marker the text is still
  // present in the string, just no longer a heading, so a containment check
  // passes either way and pins nothing.
  assert.deepEqual(lines.slice(start, start + 7), [
    'Anchor line:',
    '',
    '````',
    '```',
    '````',
    '',
    'Close the fence here.'
  ]);
  assert.ok(lines.includes('### GUIDE.md:9'));
});

test('formatPrompt leaves an ordinary anchor on a three-backtick fence', () => {
  const prompt = formatPrompt(
    build([{ file: 'a.js', line: 1, lineContent: 'const a = 1;', text: 'Rename.' }])
  );
  const { marker, content } = readFencedBlock(prompt, 'Anchor line:');

  assert.equal(marker, '```');
  assert.deepEqual(content, ['const a = 1;']);
});

// --- ids have to be unique within the document (#26) ---------------------

test('two comments on the same line get distinct ids', () => {
  // In a diff the removed line and the line that replaced it can carry the
  // same number, one on each side. Commenting on both is two ordinary
  // clicks, and `<file>:<line>` collided — so a consumer keyed by id, which
  // is what an id is for, silently kept one of them.
  const document = buildReviewDocument({
    repoPath: '/work/api',
    generatedAt: new Date('2026-01-01T00:00:00Z'),
    comments: [
      { file: 'src/auth.js', line: 5, text: 'on the removed line', lineContent: 'a' },
      { file: 'src/auth.js', line: 5, text: 'on the added line', lineContent: 'b' }
    ]
  });

  const ids = document.comments.map(comment => comment.id);

  assert.equal(new Set(ids).size, ids.length, `ids collided: ${ids.join(', ')}`);
  assert.deepEqual(ids, ['src/auth.js:5', 'src/auth.js:5#2']);
});

test('a lone comment on a line keeps the bare file:line id', () => {
  // Ids that churn are as bad as ids that collide: anything already keyed
  // on them breaks. Only a genuine collision gets a suffix.
  const document = buildReviewDocument({
    repoPath: '/work/api',
    generatedAt: new Date('2026-01-01T00:00:00Z'),
    comments: [
      { file: 'src/auth.js', line: 5, text: 'one' },
      { file: 'src/db.js', line: 9, text: 'another' }
    ]
  });

  assert.deepEqual(
    document.comments.map(comment => comment.id),
    ['src/auth.js:5', 'src/db.js:9']
  );
});

test('ids are the same on a second export of the same review', () => {
  // The format promises ids are stable across exports; the suffix must not
  // depend on anything that moves between runs.
  const comments = [
    { file: 'a.js', line: 1, text: 'first' },
    { file: 'a.js', line: 1, text: 'second' },
    { file: 'a.js', line: 1, text: 'third' }
  ];
  const build = () => buildReviewDocument({
    repoPath: '/work/api',
    generatedAt: new Date(),
    comments
  }).comments.map(comment => comment.id);

  assert.deepEqual(build(), build());
  assert.deepEqual(build(), ['a.js:1', 'a.js:1#2', 'a.js:1#3']);
});

test('filtering to a file does not renumber the ids it keeps', () => {
  // Ids are assigned before filtering, so the same comment carries the same
  // id whether or not you asked for the whole review.
  const args = {
    repoPath: '/work/api',
    generatedAt: new Date('2026-01-01T00:00:00Z'),
    comments: [
      { file: 'a.js', line: 1, text: 'one' },
      { file: 'b.js', line: 2, text: 'two' },
      { file: 'b.js', line: 2, text: 'three' }
    ]
  };
  const full = buildReviewDocument(args);
  const filtered = filterReviewDocument(buildReviewDocument(args), { file: 'b.js' });

  assert.deepEqual(
    filtered.comments.map(comment => comment.id),
    full.comments.filter(comment => comment.file === 'b.js').map(comment => comment.id)
  );
  assert.deepEqual(filtered.comments.map(comment => comment.id), ['b.js:2', 'b.js:2#2']);
});

// --- the briefing says what was reviewed, not just where HEAD is ----------

/** A one-comment document in `mode`, for reading the briefing off. */
function briefingFor(mode, { head = 'abc1234', branch = 'feature/x' } = {}) {
  return formatPrompt(buildReviewDocument({
    repoPath: '/work/api',
    generatedAt: new Date('2026-09-22T00:00:00Z'),
    head,
    branch,
    mode,
    comments: [{ file: 'a.js', line: 1, lineContent: 'const x = 1;', text: 'why' }]
  }));
}

test('a working-tree review does not claim to be a review of a commit', () => {
  // The bug this replaces: both modes printed `Reviewed at commit: <sha>`. In
  // working mode the review is of changes that are *not* in that commit, so
  // the line was not vague, it was false.
  const briefing = briefingFor('working');

  assert.match(briefing, /uncommitted changes in the working tree/);
  assert.match(briefing, /against feature\/x \(abc1234\)/);
  assert.doesNotMatch(briefing, /Reviewed at commit/);
});

test('a single-commit review names the commit and what it is against', () => {
  const briefing = briefingFor('lastCommit');

  assert.match(briefing, /Reviewed: commit abc1234, against its parent\./);
  assert.doesNotMatch(briefing, /working tree/);
});

test('a working-tree review on a detached HEAD still says what it reviewed', () => {
  assert.match(briefingFor('working', { branch: null }), /against HEAD \(abc1234\)/);
});

test('a review with no recorded mode claims no more than it knows', () => {
  // Written before the mode was stored. There is nothing on disk saying what
  // was compared, so it reports where HEAD is and stops -- which is exactly
  // what it did before, and the right answer when the alternative is a guess.
  const briefing = briefingFor(null);

  assert.match(briefing, /Reviewed at commit: abc1234/);
  assert.doesNotMatch(briefing, /working tree/);
  assert.doesNotMatch(briefing, /against its parent/);
});

test('with no commit at all the briefing omits the line rather than half-saying it', () => {
  const briefing = briefingFor(null, { head: null });

  assert.doesNotMatch(briefing, /Reviewed/);
  assert.match(briefing, /Repository: \/work\/api/);
});

test('a range review names both ends and how many commits it flattened', () => {
  // An agent handed a combined diff of nine commits should know that is what
  // it is holding. Without the count, a range of nine reads exactly like a
  // range of one.
  const briefing = formatPrompt(buildReviewDocument({
    repoPath: '/work/api',
    generatedAt: new Date('2026-09-23T00:00:00Z'),
    head: 'ff92a86',
    branch: 'main',
    mode: 'range',
    range: { base: '5ef1109', head: 'ff92a86', commits: 9 },
    comments: [{ file: 'a.js', line: 1, lineContent: 'const x = 1;', text: 'why' }]
  }));

  assert.match(briefing, /between 5ef1109 and ff92a86 \(9 commits\)/);
  assert.match(briefing, /single combined diff/);
});

test('a one-commit range still reads as English', () => {
  const briefing = formatPrompt(buildReviewDocument({
    repoPath: '/work/api',
    generatedAt: new Date('2026-09-23T00:00:00Z'),
    head: 'ff92a86',
    mode: 'range',
    range: { base: '5ef1109', head: 'ff92a86', commits: 1 },
    comments: [{ file: 'a.js', line: 1, lineContent: 'x', text: 'y' }]
  }));

  assert.match(briefing, /\(1 commit\)/);
  assert.doesNotMatch(briefing, /1 commits/);
});

test('a document with no range omits the field rather than nulling it', () => {
  // Same rule the optional comment fields follow, so `'range' in document`
  // is a meaningful test.
  const working = buildReviewDocument({
    repoPath: '/work/api',
    generatedAt: new Date('2026-09-23T00:00:00Z'),
    mode: 'working',
    comments: [{ file: 'a.js', line: 1, lineContent: 'x', text: 'y' }]
  });

  assert.equal('range' in working, false);
});

test('a diverged range tells the agent what was left out, and to leave it alone', () => {
  // An agent that sees main's newer code differ from the branch has no way
  // to know that difference was deliberately excluded. Told nothing, it may
  // "fix" it -- and revert someone else's work.
  const briefing = formatPrompt(buildReviewDocument({
    repoPath: '/work/api',
    generatedAt: new Date('2026-09-23T00:00:00Z'),
    head: '4f2c0e1',
    branch: 'feature/auth',
    mode: 'range',
    range: {
      base: '3eb5795', head: '4f2c0e1', from: '7c9c142',
      commits: 3, behind: 1, baseName: 'main', headName: 'feature/auth'
    },
    comments: [{ file: 'a.js', line: 1, lineContent: 'x', text: 'y' }]
  }));

  assert.match(briefing, /what feature\/auth changes since it diverged from main \(merge base 7c9c142, head 4f2c0e1\)/);
  assert.match(briefing, /main has 1 newer commit that is deliberately not part of this review; leave that code alone\./);
});

test('a straight-line range names both ends without talking about divergence', () => {
  const briefing = formatPrompt(buildReviewDocument({
    repoPath: '/work/api',
    generatedAt: new Date('2026-09-23T00:00:00Z'),
    mode: 'range',
    range: {
      base: '7c9c142', head: '4f2c0e1', from: '7c9c142',
      commits: 3, behind: 0, baseName: 'main', headName: 'feature/auth'
    },
    comments: [{ file: 'a.js', line: 1, lineContent: 'x', text: 'y' }]
  }));

  assert.match(briefing, /Reviewed: main → feature\/auth \(7c9c142\.\.4f2c0e1\), 3 commits/);
  assert.doesNotMatch(briefing, /diverged|leave that code alone/);
});
