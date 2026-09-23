'use strict';

/**
 * Turning git state into the flat `{ path, status }` list the file sidebar
 * renders.
 *
 * Status letters follow git's own vocabulary: `A` added, `M` modified,
 * `D` deleted, `R` renamed, `B` binary.
 */

/**
 * @typedef {object} ChangedFile
 * @property {string} path repo-relative path
 * @property {'A'|'M'|'D'|'R'|'B'} status
 */

/**
 * Unquotes git's octal-escaped, C-quoted filename strings (e.g. "\"caf\\303\\251.txt\"" -> "café.txt").
 *
 * When core.quotePath is enabled (default in git), paths containing non-ASCII
 * or control characters are enclosed in double quotes and byte-escaped with octal
 * sequences.
 *
 * @param {string} str
 * @returns {string}
 */
function unquoteGitPath(str) {
  if (typeof str !== 'string') return str;
  if (str.length >= 2 && str.startsWith('"') && str.endsWith('"')) {
    const inner = str.slice(1, -1);
    const bytes = [];
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === '\\' && i + 1 < inner.length) {
        i++;
        const next = inner[i];
        if (next >= '0' && next <= '7') {
          let octal = next;
          if (i + 1 < inner.length && inner[i + 1] >= '0' && inner[i + 1] <= '7') {
            i++;
            octal += inner[i];
            if (i + 1 < inner.length && inner[i + 1] >= '0' && inner[i + 1] <= '7') {
              i++;
              octal += inner[i];
            }
          }
          bytes.push(parseInt(octal, 8));
        } else if (next === 'a') {
          bytes.push(0x07);
        } else if (next === 'b') {
          bytes.push(0x08);
        } else if (next === 't') {
          bytes.push(0x09);
        } else if (next === 'n') {
          bytes.push(0x0a);
        } else if (next === 'v') {
          bytes.push(0x0b);
        } else if (next === 'f') {
          bytes.push(0x0c);
        } else if (next === 'r') {
          bytes.push(0x0d);
        } else if (next === '"') {
          bytes.push(0x22);
        } else if (next === '\\') {
          bytes.push(0x5c);
        } else {
          const code = next.charCodeAt(0);
          if (code >= 0xd800 && code <= 0xdbff && i + 1 < inner.length) {
            const nextCode = inner.charCodeAt(i + 1);
            if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
              const pair = inner.slice(i, i + 2);
              i++;
              const buf = Buffer.from(pair, 'utf8');
              for (const b of buf) bytes.push(b);
              continue;
            }
          }
          const buf = Buffer.from(next, 'utf8');
          for (const b of buf) bytes.push(b);
        }
      } else {
        const code = inner.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff && i + 1 < inner.length) {
          const nextCode = inner.charCodeAt(i + 1);
          if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
            const pair = inner.slice(i, i + 2);
            i++;
            const buf = Buffer.from(pair, 'utf8');
            for (const b of buf) bytes.push(b);
            continue;
          }
        }
        const buf = Buffer.from(inner[i], 'utf8');
        for (const b of buf) bytes.push(b);
      }
    }
    return Buffer.from(bytes).toString('utf8');
  }
  return str;
}

/**
 * Extracts the target path and whether the file entry represents a rename
 * from git diff --stat display format (e.g. "old => new", "prefix/{old => new}.ext").
 *
 * @param {string} raw
 * @returns {{ isRename: boolean, path: string }}
 */
function parseCommitFilePath(raw) {
  if (typeof raw !== 'string') return { isRename: false, path: raw ?? '' };

  // 1. Brace rename: prefix{old => new}suffix or {old => new}
  const braceMatch = raw.match(/^(.*?)\{(?:.*?) => (.*?)\}(.*)$/);
  if (braceMatch) {
    const rawTo = braceMatch[1] + braceMatch[2] + braceMatch[3];
    const normalized = unquoteGitPath(rawTo).replace(/\/{2,}/g, '/').replace(/^\/+/, '');
    return { isRename: true, path: normalized };
  }

  // 2. Arrow rename: old => new (or "old" => "new")
  const arrowMatch = raw.match(/^(?:.*?) => (.*)$/);
  if (arrowMatch) {
    const rawTo = arrowMatch[1].trim();
    const normalized = unquoteGitPath(rawTo).replace(/\/{2,}/g, '/').replace(/^\/+/, '');
    return { isRename: true, path: normalized };
  }

  return { isRename: false, path: unquoteGitPath(raw).replace(/^\/+/, '') };
}

/**
 * Collect working-directory changes from a `simple-git` status result.
 *
 * A single path can be reported by more than one bucket — a file that is
 * staged and then edited again shows up as both created and modified — so the
 * first status wins and later duplicates are dropped. Buckets are ordered
 * most- to least-specific for that reason.
 *
 * @param {import('simple-git').StatusResult} status
 * @returns {ChangedFile[]}
 */
