'use strict';

const path = require('path');

/**
 * Command-line parsing for the `reviewer` command.
 *
 * Kept separate from the command itself so the argument handling can be tested
 * without starting a server or opening a browser.
 */

const USAGE = `reviewer — review local git changes in your browser

Usage:
  reviewer [repository] [options]
  reviewer export [repository] [--format json|prompt] [--file <path>]

Arguments:
  repository        Path to a git repository. Defaults to the current
                    directory. It is opened automatically once the page loads.

Commands:
  export            Print the saved review of a repository to stdout, for a
                    coding agent or another tool to consume.

Options:
  -p, --port <n>    Port to listen on (default 4500; falls back to a free
                    port if that one is taken)
      --no-open     Print the URL instead of opening a browser
  -f, --format <f>  Export format: json (default) or prompt
      --file <path> Export comments for one repo-relative file
  -h, --help        Show this help
  -v, --version     Show the version

Examples:
  reviewer                 review the repository you are standing in
  reviewer ~/work/api      review another repository
  reviewer . --no-open     print the URL, open it yourself
  reviewer export .        print the review as JSON
  reviewer export . --file src/auth.js
  reviewer export . --format prompt | claude -p "apply this review"
`;

/** Formats `reviewer export` can print. */
const FORMATS = ['json', 'prompt'];

class UsageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * @typedef {object} CliOptions
 * @property {'serve'|'export'} command
 * @property {string|null} repoPath absolute path, or null when not given
 * @property {number|null} port explicit port, or null to use the default
 * @property {boolean} open whether to launch a browser
 * @property {'json'|'prompt'} format for `export`
 * @property {string|null} file repo-relative file to export, or all files
 * @property {boolean} help
 * @property {boolean} version
 */

/**
 * Parse `reviewer` arguments.
 *
 * @param {string[]} argv arguments after the node binary and script
 * @param {string} [cwd] base for resolving a relative repository path
 * @returns {CliOptions}
 * @throws {UsageError} on an unknown flag, a missing value, or a bad port
 */
function parseArgs(argv, cwd = process.cwd()) {
  /** @type {CliOptions} */
  const options = {
    command: 'serve',
    repoPath: null,
    port: null,
    open: true,
    format: 'json',
    file: null,
    help: false,
    version: false
  };
  let positional = null;

  // A leading `export` is the subcommand. Anywhere else it is an ordinary
  // path, so a directory that happens to be named `export` is still reviewable
  // as `reviewer ./export`.
  let rest = argv;
  if (argv[0] === 'export') {
    options.command = 'export';
    rest = argv.slice(1);
  }

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];

    switch (arg) {
      case '-h':
      case '--help':
        options.help = true;
        break;

      case '-v':
      case '--version':
        options.version = true;
        break;

      case '--no-open':
        options.open = false;
        break;

      case '-p':
      case '--port': {
        const value = rest[++i];
        if (value === undefined) throw new UsageError(`${arg} needs a port number`);
        options.port = parsePort(value, arg);
        break;
      }

      case '-f':
      case '--format': {
        const value = rest[++i];
        if (value === undefined) throw new UsageError(`${arg} needs a format`);
        options.format = parseFormat(value, arg);
        break;
      }

      case '--file': {
        const value = rest[++i];
        options.file = parseFile(value, '--file');
        break;
      }

      default: {
        // Support --port=4500 as well as --port 4500.
        const inlinePort = arg.match(/^--port=(.*)$/);
        if (inlinePort) {
          options.port = parsePort(inlinePort[1], '--port');
          break;
        }

        const inlineFormat = arg.match(/^--format=(.*)$/);
        if (inlineFormat) {
          options.format = parseFormat(inlineFormat[1], '--format');
          break;
        }

        const inlineFile = arg.match(/^--file=(.*)$/);
        if (inlineFile) {
          options.file = parseFile(inlineFile[1], '--file');
          break;
        }

        if (arg.startsWith('-') && arg !== '-') {
          throw new UsageError(`Unknown option: ${arg}`);
        }

        if (positional !== null) {
          throw new UsageError(`Unexpected argument: ${arg}`);
        }

        positional = arg;
      }
    }
  }

  if (positional !== null) {
    options.repoPath = path.resolve(cwd, positional);
  }

  if (options.file !== null && options.command !== 'export') {
    throw new UsageError('--file is only valid with reviewer export');
  }

  return options;
}

/**
 * @param {string} value
 * @param {string} flag the flag being parsed, for the error message
 * @returns {number}
 */
function parsePort(value, flag) {
  // Number() rather than parseInt() so "80x" is rejected instead of read as 80
  // — but Number('') is 0, and an empty value is a mistake, not a request for
  // any free port.
  const port = value.trim() === '' ? NaN : Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new UsageError(`${flag} must be a number between 0 and 65535, got "${value}"`);
  }
  return port;
}

/**
 * @param {string} value
 * @param {string} flag the flag being parsed, for the error message
 * @returns {'json'|'prompt'}
 */
function parseFormat(value, flag) {
  if (!FORMATS.includes(value)) {
    throw new UsageError(`${flag} must be one of ${FORMATS.join(', ')}, got "${value}"`);
  }
  return value;
}

/**
 * @param {string|undefined} value
 * @param {string} flag the flag being parsed, for the error message
 * @returns {string}
 */
function parseFile(value, flag) {
  if (value === undefined || value.trim() === '' || value.startsWith('-')) {
    throw new UsageError(`${flag} needs a repo-relative file path`);
  }
  return value;
}

/**
 * Build the URL to open, asking the page to load a repository if one was named.
 *
 * @param {string} origin e.g. http://127.0.0.1:4500
 * @param {string|null} repoPath
 * @returns {string}
 */
function buildUrl(origin, repoPath) {
  if (!repoPath) return origin;
  return `${origin}/?repo=${encodeURIComponent(repoPath)}`;
}

module.exports = { parseArgs, buildUrl, UsageError, USAGE, FORMATS };
