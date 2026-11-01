'use strict';

const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

const { canonicalRepoPath } = require('./review');

/**
 * Finding the Claude Code sessions that worked in a repository -- and, when
 * the one wanted is not among them, every other session on the machine.
 *
 * The session worth asking about a change is the one that made it: it read
 * the code, chose the approach and remembers why. Claude Code keeps each
 * session's transcript as a JSON-lines file under its config directory,
 * filed by the working directory it started in, and that is what is read
 * here -- only the first and last few kilobytes of each, for where it
 * worked, its name and the first thing it was asked.
 *
 * A session is not always started in the repository it works on. Started in
 * a folder above it -- a workspace holding several repositories, or the home
 * directory -- it is filed under that folder, and it counts as this
 * repository's when what was read of it shows it working here: its working
 * directory moved inside, or it read or edited a file inside.
 */

// Enough of the head for the first prompt and the working directory, and of
// the tail for a name given later in the session, without reading a
// transcript that can run to tens of megabytes.
const SLICE_BYTES = 64 * 1024;
const PROMPT_CHARS = 240;
// Places a transcript was seen working in, kept per transcript. A session
// that touched more than this many files in the parts read has said enough.
const VISITED_LIMIT = 256;

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
 * The files and folders an assistant message's tool calls name: what Read,
 * Edit, Write, Grep and Glob were pointed at. Claude Code has them take
 * absolute paths, so each one says where the session was working.
 *
 * @param {object} record
 * @returns {string[]}
 */
function toolPaths(record) {
  if (record.type !== 'assistant' || !Array.isArray(record.message?.content)) return [];
  const paths = [];
  for (const block of record.message.content) {
    if (block?.type !== 'tool_use' || !block.input || typeof block.input !== 'object') continue;
    for (const key of ['file_path', 'path', 'notebook_path']) {
      const value = block.input[key];
      if (typeof value === 'string' && path.isAbsolute(value)) paths.push(value);
    }
  }
  return paths;
}

/**
 * @typedef {object} ClaudeSession
 * @property {string} id
 * @property {string} cwd the directory it started in: where Claude Code files it, and resumes it from
 * @property {string|null} title the name it was given, or Claude Code's summary of it
 * @property {string|null} firstPrompt
 * @property {string|null} branch git branch when it started
 * @property {string} updatedAt when it last wrote anything
 */

/**
 * @typedef {'repo'|'subfolder'|'parent'|'other'} Relation
 *   Where a session started, against a repository: at its root, in a folder
 *   inside it, in a folder above it, or somewhere else.
 */

/**
 * @typedef {ClaudeSession & {relation: Relation, place: string|null, above?: number}} RelatedSession
 *   `place` is where it started, as it is shown: `src/` inside the
 *   repository, `~/work` outside it, and null at the root. `above` is how
 *   many folders above the repository a `parent` session started.
 */

/**
 * Read what a transcript says about itself, and every place it was seen
 * working in.
 *
 * @param {string} file
 * @param {import('fs').Stats} stat
 * @returns {Promise<{session: ClaudeSession, visited: string[]}|null>}
 */
async function readTranscript(file, stat) {
  const id = path.basename(file, '.jsonl');
  if (!SESSION_ID_PATTERN.test(id)) return null;

  const head = await readSlice(file, 0, SLICE_BYTES);
  const tail = stat.size > SLICE_BYTES ? await readSlice(file, stat.size - SLICE_BYTES, SLICE_BYTES) : '';

  let cwd = null;
  let branch = null;
  let firstPrompt = null;
  let title = null;
  let summary = null;
  const visited = new Set();

  for (const record of [...records(head), ...records(tail)]) {
    if (typeof record.cwd === 'string') {
      cwd ??= record.cwd;
      if (visited.size < VISITED_LIMIT) visited.add(record.cwd);
    }
    if (typeof record.gitBranch === 'string' && record.gitBranch !== '') branch ??= record.gitBranch;
    if (!firstPrompt && record.type === 'user' && !record.isMeta && !record.isSidechain) {
      firstPrompt = promptText(record.message?.content);
    }
    // Later records win: a session renamed halfway through goes by its new name.
    if (record.type === 'custom-title' && typeof record.customTitle === 'string') title = record.customTitle;
    if (record.type === 'summary' && typeof record.summary === 'string') summary = record.summary;
    for (const named of toolPaths(record)) {
      if (visited.size < VISITED_LIMIT) visited.add(named);
    }
  }

  if (!cwd) return null;
  return {
    session: { id, cwd, title: title ?? summary ?? null, firstPrompt, branch, updatedAt: stat.mtime.toISOString() },
    visited: [...visited]
  };
}

