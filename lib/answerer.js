'use strict';

const { EventEmitter } = require('events');

const { updateSavedComments } = require('./store');
const { watchComments } = require('./watch');
const { announce, listAgents, watchAgents } = require('./presence');
const { mintKey } = require('./comments');
const { awaitingAnswer, newReviewerMessages, appendReply, lastAuthor, followUpIdentity } = require('./threads');
const { questionFor } = require('./claude-background');

/**
 * Keep a review's threads answered by a background Claude Code session.
 *
 * Everything the reviewer says -- a new comment, a reply in a thread, from
 * this tab or any other -- reaches the session through the comments file,
 * and every answer goes back the same way, as a follow-up written `by:
 * claude`. Nothing here talks to the page directly except the text of an
 * answer still being written, which is not worth a file write per word.
 *
 * Threads already waiting when it connects are answered first, oldest first.
 */

/** The reviewer's messages in a thread, by identity: the comment, and their follow-ups. */
function reviewerMessages(comment) {
  return new Set([
    `comment:${comment.key}`,
    ...(comment.followUps ?? []).filter(followUp => !followUp.by).map(followUpIdentity)
  ]);
}

class Answerer extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.reviewsDir
   * @param {string} options.repoPath
   * @param {import('./claude-background').BackgroundSession} options.session
   * @param {{id: string, title: string|null, place?: string|null, relation?: string}} options.claudeSession
   *   the session being asked, and where it started against the repository (see claude-sessions.js)
   * @param {string} [options.agent] the name answers are written under
   */
  constructor({ reviewsDir, repoPath, session, claudeSession, agent = 'claude' }) {
    super();
    this.reviewsDir = reviewsDir;
    this.repoPath = repoPath;
    this.session = session;
    this.claudeSession = claudeSession;
    this.agent = agent;

    /** @type {import('./comments').Comment[]|null} */
    this.known = null;
    /** @type {Array<{key: string, force: boolean}>} */
    this.queue = [];
    /** @type {{key: string, asked: Set<string>}|null} */
    this.inFlight = null;
    this.stopped = false;

    this.presence = announce(reviewsDir, repoPath, {
      kind: 'background',
      agent,
      session: claudeSession.id,
      title: claudeSession.title
    });

    session.on('session', () => this.emit('status', this.status()));
    session.on('working', ({ key }) => this.presence.update({ working: [key] }));
    session.on('partial', ({ key, text }) => this.emit('partial', { key, text }));
    session.on('answer', ({ key, text, session: answeredBy }) => this.onAnswer(key, text, answeredBy));
    session.on('failed', ({ key, message }) => {
      this.inFlight = null;
      this.presence.update({ working: [] });
      this.emit('failed', { key, message });
      this.emit('status', this.status());
      this.dispatch();
    });
    session.on('exit', ({ message, fatal }) => {
      if (message) this.emit('failed', { key: null, message });
      // Claude Code could not even be started: say so once and disconnect,
      // rather than show "connected" while every question fails the same way.
      if (fatal) this.stop().then(() => this.emit('stopped'));
    });

    this.watcher = watchComments(reviewsDir, repoPath, state => this.onComments(state.comments));
    // Threads held back while a live session was answering are this one's
    // again when it leaves; nothing else would prompt another look.
    this.agentsWatcher = watchAgents(reviewsDir, repoPath, () => this.dispatch());
  }

  /** @param {import('./comments').Comment[]} comments */
  onComments(comments) {
    if (this.stopped) return;
    if (this.known === null) {
      for (const comment of awaitingAnswer(comments)) this.enqueue(comment.key);
    } else {
      for (const { comment } of newReviewerMessages(this.known, comments)) this.enqueue(comment.key);
    }
    this.known = comments;
    this.dispatch();
  }

  enqueue(key, force = false) {
    const queued = this.queue.find(item => item.key === key);
    if (queued) {
      queued.force ||= force;
      return;
    }
    this.queue.push({ key, force });
  }

  async dispatch() {
    if (this.stopped || this.inFlight || this.queue.length === 0 || this.known === null) return;

    // An agent answering live, in the reviewer's own terminal, takes
    // precedence. Two agents answering one thread is noise, and the live one
    // is the one somebody started on purpose.
    const live = (await listAgents(this.reviewsDir, this.repoPath).catch(() => []))
      .some(agent => agent.kind === 'channel');
    if (live || this.inFlight || this.stopped) return;

    while (this.queue.length > 0) {
      const { key, force } = this.queue.shift();
      const comment = this.known.find(entry => entry.key === key);
      // Gone, or answered by somebody else in the meantime.
      if (!comment || (!force && lastAuthor(comment) !== null)) continue;

      this.inFlight = { key, asked: reviewerMessages(comment) };
      this.session.ask(key, questionFor(comment, this.repoPath));
      this.emit('status', this.status());
      return;
    }
    this.emit('status', this.status());
  }

  async onAnswer(key, text, answeredBy) {
    const asked = this.inFlight?.key === key ? this.inFlight.asked : new Set();
    let askAgain = false;

    try {
      await updateSavedComments(this.reviewsDir, this.repoPath, current => {
        const thread = current.comments.find(comment => comment.key === key);
        if (!thread) return null; // deleted while it was being answered
        // Something the reviewer added while the answer was being written
        // was not part of the question, so the thread is asked again --
        // with everything, this answer included -- once this one is posted.
        askAgain = [...reviewerMessages(thread)].some(identity => !asked.has(identity));
        return {
          comments: appendReply(current.comments, key, {
            key: mintKey(),
            text,
            timestamp: new Date().toISOString(),
            by: this.agent,
            ...(answeredBy ? { session: answeredBy } : {})
          })
        };
      });
    } catch (error) {
      this.emit('failed', { key, message: `Could not save the answer: ${error.message}` });
    }

    this.inFlight = null;
    await this.presence.update({ working: [] });
    if (askAgain) this.enqueue(key, true);
    // Said even when nothing else is queued: the page shows "answering…"
    // until it hears this thread is no longer being worked on.
    this.emit('status', this.status());
    this.dispatch();
  }

  status() {
    return {
      kind: 'background',
      agent: this.agent,
      session: this.claudeSession.id,
      title: this.claudeSession.title,
      relation: this.claudeSession.relation ?? 'repo',
      place: this.claudeSession.place ?? null,
      answeringIn: this.session.answeringSession,
      forked: this.session.fork,
      working: this.inFlight?.key ?? null,
      queued: this.queue.map(item => item.key)
    };
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.watcher.close();
    this.agentsWatcher.close();
    await this.session.stop();
    await this.presence.close();
  }
}

module.exports = { Answerer };
