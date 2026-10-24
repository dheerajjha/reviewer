'use strict';

const { spawn } = require('child_process');

/**
 * Finding text across a review: every changed file at once, the way an IDE's
 * find navigator searches a project rather than the open file.
 *
 * The question it is built for is the one a reviewer cannot answer from one
 * file: "this function is new here -- where is it called, and where was it
 * called before this change?" So every result says which side of the change
 * it is on: a line this change added, one it deleted, unchanged code inside a
 * changed file, or code in the rest of the repository the change did not
 * touch. A references search goes one step further and tells definitions from
 * uses, and says when a definition changed but its callers did not.
 */

// What counts as part of an identifier, for whole-word matching. `$` is in
// it because JavaScript identifiers use it.
const IDENT = 'A-Za-z0-9_$';
const MODES = ['contains', 'word', 'prefix', 'suffix', 'regex'];
const SCOPES = ['changes', 'files', 'repo'];

const MAX_RESULTS = 2000;
const MAX_PER_FILE = 300;
const MAX_LINE = 2000;
const MAX_RANGES = 20;

/** A search that cannot run as asked; the message is for the person who typed it. */
class SearchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SearchError';
  }
}

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The matcher for a query, as a global regular expression.
 *
 * @param {string} query
 * @param {object} [options]
 * @param {string} [options.mode] contains, word, prefix, suffix or regex
 * @param {boolean} [options.caseSensitive]
 * @returns {RegExp}
 * @throws {SearchError}
 */
function buildMatcher(query, { mode = 'contains', caseSensitive = false } = {}) {
  if (typeof query !== 'string' || query.trim() === '') throw new SearchError('Type something to search for.');
  if (query.length > 500) throw new SearchError('That search is longer than 500 characters.');
  if (!MODES.includes(mode)) throw new SearchError(`Unknown match mode "${mode}".`);

  const literal = escapeRegExp(query);
  const source = {
    contains: literal,
    word: `(?<![${IDENT}])${literal}(?![${IDENT}])`,
    prefix: `(?<![${IDENT}])${literal}`,
    suffix: `${literal}(?![${IDENT}])`,
    regex: query
  }[mode];

  try {
    return new RegExp(source, caseSensitive ? 'g' : 'gi');
  } catch (error) {
    throw new SearchError(`That is not a valid regular expression: ${error.message.replace(/^Invalid regular expression: /, '')}`);
  }
}

/**
 * Where a matcher matches on one line, as [start, end) pairs, so the page can
 * mark exactly what matched. Very long lines -- minified bundles -- are
 * searched only as far as MAX_LINE characters.
 *
 * @param {string} text
 * @param {RegExp} matcher a global RegExp from buildMatcher
 * @returns {Array<[number, number]>}
 */
function matchRanges(text, matcher) {
  const line = text.length > MAX_LINE ? text.slice(0, MAX_LINE) : text;
  const ranges = [];
  matcher.lastIndex = 0;
  let match;
  while ((match = matcher.exec(line)) !== null) {
    if (match[0].length === 0) {
      matcher.lastIndex += 1; // an empty regex match would never advance
      continue;
    }
    ranges.push([match.index, match.index + match[0].length]);
    if (ranges.length >= MAX_RANGES) break;
  }
  return ranges;
}

/**
 * Whether a line defines `name`, as far as one line can show it, in the
 * languages people most often review: a function, class, method, type or
 * variable declared under that name. A heuristic, and labelled as one in the
 * page: a references search sorts by it, never hides by it.
 *
 * @param {string} text
 * @param {string} name
 * @returns {boolean}
 */
function definesName(text, name) {
  const n = escapeRegExp(name);
  const end = `(?![${IDENT}])`;
  const declared = new RegExp(
    `(?:^|[^${IDENT}.])(?:function\\*?|def|class|interface|type|struct|enum|trait|fn|func|const|let|var|val|module)\\s+${n}${end}`
  );
  const assigned = new RegExp(
    `(?:^|[\\s{,;(])${n}\\s*[:=]\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)\\s*=>|[A-Za-z_$][\\w$]*\\s*=>)`
  );
  const method = new RegExp(
    `^\\s*(?:(?:public|private|protected|static|async|override|export|default|get|set)\\s+)*\\*?${n}\\s*\\([^)]*\\)\\s*(?::\\s*[^{]+)?\\{\\s*$`
  );
  return declared.test(text) || assigned.test(text) || method.test(text);
}

/**
 * The side of the change a diff line is on.
 *
 * @param {'add'|'delete'|'unchanged'} type
 * @returns {'added'|'deleted'|'context'}
 */
function sideOf(type) {
  return type === 'add' ? 'added' : type === 'delete' ? 'deleted' : 'context';
}

/**
 * Search the changed files of a review.
 *
 * @param {Array<{path: string, lines: Array<{type: string, oldLine: number|null, newLine: number|null, content: string}>}>} files
 *   each changed file's diff, as the page draws it: every line of the file,
 *   with what was added and deleted marked
 * @param {RegExp} matcher
 * @param {object} [options]
 * @param {boolean} [options.changedOnly] only lines the change added or deleted
 * @returns {{results: object[], truncated: boolean}}
 */
