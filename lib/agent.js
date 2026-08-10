'use strict';

const { groupByFile } = require('./comments');
const { repoSlug } = require('./review');

/**
 * The machine-readable form of a review.
 *
 * The `.txt` review is written for a person to read. A coding agent asked to
 * act on a review needs something else: a stable schema, and above all an
 * *anchor* — the exact text of the line a comment was left on. Line numbers
 * are the first thing to go stale, because the agent's own first edit shifts
 * every line below it. The anchor is what lets a comment still be found after
 * that.
 */

const SCHEMA = 'code-review/v1';

/**
 * @typedef {object} ReviewDocument
 * @property {string} schema
 * @property {string} generatedAt ISO 8601
 * @property {{path: string, name: string, head: string|null, branch: string|null}} repository
 * @property {'working'|'lastCommit'|null} mode
 * @property {{comments: number, files: number}} summary
 * @property {AgentComment[]} comments
 */

/**
 * @typedef {object} AgentComment
 * @property {string} id stable within a document
 * @property {string} file repo-relative path
 * @property {number} line line number when the comment was written
 * @property {string|null} anchor the exact source line, for relocating the comment
 * @property {string} [selection] the snippet the reviewer highlighted
 * @property {string} body
 * @property {Array<{body: string, at?: string}>} [followUps]
 */

/**
 * Build the machine-readable review document.
 *
 * @param {object} args
 * @param {string} args.repoPath
 * @param {import('./comments').Comment[]} args.comments
 * @param {Date} args.generatedAt
 * @param {string|null} [args.head] the commit the review was written against
 * @param {string|null} [args.branch]
 * @param {string|null} [args.mode]
 * @returns {ReviewDocument}
 */
function buildReviewDocument({ repoPath, comments, generatedAt, head = null, branch = null, mode = null }) {
  const grouped = groupByFile(comments);

  return {
    schema: SCHEMA,
    generatedAt: generatedAt.toISOString(),
    repository: {
      path: repoPath,
      name: repoSlug(repoPath),
      head,
      branch
    },
    mode,
    summary: {
      comments: comments.length,
      files: grouped.length
    },
    comments: grouped.flatMap(([, fileComments]) => fileComments.map(toAgentComment))
  };
}

/**
 * Select comments from an already-built document and keep its summary honest.
 *
 * @param {ReviewDocument} document
 * @param {object} filters
 * @param {string|null} [filters.file]
 * @returns {ReviewDocument}
 */
function filterReviewDocument(document, { file = null } = {}) {
  if (file === null) return document;

  const comments = document.comments.filter(comment => comment.file === file);
  return {
    ...document,
    summary: {
      comments: comments.length,
      files: new Set(comments.map(comment => comment.file)).size
    },
    comments
  };
}

/**
 * @param {import('./comments').Comment} comment
 * @returns {AgentComment}
 */
function toAgentComment(comment) {
  const entry = {
    // File and line identify a comment uniquely — the UI anchors one comment
    // per line — and staying derived keeps ids stable across exports.
    id: `${comment.file}:${comment.line}`,
    file: comment.file,
    line: comment.line,
    anchor: comment.lineContent ?? null,
    body: comment.text
  };

  if (comment.selectedText) entry.selection = comment.selectedText;

  if (comment.followUps?.length > 0) {
    entry.followUps = comment.followUps.map(followUp => {
      const item = { body: followUp.text };
      if (followUp.timestamp) item.at = followUp.timestamp;
      return item;
    });
  }

  return entry;
}

/**
 * Render a review as instructions for a coding agent.
 *
 * This is the format meant to be piped straight into a tool like Claude Code.
 * It leads with what to do and how to locate each comment, because an agent
 * reads top-down and the instruction has to arrive before the data it governs.
 *
 * @param {ReviewDocument} document
 * @returns {string}
 */
function formatPrompt(document) {
  const { repository, summary } = document;
  const lines = [
    '# Code review to address',
    '',
    `Repository: ${repository.path}`,
    repository.head ? `Reviewed at commit: ${repository.head}` : null,
    `${summary.comments} comment(s) across ${summary.files} file(s), written ${document.generatedAt}.`,
    '',
    'Work through every comment below and make the change it asks for, or, if',
    'you disagree, say why and leave the code alone. Comments are grouped by',
    'file and ordered by line.',
    '',
    'Line numbers are from when the review was written, so treat them as a',
    'hint: locate each comment by its `anchor` line instead, since your own',
    'edits will shift everything below them. If an anchor no longer appears in',
    'the file, say so rather than guessing at the intended location.',
    ''
  ].filter(line => line !== null);

  let currentFile = null;
  for (const comment of document.comments) {
    if (comment.file !== currentFile) {
      currentFile = comment.file;
      lines.push(`## ${currentFile}`, '');
    }

    lines.push(`### ${comment.id}`, '');
    if (comment.anchor !== null) {
      lines.push('Anchor line:', '', '```', comment.anchor, '```', '');
    }
    if (comment.selection) {
      lines.push('Selected code:', '', '```', comment.selection, '```', '');
    }

    lines.push(comment.body, '');

    if (comment.followUps?.length > 0) {
      lines.push('Follow-ups:', '');
      comment.followUps.forEach((followUp, index) => {
        lines.push(`${index + 1}. ${followUp.body}`);
      });
      lines.push('');
    }
  }

  return `${lines.join('\n')}`;
}

module.exports = { buildReviewDocument, filterReviewDocument, formatPrompt, SCHEMA };
