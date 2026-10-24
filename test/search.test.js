'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { buildMatcher, matchRanges, definesName, summarizeReferences, SearchError } = require('../lib/search');
const { createApp } = require('../server');
const { createTempRepo, commitFiles, writeFiles, cleanup } = require('./helpers/repo');

test('match modes: contains, whole word, starts with, ends with, regex', () => {
  const line = 'parseThread(parseThreadKey(x)); reparseThread()';
  const count = (query, mode, caseSensitive) => matchRanges(line, buildMatcher(query, { mode, caseSensitive })).length;

  assert.equal(count('parseThread', 'contains'), 3);
  assert.equal(count('parseThread', 'word'), 1, 'not parseThreadKey, not reparseThread');
  assert.equal(count('parseThread', 'prefix'), 2, 'parseThread and parseThreadKey');
  assert.equal(count('parseThread', 'suffix'), 2, 'parseThread and reparseThread');
  assert.equal(count('parse\\w+Key', 'regex'), 1);
  assert.equal(count('PARSETHREAD', 'word'), 1, 'case-insensitive by default');
  assert.equal(count('PARSETHREAD', 'word', true), 0);
  assert.deepEqual(matchRanges('a $total b', buildMatcher('total', { mode: 'word' })), [], '$ is part of a JS identifier');
});

test('a bad search says what is wrong instead of failing', () => {
  assert.throws(() => buildMatcher('(unclosed', { mode: 'regex' }), SearchError);
  assert.throws(() => buildMatcher('   '), /Type something/);
  assert.throws(() => buildMatcher('x', { mode: 'fuzzy' }), /Unknown match mode/);
  assert.deepEqual(matchRanges('abc', buildMatcher('x*', { mode: 'regex' })), [], 'an empty match never loops');
});

test('definitions are told from uses, in the forms people write them', () => {
  for (const line of [
    'function applyDiscount(discount, subtotal) {',
    'export async function applyDiscount() {',
    'const applyDiscount = (d, s) => {',
    'applyDiscount: function (d) {',
    'def apply_discount(self):'.replace('apply_discount', 'applyDiscount'),
    '  applyDiscount(discount, subtotalCents) {',
    'class applyDiscount extends Base {'
  ]) assert.equal(definesName(line, 'applyDiscount'), true, line);

  for (const line of [
    'const total = applyDiscount(d, 100);',
    '  if (applyDiscount(d, s) > 0) {',
    'module.exports = { applyDiscount };',
    'import { applyDiscount } from "./discounts";'
  ]) assert.equal(definesName(line, 'applyDiscount'), false, line);
});

test('a references summary warns when a definition changed under uses that did not', () => {
  const summary = summarizeReferences([
    { role: 'definition', side: 'added' },
    { role: 'definition', side: 'deleted' },
    { role: 'reference', side: 'added' },
    { role: 'reference', side: 'deleted' },
    { role: 'reference', side: 'context' },
    { role: 'reference', side: 'untouched' }
  ]);
  assert.deepEqual({ ...summary, warning: Boolean(summary.warning) }, { definitions: 2, added: 1, removed: 1, unchanged: 2, warning: true });
  assert.equal(summarizeReferences([{ role: 'definition', side: 'context' }, { role: 'reference', side: 'untouched' }]).warning, null);
});

async function searchServer(t) {
  const base = await fs.realpath(os.tmpdir());
  const reviewsDir = await fs.mkdtemp(path.join(base, 'reviewer-search-'));
  const repoPath = await createTempRepo();
  await commitFiles(repoPath, {
    'cart.js': 'function total(items) {\n  return items.length;\n}\nconst t = total(list);\n',
    'checkout.js': 'const sum = total(cart);\n',
    'docs/notes.md': 'call total() before paying\n'
  }, 'initial');
  // The change: total() is renamed to subtotal(); cart.js and a new file use it.
  await writeFiles(repoPath, {
    'cart.js': 'function subtotal(items) {\n  return items.length;\n}\nconst t = subtotal(list);\n',
    'pay.js': 'const due = subtotal(items);\n'
  });
  const app = createApp({ reviewsDir });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeIdleConnections?.();
    await closed;
    await cleanup(repoPath);
    await fs.rm(reviewsDir, { recursive: true, force: true });
  });
  const { repoId } = await (await fetch(`${url}/api/load-repo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repoPath })
  })).json();
  const search = async params => {
    const response = await fetch(`${url}/api/search/${repoId}?${new URLSearchParams(params)}`);
    return { status: response.status, body: await response.json() };
  };
  return { url, repoId, search };
}

test('searching the change finds the old name where it was deleted, and nowhere it was kept', async t => {
  const { search } = await searchServer(t);

  const { status, body } = await search({ q: 'total', mode: 'word', scope: 'changes' });
  assert.equal(status, 200);
  assert.deepEqual(body.results.map(r => [r.file, r.side, r.line]), [
    ['cart.js', 'deleted', 1],
    ['cart.js', 'deleted', 4]
  ]);
  assert.deepEqual(body.results[0].ranges, [[9, 14]]);
});

test('each result points at the line the diff view draws, so the page can jump to it', async t => {
  const { url, repoId, search } = await searchServer(t);
  const { body } = await search({ q: 'subtotal', scope: 'files' });
  const diff = await (await fetch(`${url}/api/file/${repoId}/cart.js`)).json();

  for (const result of body.results.filter(r => r.file === 'cart.js')) {
    assert.equal(diff.diffLines[result.diffIndex].content, result.text);
  }
  assert.deepEqual([...new Set(body.results.map(r => r.side))].sort(), ['added']);
});

test('the whole repository adds the uses the change left alone, marked as such', async t => {
  const { search } = await searchServer(t);
  const { body } = await search({ q: 'total', mode: 'word', scope: 'repo' });

  const untouched = body.results.filter(r => r.side === 'untouched').map(r => [r.file, r.line]);
  assert.deepEqual(untouched.sort(), [['checkout.js', 1], ['docs/notes.md', 1]]);
  assert.equal(body.results.filter(r => r.file === 'cart.js' && r.side === 'untouched').length, 0, 'changed files come from their diff, once');
});

test('a references search reports the renamed definition and the caller left behind', async t => {
  const { search } = await searchServer(t);
  const { body } = await search({ q: 'total', symbol: '1', scope: 'repo' });

  assert.equal(body.symbol, true);
  assert.equal(body.results.find(r => r.role === 'definition').side, 'deleted');
  assert.equal(body.summary.removed, 1);
  assert.equal(body.summary.unchanged, 2);
  assert.match(body.summary.warning, /definition changed, and 2 uses were left/);
});

test('an invalid regular expression is a 400 with the reason', async t => {
  const { search } = await searchServer(t);
  const { status, body } = await search({ q: '(oops', mode: 'regex' });
  assert.equal(status, 400);
  assert.match(body.error, /not a valid regular expression/);
  assert.equal((await search({ q: 'x', scope: 'galaxy' })).status, 400);
});
