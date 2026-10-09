'use strict';

// The agent-plugin manifests must agree with the package and with each other.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const json = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const MANIFESTS = ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', '.cursor-plugin/plugin.json', '.github/plugin/plugin.json'];

test('every plugin manifest carries the package version and one name', () => {
  const { version } = json('package.json');
  for (const f of MANIFESTS) {
    const m = json(f);
    assert.equal(m.name, 'git-reviewer', f);
    assert.equal(m.version, version, f);
  }
  for (const p of json('.claude-plugin/marketplace.json').plugins) {
    assert.equal(p.name, 'git-reviewer');
    assert.equal(p.version, version);
    assert.equal(p.source, './');
  }
});

test('the review skill has the frontmatter agents need', () => {
  const text = fs.readFileSync(path.join(root, 'skills', 'review', 'SKILL.md'), 'utf8');
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(fm);
  assert.match(fm[1], /^name: review$/m);
  const desc = /^description: (.+)$/m.exec(fm[1]);
  assert.ok(desc && desc[1].length > 40 && desc[1].length <= 1024);
});

test('the skill only tells the agent to run commands the CLI has', () => {
  const text = fs.readFileSync(path.join(root, 'skills', 'review', 'SKILL.md'), 'utf8');
  const help = require('node:child_process').spawnSync(process.execPath, [path.join(root, 'bin', 'reviewer.js'), '--help'], { encoding: 'utf8' }).stdout;
  for (const flag of ['--staged', '--format']) {
    assert.ok(text.includes(flag), flag);
    assert.ok(help.includes(flag), `--help should list ${flag}`);
  }
  assert.ok(help.includes('export'));
});