function searchDiffs(files, matcher, { changedOnly = false } = {}) {
  const results = [];
  let truncated = false;

  for (const file of files) {
    let inFile = 0;
    for (let index = 0; index < file.lines.length; index++) {
      const line = file.lines[index];
      if (changedOnly && line.type !== 'add' && line.type !== 'delete') continue;
      const ranges = matchRanges(line.content, matcher);
      if (ranges.length === 0) continue;

      if (results.length >= MAX_RESULTS || inFile >= MAX_PER_FILE) {
        truncated = true;
        if (results.length >= MAX_RESULTS) return { results, truncated };
        break;
      }
      results.push({
        file: file.path,
        side: sideOf(line.type),
        line: line.newLine ?? line.oldLine,
        oldLine: line.oldLine,
        newLine: line.newLine,
        diffIndex: index,
        text: line.content.slice(0, MAX_LINE),
        ranges
      });
      inFile += 1;
    }
  }

  return { results, truncated };
}

/**
 * The git grep arguments for a query, as close to the matcher as git's own
 * dialect allows. Whatever git finds is filtered through the real matcher
 * afterwards, so git only has to be no narrower than it.
 *
 * @param {string} query
 * @param {{mode: string, caseSensitive: boolean}} options
 * @returns {string[]}
 */
function grepPattern(query, { mode, caseSensitive }) {
  const literal = query.replace(/[.^$*+?()[\]{}|\\]/g, '\\$&');
  const args = caseSensitive ? [] : ['-i'];
  if (mode === 'contains' || mode === 'word' || mode === 'prefix' || mode === 'suffix') {
    // A fixed-string search for the text is never narrower than any of
    // these, and git does it fastest; the boundaries are checked in JS.
    return [...args, '-F', '-e', query];
  }
  return [...args, '-E', '-e', mode === 'regex' ? query : literal];
}

/**
 * Lines matching the query in the repository's files, on the reviewed side.
 *
 * Runs `git grep` against the exact tree under review -- the working tree, the
 * index, or the head commit of a comparison -- and stops reading once it has
 * enough, so a match in every file of a large repository costs the first
 * MAX_RESULTS lines and no more.
 *
 * @param {object} options
 * @param {string} options.repoPath
 * @param {{mode: string, range: {head: string}|null}} options.session
 * @param {string} options.query
 * @param {{mode: string, caseSensitive: boolean}} options.match
 * @param {RegExp} options.matcher
 * @param {Set<string>} options.exclude paths already searched through their diff
 * @param {number} [options.limit]
 * @returns {Promise<{results: object[], truncated: boolean}>}
 */
function grepRepository({ repoPath, session, query, match, matcher, exclude, limit = MAX_RESULTS }) {
  const where = session.mode === 'staged' ? ['--cached']
    : session.range ? [session.range.head]
      : [];
  const rev = session.range && session.mode !== 'staged' ? session.range.head : null;
  const args = ['grep', '-z', '-n', '-I', '--no-color', ...grepPattern(query, match), ...where, '--'];

  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: repoPath, windowsHide: true });
    const results = [];
    const perFile = new Map();
    let buffered = '';
    let truncated = false;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      resolve({ results, truncated });
    };

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', chunk => {
      if (done) return;
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const record = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const [location, lineNumber, ...rest] = record.split('\0');
        if (lineNumber === undefined) continue;
        const file = rev && location.startsWith(`${rev}:`) ? location.slice(rev.length + 1) : location;
        if (exclude.has(file)) continue;
        const text = rest.join('\0');
        const ranges = matchRanges(text, matcher);
        if (ranges.length === 0) continue;

        const count = perFile.get(file) ?? 0;
        if (count >= MAX_PER_FILE) {
          truncated = true;
          continue;
        }
        perFile.set(file, count + 1);
        results.push({
          file,
          side: 'untouched',
          line: Number(lineNumber),
          oldLine: null,
          newLine: Number(lineNumber),
          diffIndex: null,
          text: text.slice(0, MAX_LINE),
          ranges
        });
        if (results.length >= limit) {
          truncated = true;
          child.kill();
          finish();
          return;
        }
      }
    });
    child.on('error', error => {
      if (!done) {
        done = true;
        reject(error);
      }
    });
    // git grep exits 1 when nothing matched, which is an answer, not a failure.
    child.on('close', finish);
  });
}

/**
 * What a references search found, in the terms a reviewer asks it.
 *
 * @param {object[]} results with `role` set
 * @returns {{definitions: number, added: number, removed: number, unchanged: number, warning: string|null}}
 */
function summarizeReferences(results) {
  const uses = results.filter(result => result.role === 'reference');
  const definitions = results.filter(result => result.role === 'definition');
  const summary = {
    definitions: definitions.length,
    added: uses.filter(result => result.side === 'added').length,
    removed: uses.filter(result => result.side === 'deleted').length,
    unchanged: uses.filter(result => result.side === 'context' || result.side === 'untouched').length,
    warning: null
  };
  const definitionChanged = definitions.some(result => result.side === 'added' || result.side === 'deleted');
  if (definitionChanged && summary.unchanged > 0) {
    summary.warning = `The definition changed, and ${summary.unchanged} ${summary.unchanged === 1 ? 'use was' : 'uses were'} left as they were. Check that they still fit.`;
  }
  return summary;
}

module.exports = {
  buildMatcher,
  matchRanges,
  definesName,
  searchDiffs,
  grepRepository,
  summarizeReferences,
  SearchError,
  MODES,
  SCOPES,
  MAX_RESULTS
};
