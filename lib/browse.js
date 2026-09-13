'use strict';

const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const { homeRelative } = require('./paths');

/**
 * Listing directories, so a repository can be found by looking rather than by
 * being typed from memory.
 *
 * Only directories are reported. A picker picks a folder, so file names are
 * not the question — and not answering it keeps this from being a way to read
 * the shape of someone's disk when all it needs to do is navigate.
 */

/**
 * Directories that are never worth offering.
 *
 * `.git` is a repository's own plumbing: listing it invites clicking into it,
 * and what is inside is not reviewable. `node_modules` is thousands of
 * directories nobody is looking for.
 */
const NEVER_LIST = new Set(['.git', 'node_modules']);

/**
 * Is this directory the root of a working tree?
 *
 * Decided by the presence of `.git` rather than by asking git, because this
 * runs once per row and a subprocess per row would make a home directory take
 * seconds to list. `.git` is a directory in an ordinary clone and a *file* in
 * a worktree or a submodule, so existence is the question and type is not.
 *
 * This is a hint for the UI. `lib/repo.js` stays the authority on what gets
 * opened, so a wrong guess here costs a click, not a wrong review.
 *
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
async function isRepository(dir) {
  try {
    await fs.stat(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve one directory entry, following symlinks.
 *
 * `withFileTypes` reports a symlink as a symlink, not as what it points at,
 * and a home directory with `~/code -> /Volumes/work/code` in it is ordinary.
 * Following it costs a stat; not following it hides the projects.
 *
 * @param {string} parent
 * @param {import('fs').Dirent} entry
 * @returns {Promise<{name: string, path: string, isRepository: boolean}|null>}
 *   null when the entry is not a directory, or cannot be read at all
 */
async function describe(parent, entry) {
  if (NEVER_LIST.has(entry.name)) return null;

  const full = path.join(parent, entry.name);

  if (!entry.isDirectory()) {
    if (!entry.isSymbolicLink()) return null;
    try {
      if (!(await fs.stat(full)).isDirectory()) return null;
    } catch {
      return null; // dangling symlink
    }
  }

  const repository = await isRepository(full);

  // Hidden directories are noise in a home directory -- `.cache`, `.npm`,
  // `.Trash` -- but `~/.dotfiles` is one of the most commonly reviewed
  // repositories there is. Hide the hidden ones, except the ones that are
  // repositories, which is the only reason to be looking in here.
  if (entry.name.startsWith('.') && !repository) return null;

  return { name: entry.name, path: full, isRepository: repository };
}

/**
 * List the directories inside `target`.
 *
 * An entry that cannot be read is skipped rather than failing the listing: one
 * unreadable directory in a home folder should not make the folder unbrowsable.
 *
 * @param {string} [target] directory to list; the home directory by default
 * @returns {Promise<{path: string, display: string, parent: string|null,
 *   isRepository: boolean,
 *   entries: Array<{name: string, path: string, isRepository: boolean}>}>}
 * @throws an fs error with `code` ENOENT, ENOTDIR or EACCES for the caller to map
 */
async function browse(target) {
  const asked = typeof target === 'string' ? target.trim() : '';
  const dir = path.resolve(asked === '' ? os.homedir() : asked);

  const stats = await fs.stat(dir);
  if (!stats.isDirectory()) {
    throw Object.assign(new Error(`Not a directory: ${dir}`), { code: 'ENOTDIR' });
  }

  const described = await Promise.all(
    (await fs.readdir(dir, { withFileTypes: true })).map(entry => describe(dir, entry))
  );

  const parent = path.dirname(dir);

  return {
    path: dir,
    // The same directory, written the way a person writes it. `path` stays
    // absolute because that is what gets opened; this is what gets read.
    display: homeRelative(dir),
    // At the filesystem root, dirname answers with the root again. There is
    // nowhere further up, and a parent row that goes nowhere is a bug report.
    parent: parent === dir ? null : parent,
    isRepository: await isRepository(dir),
    entries: described
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  };
}

module.exports = { browse, isRepository, NEVER_LIST };
