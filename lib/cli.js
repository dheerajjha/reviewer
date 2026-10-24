'use strict';

const path = require('path');

const { KEY_PATTERN, AUTHOR_PATTERN } = require('./comments');

/**
 * Command-line parsing for the `reviewer` command.
 *
 * Kept separate from the command itself so the argument handling can be tested
 * without starting a server or opening a browser.
 */

function usage(name = 'git reviewer') {
  return `${name} — review local git changes in your browser

Usage:
  ${name} [repository] [options]
  ${name} export [repository] [--format json|prompt] [--file <path>]
  ${name} connect [repository] [--session <id>] [--fork] [--list]
  ${name} reply <key> <text | -> [--repo <path>] [--as <name>]
  ${name} watch [repository]
  ${name} channel [repository]

One program, two names. git reviewer is the name the package is installed as
-- git runs any git-<name> on your PATH as a subcommand -- and reviewer is the
short form. Under git, use -h for this text: git reviewer --help opens the
manual page instead.

Handing a review to an agent:
  ${name} | claude -p "Apply this review."

  With something reading its output, it writes the finished review there
  the moment you submit it in the browser, and exits. On a terminal there is
  nothing waiting, so it says where the review was saved and keeps serving.
  Everything it tells you goes to stderr either way, so only the review is
  ever on stdout.

Arguments:
  repository        Path to a git repository, or to any directory inside one.
                    Defaults to the current directory. It is opened
                    automatically once the page loads.

Commands:
  export            Print the saved review of a repository to stdout, for a
                    coding agent or another tool to consume.
  connect           Resume the Claude Code session that worked in this
                    repository with reviewer attached: every comment you
                    write is sent to it, and it answers in the thread.
                    --list shows the sessions; --session picks one.
  reply             Post a reply in a comment thread, as an agent: the
                    page shows it under the comment straight away. Use -
                    as the text to read it from stdin.
  watch             Print each new comment or reply from the reviewer as
                    one JSON line, for an agent to follow and answer.
  channel           The MCP server Claude Code runs for connect. Not
                    something to run by hand.

Options:
  -p, --port <n>    Port to listen on (default 4500; falls back to a free
                    port if that one is taken)
      --no-open     Print the URL instead of opening a browser
      --no-intro    Open the review without the first-run help
      --no-untracked Exclude untracked files from working directory reviews
      --staged      Review only staged changes (HEAD vs index)
      --json        Print one JSON line on stderr at startup instead of the banner
  -f, --format <f>  Export format: json (default) or prompt
      --file <path> Export comments for one repo-relative file
      --session <id> connect: the Claude Code session to resume
      --fork        connect: answer in a copy of the session
      --list        connect: list this repository's sessions
      --repo <path> reply: the repository (default: the current one)
      --as <name>   reply: who the reply is from (default: claude inside
                    Claude Code, agent elsewhere)
  -h, --help        Show this help
  -v, --version     Show the version

Examples:
  ${name}
      review the repository you are standing in
  ${name} | claude -p "Apply this review."
      review it, then hand it straight to an agent
  ${name} ~/work/api
      review another repository
  ${name} . --no-open
      print the URL, open it yourself
  ${name} export .
      print the review as JSON
  ${name} export . --file src/auth.js
      only the comments on one file
  ${name} export . --format prompt | claude -p "apply this review"
      hand over a review written earlier
  ${name} connect
      have the session that wrote the code answer your comments
`;
}

/** Formats `reviewer export` can print. */
const FORMATS = ['json', 'prompt'];

/** Words that, first on the command line, name a subcommand. */
const COMMANDS = ['export', 'connect', 'reply', 'watch', 'channel'];

class UsageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * @typedef {object} CliOptions
 * @property {'serve'|'export'|'connect'|'reply'|'watch'|'channel'} command
 * @property {string|null} repoPath absolute path, or null when not given
 * @property {number|null} port explicit port, or null to use the default
 * @property {boolean} open whether to launch a browser
 * @property {boolean} noIntro skip the first-run help dialog
 * @property {boolean} staged whether to review only the index
 * @property {boolean} untracked whether to include untracked files
 * @property {boolean} json whether to print the startup info as one JSON line
 * @property {'json'|'prompt'} format for `export`
 * @property {string|null} file repo-relative file to export, or all files
 * @property {string|null} session `connect`: Claude Code session id
 * @property {boolean} fork `connect`: resume a copy of the session
 * @property {boolean} list `connect`: list sessions instead of connecting
 * @property {string|null} key `reply`: the comment to reply to
 * @property {string|null} text `reply`: what to say
 * @property {boolean} textFromStdin `reply`: the text is to be read from stdin
 * @property {string|null} as `reply`: who it is from
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
    noIntro: false,
    staged: false,
    untracked: true,
    json: false,
    format: 'json',
    file: null,
    session: null,
    fork: false,
    list: false,
    key: null,
    text: null,
    textFromStdin: false,
    as: null,
    help: false,
    version: false
  };
  let positional = null;
  const positionals = [];
  let replyRepo = null;

  // A leading command word is the subcommand. Anywhere else it is an
  // ordinary path, so a directory that happens to be named `export` is still
  // reviewable as `reviewer ./export`.
  let rest = argv;
  if (COMMANDS.includes(argv[0])) {
    options.command = argv[0];
    rest = argv.slice(1);
  }

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];

    // A reply is prose, and prose starts with "- " as often as anything:
    // a Markdown list. After the key, a word that is not one of reply's own
    // options is part of the reply, and `--` makes everything after it so.
    if (options.command === 'reply') {
      if (arg === '--') {
        positionals.push(...rest.slice(i + 1));
        break;
      }
      const ownOption = ['--repo', '--as', '-h', '--help', '-v', '--version'].includes(arg) ||
        /^--(repo|as)=/.test(arg);
      if (positionals.length > 0 && !ownOption) {
        positionals.push(arg);
        continue;
      }
    }

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

      case '--no-intro':
        options.noIntro = true;
        break;

      case '--staged':
        options.staged = true;
        break;

      case '--no-untracked':
        options.untracked = false;
        break;

      case '--json':
        options.json = true;
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

      case '--session': {
        const value = rest[++i];
        if (value === undefined || value.startsWith('-')) throw new UsageError('--session needs a session id');
        options.session = value;
        break;
      }

      case '--fork':
        options.fork = true;
        break;

      case '--list':
        options.list = true;
        break;

      case '--repo': {
        const value = rest[++i];
        if (value === undefined || value.startsWith('-')) throw new UsageError('--repo needs a repository path');
        replyRepo = value;
        break;
      }

      case '--as': {
        const value = rest[++i];
        if (value === undefined || !AUTHOR_PATTERN.test(value)) {
          throw new UsageError('--as needs a short name, such as claude');
        }
        options.as = value;
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

        const inlineRepo = arg.match(/^--repo=(.+)$/);
        if (inlineRepo) {
          replyRepo = inlineRepo[1];
          break;
        }

        const inlineAs = arg.match(/^--as=(.*)$/);
        if (inlineAs) {
          if (!AUTHOR_PATTERN.test(inlineAs[1])) throw new UsageError('--as needs a short name, such as claude');
          options.as = inlineAs[1];
          break;
        }

        if (arg.startsWith('-') && arg !== '-') {
          throw new UsageError(`Unknown option: ${arg}`);
        }

        // `reply <key> <text...>` takes words, not a repository: the reply
        // is everything after the key, so it need not be quoted.
        if (options.command === 'reply') {
          positionals.push(arg);
          break;
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

  if (options.command === 'reply') {
    if (!options.help && !options.version) {
      const [key, ...words] = positionals;
      if (!key || !KEY_PATTERN.test(key)) throw new UsageError('reply needs the key of the comment to reply to');
      const text = words.join(' ').trim();
      if (text === '') throw new UsageError('reply needs the text of the reply, or - to read it from stdin');
      options.key = key;
      // `-` alone: the reply is on stdin, which suits an answer of several
      // lines and quotes that a shell would otherwise have to survive.
      options.text = text === '-' ? null : text;
      options.textFromStdin = text === '-';
    }
    if (replyRepo !== null) options.repoPath = path.resolve(cwd, replyRepo);
  } else if (replyRepo !== null) {
    throw new UsageError('--repo is only valid with reviewer reply; name the repository directly');
  }
  if (options.as !== null && options.command !== 'reply') {
    throw new UsageError('--as is only valid with reviewer reply');
  }
  for (const [flag, set] of [['--session', options.session !== null], ['--fork', options.fork], ['--list', options.list]]) {
    if (set && options.command !== 'connect') throw new UsageError(`${flag} is only valid with reviewer connect`);
  }

  if (options.file !== null && options.command !== 'export') {
    throw new UsageError('--file is only valid with reviewer export');
  }

  if (options.staged && options.command !== 'serve') {
    throw new UsageError('--staged is only valid when serving a review');
  }
  if (options.noIntro && options.command !== 'serve') {
    throw new UsageError('--no-intro is only valid when serving a review');
  }
  if (!options.untracked && options.command !== 'serve') {
    throw new UsageError('--no-untracked is only valid when serving a review');
  }

  if (options.json && options.command !== 'serve') {
    throw new UsageError('--json is only valid when serving a review');
  }
  if (options.port !== null && options.command !== 'serve') {
    throw new UsageError('--port is only valid when serving a review');
  }
  if (!options.open && options.command !== 'serve') {
    throw new UsageError('--no-open is only valid when serving a review');
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
 * @param {boolean} [staged]
 * @param {boolean} [noIntro] add intro=0 so a fresh browser skips the first-run help
 * @param {boolean} [untracked] include untracked files in working directory reviews
 * @returns {string}
 */
function buildUrl(origin, repoPath, staged = false, noIntro = false, untracked = true) {
  const params = [];
  if (repoPath) {
    // Slashes are left as slashes. They are legal in a query value -- RFC 3986
    // has `query = *( pchar / "/" / "?" )` -- and encoding them turns the most
    // prominent line the command prints into %2F soup:
    //
    //   before  http://127.0.0.1:4500/?repo=%2FUsers%2Fyou%2Fwork%2Fapi
    //   after   http://127.0.0.1:4500/?repo=/Users/you/work/api
    //
    // Everything else stays encoded, including the characters that would
    // otherwise end the query and take the rest of the path with them.
    params.push(`repo=${encodeURIComponent(repoPath).replace(/%2F/g, '/')}`);
  }
  if (staged) params.push('staged=1');
  if (noIntro) params.push('intro=0');
  if (!untracked) params.push('untracked=0');
  return params.length === 0 ? origin : `${origin}/?${params.join('&')}`;
}

/**
 * The name to show in help and hints: the one the person actually typed.
 *
 * The package is git-reviewer and installs two commands, reviewer and
 * git-reviewer. Showing one while someone typed the other was the confusing
 * part, so this answers with theirs. Git sets GIT_EXEC_PATH when it runs a
 * subcommand, which is how `git reviewer` is told apart from `git-reviewer`
 * typed directly; npx sets npm_command=exec, and for an npx run neither bare
 * name is on the PATH, so the hint has to say npx too.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string|undefined} argv1 process.argv[1]
 */
function invokedAs(env, argv1) {
  if (env.npm_command === 'exec') return 'npx git-reviewer';
  const bin = String(argv1 || '').split(/[\\/]/).pop().replace(/\.js$/, '');
  if (bin === 'git-reviewer') return env.GIT_EXEC_PATH ? 'git reviewer' : 'git-reviewer';
  return 'reviewer';
}

const USAGE = usage();

module.exports = { parseArgs, buildUrl, UsageError, USAGE, FORMATS, COMMANDS, usage, invokedAs };
