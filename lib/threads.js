'use strict';

/**
 * A review comment as a conversation: the reviewer's comment, then follow-ups
 * from either side. An agent connected to a review answers in these threads,
 * so this is where "what is still waiting for an answer" and "what is new
 * since I last looked" are decided -- once, for the page, the channel and the
 * background session alike.
 */

/**
 * Who wrote the last word in a thread: null for the reviewer, otherwise the
 * `by` of the last follow-up.
 *
 * @param {import('./comments').Comment} comment
 * @returns {string|null}
 */
function lastAuthor(comment) {
  const followUps = comment.followUps ?? [];
  return followUps.length === 0 ? null : (followUps[followUps.length - 1].by ?? null);
}

/**
 * Threads whose last word is the reviewer's: what an agent has yet to answer.
 *
 * @template {import('./comments').Comment} T
 * @param {T[]} comments
 * @returns {T[]}
 */
function awaitingAnswer(comments) {
  return comments.filter(comment => lastAuthor(comment) === null);
}

/** The identity a follow-up is merged by: its key, or what it said and when. */
function followUpIdentity(followUp) {
  return followUp.key ?? JSON.stringify([followUp.timestamp ?? null, followUp.text, followUp.by ?? null]);
}

/**
 * Every follow-up in either list, once.
 *
 * Follow-ups are only ever added -- nothing in the page or the API removes
 * one -- so a follow-up present on either side is one somebody wrote, and
 * the union is the only merge that cannot lose an answer. `ours` keeps its
 * order; follow-ups only `theirs` holds are placed by timestamp.
 *
 * @param {import('./comments').FollowUp[]} [ours]
 * @param {import('./comments').FollowUp[]} [theirs]
 * @returns {import('./comments').FollowUp[]}
 */
function unionFollowUps(ours = [], theirs = []) {
  const merged = [...ours];
  const seen = new Set(ours.map(followUpIdentity));

  for (const followUp of theirs) {
    const identity = followUpIdentity(followUp);
    if (seen.has(identity)) continue;
    seen.add(identity);

    // After the last entry that is not later than it, so an answer that was
    // written while this side was adding its own lands where it happened.
    const at = followUp.timestamp ?? '';
    let index = merged.length;
    if (at) {
      while (index > 0 && (merged[index - 1].timestamp ?? '') > at) index--;
    }
    merged.splice(index, 0, followUp);
  }

  return merged;
}

/**
 * Carry over follow-ups a save never saw.
 *
 * A tab saves the whole list it holds. An agent may have answered in a thread
 * after that tab last heard from the server; saving the tab's copy of the
 * thread as it stands would erase the answer. For every comment present both
 * in the save and on disk, the follow-ups on disk are kept alongside the
 * tab's.
 *
 * @param {import('./comments').Comment[]} incoming keyed comments being saved
 * @param {import('./comments').Comment[]} current keyed comments on disk
 * @returns {import('./comments').Comment[]}
 */
function keepFollowUpsFrom(incoming, current) {
  const onDisk = new Map(current.map(comment => [comment.key, comment]));

  return incoming.map(comment => {
    const stored = onDisk.get(comment.key);
    if (!stored?.followUps?.length) return comment;

    const followUps = unionFollowUps(comment.followUps, stored.followUps);
    return followUps.length === (comment.followUps?.length ?? 0) ? comment : { ...comment, followUps };
  });
}

/**
 * What the reviewer has said in `next` that was not in `prev`: new comments,
 * and new follow-ups the reviewer wrote. Each comes back once, keyed, so an
 * agent can be told about it exactly once.
 *
 * @param {import('./comments').Comment[]} prev keyed
 * @param {import('./comments').Comment[]} next keyed
 * @returns {Array<{comment: import('./comments').Comment, followUp: import('./comments').FollowUp|null}>}
 */
function newReviewerMessages(prev, next) {
  const before = new Map(prev.map(comment => [comment.key, comment]));
  const messages = [];

  for (const comment of next) {
    const old = before.get(comment.key);
    if (!old) {
      messages.push({ comment, followUp: null });
    }
    const known = new Set((old?.followUps ?? []).map(followUpIdentity));
    for (const followUp of comment.followUps ?? []) {
      if (followUp.by || known.has(followUpIdentity(followUp))) continue;
      // A brand-new comment arriving with follow-ups already on it is one
      // message, not several: the agent is told about the thread once.
      if (!old) continue;
      messages.push({ comment, followUp });
    }
  }

  return messages;
}

/**
 * The thread an agent is being asked to answer, as plain text.
 *
 * Shared by every way an agent can be connected, so a background session and
 * a live one are asked the same question in the same words.
 *
 * @param {import('./comments').Comment} comment
 * @returns {string}
 */
function describeThread(comment) {
  const lines = [`${comment.file}, line ${comment.line}`];
  if (comment.lineContent !== undefined && comment.lineContent !== null && comment.lineContent !== '') {
    lines.push(`Line: ${comment.lineContent.trim()}`);
  }
  if (comment.selectedText) {
    lines.push(`Selected: ${comment.selectedText.trim()}`);
  }
  lines.push('', `Reviewer: ${comment.text}`);
  for (const followUp of comment.followUps ?? []) {
    lines.push(`${followUp.by ? `${followUp.by} (you)` : 'Reviewer'}: ${followUp.text}`);
  }
  return lines.join('\n');
}

/**
 * Append an agent's answer to a thread.
 *
 * @param {import('./comments').Comment[]} comments keyed
 * @param {string} key comment to answer
 * @param {import('./comments').FollowUp} reply
 * @returns {import('./comments').Comment[]|null} the new list, or null when no comment has that key
 */
function appendReply(comments, key, reply) {
  let found = false;
  const updated = comments.map(comment => {
    if (comment.key !== key) return comment;
    found = true;
    return { ...comment, followUps: [...(comment.followUps ?? []), reply] };
  });
  return found ? updated : null;
}

module.exports = {
  lastAuthor,
  awaitingAnswer,
  unionFollowUps,
  keepFollowUpsFrom,
  newReviewerMessages,
  describeThread,
  appendReply,
  followUpIdentity
};