// What each transcript said, kept between lookups -- the page asks again
// each time the dialog opens or a search changes -- and read again only once
// the transcript has changed. Bounded: a machine can hold thousands.
const transcriptCache = new Map();
const CACHE_LIMIT = 10000;

/**
 * @param {string} file
 * @param {import('fs').Stats} stat
 */
async function readTranscriptCached(file, stat) {
  const cached = transcriptCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.result;
  let result;
  try {
    result = await readTranscript(file, stat);
  } catch {
    return null; // gone since it was listed, or unreadable: not remembered, so the next look tries again
  }
  transcriptCache.delete(file);
  if (transcriptCache.size >= CACHE_LIMIT) transcriptCache.delete(transcriptCache.keys().next().value);
  transcriptCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, result });
  return result;
}

/**
 * Read what a transcript says about itself.
 *
 * @param {string} file
 * @returns {Promise<ClaudeSession|null>} null for a file that is not a session transcript
 */
async function describeSession(file) {
  return (await readTranscript(file, await fsp.stat(file)))?.session ?? null;
}

/** @param {string} child @param {string} parent */
function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Claude Code's project directories, one per working directory sessions
 * started in.
 *
 * @param {string} configDir
 * @returns {Promise<string[]>}
 */
async function projectDirs(configDir) {
  const projects = path.join(configDir, 'projects');
  try {
    return (await fsp.readdir(projects, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(projects, entry.name));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/** The session ids a project directory holds transcripts for. */
async function idsIn(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl') && SESSION_ID_PATTERN.test(entry.name.slice(0, -6)))
    .map(entry => entry.name.slice(0, -6));
}

/**
 * The session transcripts in the project directories `pick` accepts, newest
 * first.
 *
 * @param {string} configDir
 * @param {(name: string) => boolean} [pick]
 * @returns {Promise<Array<{file: string, id: string, stat: import('fs').Stats}>>}
 */
async function transcripts(configDir, pick = () => true) {
  const found = [];
  for (const dir of (await projectDirs(configDir)).filter(dir => pick(path.basename(dir)))) {
    const files = (await idsIn(dir)).map(id => ({ file: path.join(dir, `${id}.jsonl`), id }));
    const stats = await Promise.all(files.map(({ file }) => fsp.stat(file).catch(() => null)));
    files.forEach((entry, index) => {
      if (stats[index]) found.push({ ...entry, stat: stats[index] });
    });
  }
  return found.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
}

/**
 * How a session stands to a repository, and where it is shown as having
 * started.
 *
 * @param {ClaudeSession} session
 * @param {string} root the repository, canonical
 * @param {string} [home]
 * @param {(dir: string) => string} [canonical]
 * @returns {{relation: Relation, place: string|null, above?: number}}
 */
function relate(session, root, home = os.homedir(), canonical = canonicalRepoPath) {
  const start = canonical(session.cwd);
  if (isInside(start, root)) {
    if (start === root) return { relation: 'repo', place: null };
    return { relation: 'subfolder', place: `${path.relative(root, start).split(path.sep).join('/')}/` };
  }
  const place = homeRelative(session.cwd, home);
  if (isInside(root, start)) {
    return { relation: 'parent', place, above: path.relative(start, root).split(path.sep).length };
  }
  return { relation: 'other', place };
}

/**
 * How a session stands to a repository: `relate`, for a repository path as
 * given.
 *
 * @param {ClaudeSession} session
 * @param {string} repoPath
 * @param {object} [options]
 * @param {string} [options.home]
 */
function relateToRepository(session, repoPath, { home = os.homedir() } = {}) {
  return relate(session, canonicalRepoPath(repoPath), home);
}

/**
 * Whether a session started where it can already read the whole repository:
 * at its root or in a folder above it. Started inside it or elsewhere, it
 * needs the repository given to it.
 *
 * @param {Relation} relation
 */
function readsRepository(relation) {
  return relation === 'repo' || relation === 'parent';
}

/** A path as it is shown: under the home directory as `~/...`. */
function homeRelative(dir, home = os.homedir()) {
  const resolved = path.resolve(dir);
  if (!home || !isInside(resolved, home)) return resolved;
  const relative = path.relative(home, resolved);
  return relative === '' ? '~' : `~/${relative.split(path.sep).join('/')}`;
}

/** Whether any place a transcript was seen working in is inside the repository. */
function workedIn(visited, roots) {
  return visited.some(place => roots.some(root => isInside(path.resolve(place), root)));
}

/**
 * Whether a session answers a search: every word in it appears in the
 * session's name, first prompt, folder, branch or id. The folder as it is
 * shown, under `~`: the path to the home directory is in nearly every
 * session's, and a word from it would match them all.
 *
 * @param {RelatedSession} session
 * @param {string[]} words lower case
 * @param {string} [home]
 */
function matchesSearch(session, words, home = os.homedir()) {
  if (words.length === 0) return true;
  const haystack = [session.title, session.firstPrompt, homeRelative(session.cwd, home), session.branch, session.id]
    .filter(Boolean).join('\n').toLowerCase();
  return words.every(word => haystack.includes(word));
}

// Transcripts read at once. Reading them one after another left a disk that
// could serve many reads at a time serving one: a few seconds, cold, for the
// thousand sessions a home directory can hold.
const READ_BATCH = 16;

/**
 * What each transcript says, in the order given, read a batch at a time so
 * a caller that stops early has not read them all.
 *
 * @param {Array<{file: string, stat: import('fs').Stats}>} found
 */
async function* readAll(found) {
  for (let i = 0; i < found.length; i += READ_BATCH) {
    yield* await Promise.all(found.slice(i, i + READ_BATCH).map(({ file, stat }) => readTranscriptCached(file, stat)));
  }
}

/**
 * @typedef {object} SessionPage
 * @property {RelatedSession[]} sessions
 * @property {boolean} more whether a later page has more
 */

/**
 * Find sessions, most recently active first.
 *
 * `repository` scope is the sessions that worked in the repository: those
 * that started in it or a folder inside it, and those that started in a
 * folder above it and were seen working inside it. `all` is every session
 * Claude Code has on this machine, each said how it stands to the
 * repository.
 *
 * @param {object} options
 * @param {string} options.repoPath
 * @param {'repository'|'all'} [options.scope]
 * @param {string} [options.query] words that must all appear (see `matchesSearch`)
 * @param {number} [options.offset] matching sessions to skip, for a later page
 * @param {number} [options.limit]
 * @param {string} [options.configDir]
 * @param {string} [options.home] for showing folders under it as `~/...`
 * @returns {Promise<SessionPage>}
 */
async function findSessions({
  repoPath,
  scope = 'repository',
  query = '',
  offset = 0,
  limit = 20,
  configDir = claudeConfigDir(),
  home = os.homedir()
}) {
  const root = canonicalRepoPath(repoPath);
  const roots = [...new Set([root, path.resolve(repoPath)])];

  let pick;
  if (scope === 'repository') {
    // The encoding loses information -- `/a/b-c` and `/a/b/c` share a name --
    // so a directory is only a candidate. Each transcript's own working
    // directory is what decides.
    const prefixes = roots.map(projectDirName);
    const ancestors = new Set();
    for (const dir of roots) {
      for (let up = path.dirname(dir); ; up = path.dirname(up)) {
        ancestors.add(projectDirName(up));
        if (path.dirname(up) === up) break;
      }
    }
    pick = name => ancestors.has(name) || prefixes.some(prefix => name.startsWith(prefix));
  }

  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  // Sessions mostly share a handful of folders; each is resolved once.
  const starts = new Map();
  const canonical = dir => {
    if (!starts.has(dir)) starts.set(dir, canonicalRepoPath(dir));
    return starts.get(dir);
  };
  const sessions = [];
  const listed = new Set();
  let skipped = 0;

  for await (const read of readAll(await transcripts(configDir, pick))) {
    if (!read || !(read.session.firstPrompt || read.session.title)) continue;

    const related = { ...read.session, ...relate(read.session, root, home, canonical) };
    if (scope === 'repository') {
      const ranHere = related.relation === 'repo' || related.relation === 'subfolder';
      if (!ranHere && !(related.relation === 'parent' && workedIn(read.visited, roots))) continue;
    }
    if (!matchesSearch(related, words, home)) continue;
    // One session filed twice -- resumed from another folder, say -- is listed
    // once, by its most recent transcript.
    if (listed.has(related.id)) continue;
    listed.add(related.id);

    if (skipped < offset) {
      skipped += 1;
      continue;
    }
    if (sessions.length === limit) return { sessions, more: true };
    sessions.push(related);
  }
  return { sessions, more: false };
}

/**
 * The sessions that worked in a repository, most recently active first:
 * `findSessions` in repository scope, as a list.
 *
 * @param {string} repoPath
 * @param {object} [options]
 * @param {string} [options.configDir]
 * @param {number} [options.limit]
 * @returns {Promise<RelatedSession[]>}
 */
async function listClaudeSessions(repoPath, { configDir = claudeConfigDir(), limit = 20 } = {}) {
  return (await findSessions({ repoPath, configDir, limit })).sessions;
}

/**
 * One session, by id, wherever it ran -- or null, which is the answer for an
 * id that is malformed or unknown. The id goes on a command line, so only an
 * id with a transcript of its own is ever returned.
 *
 * @param {string} id
 * @param {object} [options]
 * @param {string} [options.configDir]
 * @returns {Promise<ClaudeSession|null>}
 */
async function findClaudeSession(id, { configDir = claudeConfigDir() } = {}) {
  if (typeof id !== 'string' || !SESSION_ID_PATTERN.test(id)) return null;
  // Claude Code names transcripts by the lower-case id.
  const name = `${id.toLowerCase()}.jsonl`;
  for (const dir of await projectDirs(configDir)) {
    const file = path.join(dir, name);
    const stat = await fsp.stat(file).catch(() => null);
    if (stat?.isFile()) return (await readTranscriptCached(file, stat))?.session ?? null;
  }
  return null;
}

/**
 * The ids of every session whose id starts with `prefix`, wherever it ran.
 *
 * @param {string} prefix
 * @param {object} [options]
 * @param {string} [options.configDir]
 * @returns {Promise<string[]>}
 */
async function sessionIdsStartingWith(prefix, { configDir = claudeConfigDir() } = {}) {
  const wanted = String(prefix).toLowerCase();
  if (wanted === '') return [];
  const ids = new Set();
  for (const dir of await projectDirs(configDir)) {
    for (const id of await idsIn(dir)) {
      if (id.toLowerCase().startsWith(wanted)) ids.add(id);
    }
  }
  return [...ids];
}

module.exports = {
  findSessions,
  listClaudeSessions,
  findClaudeSession,
  sessionIdsStartingWith,
  relateToRepository,
  readsRepository,
  describeSession,
  claudeConfigDir,
  projectDirName,
  promptText,
  homeRelative,
  SESSION_ID_PATTERN
};