function collectWorkingChanges(status) {
  const buckets = [
    [status?.renamed ?? [], 'R'],
    [status?.deleted ?? [], 'D'],
    [status?.created ?? [], 'A'],
    [status?.not_added ?? [], 'A'],
    [status?.modified ?? [], 'M']
  ];

  const seen = new Map();

  for (const [files, letter] of buckets) {
    for (const entry of files) {
      // `renamed` holds `{ from, to }`; every other bucket holds plain strings.
      const rawPath = typeof entry === 'string' ? entry : entry?.to;
      const filePath = unquoteGitPath(rawPath);
      if (!filePath || seen.has(filePath)) continue;
      seen.set(filePath, { path: filePath, status: letter });
    }
  }

  return [...seen.values()];
}

/**
 * Derive a status letter for one file of a commit diff summary.
 *
 * `simple-git` reports binary files without insertion/deletion counts, and a
 * commit that only adds lines to a file is an addition of that file only when
 * it deletes none.
 *
 * @param {object} file entry from `git.diffSummary()`
 * @returns {'A'|'M'|'D'|'R'|'B'}
 */
function classifyCommitFile(file) {
  if (file?.file && parseCommitFilePath(file.file).isRename) return 'R';
  if (file?.binary) return 'B';

  const insertions = file?.insertions ?? 0;
  const deletions = file?.deletions ?? 0;

  if (insertions > 0 && deletions > 0) return 'M';
  if (insertions > 0) return 'A';
  if (deletions > 0) return 'D';
  return 'M';
}

/**
 * Collect the files touched by a commit.
 *
 * @param {import('simple-git').DiffResult} diffSummary
 * @returns {ChangedFile[]}
 */
/**
 * Read `git diff --name-status -z` into what git itself says happened to
 * each path.
 *
 * This exists because `classifyCommitFile` above has to guess from line
 * counts, and the guess is wrong for a large share of ordinary edits: a
 * change that only adds lines to an existing file reads as `A`, and one that
 * only removes lines reads as `D` -- a reviewer shown "deleted" on a file
 * that lost one line has been told something false by the badge meant to
 * orient them. Git knows the answer; ask it.
 *
 * `-z` rather than the default output because the default quotes and
 * octal-escapes non-ASCII paths the same way `--stat` does, and those were
 * #20's bug the first time. With `-z` every field is NUL-terminated and the
 * path is raw bytes, so there is nothing to unquote.
 *
 * Renames and copies (`R100`, `C75`) carry two paths; the second is the one
 * the file now lives at, which is the one the rest of the app keys on.
 *
 * @param {string} raw output of `git diff --name-status -z -M <from> <to>`
 * @returns {Map<string, 'A'|'M'|'D'|'R'>} path -> status
 */
function parseNameStatus(raw) {
  const statuses = new Map();
  const fields = String(raw ?? '').split('\0');

  for (let i = 0; i < fields.length; ) {
    const code = fields[i];
    if (!code) { i += 1; continue; }

    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      const to = fields[i + 2];
      // A copy is a new file that happens to resemble an old one; from the
      // reviewer's side it is an addition.
      if (to) statuses.set(to, letter === 'R' ? 'R' : 'A');
      i += 3;
      continue;
    }

    const path = fields[i + 1];
    if (path) {
      // T is a type change (a file became a symlink, or the reverse). The
      // path still exists on both sides, so for review purposes it is a
      // modification.
      statuses.set(path, letter === 'A' || letter === 'D' ? letter : 'M');
    }
    i += 2;
  }

  return statuses;
}

/**
 * The flat file list for a commit or range review.
 *
 * Paths still come from `diffSummary`, whose rename and quoting handling was
 * earned the hard way (#20, #25, #64). Only the status letter comes from
 * `statuses` when it is given -- which every caller in the server does. The
 * count-based guess remains as the fallback for a caller that has nothing
 * better, not as the answer.
 *
 * @param {import('simple-git').DiffResult} diffSummary
 * @param {Map<string, string>} [statuses] from `parseNameStatus`
 */
function collectCommitChanges(diffSummary, statuses) {
  const files = diffSummary?.files ?? [];
  return files.map(file => {
    const { path, isRename } = parseCommitFilePath(file?.file);
    if (isRename) return { path, status: 'R' };
    if (file?.binary) return { path, status: 'B' };

    const known = statuses?.get(path);
    return { path, status: known ?? classifyCommitFile(file) };
  });
}

module.exports = {
  collectWorkingChanges,
  collectCommitChanges,
  classifyCommitFile,
  unquoteGitPath,
  parseCommitFilePath,
  parseNameStatus
};
