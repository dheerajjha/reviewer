'use strict';

const fs = require('fs').promises;
const path = require('path');

const { readSavedComments } = require('./store');
const { commentsFilename, repoKey } = require('./review');
const { groupByFile } = require('./comments');
const { homeRelative } = require('./paths');

/** Find the latest submitted review for this repository. */
async function latestSubmission(reviewsDir, repoPath) {
  let names;

  try {
    names = await fs.readdir(reviewsDir);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  const prefix = `review_${repoKey(repoPath)}_`;

  const matches = names
    .filter(name => name.startsWith(prefix) && name.endsWith('.json'))
    .sort()
    .reverse();

  for (const name of matches) {
    const document = JSON.parse(
      await fs.readFile(path.join(reviewsDir, name), 'utf8')
    );

    if (document.generatedAt) {
      return document.generatedAt;
    }
  }

  return null;
}

/** Return saved and submitted review status. */
async function readReviewStatus(reviewsDir, repoPath) {
  const savedFile = path.join(reviewsDir, commentsFilename(repoPath));
  const review = await readSavedComments(reviewsDir, repoPath);

  // A review can be saved even when it contains zero comments.
  let saved = review.adopted;

  if (!saved) {
    try {
      await fs.access(savedFile);
      saved = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  const comments = review.comments.length;
  const files = groupByFile(review.comments).length;
  const lastUpdated = review.lastUpdated ?? null;
  const lastSubmitted = await latestSubmission(reviewsDir, repoPath);

  const savedTime = lastUpdated ? Date.parse(lastUpdated) : NaN;
  const submittedTime = lastSubmitted ? Date.parse(lastSubmitted) : NaN;

  const submitted =
    Number.isFinite(savedTime) &&
    Number.isFinite(submittedTime) &&
    submittedTime > savedTime;

  return {
    repository: repoPath,
    saved,
    comments,
    files,
    lastUpdated,
    submitted,
    lastSubmitted,
    mode: review.mode,
    range: review.range
  };
}

/**
 * Format review status for people.
 * JSON consumers use the original status object instead.
 */
function formatStatus(status) {
  const repository = homeRelative(status.repository);

  if (!status.saved) {
    return `${repository}: No review saved yet\n`;
  }

  const commentCount =
    `${status.comments} comment${status.comments === 1 ? '' : 's'}`;
  const fileCount =
    `${status.files} file${status.files === 1 ? '' : 's'}`;

  const state = status.submitted
    ? 'submitted'
    : 'not submitted since last save';

  const lastSaved = status.lastUpdated
    ? `last saved ${status.lastUpdated}`
    : 'save time unknown';

  const modes = {
    working: 'uncommitted changes',
    staged: 'staged changes',
    commit: 'the last commit',
    last: 'the last commit',
    head: 'the last commit'
  };

  let scope = modes[status.mode] ?? status.mode ?? 'unknown';

  if (status.mode === 'range' && status.range) {
    const range = status.range;

    if (range.kind === 'commits') {
      const first = range.first ?? '?';
      const last = range.last ?? '?';
      scope = `reviewing commits ${first} \u2192 ${last}`;
    } else {
      const from = range.baseName ?? range.base ?? '?';
      const to = range.headName ?? range.head ?? '?';
      scope = `reviewing ${from} \u2192 ${to}`;
    }

    if (Number.isInteger(range.commits)) {
      scope += `, ${range.commits} commit${range.commits === 1 ? '' : 's'}`;
    }
  }

  return `${repository}: ${commentCount} on ${fileCount}, ` +
    `${lastSaved}, ${state}\n  ${scope}\n`;
}

module.exports = { readReviewStatus, formatStatus };
