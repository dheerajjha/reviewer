'use strict';

const crypto = require('crypto');

/**
 * In-memory record of which repository each browser session is reviewing.
 *
 * Sessions live only as long as the process: the desktop app starts a fresh
 * server per launch, and the web mode is a local single-user tool. Nothing
 * here is persisted, so a restart simply asks the user to reopen the repo.
 */

/**
 * @typedef {'working'|'lastCommit'|'range'} ReviewMode
 * `working` diffs the working tree against HEAD; `lastCommit` diffs HEAD
 * against its parent, which is what a clean tree falls back to; `range`
 * diffs two refs the reviewer chose.
 */

/**
 * @typedef {object} ReviewRange
 * @property {string} base ref the review is measured from, already resolved
 * @property {string} head ref the review is measured to, already resolved
 * @property {number} commits how many commits separate them
 *
 * Present for every commit-based review, including `lastCommit`, which is
 * just the range `HEAD~1..HEAD` under a name. `working` has no range: its
 * head is the working tree, which is not a ref.
 */

class SessionStore {
  /**
   * @param {() => string} [generateId] injectable for deterministic tests
   */
  constructor(generateId = () => crypto.randomBytes(8).toString('hex')) {
    this.generateId = generateId;
    /** @type {Map<string, {repoPath: string, mode: ReviewMode, range: ReviewRange|null}>} */
    this.sessions = new Map();
  }

  /**
   * @param {string} repoPath absolute path of the opened repository
   * @param {ReviewMode} mode
   * @param {ReviewRange|null} [range] the two refs, for a commit-based review
   * @returns {string} the new session id
   */
  create(repoPath, mode, range = null) {
    const repoId = this.generateId();
    this.sessions.set(repoId, { repoPath, mode, range });
    return repoId;
  }

  /**
   * @param {string} repoId
   * @returns {{repoPath: string, mode: ReviewMode, range: ReviewRange|null}|undefined}
   */
  get(repoId) {
    return this.sessions.get(repoId);
  }

  /**
   * @param {string} repoId
   * @returns {boolean} whether a session was removed
   */
  delete(repoId) {
    return this.sessions.delete(repoId);
  }

  /** @returns {number} */
  get size() {
    return this.sessions.size;
  }
}

module.exports = { SessionStore };
