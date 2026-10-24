'use strict';

const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

const { canonicalRepoPath } = require('./review');

/**
 * Finding the Claude Code sessions that worked in a repository.
 *
 * The session worth asking about a change is the one that made it: it read
 * the code, chose the approach and remembers why. Claude Code keeps each
 * session's transcript as a JSON-lines file under its config directory,
 * filed by the working directory it ran in, and that is what is read here --
 * only the first and last few kilobytes of each, for its working directory,
 * its name and the first thing it was asked.
 */

// Enough of the head for the first prompt and the working directory, and of
// the tail for a name given later in the session, without reading a
// transcript that can run to tens of megabytes.
const SLICE_BYTES = 64 * 1024;
const PROMPT_CHARS = 240;

/** Where Claude Code keeps its state: `CLAUDE_CONFIG_DIR`, or `~/.claude`. */
function claudeConfigDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), '.claude');
}

/**
 * The directory name Claude Code files a working directory's sessions under:
 * the path with every character that is not a letter or a digit turned into
 * `-`. `/home/you/work/api` becomes `-home-you-work-api`.
 *
 * @param {string} dir
 */
function projectDirName(dir) {
  return dir.replace(/[^A-Za-z0-9]/g, '-');
}

/** A session id as Claude Code writes them: a UUID. */
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {string} file
 * @param {number} start
 * @param {number} length
 * @returns {Promise<string>}
 */
async function readSlice(file, start, length) {
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString('utf-8');
  } finally {
    await handle.close();
  }
}

/**
 * The records in a slice of a transcript. A slice cut mid-line yields a
 * fragment at either end, which does not parse and is skipped.
 *
 * @param {string} text
 * @returns {object[]}
 */
function records(text) {
  const parsed = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      parsed.push(JSON.parse(line));
    } catch {
      /* a fragment */
    }
  }
  return parsed;
}

/**
 * What a person typed, out of a transcript's user message -- not a tool
 * result, and not the wrappers Claude Code puts around slash commands and
 * reminders, which all open with a tag.
 *
 * @param {unknown} content
 * @returns {string|null}
 */
function promptText(content) {
  let text = null;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content.find(block => block?.type === 'text' && typeof block.text === 'string')?.text ?? null;
  }
  if (!text) return null;
  text = text.trim();
  if (text === '' || text.startsWith('<') || text.startsWith('Caveat:')) return null;
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > PROMPT_CHARS ? `${flat.slice(0, PROMPT_CHARS - 1)}…` : flat;
}

/**
 * @typedef {object} ClaudeSession
 * @property {string} id
 * @property {string} cwd the directory it ran in
 * @property {string|null} title the name it was given, or Claude Code's summary of it
 * @property {string|null} firstPrompt
 * @property {string|null} branch git branch when it started
 * @property {string} updatedAt when it last wrote anything
 */

/**
 * Read what a transcript says about itself.
 *
 * @param {string} file
 * @returns {Promise<ClaudeSession|null>} null for a file that is not a session transcript
 */
async function describeSession(file) {
  const id = path.basename(file, '.jsonl');
  if (!SESSION_ID_PATTERN.test(id)) return null;

  const stat = await fsp.stat(file);
  const head = await readSlice(file, 0, SLICE_BYTES);
  const tail = stat.size > SLICE_BYTES ? await readSlice(file, stat.size - SLICE_BYTES, SLICE_BYTES) : '';

  let cwd = null;
  let branch = null;
  let firstPrompt = null;
  let title = null;
  let summary = null;

  for (const record of [...records(head), ...records(tail)]) {
    if (typeof record.cwd === 'string') cwd ??= record.cwd;
    if (typeof record.gitBranch === 'string' && record.gitBranch !== '') branch ??= record.gitBranch;
    if (!firstPrompt && record.type === 'user' && !record.isMeta && !record.isSidechain) {
      firstPrompt = promptText(record.message?.content);
    }
    // Later records win: a session renamed halfway through goes by its new name.
    if (record.type === 'custom-title' && typeof record.customTitle === 'string') title = record.customTitle;
    if (record.type === 'summary' && typeof record.summary === 'string') summary = record.summary;
  }

  if (!cwd) return null;
  return { id, cwd, title: title ?? summary ?? null, firstPrompt, branch, updatedAt: stat.mtime.toISOString() };
}

/** @param {string} child @param {string} parent */
function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Claude Code sessions that ran in a repository or any directory inside it,
 * most recently active first.
 *
 * @param {string} repoPath
 * @param {object} [options]
 * @param {string} [options.configDir]
 * @param {number} [options.limit]
 * @returns {Promise<ClaudeSession[]>}
 */
async function listClaudeSessions(repoPath, { configDir = claudeConfigDir(), limit = 20 } = {}) {
  const projects = path.join(configDir, 'projects');
  const root = canonicalRepoPath(repoPath);
  // The encoding loses information -- `/a/b-c` and `/a/b/c` share a name --
  // so a matching directory is only a candidate. Each transcript's own
  // working directory is what decides.
  const prefixes = [...new Set([projectDirName(root), projectDirName(path.resolve(repoPath))])];

  let dirs;
  try {
    dirs = (await fsp.readdir(projects, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && prefixes.some(prefix => entry.name.startsWith(prefix)))
      .map(entry => path.join(projects, entry.name));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const candidates = [];
  for (const dir of dirs) {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const file = path.join(dir, entry.name);
      const stat = await fsp.stat(file).catch(() => null);
      if (stat) candidates.push({ file, mtimeMs: stat.mtimeMs });
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const sessions = [];
  for (const { file } of candidates) {
    if (sessions.length >= limit) break;
    const session = await describeSession(file).catch(() => null);
    if (!session || !(session.firstPrompt || session.title)) continue;
    if (!isInside(canonicalRepoPath(session.cwd), root)) continue;
    sessions.push(session);
  }
  return sessions;
}

/**
 * One session of a repository, by id -- or null, which is the answer for an
 * id that is malformed, unknown, or belongs to another repository.
 *
 * @param {string} repoPath
 * @param {string} id
 * @param {object} [options]
 * @param {string} [options.configDir]
 * @returns {Promise<ClaudeSession|null>}
 */
async function findClaudeSession(repoPath, id, { configDir = claudeConfigDir() } = {}) {
  if (typeof id !== 'string' || !SESSION_ID_PATTERN.test(id)) return null;
  const sessions = await listClaudeSessions(repoPath, { configDir, limit: Infinity });
  return sessions.find(session => session.id === id) ?? null;
}

module.exports = {
  listClaudeSessions,
  findClaudeSession,
  describeSession,
  claudeConfigDir,
  projectDirName,
  promptText,
  SESSION_ID_PATTERN
};
