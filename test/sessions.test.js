'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { SessionStore } = require('../lib/sessions');

test('create returns an id that resolves to the repository', () => {
  const sessions = new SessionStore();
  const repoId = sessions.create('/work/app', 'working');

  assert.deepEqual(sessions.get(repoId), { repoPath: '/work/app', mode: 'working', range: null });
});

test('get returns undefined for an unknown id', () => {
  assert.equal(new SessionStore().get('nope'), undefined);
});

test('sessions are independent of one another', () => {
  const sessions = new SessionStore();
  const first = sessions.create('/work/one', 'working');
  const second = sessions.create('/work/two', 'lastCommit');

  assert.equal(sessions.get(first).repoPath, '/work/one');
  assert.equal(sessions.get(second).mode, 'lastCommit');
  assert.equal(sessions.size, 2);
});

test('generated ids are unique', () => {
  const sessions = new SessionStore();
  const ids = new Set(Array.from({ length: 200 }, () => sessions.create('/work/app', 'working')));

  assert.equal(ids.size, 200);
});

test('generated ids are hex and hard to guess', () => {
  const repoId = new SessionStore().create('/work/app', 'working');

  assert.match(repoId, /^[0-9a-f]{16}$/);
});

test('delete removes a session and reports whether it existed', () => {
  const sessions = new SessionStore();
  const repoId = sessions.create('/work/app', 'working');

  assert.equal(sessions.delete(repoId), true);
  assert.equal(sessions.get(repoId), undefined);
  assert.equal(sessions.delete(repoId), false);
  assert.equal(sessions.size, 0);
});

test('the id generator can be injected', () => {
  let n = 0;
  const sessions = new SessionStore(() => `id-${++n}`);

  assert.equal(sessions.create('/a', 'working'), 'id-1');
  assert.equal(sessions.create('/b', 'working'), 'id-2');
});
