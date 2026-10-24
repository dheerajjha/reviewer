'use strict';

const fs = require('fs');
const path = require('path');

const { readSavedComments } = require('./store');
const { commentsFilename } = require('./review');

/**
 * Hearing about a review changing, whoever changed it.
 *
 * The comments file is the source of truth and, now that agents answer in
 * threads, it has writers other than the page: `reviewer channel` running
 * inside a Claude Code session, `reviewer reply`, a background session the
 * server started. Each of them writes the file; everyone interested watches
 * it. That keeps the writers from needing to know who is listening, or where.
 *
 * `fs.watch` gives the change within milliseconds where the platform supports
 * it. A slow poll runs alongside, because there are filesystems where
 * `fs.watch` is silently deaf -- network mounts, some containers -- and a
 * reply that never shows up is worse than one that shows up a second late.
 */

const DEBOUNCE_MS = 25;
const POLL_MS = 1500;

/**
 * Watch one repository's saved comments.
 *
 * `onChange` is called with what was read whenever `lastUpdated` moves, and
 * once at the start with the state as it stands, so a caller never has to
 * read separately and race the first change.
 *
 * @param {string} reviewsDir
 * @param {string} repoPath
 * @param {(state: import('./store').SavedReview) => void} onChange
 * @param {object} [options]
 * @param {number} [options.pollMs]
 * @param {(error: Error) => void} [options.onError] a file that cannot be read or parsed; the watch carries on
 * @returns {{close: () => void, ready: Promise<void>}}
 */
function watchComments(reviewsDir, repoPath, onChange, { pollMs = POLL_MS, onError = () => {} } = {}) {
  const filename = commentsFilename(repoPath);
  const file = path.join(reviewsDir, filename);

  let closed = false;
  let lastSeen;
  let lastStat = null;
  let timer = null;
  let reading = null;
  let again = false;

  const check = async () => {
    if (closed) return;
    if (reading) {
      again = true;
      return reading;
    }
    reading = (async () => {
      try {
        const state = await readSavedComments(reviewsDir, repoPath);
        if (closed) return;
        if (state.lastUpdated !== lastSeen) {
          lastSeen = state.lastUpdated;
          onChange(state);
        }
      } catch (error) {
        // A file caught mid-replace by a writer that is not atomic, or one
        // hand-edited into invalid JSON. Say so and keep watching: the next
        // write will be readable.
        if (!closed) onError(error);
      }
    })();
    try {
      await reading;
    } finally {
      reading = null;
      if (again && !closed) {
        again = false;
        check();
      }
    }
  };

  const schedule = () => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(check, DEBOUNCE_MS);
  };

  let watcher = null;
  try {
    fs.mkdirSync(reviewsDir, { recursive: true });
    // The directory, not the file: an atomic write replaces the file, and a
    // watch on the old one would go quiet after the first save.
    watcher = fs.watch(reviewsDir, (event, name) => {
      if (!name || name === filename) schedule();
    });
    watcher.on('error', () => {
      watcher?.close();
      watcher = null;
    });
  } catch {
    watcher = null; // the poll below still covers it
  }

  const poll = setInterval(() => {
    fs.stat(file, (error, stat) => {
      const signature = error ? null : `${stat.mtimeMs}:${stat.size}`;
      if (signature !== lastStat) {
        lastStat = signature;
        check();
      }
    });
  }, pollMs);
  poll.unref();

  const ready = check();

  return {
    ready,
    close() {
      closed = true;
      clearTimeout(timer);
      clearInterval(poll);
      watcher?.close();
    }
  };
}

module.exports = { watchComments };
