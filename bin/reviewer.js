#!/usr/bin/env node
'use strict';

const fs = require('fs').promises;
const path = require('path');

const simpleGit = require('simple-git');

const { parseArgs, buildUrl, UsageError, USAGE } = require('../lib/cli');
const { openInBrowser } = require('../lib/browser');
const { buildReviewDocument, filterReviewDocument, formatPrompt } = require('../lib/agent');
const { commentsFilename } = require('../lib/review');
const { startServer, DEFAULT_PORT, DEFAULT_HOST, REVIEWS_DIR } = require('../server');
const { version } = require('../package.json');

/**
 * The `reviewer` command: start the local server and open it in a browser.
 */

/**
 * Listen on `port`, falling back to any free port if it is taken.
 *
 * Someone reviewing two repositories at once should get a second window, not
 * an EADDRINUSE stack trace.
 *
 * @param {number} port
 * @returns {Promise<import('http').Server>}
 */
async function listen(port) {
  try {
    return await startServer({ port, host: DEFAULT_HOST, silent: true });
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;

    console.log(`Port ${port} is in use, picking another.`);
    return startServer({ port: 0, host: DEFAULT_HOST, silent: true });
  }
}

/**
 * Print the saved review of a repository to stdout.
 *
 * Reads the same JSON the UI writes on every edit, so a review can be handed
 * to another tool without submitting it or keeping the server running.
 *
 * @param {import('../lib/cli').CliOptions} options
 */
async function exportReview(options) {
  const repoPath = options.repoPath ?? process.cwd();
  const source = path.join(REVIEWS_DIR, commentsFilename(repoPath));

  let saved;
  try {
    saved = JSON.parse(await fs.readFile(source, 'utf-8'));
  } catch {
    throw new UsageError(`No saved review for ${repoPath}. Review it first, then export.`);
  }

  const comments = saved.comments ?? [];
  if (comments.length === 0) {
    throw new UsageError(`The saved review for ${repoPath} has no comments.`);
  }

  // Recording the commit lets a consumer tell whether the tree has moved on
  // since the review was written. Neither is fatal if git will not say.
  const git = simpleGit(repoPath);
  const head = await git.revparse(['HEAD']).then(sha => sha.trim()).catch(() => null);
  const branch = await git.revparse(['--abbrev-ref', 'HEAD']).then(name => name.trim()).catch(() => null);

  const document = filterReviewDocument(
    buildReviewDocument({
      repoPath,
      comments,
      generatedAt: new Date(),
      head,
      branch
    }),
    { file: options.file }
  );

  if (document.comments.length === 0) {
    throw new UsageError(`The saved review for ${repoPath} has no comments for ${options.file}.`);
  }

  process.stdout.write(
    options.format === 'prompt'
      ? formatPrompt(document)
      : `${JSON.stringify(document, null, 2)}\n`
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }

  if (options.version) {
    console.log(version);
    return;
  }

  if (options.repoPath) {
    try {
      await fs.access(options.repoPath);
    } catch {
      throw new UsageError(`No such directory: ${options.repoPath}`);
    }
  }

  if (options.command === 'export') {
    return exportReview(options);
  }

  const server = await listen(options.port ?? (Number(process.env.PORT) || DEFAULT_PORT));
  const url = buildUrl(`http://${DEFAULT_HOST}:${server.address().port}`, options.repoPath);

  console.log(`\n  Code Reviewer  ${url}`);
  if (options.repoPath) console.log(`  reviewing      ${options.repoPath}`);
  console.log('\n  Press Ctrl+C to stop.\n');

  if (options.open && !(await openInBrowser(url))) {
    console.log('  Could not open a browser — open the URL above yourself.\n');
  }

  const stop = () => {
    server.close(() => process.exit(0));
    // Don't wait forever on a browser holding the connection open.
    setTimeout(() => process.exit(0), 2000).unref();
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch(error => {
  if (error instanceof UsageError) {
    console.error(`error: ${error.message}\n`);
    process.stderr.write(USAGE);
    process.exit(2);
  }

  console.error(error);
  process.exit(1);
});
