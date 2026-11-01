'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * What the sessions dialog says about a session and how it hands one to a
 * terminal, lifted out of public/app.js the way commits-ui.test.js lifts the
 * commit list's arithmetic. A session may have started somewhere other than
 * the repository under review, and the dialog has to say where without
 * claiming more than it knows.
 */

const APP_JS = path.join(__dirname, '..', 'public', 'app.js');
const CODE = fs.readFileSync(APP_JS, 'utf-8');

function source(name) {
  const match = CODE.match(new RegExp(`function ${name}\\([^{]*\\{([\\s\\S]*?\\n\\})`));
  if (!match) throw new Error(`Could not find ${name} in app.js`);
  return match[0];
}

const context = vm.createContext({ FOLDER_ICON: '<svg/>' });
vm.runInContext(['escapeHtml', 'sessionPlaceHtml', 'startedText', 'liveCommand', 'shellQuote', 'emptySessionsHtml'].map(source).join('\n\n'), context);
const { sessionPlaceHtml, startedText, liveCommand, emptySessionsHtml } = context;

/** The words a reader sees, without the markup. */
const words = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

test('a session at the repository\'s root says nothing among this repository\'s own, and is marked among all', () => {
  const session = { relation: 'repo', place: null, cwd: '/w/shop' };
  assert.equal(sessionPlaceHtml(session, 'repository'), '');
  assert.equal(words(sessionPlaceHtml(session, 'all')), 'this repository');
});

test('a session started in a folder inside shows that folder, and is this repository\'s among all', () => {
  const session = { relation: 'subfolder', place: 'src/', cwd: '/w/shop/src' };
  assert.equal(words(sessionPlaceHtml(session, 'repository')), 'src/');
  assert.equal(words(sessionPlaceHtml(session, 'all')), 'src/ this repository');
});

test('a session started above says how far above, and its full path is a hover away', () => {
  const one = sessionPlaceHtml({ relation: 'parent', place: '~/work', above: 1, cwd: '/home/me/work' }, 'repository');
  assert.equal(words(one), '~/work a folder above');
  assert.match(one, /title="\/home\/me\/work"/);
  assert.equal(words(sessionPlaceHtml({ relation: 'parent', place: '~', above: 2, cwd: '/home/me' }, 'all')), '~ 2 folders above');
});

test('a session from somewhere else shows only where, and a hostile folder name stays text', () => {
  assert.equal(words(sessionPlaceHtml({ relation: 'other', place: '~/blog', cwd: '/home/me/blog' }, 'all')), '~/blog');
  const html = sessionPlaceHtml({ relation: 'other', place: '~/<img src=x onerror=alert(1)>', cwd: '/x/"><b>' }, 'all');
  assert.doesNotMatch(html, /<img|<b>/);
});

test('the connection says where the answering session started, and so what it can read', () => {
  assert.equal(startedText({ relation: 'repo', place: null }), '');
  assert.equal(startedText({ relation: 'subfolder', place: 'src/' }), 'Started in src/; it has been given the whole repository to read.');
  assert.equal(startedText({ relation: 'parent', place: '~/work' }), 'Started in ~/work, above this repository; it can read all of ~/work.');
  assert.equal(startedText({ relation: 'other', place: '~/api' }),
    'Started in ~/api, outside this repository; it can read ~/api and this repository.');
  assert.equal(startedText({ place: null }), '', 'a status from before this was reported');
});

test('the live command names the repository, so it runs from any folder, quoted only when it must be', () => {
  const id = '00000001-0000-4000-8000-000000000001';
  assert.equal(liveCommand('/home/me/work/shop', id), `reviewer connect /home/me/work/shop --session ${id}`);
  assert.equal(liveCommand('/home/me/My Work/shop', id), `reviewer connect '/home/me/My Work/shop' --session ${id}`);
  assert.equal(liveCommand("/home/me/it's", id), `reviewer connect '/home/me/it'\\''s' --session ${id}`);
  assert.equal(liveCommand('/tmp/$(rm -rf ~)', id), `reviewer connect '/tmp/$(rm -rf ~)' --session ${id}`);
  assert.equal(liveCommand('C:\\work\\shop', id), `reviewer connect C:\\work\\shop --session ${id}`);
  assert.equal(liveCommand('C:\\My Work\\shop', id), `reviewer connect "C:\\My Work\\shop" --session ${id}`);
  assert.equal(liveCommand(null, id), `reviewer connect --session ${id}`, 'before the list has said which repository');
});

test('an empty list says why, and offers the wider list where there is one', () => {
  assert.match(emptySessionsHtml('repository', ''), /No Claude Code session has worked in this repository yet/);
  assert.match(emptySessionsHtml('repository', ''), /setSessionScope\('all'\)">Show all sessions/);
  assert.match(emptySessionsHtml('repository', 'auth'), /No session of this repository matches \u201cauth\u201d/);
  assert.match(emptySessionsHtml('repository', 'auth'), /Search all sessions/);
  assert.match(emptySessionsHtml('all', 'auth'), /^<p class="agent-empty">No session matches \u201cauth\u201d\.<\/p>$/);
  assert.doesNotMatch(emptySessionsHtml('all', '<b>x</b>'), /<b>/);
  assert.match(emptySessionsHtml('all', ''), /No Claude Code sessions were found/);
});
