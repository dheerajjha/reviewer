'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const { repoKey } = require('./review');
const { writeFileAtomic, isAlive } = require('./store');

/**
 * Which agents are connected to a review right now.
 *
 * An agent answering in a review's threads may live in another process -- a
 * Claude Code session running `reviewer channel` -- or inside the server
 * itself. Either way it leaves a small file here saying who it is and what it
 * is working on, refreshes it while it lives, and removes it when it stops.
 * The page shows those files as "Claude is connected" and "answering…", which
 * is the difference between a reply that is coming and silence.
 *
 * A file is trusted only while its process is alive and its heartbeat is
 * recent, so an agent killed without the chance to clean up drops out of the
 * list on its own instead of claiming to be connected forever.
 */

const HEARTBEAT_MS = 10000;
const STALE_MS = 30000;
const POLL_MS = 3000;

/**
 * @typedef {object} AgentPresence
 * @property {string} id
 * @property {string} repoPath
 * @property {'channel'|'background'|'watch'} kind how it is connected
 * @property {string} agent who answers, e.g. `claude`
 * @property {string|null} session the agent's own session id, when known
 * @property {string|null} title what that session is about, when known
 * @property {number} pid
 * @property {string} startedAt
 * @property {string} heartbeatAt
 * @property {string[]} working keys of threads it has been asked and not yet answered
 */

/** @param {string} reviewsDir @param {string} repoPath */
function agentsDir(reviewsDir, repoPath) {
  return path.join(reviewsDir, 'agents', repoKey(repoPath));
}

/**
 * Announce an agent and keep the announcement fresh until `close()`.
 *
 * @param {string} reviewsDir
 * @param {string} repoPath
 * @param {Omit<AgentPresence, 'id'|'repoPath'|'pid'|'startedAt'|'heartbeatAt'|'working'> & {working?: string[]}} info
 */
function announce(reviewsDir, repoPath, info) {
  const id = crypto.randomBytes(6).toString('base64url');
  const dir = agentsDir(reviewsDir, repoPath);
  const file = path.join(dir, `${id}.json`);
  const startedAt = new Date().toISOString();
  /** @type {AgentPresence} */
  let record = {
    id,
    repoPath,
    kind: info.kind,
    agent: info.agent,
    session: info.session ?? null,
    title: info.title ?? null,
    pid: process.pid,
    startedAt,
    heartbeatAt: startedAt,
    working: info.working ?? []
  };
  let closed = false;
  let writing = Promise.resolve();

  const write = () => {
    record = { ...record, heartbeatAt: new Date().toISOString() };
    const snapshot = `${JSON.stringify(record, null, 2)}\n`;
    writing = writing
      .then(async () => {
        if (closed) return;
        await fsp.mkdir(dir, { recursive: true });
        await writeFileAtomic(file, snapshot);
      })
      .catch(() => {});
    return writing;
  };

  const heartbeat = setInterval(write, HEARTBEAT_MS);
  heartbeat.unref();

  // A synchronous last word, for an exit that gives no time for anything else.
  const removeNow = () => {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* nothing more can be done on the way out */
    }
  };
  process.on('exit', removeNow);

  return {
    id,
    ready: write(),
    /** @param {Partial<AgentPresence>} fields */
    update(fields) {
      record = { ...record, ...fields };
      return write();
    },
    get record() {
      return record;
    },
    async close() {
      closed = true;
      clearInterval(heartbeat);
      process.off('exit', removeNow);
      await writing;
      await fsp.rm(file, { force: true });
    }
  };
}

/**
 * The agents connected to a review, live ones only.
 *
 * @param {string} reviewsDir
 * @param {string} repoPath
 * @param {object} [options]
 * @param {number} [options.now]
 * @returns {Promise<AgentPresence[]>} oldest first
 */
async function listAgents(reviewsDir, repoPath, { now = Date.now() } = {}) {
  const dir = agentsDir(reviewsDir, repoPath);
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const agents = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let record;
    try {
      record = JSON.parse(await fsp.readFile(file, 'utf-8'));
    } catch {
      continue; // being replaced right now, or not ours
    }
    const fresh = now - Date.parse(record.heartbeatAt) < STALE_MS;
    if (fresh && isAlive(record.pid)) {
      agents.push(record);
    } else if (!isAlive(record.pid)) {
      // Its process is gone and cannot clean up after itself any more.
      await fsp.rm(file, { force: true }).catch(() => {});
    }
  }

  return agents.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/**
 * Hear about agents connecting, disconnecting and changing what they work on.
 *
 * @param {string} reviewsDir
 * @param {string} repoPath
 * @param {(agents: AgentPresence[]) => void} onChange called at the start and on every change
 * @param {object} [options]
 * @param {number} [options.pollMs]
 * @returns {{close: () => void, ready: Promise<void>}}
 */
function watchAgents(reviewsDir, repoPath, onChange, { pollMs = POLL_MS } = {}) {
  const dir = agentsDir(reviewsDir, repoPath);
  let closed = false;
  let last;
  let timer = null;

  const check = async () => {
    if (closed) return;
    const agents = await listAgents(reviewsDir, repoPath).catch(() => []);
    // Heartbeats move every ten seconds without anything a person would see
    // changing, so they are left out of the comparison.
    const signature = JSON.stringify(agents.map(({ heartbeatAt, ...agent }) => agent));
    if (!closed && signature !== last) {
      last = signature;
      onChange(agents);
    }
  };

  let watcher = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    watcher = fs.watch(dir, () => {
      clearTimeout(timer);
      timer = setTimeout(check, 25);
    });
    watcher.on('error', () => {
      watcher?.close();
      watcher = null;
    });
  } catch {
    watcher = null;
  }

  // Also how an agent that died without cleaning up is noticed.
  const poll = setInterval(check, pollMs);
  poll.unref();

  return {
    ready: check(),
    close() {
      closed = true;
      clearTimeout(timer);
      clearInterval(poll);
      watcher?.close();
    }
  };
}

module.exports = { announce, listAgents, watchAgents, agentsDir, isAlive, HEARTBEAT_MS, STALE_MS };
