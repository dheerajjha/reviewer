'use strict';

const fs = require('fs').promises;
const pathModule = require('path');

const { canonicalRepoPath, repoSlug } = require('./review');
const { homeRelative } = require('./paths');

/**
 * The repositories this machine has opened, newest first.
 *
 * `listReviews` already answers a related question — which repositories have a
 * saved review — but that is not the same list. A repository you opened,
 * read and left without commenting on has no review and is exactly the one you
 * want offered back to you next time.
 */

/** Filename inside the data directory. Not a review, so `listReviews` skips it. */
const RECENTS_FILE = 'recent-projects.json';

/** How many to keep. Long enough to cover what you are working on, short enough to read. */
const LIMIT = 10;

/**
 * @param {string} dataDir
 * @returns {string}
 */
function recentsFile(dataDir) {
  return pathModule.join(dataDir, RECENTS_FILE);
}

/**
 * Read the recorded list.
 *
 * Answers an empty list for every failure — absent, unreadable, not JSON, or
 * JSON of the wrong shape. A damaged recents file is a lost convenience, and
 * it must not be allowed to become a failure to open a repository.
 *
 * @param {string} dataDir
 * @returns {Promise<Array<{path: string, openedAt: string}>>} newest first
 */
async function readRecents(dataDir) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(recentsFile(dataDir), 'utf-8'));
  } catch {
    return [];
  }

  if (!Array.isArray(parsed?.projects)) return [];

  return parsed.projects.filter(
    project =>
      typeof project?.path === 'string' &&
      project.path !== '' &&
      typeof project.openedAt === 'string'
  );
}

/**
 * Record a repository as just opened.
 *
 * Written to a temporary file and renamed, so two `reviewer` processes racing
 * cannot leave a half-written list behind. The loser of the race loses one
 * entry, which is the right thing to lose.
 *
 * @param {string} dataDir
 * @param {string} repoPath
 * @param {Date} [now]
 * @returns {Promise<Array<{path: string, openedAt: string}>>} the new list
 */
async function recordRecent(dataDir, repoPath, now = new Date()) {
  const canonical = canonicalRepoPath(repoPath);
  const existing = await readRecents(dataDir);

  const projects = [
    { path: canonical, openedAt: now.toISOString() },
    ...existing.filter(project => canonicalRepoPath(project.path) !== canonical)
  ].slice(0, LIMIT);

  await fs.mkdir(dataDir, { recursive: true });

  const temporary = `${recentsFile(dataDir)}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify({ version: 1, projects }, null, 2)}\n`);
  await fs.rename(temporary, recentsFile(dataDir));

  return projects;
}

/**
 * The recent list, as the picker needs to draw it.
 *
 * A repository that has been moved or deleted is reported rather than dropped:
 * seeing it greyed out with the path you remember is a better answer than a
 * list that quietly gets shorter.
 *
 * @param {string} dataDir
 * @param {Map<string, number>} [commentCounts] repository path -> saved comments
 * @returns {Promise<Array<{path: string, name: string, location: string,
 *   openedAt: string, exists: boolean, comments: number}>>}
 */
async function describeRecents(dataDir, commentCounts = new Map()) {
  const projects = await readRecents(dataDir);

  return Promise.all(
    projects.map(async project => ({
      path: project.path,
      name: repoSlug(project.path),
      // Where it lives, rather than all of where it lives. The name is on the
      // row already, and two checkouts are told apart by the directory holding
      // them, not by the forty characters they have in common.
      location: homeRelative(pathModule.dirname(project.path)),
      openedAt: project.openedAt,
      exists: await fs
        .stat(project.path)
        .then(stats => stats.isDirectory())
        .catch(() => false),
      comments: commentCounts.get(canonicalRepoPath(project.path)) ?? 0
    }))
  );
}

module.exports = { readRecents, recordRecent, describeRecents, RECENTS_FILE, LIMIT };
