'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  lastAuthor,
  awaitingAnswer,
  unionFollowUps,
  keepFollowUpsFrom,
  newReviewerMessages,
  describeThread,
  appendReply
} = require('../lib/threads');

const question = { key: 'q1', text: 'Why inclusive?', timestamp: '2026-10-24T10:00:00.000Z' };
const answer = { key: 'a1', text: 'On purpose.', timestamp: '2026-10-24T10:00:05.000Z', by: 'claude' };
const comment = (key, extra = {}) => ({ key, file: 'src/a.js', line: 3, lineContent: 'x > y', text: `comment ${key}`, ...extra });

test('a thread waits for an answer until an agent has the last word', () => {
  assert.equal(lastAuthor(comment('k')), null);
  assert.equal(lastAuthor(comment('k', { followUps: [answer] })), 'claude');
  assert.equal(lastAuthor(comment('k', { followUps: [answer, question] })), null, 'the reviewer replied after the answer');

  const waiting = awaitingAnswer([
    comment('new'),
    comment('answered', { followUps: [answer] }),
    comment('asked-again', { followUps: [answer, question] })
  ]);
  assert.deepEqual(waiting.map(c => c.key), ['new', 'asked-again']);
});

test('a union of follow-ups keeps every answer once, in the order written', () => {
  const mine = { key: 'm1', text: 'And time zones?', timestamp: '2026-10-24T10:00:09.000Z' };

  assert.deepEqual(unionFollowUps([question, mine], [question, answer]).map(f => f.key), ['q1', 'a1', 'm1']);
  assert.deepEqual(unionFollowUps([question], [question]).map(f => f.key), ['q1'], 'nothing is doubled');
  assert.deepEqual(unionFollowUps(undefined, [answer]).map(f => f.key), ['a1']);
});

test('follow-ups saved before keys existed are matched by what they said and when', () => {
  const legacy = { text: 'still open', timestamp: '2026-08-10T09:00:00.000Z' };
  assert.equal(unionFollowUps([legacy], [{ ...legacy }]).length, 1);
});

test('a whole-list save keeps the follow-ups already on disk for every comment it still holds', () => {
  const stale = [comment('k1'), comment('k2')];
  const onDisk = [comment('k1', { followUps: [answer] }), comment('k3')];

  const kept = keepFollowUpsFrom(stale, onDisk);

  assert.deepEqual(kept.find(c => c.key === 'k1').followUps, [answer], 'the answer survives a save from a tab that never saw it');
  assert.equal(kept.find(c => c.key === 'k2').followUps, undefined);
  assert.equal(kept.length, 2, 'what the save deletes or never had is not this function\'s to decide');
});

test('what the reviewer said since last time comes back once per message', () => {
  const before = [comment('k1'), comment('k2', { followUps: [answer] })];
  const after = [
    comment('k1', { followUps: [question] }),
    comment('k2', { followUps: [answer, { ...answer, key: 'a2' }] }),
    comment('k3', { followUps: [{ key: 'q9', text: 'arrived with the comment' }] })
  ];

  const messages = newReviewerMessages(before, after);

  assert.deepEqual(messages.map(m => [m.comment.key, m.followUp?.key ?? null]), [
    ['k1', 'q1'], // a reply from the reviewer
    ['k3', null] // a new comment, told once even though it arrived with a follow-up
  ]);
});

test('an agent\'s own answer is not news to it', () => {
  const before = [comment('k1')];
  const after = [comment('k1', { followUps: [answer] })];
  assert.deepEqual(newReviewerMessages(before, after), []);
});

test('a thread is described with its anchor, selection and who said what', () => {
  const text = describeThread(comment('k1', {
    selectedText: 'x > y',
    followUps: [answer, question]
  }));

  assert.equal(text, [
    'src/a.js, line 3',
    'Line: x > y',
    'Selected: x > y',
    '',
    'Reviewer: comment k1',
    'claude (you): On purpose.',
    'Reviewer: Why inclusive?'
  ].join('\n'));
});

test('a reply lands on the comment with its key, and an unknown key is reported, not ignored', () => {
  const comments = [comment('k1'), comment('k2')];

  const updated = appendReply(comments, 'k2', answer);
  assert.deepEqual(updated.find(c => c.key === 'k2').followUps, [answer]);
  assert.equal(comments[1].followUps, undefined, 'the input is left alone');

  assert.equal(appendReply(comments, 'nope', answer), null);
});
