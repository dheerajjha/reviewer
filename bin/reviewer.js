#!/usr/bin/env node
'use strict';

const fs = require('fs').promises;
const path = require('path');

const { parseArgs, buildUrl, UsageError, USAGE } = require('../lib/cli');
const { homeRelative } = require('../lib/paths');
const { openInBrowser } = require('../lib/browser');
const { formatPrompt } = require('../lib/agent');
const { ReviewOwnershipError } = require('../lib/store');
const { reviewsDir, adoptLegacyReviews } = require('../lib/paths');
const { repoRoot } = require('../lib/repo');
const {
  loadReviewDocument,
  NoReviewError,
  NoMatchingCommentsError
} = require('../lib/export');
const { startServer, DEFAULT_PORT, DEFAULT_HOST } = require('../server');
const { version } = require('../package.json');

/**
 * The `reviewer` command: start the local server and open it in a browser.
 */

/**
 * Everything this command says to the person running it.
 *
 * stderr, not stdout, and that is the whole design. stdout carries the
 * finished review so it can be piped into a coding agent; a banner or a
 * progress line written there lands in the middle of it. Both streams go to
 * the same terminal when nothing is piping, so this is invisible until it
 * matters.
 *
 * @param {string} [line]
 */
function note(line = '') {
  process.stderr.write(`${line}\n`);
}

/**
 * Listen on `port`, falling back to any free port if it is taken.
 *
 * Someone reviewing two repositories at once should get a second window, not
 * an EADDRINUSE stack trace.
 *
 * @param {number} port
 * @param {object} [options] passed through to the server
 * @returns {Promise<import('http').Server>}
 */
async function listen(port, options = {}) {
  try {
    return await startServer({ ...options, port, host: DEFAULT_HOST, silent: true });
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;

    note(`Port ${port} is in use, picking another.`);
    return startServer({ ...options, port: 0, host: DEFAULT_HOST, silent: true });
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
  // Saved reviews are filed under the repository root, so exporting from a
  // subdirectory has to look there too — otherwise the browser saves a review
  // one directory up and this reports that none exists. Falling back to the
  // path as given keeps the case `lib/export.js` deliberately supports: a
  // review whose repository is no longer a repository is still exportable.
  const given = options.repoPath ?? process.cwd();
  const repoPath = (await repoRoot(given)) ?? given;

  let document;
  try {
    document = await loadReviewDocument(reviewsDir(), repoPath, { file: options.file });
  } catch (error) {
    // `lib/export` raises domain errors so that an MCP tool or an agent
    // handover can answer them its own way. The terminal wants all three as
    // the same usage error, with the same wording it has always printed.
    if (
      error instanceof NoReviewError ||
      error instanceof NoMatchingCommentsError ||
      error instanceof ReviewOwnershipError
    ) {
      throw new UsageError(error.message);
    }
    throw error;
  }

  process.stdout.write(
    options.format === 'prompt'
      ? formatPrompt(document)
      : `${JSON.stringify(document, null, 2)}\n`
  );
}

/**
 * Which repository the page should open.
 *
 * `reviewer` with no argument reviews the repository you are standing in.
 * `--help` has promised that since the first release and the code never did
 * it, so the page opened on an empty path box instead.
 *
 * Naming a directory and defaulting to one are answered differently on
 * purpose. Name one, and you are told when it is not a repository, because
 * you asked about it. Nobody asked for the current directory in particular —
 * so when that is not inside a repository the page opens on its picker
 * exactly as it always has, rather than greeting you with an error.
 *
 * @param {string|null} given the repository named on the command line
 * @returns {Promise<string|null>} repository to open, or null for the picker
 */
async function repositoryToOpen(given) {
  if (given) return (await repoRoot(given)) ?? given;
  return repoRoot(process.cwd());
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  // Reviews written by a version that kept them inside the package directory
  // are moved out before anything reads them. Once, synchronously, so no read
  // can start against a half-populated directory. See #33.
  const adopted = adoptLegacyReviews();
  if (adopted > 0) {
    note(
      `  Copied ${adopted} saved review${adopted === 1 ? '' : 's'} out of the ` +
        `install directory to\n  ${reviewsDir()}\n  so that upgrading or ` +
        'reinstalling this package can no longer delete them.\n' +
        '  The originals are left where they were.'
    );
  }

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

  const repoPath = await repositoryToOpen(options.repoPath);

  // Is anything reading our stdout? If so, the review goes there when it is
  // submitted and the command finishes -- which is what turns the whole loop
  // into one line:
  //
  //     reviewer | claude -p "Apply this review."
  //
  // On a terminal there is nothing waiting, so submitting is not the end of
  // anything: you may have more to review. It says where the review went and
  // what to run next, and keeps serving.
  const handingOff = !process.stdout.isTTY;

  let handedOff = false;
  const stop = () => {
    server.close(() => process.exit(0));
    // Don't wait forever on a browser holding the connection open.
    setTimeout(() => process.exit(0), 2000).unref();
  };

  /**
   * A review has just been written. Say so, or hand it over.
   *
   * @param {{document: object, reviewPath: string}} submitted
   */
  const onReviewSubmitted = ({ document, reviewPath }) => {
    const { comments, files } = document.summary;
    const count = `${comments} comment${comments === 1 ? '' : 's'} on ` +
      `${files} file${files === 1 ? '' : 's'}`;

    if (!handingOff) {
      note(`\n  Review saved    ${homeRelative(reviewPath)}`);
      note(`  ${count}\n`);
      note('  Hand it to an agent with:');
      note(`    reviewer export ${repoPath ? homeRelative(repoPath) : '.'} --format prompt | claude -p "Apply this review."\n`);
      return;
    }

    // Once is enough: the first submitted review is what the pipe is waiting
    // for, and a second would arrive after the process has gone.
    if (handedOff) return;
    handedOff = true;

    note(`\n  ${count} — handing the review back to your terminal.\n`);
    process.stdout.write(formatPrompt(document));
    stop();
  };

  const server = await listen(
    options.port ?? (Number(process.env.PORT) || DEFAULT_PORT),
    { onReviewSubmitted, handoff: handingOff }
  );
  const url = buildUrl(`http://${DEFAULT_HOST}:${server.address().port}`, repoPath);

  note(`\n  Code Reviewer  ${url}`);
  if (repoPath) note(`  reviewing      ${repoPath}`);
  note(handingOff
    ? '\n  Submit the review in the browser and it will be written here.\n'
    : '\n  Press Ctrl+C to stop.\n');

  if (options.open && !(await openInBrowser(url))) {
    note('  Could not open a browser — open the URL above yourself.\n');
  }

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
