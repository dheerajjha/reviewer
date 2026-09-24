// Use current origin for Electron compatibility (dynamic port)
// In web mode, this will be http://localhost:4500
// In Electron, this will be the random port Electron assigned
const API_BASE = `${window.location.origin}/api`;

let currentRepoId = null;
let currentFiles = [];
let currentFile = null;
let currentDiffLines = [];
let comments = [];

// Auto-save comments to backend
async function saveCommentsToBackend() {
  if (!currentRepoId) return;

  try {
    await fetch(`${API_BASE}/save-comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoId: currentRepoId,
        comments: comments // Send empty array if no comments
      })
    });
  } catch (error) {
    console.error('Failed to save comments:', error);
  }
}

// Load comments from backend
async function loadCommentsFromBackend() {
  if (!currentRepoId) return [];

  try {
    const response = await fetch(`${API_BASE}/load-comments/${currentRepoId}`);
    const data = await response.json();
    return data.comments || [];
  } catch (error) {
    console.error('Failed to load comments:', error);
    return [];
  }
}

// Fuzzy match saved comments to current diff
function matchCommentsToDiff(savedComments, filePath, diffLines) {
  const fileComments = savedComments.filter(c => c.file === filePath);
  const matched = [];

  fileComments.forEach(savedComment => {
    let matchResult = null;

    // Try exact match first (line number + content)
    const exactMatch = diffLines.findIndex(dl =>
      (dl.newLine === savedComment.line || dl.oldLine === savedComment.line) &&
      dl.content === savedComment.lineContent
    );

    if (exactMatch !== -1) {
      matchResult = {
        ...savedComment,
        diffLineIndex: exactMatch,
        matchType: 'exact'
      };
    } else {
      // Try fuzzy match (search ±5 lines for similar content)
      let bestMatch = -1;
      let bestSimilarity = 0;

      for (let i = 0; i < diffLines.length; i++) {
        const dl = diffLines[i];
        const lineNum = dl.newLine || dl.oldLine;

        // Check if within ±5 lines
        if (Math.abs(lineNum - savedComment.line) <= 5) {
          const similarity = calculateSimilarity(dl.content, savedComment.lineContent);
          if (similarity > bestSimilarity && similarity > 0.6) {
            bestSimilarity = similarity;
            bestMatch = i;
          }
        }
      }

      if (bestMatch !== -1) {
        matchResult = {
          ...savedComment,
          diffLineIndex: bestMatch,
          matchType: 'fuzzy',
          newLineContent: diffLines[bestMatch].content
        };
      } else {
        // No match found - mark as unmatched
        matchResult = {
          ...savedComment,
          diffLineIndex: null,
          matchType: 'unmatched'
        };
      }
    }

    if (matchResult) {
      matched.push(matchResult);
    }
  });

  return matched;
}

// Simple similarity calculation (Levenshtein-based approximation)
function calculateSimilarity(str1, str2) {
  if (str1 === str2) return 1;
  if (!str1 || !str2) return 0;

  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;

  if (longer.length === 0) return 1;

  // Simple matching: count common characters
  const longerLower = longer.toLowerCase().trim();
  const shorterLower = shorter.toLowerCase().trim();

  if (longerLower.includes(shorterLower) || shorterLower.includes(longerLower)) {
    return 0.8;
  }

  // Count matching words
  const words1 = str1.toLowerCase().split(/\s+/);
  const words2 = str2.toLowerCase().split(/\s+/);
  const commonWords = words1.filter(w => words2.includes(w));

  return commonWords.length / Math.max(words1.length, words2.length);
}

// Load local repository
/** Short form of a commit sha, for reading rather than for copying. */
function shortSha(sha) {
  return typeof sha === 'string' ? sha.slice(0, 8) : '';
}

/** A full sha is shortened for display; a branch or tag name is left alone. */
function displayRef(ref) {
  return /^[0-9a-f]{40}$/i.test(ref ?? '') ? shortSha(ref) : (ref ?? '');
}

/** `n thing` or `n things`, instead of the `thing(s)` that reads like a form. */
function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// What the compare pickers can offer, from /api/refs. Refetched on every
// load, because a comparison opens a new session and branches move.
let currentRefs = null;

// The "type something else" choice at the foot of either picker.
const OTHER_REF = '__other__';

const PICKERS = {
  base: { select: 'compareBaseSelect', other: 'compareBaseOther' },
  head: { select: 'compareHeadSelect', other: 'compareHeadOther' }
};

/**
 * Fetch the branches, tags and commits the pickers offer, and fill both.
 *
 * A failure leaves both pickers with only "Other…" in them, which still
 * works; a repository whose refs will not list is not a reason to refuse to
 * compare it.
 */
async function loadRefs(repoId, head) {
  try {
    const query = head ? `?${new URLSearchParams({ head })}` : '';
    const response = await fetch(`${API_BASE}/refs/${repoId}${query}`);
    currentRefs = response.ok ? await response.json() : null;
  } catch {
    currentRefs = null;
  }
  fillPicker('base');
  fillPicker('head');
}

/**
 * Fill one picker, grouped the way people look for things.
 *
 * Branches first, because "my branch against main" is the comparison people
 * reach for. Every label goes in through `new Option`, which sets text, not
 * markup: branch names and commit subjects come from whatever repository is
 * open, and a ref name may legally contain `<` and `>`.
 */
function fillPicker(end) {
  const select = document.getElementById(PICKERS[end].select);
  const refs = currentRefs;
  select.innerHTML = '';

  const placeholder = new Option(end === 'base' ? 'Choose a base…' : 'Choose what to compare…', '');
  placeholder.disabled = true;
  select.appendChild(placeholder);

  const group = (label, options) => {
    if (options.length === 0) return;
    const optgroup = document.createElement('optgroup');
    optgroup.label = label;
    options.forEach(option => optgroup.appendChild(option));
    select.appendChild(optgroup);
  };

  if (refs) {
    group('Branches', refs.branches.map(branch => new Option(
      `${branch.name}${branch.name === refs.current ? ' (current)' : ''}  ·  ${branch.when}`,
      branch.name
    )));
    // Commits second, not last. In 2.12 they came after every remote branch
    // and tag -- option 51 of 81 in this project's own repository -- which is
    // why comparing a commit felt like a feature that had been removed.
    group(
      'Recent commits',
      refs.commits.map(commit => new Option(`${commit.short}  ·  ${commit.subject}  ·  ${commit.when}`, commit.sha))
    );
    group('Remote branches', refs.remotes.map(branch => new Option(`${branch.name}  ·  ${branch.when}`, branch.name)));
    group('Tags', refs.tags.map(tag => new Option(`${tag.name}  ·  ${tag.when}`, tag.name)));
  }

  select.appendChild(new Option('Other: a tag, HEAD~5, a sha…', OTHER_REF));
  select.value = '';
}

/**
 * Point a picker at a ref, by name if it is offered, by sha if the name is
 * not but the commit is, and otherwise through "Other…" with the text shown.
 *
 * A range opened by typing `HEAD~2` resolves to a commit that may well be in
 * the list; showing it selected there is more useful than a picker stuck on
 * "Other" around a value that is also sitting three rows down.
 */
function selectRef(end, name, sha) {
  const select = document.getElementById(PICKERS[end].select);
  const other = document.getElementById(PICKERS[end].other);
  const offered = value => [...select.options].some(option => option.value === value);

  if (name && offered(name)) {
    select.value = name;
  } else if (sha && offered(sha)) {
    select.value = sha;
  } else if (name || sha) {
    select.value = OTHER_REF;
    other.value = name || displayRef(sha);
    other.classList.remove('hidden');
    return;
  } else {
    select.value = '';
  }
  other.classList.add('hidden');
  other.value = '';
}

/** The ref one end of the comparison currently names, or '' if none yet. */
function pickedRef(end) {
  const select = document.getElementById(PICKERS[end].select);
  return select.value === OTHER_REF
    ? document.getElementById(PICKERS[end].other).value.trim()
    : select.value;
}

/** Either picker changed: compare as soon as both ends are known. */
function onPickerChange(end) {
  const select = document.getElementById(PICKERS[end].select);
  const other = document.getElementById(PICKERS[end].other);

  if (select.value === OTHER_REF) {
    other.classList.remove('hidden');
    other.focus();
    return; // Enter in the box compares; see the listeners in DOMContentLoaded.
  }

  other.classList.add('hidden');
  compareNow();
}

function compareNow() {
  const base = pickedRef('base');
  const head = pickedRef('head');
  if (base && head) loadRepo({ base, head });
}

/** Reverse the comparison: "what does main have that my branch does not". */
function swapCompare() {
  const base = pickedRef('base');
  const head = pickedRef('head');
  if (base && head) loadRepo({ base: head, head: base });
}

/**
 * The base most people mean, if the repository makes it obvious.
 *
 * The remote comes first: a local `main` that has not been pulled in a week
 * is a quietly wrong base, and `origin/main` is what the pull request will be
 * measured against. Never the branch you are on -- comparing a branch with
 * itself is always empty, and offering it as a default would make the first
 * click of the feature look broken.
 */
function defaultBase() {
  const refs = currentRefs;
  if (!refs) return null;

  const known = new Set([...refs.branches, ...refs.remotes].map(ref => ref.name));
  const candidates = ['origin/main', 'main', 'origin/master', 'master', 'origin/develop', 'develop'];
  return candidates.find(name => known.has(name) && name !== refs.current) ?? null;
}

/**
 * Open the compare row. With an obvious base, compare straight away: one
 * click to the view a pull request would give you. Without one, show the
 * pickers and wait -- a guessed comparison nobody asked for is worse than
 * asking.
 */
function openCompare() {
  document.getElementById('compareRow').classList.remove('hidden');
  const head = currentRefs?.current ?? 'HEAD';
  const base = defaultBase();

  if (base) {
    loadRepo({ base, head });
    return;
  }

  selectRef('base', null, null);
  selectRef('head', head, null);
  document.getElementById('compareToggle').classList.add('hidden');
  document.getElementById('scopeResetBtn').classList.remove('hidden');
  document.getElementById(PICKERS.base.select).focus();
}

/** Back to the default scope: uncommitted changes, or the last commit. */
function resetScope() {
  document.getElementById('compareRow').classList.add('hidden');
  loadRepo();
}

/**
 * Say what the review is of, in the names the reviewer used.
 *
 * Built from DOM nodes rather than markup: branch names are chosen by
 * whoever made the repository, and one may legally contain `<`.
 *
 * @param {{mode: string, range: ?object, files: object[]}} data
 */
function renderScope(data) {
  const bar = document.getElementById('scopeBar');
  const label = document.getElementById('scopeLabel');
  const meta = document.getElementById('scopeMeta');
  const note = document.getElementById('scopeNote');
  const row = document.getElementById('compareRow');
  const toggle = document.getElementById('compareToggle');
  const reset = document.getElementById('scopeResetBtn');

  const strong = text => {
    const el = document.createElement('strong');
    el.textContent = text;
    return el;
  };
  const setNote = (text, { message = false } = {}) => {
    note.textContent = text ?? '';
    note.classList.toggle('hidden', !text);
    // A commit message keeps its line breaks; an explanation reflows.
    note.classList.toggle('scope-note-message', Boolean(text) && message);
  };

  const nav = document.getElementById('commitNav');
  const position = document.getElementById('commitPosition');
  const allCommits = document.getElementById('allCommitsBtn');
  nav.classList.add('hidden');
  allCommits.classList.add('hidden');
  reset.textContent = 'Stop comparing';

  bar.classList.remove('hidden');
  label.replaceChildren();
  const branch = currentRefs?.current;

  if (data.mode === 'range' && data.range?.kind === 'commits') {
    // One commit, or a run of them, picked from the commits list.
    const run = data.range;
    const single = run.first === run.last;
    const chrono = chronologicalCommits(commitContext);
    const index = chrono.findIndex(commit => commit.sha === run.first);
    const commit = single && index !== -1 ? chrono[index] : null;
    const files = plural(data.files.length, 'file') + ' changed';

    if (single) {
      label.append('Commit ', strong(run.headName));
    } else {
      label.append(strong(run.baseName), ' \u2026 ', strong(run.headName));
    }

    const inComparison = commitContext?.kind === 'comparison';
    if (inComparison) {
      const outer = commitContext.range;
      label.append(' in ', strong(displayRef(outer.baseName ?? outer.base)), ' \u2192 ',
        strong(displayRef(outer.headName ?? outer.head)));
    } else if (branch) {
      label.append(' on ', strong(branch));
    }

    meta.textContent = single
      ? `${commit?.subject ?? run.subject ?? ''} \u00b7 ${files}`
      : `${plural(run.commits, 'commit')} \u00b7 ${files}`;

    // The message is review material -- often the only place the author says
    // why -- so a single commit shows its body, not just its subject line.
    if (single && commit?.body) {
      setNote(commit.body, { message: true });
    } else if (!single) {
      setNote(`Reviewing ${plural(run.commits, 'commit')} as one combined diff, from ${run.baseName} through ${run.headName}.`);
    } else {
      setNote(null);
    }

    if (single && index !== -1) {
      nav.classList.remove('hidden');
      // "2 of 3" means something inside a comparison; inside a branch's
      // history it would count from wherever the list happened to stop.
      position.textContent = inComparison ? `${index + 1} of ${chrono.length}` : '';
      document.getElementById('prevCommitBtn').disabled = index === 0;
      document.getElementById('nextCommitBtn').disabled = index === chrono.length - 1;
    }

    if (inComparison) {
      row.classList.remove('hidden');
      const outer = commitContext.range;
      selectRef('base', outer.baseName, outer.base);
      selectRef('head', outer.headName, outer.head);
      allCommits.textContent = `All ${plural(chrono.length, 'commit')}`;
      allCommits.classList.remove('hidden');
      toggle.classList.add('hidden');
      reset.classList.remove('hidden');
    } else {
      row.classList.add('hidden');
      toggle.classList.remove('hidden');
      reset.textContent = 'Back to latest';
      reset.classList.remove('hidden');
    }
    return;
  }

  if (data.mode === 'range' && data.range) {
    const range = data.range;
    const base = displayRef(range.baseName ?? range.base);
    const head = displayRef(range.headName ?? range.head);
    const files = data.files.length;

    label.append(strong(base), ' → ', strong(head));
    meta.textContent = files > 0
      ? `${plural(range.commits, 'commit')} · ${plural(files, 'file')} changed`
      : `${plural(range.commits, 'commit')} · no files differ`;

    // The empty cases first: they are the ones that need explaining, and an
    // empty file list with no explanation reads as the tool having failed.
    if (files === 0 && range.commits === 0) {
      setNote(range.behind > 0
        ? `${head} has nothing that ${base} does not already have. Try swapping them to see what ${base} adds.`
        : `${base} and ${head} are the same commit, so there is nothing between them.`);
    } else if (files === 0) {
      setNote(`Those ${plural(range.commits, 'commit')} undo each other: every change in them was reverted again before ${head}, so there is no difference left to review.`);
    } else if (range.behind > 0) {
      // The merge-base diff leaves these out on purpose, the way a pull
      // request does. Say so, or someone goes looking for main's change and
      // concludes the tool lost it.
      setNote(`${base} has ${plural(range.behind, 'newer commit')} that ${range.behind === 1 ? 'is' : 'are'} not on ${head}. ${range.behind === 1 ? 'It is' : 'They are'} left out: this shows only what ${head} changes since the two diverged, as a pull request would.`);
    } else {
      setNote(null);
    }

    row.classList.remove('hidden');
    selectRef('base', range.baseName, range.base);
    selectRef('head', range.headName, range.head);
    toggle.classList.add('hidden');
    reset.classList.remove('hidden');
    return;
  }

  if (data.mode === 'lastCommit') {
    label.append('Last commit');
    if (branch) label.append(' on ', strong(branch));
    const tip = commitContext?.commits?.[0] ?? currentRefs?.commits?.[0];
    meta.textContent = tip ? `${tip.subject} · ${tip.short}` : '';
    setNote(tip?.body || null, { message: true });

    // One click back through history from here -- the first thing someone
    // looking at the last commit is likely to want next.
    if ((commitContext?.commits?.length ?? 0) > 1) {
      nav.classList.remove('hidden');
      position.textContent = '';
      document.getElementById('prevCommitBtn').disabled = false;
      document.getElementById('nextCommitBtn').disabled = true;
    }
  } else {
    label.append('Uncommitted changes');
    if (branch) label.append(' on ', strong(branch));
    meta.textContent = plural(data.files.length, 'file') + ' changed';
    setNote(null);
  }

  row.classList.add('hidden');
  toggle.classList.remove('hidden');
  reset.classList.add('hidden');
}

// --- commits: reviewing them one at a time, or a run of them -----------------

// What the commits list is showing. `comparison` is the commits a Compare is
// made of, oldest first; `history` is the recent history of the branch when
// the view is its last commit, newest first. Null for the working tree, which
// has no commits to list. `range` keeps the outer comparison, so narrowing to
// one commit does not lose what it was a commit *of*.
let commitContext = null;

// Which of those commits the review currently shows, as `{from, to}` shas,
// oldest first; null for all of them.
let commitSelection = null;

// The commit a shift-click extends from.
let commitAnchor = null;

/** The context's commits, oldest first, whichever order the list shows them in. */
function chronologicalCommits(context) {
  if (!context) return [];
  return context.order === 'newest-first' ? [...context.commits].reverse() : context.commits;
}

/**
 * The run between two commits of a list, oldest first -- whichever was
 * clicked first. A shift-click upwards and one downwards select the same run.
 *
 * @param {{sha: string}[]} chronological commits, oldest first
 * @returns {[string, string]|null} [from, to]
 */
function orderedRun(chronological, a, b) {
  const i = chronological.findIndex(commit => commit.sha === a);
  const j = chronological.findIndex(commit => commit.sha === b);
  if (i === -1 || j === -1) return null;
  return i <= j
    ? [chronological[i].sha, chronological[j].sha]
    : [chronological[j].sha, chronological[i].sha];
}

/**
 * Where a step lands, or -1 if there is nowhere to go.
 *
 * From "all commits" a step forward starts at the oldest -- the beginning of
 * the story -- and a step back starts at the newest. Stepping never wraps:
 * reaching the end of a branch and silently landing on its first commit
 * again reads as the list having started over.
 *
 * @param {number} length
 * @param {number} current index of the one commit shown, or -1 if not one
 * @param {1|-1} direction +1 newer, -1 older
 */
function stepIndex(length, current, direction) {
  if (length === 0) return -1;
  if (current === -1) return direction > 0 ? 0 : length - 1;
  const next = current + direction;
  return next >= 0 && next < length ? next : -1;
}

/**
 * "3 hours ago" as "3h", for a list where the subject needs the width.
 *
 * Git's relative dates are written for a sentence, and in a 320px sidebar
 * "2 seconds ago" took more room than the commit subject beside it. The full
 * phrase stays in the row's tooltip. Anything not recognised is returned as
 * it came, rather than guessed at.
 *
 * @param {string} when git's %cr, e.g. "3 weeks ago" or "1 year, 2 months ago"
 */
function compactWhen(when) {
  const match = /^(\d+) (second|minute|hour|day|week|month|year)s?(?:, .*)? ago$/.exec(when ?? '');
  if (!match) return when ?? '';
  const unit = { second: 's', minute: 'm', hour: 'h', day: 'd', week: 'w', month: 'mo', year: 'y' }[match[2]];
  return `${match[1]}${unit}`;
}

/** Fetch a commits list for the context the review is in. */
async function fetchCommitContext(repoId, kind, { base, head, range }) {
  const query = new URLSearchParams({ head });
  if (base) query.set('base', base);

  try {
    const response = await fetch(`${API_BASE}/log/${repoId}?${query}`);
    if (!response.ok) return null;
    const log = await response.json();
    return { kind, base, head, range, ...log };
  } catch {
    return null;
  }
}

/**
 * Decide what the commits list shows after a load.
 *
 * A load that narrows to commits keeps the list it narrowed from; anything
 * else rebuilds it. The branch history offered with "last commit" is the same
 * gesture as a comparison's commits: this is where "review the changes since
 * that commit", which 2.11 had as a dropdown and 2.12 buried under forty
 * branches, lives now.
 */
async function refreshCommitContext(data, scope) {
  if (scope.commits && commitContext) {
    commitSelection = { from: data.range.first, to: data.range.last };
    return;
  }

  commitAnchor = null;
  commitSelection = null;

  if (data.mode === 'range' && data.range) {
    commitContext = await fetchCommitContext(data.repoId, 'comparison', {
      base: data.range.base, head: data.range.head, range: data.range
    });
  } else if (data.mode === 'lastCommit' && data.range) {
    commitContext = await fetchCommitContext(data.repoId, 'history', { head: data.range.head });
    // The last commit is itself one of the listed commits, so it is shown as
    // the selected one, and shift-clicking further down selects "since then".
    commitSelection = { from: data.range.head, to: data.range.head };
    commitAnchor = data.range.head;
  } else {
    commitContext = null;
  }
}

/** Draw the commits list, marking the ones the review is of. */
function renderCommitList() {
  const section = document.getElementById('commitsSection');
  const list = document.getElementById('commitsList');
  const title = document.getElementById('commitsTitle');
  const count = document.getElementById('commitCount');
  const truncated = document.getElementById('commitsTruncated');

  if (!commitContext || commitContext.commits.length === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');
  title.textContent = commitContext.kind === 'comparison'
    ? 'Commits in this comparison'
    : `Recent commits${currentRefs?.current ? ` on ${currentRefs.current}` : ''}`;
  count.textContent = String(commitContext.total);
  truncated.classList.toggle('hidden', !commitContext.truncated);
  truncated.textContent = commitContext.truncated
    ? `Showing ${commitContext.commits.length} of ${commitContext.total}. Anything further back is still reachable by typing it into Compare.`
    : '';

  // Which rows are in the review: everything from `from` to `to` in time,
  // or every row when there is no selection.
  const chrono = chronologicalCommits(commitContext);
  const inRun = new Set();
  if (commitSelection) {
    const i = chrono.findIndex(c => c.sha === commitSelection.from);
    const j = chrono.findIndex(c => c.sha === commitSelection.to);
    if (i !== -1 && j !== -1) chrono.slice(Math.min(i, j), Math.max(i, j) + 1).forEach(c => inRun.add(c.sha));
  } else {
    chrono.forEach(c => inRun.add(c.sha));
  }

  // Built from nodes: subjects and author names are whatever the repository
  // says, and they are shown, never parsed as markup.
  const rows = commitContext.commits.map(commit => {
    const item = document.createElement('li');
    item.className = 'commit-item';
    item.dataset.sha = commit.sha;
    item.tabIndex = 0;
    item.setAttribute('role', 'option');
    const selected = inRun.has(commit.sha) && commitSelection !== null;
    item.setAttribute('aria-selected', String(selected));
    if (selected) item.classList.add('commit-item-selected');
    item.title = `${commit.subject}\n${commit.short} · ${commit.author} · ${commit.when}${commit.merge ? ' · merge' : ''}`;

    const sha = document.createElement('span');
    sha.className = 'commit-sha';
    sha.textContent = commit.short;
    const subject = document.createElement('span');
    subject.className = 'commit-subject';
    subject.textContent = commit.subject;
    const when = document.createElement('span');
    when.className = 'commit-when';
    when.textContent = compactWhen(commit.when);

    item.append(sha, subject);
    if (commit.merge) {
      const merge = document.createElement('span');
      merge.className = 'commit-merge';
      merge.textContent = 'merge';
      item.append(merge);
    }
    item.append(when);
    return item;
  });
  list.replaceChildren(...rows);

  const current = list.querySelector('.commit-item-selected');
  if (current) current.scrollIntoView({ block: 'nearest' });
}

/**
 * Review one commit, or -- with shift -- the run from the anchor to it.
 *
 * @param {string} sha
 * @param {boolean} extend
 */
function selectCommit(sha, extend) {
  if (!commitContext) return;

  if (extend && commitAnchor) {
    const run = orderedRun(chronologicalCommits(commitContext), commitAnchor, sha);
    if (run) loadRepo({ commits: { from: run[0], to: run[1] } });
    return;
  }

  commitAnchor = sha;
  loadRepo({ commits: { from: sha, to: sha } });
}

/** Step one commit older (-1) or newer (+1): commit-by-commit review. */
function stepCommit(direction) {
  if (!commitContext) return;
  const chrono = chronologicalCommits(commitContext);
  const single = commitSelection && commitSelection.from === commitSelection.to
    ? chrono.findIndex(c => c.sha === commitSelection.from)
    : -1;
  const next = stepIndex(chrono.length, single, direction);
  if (next !== -1) selectCommit(chrono[next].sha, false);
}

/** Back from one commit to the whole comparison it was part of. */
function showAllCommits() {
  if (commitContext?.kind !== 'comparison') return;
  // By the names that were picked, so the bar still says main -> feature/auth
  // rather than two SHAs.
  const { range } = commitContext;
  loadRepo({ base: range.baseName ?? range.base, head: range.headName ?? range.head });
}

/** Empty the diff pane, so a finished comparison cannot leave the last one's file on screen. */
function clearCodePane() {
  currentFile = null;
  currentDiffLines = [];
  document.getElementById('codeSection').classList.add('hidden');
  document.getElementById('currentFile').textContent = '';
}

/** What the file list says when a comparison has no files in it. */
function showEmptyFileList(message) {
  const filesList = document.getElementById('filesList');
  const empty = document.createElement('div');
  empty.className = 'files-empty';
  empty.textContent = message;
  filesList.replaceChildren(empty);
}

/**
 * Load a repository, optionally as a range between two commits.
 *
 * @param {{base?: string, head?: string, commits?: {from: string, to: string}}} [scope]
 *   omit for the default: uncommitted changes, falling back to the last
 *   commit on a clean tree. `base`/`head` compare two refs from their merge
 *   base; `commits` reviews one commit or an unbroken run of them, inclusive.
 */
async function loadRepo(scope = {}) {
  const repoPath = document.getElementById('repoPath').value.trim();

  if (!repoPath) {
    showStatus('Please enter a repository path', 'error');
    return;
  }

  showStatus('Loading repository...', 'loading');
  document.getElementById('loadBtn').disabled = true;

  try {
    const response = await fetch(`${API_BASE}/load-repo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        scope.commits ? { repoPath, commits: scope.commits }
          : scope.base ? { repoPath, base: scope.base, ...(scope.head ? { head: scope.head } : {}) }
            : { repoPath }
      )
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to load repository');
    }

    currentRepoId = data.repoId;
    currentFiles = data.files;

    // The server answers with the root of the working tree, which is not
    // always what was asked for: open a subdirectory and the repository above
    // it is what gets reviewed. Show the path that is actually loaded.
    if (data.repoPath) {
      document.getElementById('repoPath').value = data.repoPath;
      setRepoButton(data.repoPath);
    }

    // In this order: the commits list first, because it decides which head
    // the pickers' commits should follow; the refs next, because renderScope
    // needs the options present to select the current ends among them and
    // the current branch to name it; then the bar and the list.
    await refreshCommitContext(data, scope);
    await loadRefs(data.repoId, commitContext?.head ?? data.range?.head);
    renderScope(data);
    renderCommitList();

    if (data.files.length === 0) {
      // A range with no files is a real answer, not a failure: every change
      // in it was undone again before the far end. The server says so in
      // `message`, and the scope bar above is still showing how many commits
      // that covers -- so this is information, not an error, and it must not
      // be dressed as one.
      if (data.mode === 'range') {
        // The scope bar is already explaining this; a status line repeating
        // it underneath is two bars saying one thing.
        clearStatus();
        hidePicker();
        displayFiles([]);
        showEmptyFileList(data.range?.kind !== 'commits'
          ? 'No files differ between these two.'
          : data.range.first === data.range.last
            ? 'This commit changes no files.'
            : 'These commits change no files between them.');
        updateCommentsSidebar();
        // Or the previous comparison's file stays on screen under a bar that
        // says there are no files, and reads as part of this one.
        clearCodePane();
        document.getElementById('loadBtn').disabled = false;
        return;
      }

      showStatus('No uncommitted changes found in the repository', 'error');
      document.getElementById('loadBtn').disabled = false;
      return;
    }

    // The scope bar above says what was loaded, in more useful terms than
    // this line did ("Found 3 changed file(s)"), so there is nothing left
    // for the status line to add on success.
    clearStatus();
    hidePicker();
    displayFiles(data.files);
    // Which comments are in view depends on which files are, so the sidebar
    // is redrawn for every new scope, not only when saved comments arrive.
    updateCommentsSidebar();

    // Load saved comments
    const savedComments = await loadCommentsFromBackend();
    if (savedComments.length > 0) {
      // These went into `window.savedComments` as well, as a second copy for
      // the matcher to read. Nothing reads it now, and leaving a stale copy of
      // the review lying around is how the resurrection happened in the first
      // place -- so there is one list, and it is this one.

      // Add all saved comments to the comments array immediately
      comments = savedComments.map(c => ({
        ...c,
        diffLineIndex: null, // Will be updated when file is loaded
        matchType: c.matchType || 'exact'
      }));

      // Show comments sidebar immediately
      updateCommentsSidebar();

      showStatus(`Picked up ${plural(savedComments.length, 'saved comment')} from last time.`, 'success');
    }

    // Open something. A loaded repository used to sit behind an empty pane
    // until a file was clicked, which reads as a failure rather than as a
    // result (#47). Done here rather than in `displayFiles` because the saved
    // comments have to be in hand first, or the diff renders without them.
    //
    // The file already open wins if it is still in the list, so reloading a
    // repository does not move you off what you were reading.
    if (currentFiles.length > 0) {
      const previous = currentFiles.findIndex(file => file.path === currentFile);
      const opening = previous === -1 ? 0 : previous;

      loadFile(currentFiles[opening].path, opening);
      offerHelpOnce();
    }

  } catch (error) {
    showStatus(`Error: ${error.message}`, 'error');
    showPicker();
  } finally {
    document.getElementById('loadBtn').disabled = false;
  }
}

// Display list of changed files
/** What each status letter means, for the badge's tooltip and screen readers. */
const FILE_STATUS_NAMES = {
  A: 'Added',
  M: 'Modified',
  D: 'Deleted',
  R: 'Renamed',
  B: 'Binary'
};

function fileStatusClass(status) {
  switch (status) {
    case 'A': return 'file-status-added';
    case 'D': return 'file-status-deleted';
    case 'R': return 'file-status-renamed';
    case 'B': return 'file-status-binary';
    case 'M':
    default: return 'file-status-modified';
  }
}

function displayFiles(files) {
  const sidebar = document.getElementById('sidebar');
  const filesList = document.getElementById('filesList');
  const fileCount = document.getElementById('fileCount');
  const submitBtn = document.getElementById('submitReviewBtn');
  const resizeHandle = document.getElementById('resizeHandle');

  filesList.innerHTML = files.map((fileObj, index) => {
    const file = fileObj.path;
    const status = fileObj.status;
    const parts = file.split('/');
    const filename = parts[parts.length - 1];
    const path = parts.slice(0, -1).join('/');

    // Because of RTL, we need to reverse the order in HTML. The label is
    // markup -- the name is split so the last segment can be emphasised -- so
    // both halves are escaped going in. They were not, and a name is chosen by
    // whatever repository is open: markup in one was drawn as markup, without
    // anyone clicking anything.
    const displayText = path
      ? `${escapeHtml(path)}/<span class="filename">${escapeHtml(filename)}</span>`
      : `<span class="filename">${escapeHtml(filename)}</span>`;
    const statusClass = fileStatusClass(status);
    // One letter is git's vocabulary, not everyone's. The name rides along as
    // a tooltip and as the accessible label, so "D" is never the only thing
    // saying that a file is gone. `status` is one of five letters the server
    // produces, and escaped anyway: it is data that ends up in markup.
    const statusName = FILE_STATUS_NAMES[status] ?? 'Changed';
    const statusBadge = `<span class="file-status ${statusClass}" title="${statusName}" aria-label="${statusName}">${escapeHtml(status)}</span>`;

    // The row used to carry the file name itself, inside a string literal
    // inside the attribute the browser evaluates as JavaScript. A name with a
    // quote in it ended that literal and the rest of the name ran on click
    // (#46). Escaping cannot close it: entities in an attribute are decoded
    // before the handler is parsed, so an escaped quote is a quote again by
    // the time it matters. The row carries its position instead, and the name
    // is read back out of `currentFiles`, where it stays data.
    // The count is filled in by `updateFileCommentCounts`, not here. Rendering
    // it now would mean re-rendering this list on every comment to keep it
    // true, and re-rendering the list is what loses the selected row.
    return `<div class="file-item" onclick="openFileAt(${Number(index)})" title="${escapeHtml(file)}">
      ${statusBadge}<span class="file-path-text">${displayText}</span>
      <span class="file-comment-count" data-file-index="${Number(index)}" hidden></span>
    </div>`;
  }).join('');

  fileCount.textContent = `${files.length} file${files.length !== 1 ? 's' : ''}`;
  sidebar.classList.remove('hidden');
  resizeHandle.classList.remove('hidden');
  submitBtn.classList.remove('hidden');

  // Update comments sidebar
  updateCommentsSidebar();
}

/**
 * Open the file at a position in the list. The handler the file rows carry.
 *
 * `loadFile` still takes a path, because every other caller already has one in
 * hand and none of them travels through an attribute. This one does, so it
 * takes the index and looks the path up here. See the note in `displayFiles`.
 *
 * @param {number} index position in `currentFiles`
 */
function openFileAt(index) {
  const file = currentFiles[Number(index)];
  if (!file) return;

  loadFile(file.path, Number(index));
}

// Load file content
async function loadFile(filePath, index) {
  if (!currentRepoId) return Promise.resolve();

  currentFile = filePath;
  currentFileIndex = index; // Track for keyboard navigation

  // Reset full context mode when switching files
  isFullContextMode = false;
  storedFullFileLines = null;

  // Update active file highlight and scroll into view
  document.querySelectorAll('.file-item').forEach((el, i) => {
    el.classList.toggle('active', i === index);
    if (i === index) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });

  try {
    const response = await fetch(`${API_BASE}/file/${currentRepoId}/${filePath}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to load file');
    }

    // Give this file's comments their position in the diff just rendered.
    //
    // The source here used to be `window.savedComments`, a snapshot taken when
    // the repository was opened and never updated again. Everything else works
    // from `comments`, the live list -- so a comment you deleted was still in
    // the snapshot, was not found in the live list, and the branch below added
    // it straight back. It vanished from disk and reappeared on screen, and
    // the next save wrote the resurrected copy back over the deletion. Editing
    // one did the same thing by a different route: the text no longer matched,
    // so the pre-edit copy was added alongside the edited one (#52).
    //
    // `comments` is what exists. A comment that is not in it does not exist.
    if (comments.length > 0) {
      const matchedComments = matchCommentsToDiff(comments, filePath, data.diffLines);

      // Update existing comments in the array with matched diff indices
      matchedComments.forEach(mc => {
        const existing = comments.find(c =>
          c.file === mc.file &&
          c.line === mc.line &&
          c.text === mc.text
        );

        if (existing) {
          // Update existing comment with new diff line index and match type
          existing.diffLineIndex = mc.diffLineIndex;
          existing.matchType = mc.matchType;
          existing.newLineContent = mc.newLineContent;
          // Preserve followUps from saved data
          if (mc.followUps) {
            existing.followUps = mc.followUps;
          }
        } else {
          // Unreachable now that the matcher is fed the live list: everything
          // it returns came from there. Kept as a guard rather than removed,
          // because silently dropping a comment is the worse failure of the
          // two, and this is the line that would do it.
          // Add new comment if it doesn't exist
          comments.push({
            file: mc.file,
            diffLineIndex: mc.diffLineIndex,
            line: mc.line,
            lineContent: mc.lineContent,
            selectedText: mc.selectedText,
            text: mc.text,
            matchType: mc.matchType,
            newLineContent: mc.newLineContent,
            followUps: mc.followUps || []
          });
        }
      });

      // Update comments sidebar after matching comments
      updateCommentsSidebar();
    }

    displayCode(data.filePath, data.diffLines, data.binary);
    updateFullContextButton();
    return Promise.resolve();

  } catch (error) {
    showStatus(`Error loading file: ${error.message}`, 'error');
    return Promise.reject(error);
  }
}

// Display code with diff highlighting
function displayCode(filePath, diffLines, binary) {
  const codeSection = document.getElementById('codeSection');
  const currentFileEl = document.getElementById('currentFile');
  const codeViewer = document.getElementById('codeViewer');

  currentFileEl.textContent = filePath;
  currentDiffLines = diffLines; // Store for reference when adding comments

  // A binary file has no lines to show and none to comment on. Saying so is
  // the whole feature: it used to be decoded as UTF-8 and rendered as
  // mojibake, and a comment left on one of those lines exported an anchor
  // that could never match the file again.
  if (binary) {
    codeSection.style.display = 'block';
    codeViewer.innerHTML =
      '<div class="binary-notice">Binary file &mdash; not shown.' +
      '<span>git reports this file as binary, so there are no lines to ' +
      'review. Comments need a line to anchor to.</span></div>';
    return;
  }

  const fileComments = comments.filter(c => c.file === filePath);

  let html = '';
  diffLines.forEach((diffLine, index) => {
    // Use diffLineIndex to uniquely identify each line in the diff
    const diffLineIndex = index;
    const hasComment = fileComments.find(c => c.diffLineIndex === diffLineIndex);

    const lineClass = `line diff-${diffLine.type} ${hasComment ? 'commented' : ''}`;

    // Use the appropriate line number for clicking (newLine for add/unchanged, oldLine for delete)
    const clickableLineNum = diffLine.newLine || diffLine.oldLine;

    // Make both old and new line numbers clickable
    // `Number(...)` at every interpolation into a handler, here and below. The
    // rule the page now keeps is that nothing but a number goes into an
    // attribute the browser evaluates as code, and coercing it where it is
    // written makes that true of the markup rather than true of whatever the
    // caller happened to pass. See `displayFiles` and #46.
    const oldLineClick = diffLine.type === 'delete' ? `onclick="toggleCommentInput(${Number(diffLineIndex)})"` : '';
    const newLineClick = diffLine.type !== 'delete' ? `onclick="toggleCommentInput(${Number(diffLineIndex)})"` : '';

    html += `
      <div class="${lineClass}" tabindex="0" data-diff-index="${diffLineIndex}">
        ${hasComment ? '<span class="comment-indicator"></span>' : ''}
        <div class="line-numbers">
          <span class="old-line-number" ${oldLineClick}>${diffLine.oldLine || ''}</span>
          <span class="new-line-number" ${newLineClick}>${diffLine.newLine || ''}</span>
        </div>
        <div class="line-content">${escapeHtml(diffLine.content) || ' '}</div>
      </div>
    `;

    if (hasComment) {
      const matchTypeClass = hasComment.matchType === 'fuzzy' ? 'comment-box-fuzzy' : '';
      const fuzzyWarning = hasComment.matchType === 'fuzzy' ? `
        <div class="comment-fuzzy-warning">
          ⚠️ Code changed - comment anchored to similar line
          ${hasComment.newLineContent !== hasComment.lineContent ? `<div class="comment-original-code">Original: <code>${escapeHtml(hasComment.lineContent)}</code></div>` : ''}
        </div>
      ` : '';

      // Generate follow-ups HTML
      let followUpsHtml = '';
      if (hasComment.followUps && hasComment.followUps.length > 0) {
        followUpsHtml = '<div class="comment-followups">';
        hasComment.followUps.forEach((followUp, idx) => {
          const timestamp = followUp.timestamp ? new Date(followUp.timestamp).toLocaleString() : '';
          followUpsHtml += `
            <div class="comment-followup-item">
              <span class="followup-text">${escapeHtml(followUp.text)}</span>
              ${timestamp ? `<span class="followup-timestamp">${timestamp}</span>` : ''}
            </div>
          `;
        });
        followUpsHtml += '</div>';
      }

      html += `
        <div class="comment-box ${matchTypeClass}">
          ${fuzzyWarning}
          <span class="comment-text">${escapeHtml(hasComment.text)}</span>
          ${followUpsHtml}
          <div class="comment-actions">
            <button class="comment-reply" onclick="addFollowUp(${Number(diffLineIndex)})">Reply</button>
            <button class="comment-edit" onclick="editComment(${Number(diffLineIndex)})">Edit</button>
            <button class="comment-delete" onclick="deleteComment(${Number(diffLineIndex)})">Delete</button>
          </div>
        </div>
      `;
    }
  });

  // Show unmatched comments at the end
  const unmatchedComments = fileComments.filter(c => c.matchType === 'unmatched');
  unmatchedShown = unmatchedComments;
  if (unmatchedComments.length > 0) {
    html += '<div class="unmatched-comments-section">';
    unmatchedComments.forEach((comment, unmatchedIndex) => {
      // Generate follow-ups for unmatched comments
      let unmatchedFollowUpsHtml = '';
      if (comment.followUps && comment.followUps.length > 0) {
        unmatchedFollowUpsHtml = '<div class="comment-followups">';
        comment.followUps.forEach((followUp, idx) => {
          const timestamp = followUp.timestamp ? new Date(followUp.timestamp).toLocaleString() : '';
          unmatchedFollowUpsHtml += `
            <div class="comment-followup-item">
              <span class="followup-text">${escapeHtml(followUp.text)}</span>
              ${timestamp ? `<span class="followup-timestamp">${timestamp}</span>` : ''}
            </div>
          `;
        });
        unmatchedFollowUpsHtml += '</div>';
      }

      // Every control in here used to carry the comment's file name and text,
      // quoted into an attribute that is evaluated as JavaScript -- with `'`
      // replaced by `\'` and nothing else, which a name ending in a backslash
      // walks straight out of. They carry the row's position instead, and the
      // three fields are read back from `unmatchedShown`, the array this was
      // rendered from. The row's random id went with it: the position is the
      // identifier now.
      html += `
        <div class="unmatched-comment-item collapsed" tabindex="0">
          <div class="unmatched-comment-header" onclick="toggleUnmatchedComment(${Number(unmatchedIndex)})">
            <span class="unmatched-comment-icon">⚠️</span>
            <span class="unmatched-comment-title">Comment not found (Line ${comment.line} changed)</span>
            <span class="unmatched-comment-toggle">▶</span>
          </div>
          <div class="unmatched-comment-body">
            <div class="unmatched-comment-original">
              <strong>Original line:</strong>
              <code>${escapeHtml(comment.lineContent)}</code>
            </div>
            <div class="comment-text">${escapeHtml(comment.text)}</div>
            ${comment.selectedText ? `<div class="comment-item-selected">${escapeHtml(comment.selectedText)}</div>` : ''}
            ${unmatchedFollowUpsHtml}
            <div class="comment-actions">
              <button class="comment-reply" onclick="addFollowUpToUnmatched(${Number(unmatchedIndex)})">Reply</button>
              <button class="comment-delete" onclick="deleteUnmatchedComment(${Number(unmatchedIndex)})">Delete</button>
            </div>
          </div>
        </div>
      `;
    });
    html += '</div>';
  }

  codeViewer.innerHTML = html;
  codeSection.classList.remove('hidden');

  // Add text selection handler
  codeViewer.removeEventListener('mousedown', trackShiftKeyDown);
  codeViewer.removeEventListener('mouseup', handleTextSelection);
  codeViewer.addEventListener('mousedown', trackShiftKeyDown);
  codeViewer.addEventListener('mouseup', handleTextSelection);
}

/**
 * The unmatched comments the code pane is showing, in the order they were
 * drawn. The rows below are identified by their position in here, because the
 * fields that used to identify them -- a file name and the comment's own text
 * -- cannot be written into a handler attribute safely. See #46.
 *
 * @type {object[]}
 */
let unmatchedShown = [];

/**
 * The row an unmatched comment was drawn into.
 *
 * @param {number} index position in `unmatchedShown`
 * @returns {Element|null}
 */
function unmatchedRow(index) {
  return document.querySelectorAll('.unmatched-comment-item')[Number(index)] ?? null;
}

// Toggle unmatched comment expansion
function toggleUnmatchedComment(index) {
  const element = unmatchedRow(index);
  if (!element) return;

  element.classList.toggle('collapsed');
  const toggle = element.querySelector('.unmatched-comment-toggle');
  if (toggle) {
    toggle.textContent = element.classList.contains('collapsed') ? '▶' : '▼';
  }
}

// Delete unmatched comment
function deleteUnmatchedComment(index) {
  const target = unmatchedShown[Number(index)];
  if (!target) return;

  const { file, line, text } = target;
  comments = comments.filter(c => !(c.file === file && c.line === line && c.text === text));

  // Auto-save to backend
  saveCommentsToBackend();

  // Update comments sidebar
  updateCommentsSidebar();

  // Reload the current file to remove the comment
  if (currentFile === file) {
    const fileIndex = currentFiles.findIndex(f => f.path === file);
    loadFile(file, fileIndex);
  }
}

// Add follow-up to a regular comment
function addFollowUp(diffLineIndex) {
  // Remove any existing follow-up input
  const existingInput = document.querySelector('.followup-input-box');
  if (existingInput) {
    existingInput.remove();
  }

  // Find the comment box
  const lineEl = document.querySelector(`.line[data-diff-index="${diffLineIndex}"]`);
  if (!lineEl) return;

  const commentBox = lineEl.nextElementSibling;
  if (!commentBox || !commentBox.classList.contains('comment-box')) return;

  // Create follow-up input
  const inputBox = document.createElement('div');
  inputBox.className = 'followup-input-box';
  inputBox.innerHTML = `
    <textarea placeholder="Enter your follow-up (Cmd/Ctrl+Enter to save)..." id="followupInput"></textarea>
    <div class="actions">
      <button onclick="saveFollowUp(${Number(diffLineIndex)})">Add Follow-up</button>
      <button class="cancel-btn" onclick="this.closest('.followup-input-box').remove()">Cancel</button>
    </div>
  `;

  // Insert after the comment actions
  const actionsDiv = commentBox.querySelector('.comment-actions');
  if (actionsDiv) {
    actionsDiv.after(inputBox);
  }

  const textarea = document.getElementById('followupInput');
  textarea.focus();

  // Auto-resize textarea
  const autoResize = () => {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  };

  textarea.addEventListener('input', autoResize);
  autoResize();

  // Add keyboard shortcuts
  textarea.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      saveFollowUp(diffLineIndex);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      inputBox.remove();
    }
  });
}

// Save follow-up to a regular comment
function saveFollowUp(diffLineIndex) {
  const input = document.getElementById('followupInput');
  const text = input?.value.trim();

  if (!text) {
    showStatus('Please enter a follow-up comment', 'error');
    return;
  }

  const comment = comments.find(c => c.file === currentFile && c.diffLineIndex === diffLineIndex);
  if (!comment) return;

  // Initialize followUps if it doesn't exist
  if (!comment.followUps) {
    comment.followUps = [];
  }

  comment.followUps.push({
    text: text,
    timestamp: new Date().toISOString()
  });

  // Auto-save to backend
  saveCommentsToBackend();

  // Update comments sidebar
  updateCommentsSidebar();

  // Reload the current file to show the follow-up
  const fileIndex = currentFiles.findIndex(f => f.path === currentFile);
  loadFile(currentFile, fileIndex);
}

// Add follow-up to an unmatched comment
function addFollowUpToUnmatched(index) {
  // Remove any existing follow-up input
  const existingInput = document.querySelector('.followup-input-box');
  if (existingInput) {
    existingInput.remove();
  }

  // The row this belongs to, by position. It used to be found by comparing the
  // rendered text against the comment's own text, which picked the wrong row
  // when two unmatched comments on a file said the same thing on the same line.
  const targetItem = unmatchedRow(index);
  if (!targetItem) return;

  const commentBody = targetItem.querySelector('.unmatched-comment-body');
  if (!commentBody) return;

  // Create follow-up input
  const inputBox = document.createElement('div');
  inputBox.className = 'followup-input-box';

  // The input is named after the row, which is one number, so the button that
  // saves it needs to carry nothing but that number. It used to carry the file
  // name, the comment text and a random id, all quoted into the handler.
  const inputId = `followupInput-${Number(index)}`;

  inputBox.innerHTML = `
    <textarea placeholder="Enter your follow-up (Cmd/Ctrl+Enter to save)..." id="${inputId}"></textarea>
    <div class="actions">
      <button onclick="saveFollowUpToUnmatched(${Number(index)})">Add Follow-up</button>
      <button class="cancel-btn" onclick="this.closest('.followup-input-box').remove()">Cancel</button>
    </div>
  `;

  // Insert before the comment actions
  const actionsDiv = commentBody.querySelector('.comment-actions');
  if (actionsDiv) {
    actionsDiv.before(inputBox);
  }

  const textarea = document.getElementById(inputId);
  textarea.focus();

  // Auto-resize textarea
  const autoResize = () => {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  };

  textarea.addEventListener('input', autoResize);
  autoResize();

  // Add keyboard shortcuts
  textarea.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      saveFollowUpToUnmatched(index);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      inputBox.remove();
    }
  });
}

// Save follow-up to an unmatched comment
function saveFollowUpToUnmatched(index) {
  const input = document.getElementById(`followupInput-${Number(index)}`);
  const followUpText = input?.value.trim();

  if (!followUpText) {
    showStatus('Please enter a follow-up comment', 'error');
    return;
  }

  // The row's position, not the three fields that used to be quoted into the
  // button. `unmatchedShown` holds the same objects `comments` does, so the
  // follow-up is pushed onto the comment itself rather than onto a copy.
  const comment = unmatchedShown[Number(index)];
  if (!comment) return;

  // Initialize followUps if it doesn't exist
  if (!comment.followUps) {
    comment.followUps = [];
  }

  comment.followUps.push({
    text: followUpText,
    timestamp: new Date().toISOString()
  });

  // Auto-save to backend
  saveCommentsToBackend();

  // Update comments sidebar
  updateCommentsSidebar();

  // Reload the current file to show the follow-up
  if (currentFile === comment.file) {
    const fileIndex = currentFiles.findIndex(f => f.path === comment.file);
    loadFile(comment.file, fileIndex);
  }
}

// Track command key state during selection
let commandKeyPressed = false;

// Track command key on mousedown
function trackShiftKeyDown(e) {
  commandKeyPressed = e.metaKey;
}

// Handle text selection in code viewer
function handleTextSelection(e) {
  const selection = window.getSelection();
  const rawSelectedText = selection.toString().trim();

  if (!rawSelectedText) {
    commandKeyPressed = false;
    return;
  }

  // Only trigger comment input if Command key was held during selection
  if (!commandKeyPressed) {
    commandKeyPressed = false;
    return;
  }

  // Reset command key tracking
  commandKeyPressed = false;

  // Extract only the code content, excluding line numbers
  const range = selection.getRangeAt(0);
  const container = document.createElement('div');
  container.appendChild(range.cloneContents());

  // Remove all line numbers from the cloned selection
  const lineNumbers = container.querySelectorAll('.line-numbers, .old-line-number, .new-line-number');
  lineNumbers.forEach(el => el.remove());

  // Extract text from each .line-content separately to avoid extra whitespace
  const lineContents = container.querySelectorAll('.line-content');
  let selectedText = '';

  if (lineContents.length > 0) {
    // Get text from each line-content and join with single newlines
    const lines = Array.from(lineContents).map(el => el.textContent);
    selectedText = lines.join('\n').trim();
  } else {
    // Fallback to full textContent if no line-content elements found
    selectedText = container.textContent.trim();
  }

  if (!selectedText) {
    selection.removeAllRanges();
    return;
  }

  // Find the line element where selection ends
  let targetElement = selection.focusNode;

  // Traverse up to find the line element
  while (targetElement && !targetElement.classList?.contains('line')) {
    targetElement = targetElement.parentElement;
  }

  if (!targetElement) {
    selection.removeAllRanges();
    return;
  }

  const diffLineIndex = parseInt(targetElement.dataset.diffIndex);
  if (diffLineIndex === undefined || isNaN(diffLineIndex)) {
    selection.removeAllRanges();
    return;
  }

  // Clear selection
  selection.removeAllRanges();

  // Show comment input with selected text
  toggleCommentInputWithSelection(diffLineIndex, selectedText);
}

/**
 * The selected code, as an attribute on the button that saves it.
 *
 * The save button used to carry the selection inside a template literal inside
 * its handler, which is a JavaScript context: a `${` in the selected code
 * opened an interpolation and ran whatever followed it, and the file being
 * reviewed is where that code comes from. The selection is not an index into
 * anything -- it is a fragment of a live selection -- so it travels as data on
 * the element and the handler reads it back at click time. A `data-` attribute
 * is an attribute and nothing more; `escapeHtml` is enough for it, and the
 * browser hands the original string back through `dataset`.
 *
 * @param {string|null} selectedText
 * @returns {string} an attribute to splice into the tag, or nothing
 */
function selectedTextData(selectedText) {
  return selectedText ? ` data-selected-text="${escapeHtml(selectedText)}"` : '';
}

// Toggle comment input
function toggleCommentInput(diffLineIndex) {
  toggleCommentInputWithSelection(diffLineIndex, null);
}

// Toggle comment input with optional selected text
function toggleCommentInputWithSelection(diffLineIndex, selectedText = null) {
  const existing = document.querySelector('.comment-input-box');
  if (existing) {
    existing.remove();
  }

  // Check if comment already exists
  if (comments.find(c => c.file === currentFile && c.diffLineIndex === diffLineIndex)) {
    return;
  }

  const lineEl = document.querySelector(`.line[data-diff-index="${diffLineIndex}"]`);
  const inputBox = document.createElement('div');
  inputBox.className = 'comment-input-box';

  // Show selected text if available
  const selectedTextHtml = selectedText
    ? `<div class="selected-text-preview">
         <strong>Selected code:</strong>
         <pre>${escapeHtml(selectedText)}</pre>
       </div>`
    : '';

  inputBox.innerHTML = `
    ${selectedTextHtml}
    <textarea placeholder="Enter your comment (Cmd/Ctrl+Enter to save)..." id="commentInput"></textarea>
    <div class="actions">
      <button${selectedTextData(selectedText)} onclick="saveComment(${Number(diffLineIndex)}, this.dataset.selectedText ?? null)">Save Comment</button>
      <button class="cancel-btn" onclick="this.closest('.comment-input-box').remove()">Cancel</button>
    </div>
  `;

  lineEl.after(inputBox);
  const textarea = document.getElementById('commentInput');
  textarea.focus();

  // Auto-resize textarea
  const autoResize = () => {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  };

  textarea.addEventListener('input', autoResize);
  autoResize(); // Initial resize

  // Add keyboard shortcuts
  textarea.addEventListener('keydown', (e) => {
    // Cmd/Ctrl+Enter to save
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      saveComment(diffLineIndex, selectedText);
    }
    // Escape to close
    if (e.key === 'Escape') {
      e.preventDefault();
      inputBox.remove();
    }
  });
}

// Save comment
function saveComment(diffLineIndex, selectedText = null) {
  const input = document.getElementById('commentInput');
  const text = input.value.trim();

  if (!text) {
    showStatus('Please enter a comment', 'error');
    return;
  }

  // Find the diff line
  const diffLine = currentDiffLines[diffLineIndex];
  if (!diffLine) return;

  const lineContent = diffLine.content || '';
  const lineNum = diffLine.newLine || diffLine.oldLine;

  comments.push({
    file: currentFile,
    diffLineIndex: diffLineIndex,
    line: lineNum,
    lineContent: lineContent,
    selectedText: selectedText,
    text: text,
    matchType: 'exact', // New comments are exact matches
    followUps: [] // Initialize empty follow-ups array
  });

  // Auto-save to backend
  saveCommentsToBackend();

  // Update comments sidebar
  updateCommentsSidebar();

  // Reload the current file to show the new comment
  const fileIndex = currentFiles.findIndex(f => f.path === currentFile);
  loadFile(currentFile, fileIndex);
}

// Edit comment
function editComment(diffLineIndex) {
  const comment = comments.find(c => c.file === currentFile && c.diffLineIndex === diffLineIndex);
  if (!comment) return;

  // The Edit button used to hand the selected code back in as an argument,
  // quoted into its own handler -- and after `escapeHtml` learned to escape
  // quotes, the hand-rolled backslash escaping beside it stopped matching
  // anything at all, so a quote in the selected code ended the literal and the
  // rest ran. The comment is looked up here anyway; the selection comes off it.
  const selectedText = comment.selectedText ?? null;

  // Remove the comment from the list temporarily
  comments = comments.filter(c => !(c.file === currentFile && c.diffLineIndex === diffLineIndex));

  // Reload file and show edit input
  const fileIndex = currentFiles.findIndex(f => f.path === currentFile);
  loadFile(currentFile, fileIndex).then(() => {
    // Show comment input with existing text
    const lineEl = document.querySelector(`.line[data-diff-index="${diffLineIndex}"]`);
    if (!lineEl) return;

    const inputBox = document.createElement('div');
    inputBox.className = 'comment-input-box';

    const selectedTextHtml = selectedText
      ? `<div class="selected-text-preview">
           <strong>Selected code:</strong>
           <pre>${escapeHtml(selectedText)}</pre>
         </div>`
      : '';

    inputBox.innerHTML = `
      ${selectedTextHtml}
      <textarea placeholder="Enter your comment (Cmd/Ctrl+Enter to save)..." id="commentInput">${escapeHtml(comment.text)}</textarea>
      <div class="actions">
        <button${selectedTextData(selectedText)} onclick="saveComment(${Number(diffLineIndex)}, this.dataset.selectedText ?? null)">Save Comment</button>
        <button class="cancel-btn" onclick="this.closest('.comment-input-box').remove()">Cancel</button>
      </div>
    `;

    lineEl.after(inputBox);
    const textarea = document.getElementById('commentInput');
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    // Auto-resize textarea
    const autoResize = () => {
      textarea.style.height = 'auto';
      textarea.style.height = textarea.scrollHeight + 'px';
    };

    textarea.addEventListener('input', autoResize);
    autoResize(); // Initial resize

    // Add keyboard shortcuts
    textarea.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        saveComment(diffLineIndex, selectedText);
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        inputBox.remove();
        // Restore the comment if canceled
        comments.push(comment);
        const fileIndex = currentFiles.findIndex(f => f.path === currentFile);
        loadFile(currentFile, fileIndex);
      }
    });
  });
}

// Delete comment
function deleteComment(diffLineIndex) {
  comments = comments.filter(c => !(c.file === currentFile && c.diffLineIndex === diffLineIndex));

  // Auto-save to backend
  saveCommentsToBackend();

  // Update comments sidebar
  updateCommentsSidebar();

  // Reload the current file to remove the comment
  const fileIndex = currentFiles.findIndex(f => f.path === currentFile);
  loadFile(currentFile, fileIndex);
}

// Submit review
async function submitReview() {
  if (!currentRepoId) {
    showStatus('Please load a repository first', 'error');
    return;
  }

  // Ensure comments are saved before generating review
  await saveCommentsToBackend();

  try {
    const response = await fetch(`${API_BASE}/submit-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoId: currentRepoId
        // Backend reads from JSON file (single source of truth)
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to submit review');
    }

    showReviewModal(data);
    showStatus(`Review submitted successfully! ${data.totalComments} comments`, 'success');

  } catch (error) {
    showStatus(`Error: ${error.message}`, 'error');
  }
}

/**
 * What happened when you pressed Submit.
 *
 * This used to offer a download and nothing else, which is a strange thing to
 * put in front of somebody who started this from a terminal: the review is
 * already a file, and they are more likely to want to know where it is than
 * to want a second copy of it in ~/Downloads.
 *
 * So it says where the review was written, and when something is waiting on
 * the other end of a pipe it says that instead — because in that case the
 * answer to "what do I do now" is "nothing, it has already gone".
 *
 * @param {{reviewContent: string, filename: string, reviewPath?: string,
 *   handoff?: boolean, totalComments?: number}} result
 */
function showReviewModal(result) {
  const { reviewContent, filename, reviewPath, handoff, totalComments } = result;

  const count = totalComments === undefined
    ? ''
    : `${totalComments} comment${totalComments === 1 ? '' : 's'} · `;

  const destination = handoff
    ? `<div class="review-destination handed-off">
         <strong>Handed back to your terminal.</strong>
         <span>${escapeHtml(count)}The command you ran has printed this review and exited. You can close this window.</span>
       </div>`
    : `<div class="review-destination">
         <strong>Saved</strong>
         <span class="review-path" title="${escapeHtml(reviewPath ?? '')}">${escapeHtml(reviewPath ?? filename)}</span>
       </div>`;

  const modal = document.createElement('div');
  modal.className = 'review-modal';
  modal.innerHTML = `
    <div class="review-modal-content">
      <div class="review-modal-header">
        <h2>Review Submitted</h2>
        <button class="close-modal" onclick="this.closest('.review-modal').remove()">×</button>
      </div>
      <div class="review-modal-body">
        ${destination}
        <pre class="review-text">${escapeHtml(reviewContent)}</pre>
      </div>
      <div class="review-modal-footer">
        <button data-filename="${escapeHtml(filename)}" onclick="downloadReview(this.dataset.filename, this.closest('.review-modal').querySelector('.review-text').textContent)">
          Download
        </button>
        <button onclick="copyReviewToClipboard(this.closest('.review-modal').querySelector('.review-text').textContent)">
          Copy to Clipboard
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
}

// Download review as file
function downloadReview(filename, content) {
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  showStatus('Review downloaded successfully', 'success');
}

// Copy review to clipboard
async function copyReviewToClipboard(content) {
  try {
    await navigator.clipboard.writeText(content);
    showStatus('Review copied to clipboard!', 'success');
  } catch (error) {
    showStatus('Failed to copy to clipboard', 'error');
  }
}

// Cleanup session
async function cleanupRepo() {
  if (!currentRepoId) return;

  try {
    await fetch(`${API_BASE}/cleanup/${currentRepoId}`, {
      method: 'DELETE'
    });

    showStatus('Session cleared', 'success');
    resetApp();

  } catch (error) {
    console.error('Cleanup error:', error);
  }
}

// Reset application
function resetApp() {
  currentRepoId = null;
  currentFiles = [];
  currentFile = null;
  currentFileIndex = -1;
  comments = [];

  document.getElementById('repoPath').value = '';
  setRepoButton(null);
  document.getElementById('sidebar').classList.add('hidden');
  document.getElementById('resizeHandle').classList.add('hidden');
  document.getElementById('codeSection').classList.add('hidden');
  document.getElementById('commentsSidebar').classList.add('hidden');
  document.getElementById('submitReviewBtn').classList.add('hidden');
  document.getElementById('status').textContent = '';
  document.getElementById('status').className = 'status';

  showPicker();
}

// Show status message
function showStatus(message, type) {
  const statusEl = document.getElementById('status');
  // No "Status:" prefix. The element is role="status", which is what tells a
  // screen reader what it is; sighted readers could already see that.
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
}

/** Hide the status line, when something else on screen is already saying it. */
function clearStatus() {
  const statusEl = document.getElementById('status');
  statusEl.textContent = '';
  statusEl.className = 'status hidden';
}

// Track if we're in full context mode
let isFullContextMode = false;
let storedFullFileLines = null;

// Toggle between full context and diff-only view
async function showFullContext() {
  if (!currentRepoId || !currentFile) return;

  if (isFullContextMode) {
    // Switch back to diff view
    displayCode(currentFile, currentDiffLines);
    isFullContextMode = false;
    updateFullContextButton();
  } else {
    // Switch to full context
    try {
      const response = await fetch(`${API_BASE}/file-full/${currentRepoId}/${currentFile}`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to load full file content');
      }

      storedFullFileLines = data.lines;
      displayFullContext(data.filePath, data.lines);
      isFullContextMode = true;
      updateFullContextButton();

    } catch (error) {
      showStatus(`Error loading full context: ${error.message}`, 'error');
    }
  }
}

// Update the full context button text
function updateFullContextButton() {
  const button = document.querySelector('.full-context-btn');
  if (button) {
    const icon = button.querySelector('svg');
    if (isFullContextMode) {
      button.innerHTML = icon.outerHTML + ' Show Diff Only';
    } else {
      button.innerHTML = icon.outerHTML + ' Full Context';
    }
  }
}

// Display full file content with deleted lines
function displayFullContext(filePath, lines) {
  const codeViewer = document.getElementById('codeViewer');
  const fileComments = comments.filter(c => c.file === filePath);

  // Create a merged view: currentDiffLines + missing lines from full content
  const mergedLines = [];
  const coveredNewLines = new Set();

  // First, add all diff lines (includes deleted, added, and changed lines)
  let lastNewLine = 0;
  currentDiffLines.forEach(diffLine => {
    // Check if we need to fill in any missing lines before this diffLine
    if (diffLine.newLine && diffLine.newLine > lastNewLine + 1) {
      // Fill in the gap with unchanged lines
      for (let i = lastNewLine + 1; i < diffLine.newLine; i++) {
        if (lines[i - 1] !== undefined) {
          mergedLines.push({
            oldLine: i,
            newLine: i,
            type: 'unchanged',
            content: lines[i - 1]
          });
          coveredNewLines.add(i);
        }
      }
    }

    mergedLines.push(diffLine);
    if (diffLine.newLine) {
      coveredNewLines.add(diffLine.newLine);
      lastNewLine = diffLine.newLine;
    }
  });

  // Add any remaining lines after the last diff
  for (let i = lastNewLine + 1; i <= lines.length; i++) {
    if (!coveredNewLines.has(i) && lines[i - 1] !== undefined) {
      mergedLines.push({
        oldLine: i,
        newLine: i,
        type: 'unchanged',
        content: lines[i - 1]
      });
    }
  }

  // Find matching diffLineIndex for comments in full context
  // Need to map mergedLines back to original diffLines indices
  const mergedToDiffIndexMap = new Map();
  mergedLines.forEach((mergedLine, mergedIndex) => {
    // Find this line in original diffLines
    const diffIndex = currentDiffLines.findIndex(dl =>
      (dl.newLine === mergedLine.newLine && dl.oldLine === mergedLine.oldLine && dl.content === mergedLine.content)
    );
    if (diffIndex !== -1) {
      mergedToDiffIndexMap.set(mergedIndex, diffIndex);
    }
  });

  // Now render the merged lines
  let html = '';
  mergedLines.forEach((diffLine, mergedIndex) => {
    const diffLineIndex = mergedToDiffIndexMap.get(mergedIndex);
    const hasComment = diffLineIndex !== undefined ? fileComments.find(c => c.diffLineIndex === diffLineIndex) : null;

    const lineClass = `line diff-${diffLine.type} ${hasComment ? 'commented' : ''}`;
    const dataDiffIndexAttr = diffLineIndex !== undefined ? `data-diff-index="${diffLineIndex}"` : '';

    html += `
      <div class="${lineClass}" tabindex="0" ${dataDiffIndexAttr}>
        ${hasComment ? '<span class="comment-indicator"></span>' : ''}
        <div class="line-numbers">
          <span class="old-line-number">${diffLine.oldLine || ''}</span>
          <span class="new-line-number" ${diffLineIndex !== undefined ? `onclick="toggleCommentInput(${Number(diffLineIndex)})"` : ''}>${diffLine.newLine || ''}</span>
        </div>
        <div class="line-content">${escapeHtml(diffLine.content) || ' '}</div>
      </div>
    `;

    if (hasComment) {
      html += `
        <div class="comment-box">
          <span class="comment-text">${escapeHtml(hasComment.text)}</span>
          <div class="comment-actions">
            <button class="comment-edit" onclick="editComment(${Number(diffLineIndex)})">Edit</button>
            <button class="comment-delete" onclick="deleteComment(${Number(diffLineIndex)})">Delete</button>
          </div>
        </div>
      `;
    }
  });

  codeViewer.innerHTML = html;

  // Add text selection handler for full context too
  codeViewer.removeEventListener('mousedown', trackShiftKeyDown);
  codeViewer.removeEventListener('mouseup', handleTextSelection);
  codeViewer.addEventListener('mousedown', trackShiftKeyDown);
  codeViewer.addEventListener('mouseup', handleTextSelection);

  showStatus('Showing full file context', 'success');
}

// Escape HTML
function escapeHtml(text) {
  // The DOM does this for &, < and > and leaves both quote characters alone,
  // which is right for a text node and wrong for an attribute -- and most of
  // the callers here are attributes. A file or folder whose name contained a
  // double quote closed the attribute early, and everything after it in the
  // name was read as markup. Escaped here rather than at each call site,
  // because the safe version has to be the one that is easy to reach for.
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Sidebar resize functionality
function initResizeHandle() {
  const resizeHandle = document.getElementById('resizeHandle');
  const sidebar = document.getElementById('sidebar');
  const commentsResizeHandle = document.getElementById('commentsResizeHandle');
  const commentsSidebar = document.getElementById('commentsSidebar');
  let isResizing = false;
  let isResizingComments = false;

  // Left sidebar resize
  resizeHandle.addEventListener('mousedown', (e) => {
    isResizing = true;
    resizeHandle.classList.add('resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  // Comments sidebar resize
  commentsResizeHandle.addEventListener('mousedown', (e) => {
    isResizingComments = true;
    commentsResizeHandle.classList.add('resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (isResizing) {
      const newWidth = e.clientX;
      const minWidth = 200;
      const maxWidth = 600;

      if (newWidth >= minWidth && newWidth <= maxWidth) {
        sidebar.style.width = `${newWidth}px`;
      }
    }

    if (isResizingComments) {
      const newWidth = window.innerWidth - e.clientX;
      const minWidth = 250;
      const maxWidth = 600;

      if (newWidth >= minWidth && newWidth <= maxWidth) {
        commentsSidebar.style.width = `${newWidth}px`;
      }
    }
  });

  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      resizeHandle.classList.remove('resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    if (isResizingComments) {
      isResizingComments = false;
      commentsResizeHandle.classList.remove('resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });
}

// Track current file index for keyboard navigation
let currentFileIndex = -1;

// Update comments sidebar
/**
 * How many comments sit on each file, on the file rows themselves.
 *
 * In a review of any size the question you keep asking is which files you have
 * already covered, and the only answer on screen was a total in the sidebar
 * header — so you found out by clicking through every file (#48).
 *
 * Updated in place rather than by re-rendering the list. Re-rendering would be
 * one line, and it would drop the selected row and the scroll position of the
 * file list every time anyone typed a comment.
 */
function updateFileCommentCounts() {
  const badges = document.querySelectorAll('.file-comment-count');
  if (badges.length === 0) return;

  const perFile = new Map();
  for (const comment of comments) {
    perFile.set(comment.file, (perFile.get(comment.file) ?? 0) + 1);
  }

  for (const badge of badges) {
    const file = currentFiles[Number(badge.dataset.fileIndex)];
    const count = file ? perFile.get(file.path) ?? 0 : 0;

    badge.textContent = count;
    badge.title = `${count} comment${count === 1 ? '' : 's'} on this file`;
    badge.hidden = count === 0;
  }
}

function updateCommentsSidebar() {
  const sidebar = document.getElementById('commentsSidebar');
  const commentsList = document.getElementById('commentsList');
  const commentsCount = document.getElementById('commentsCount');
  const commentsResizeHandle = document.getElementById('commentsResizeHandle');

  // Every path that changes a comment already calls this, so the per-file
  // counts ride along rather than needing ten more call sites of their own.
  updateFileCommentCounts();

  commentsCount.textContent = comments.length;

  if (comments.length === 0) {
    sidebar.classList.add('hidden');
    commentsResizeHandle.classList.add('hidden');
    commentsList.innerHTML = '<div style="text-align: center; color: #586069; padding: 20px; font-size: 13px;">No comments yet</div>';
    return;
  }

  sidebar.classList.remove('hidden');
  commentsResizeHandle.classList.remove('hidden');

  // Group comments by file
  const commentsByFile = {};
  comments.forEach(comment => {
    if (!commentsByFile[comment.file]) {
      commentsByFile[comment.file] = [];
    }
    commentsByFile[comment.file].push(comment);
  });

  let html = '';
  for (const [file, fileComments] of Object.entries(commentsByFile)) {
    fileComments
      .sort((a, b) => a.line - b.line)
      .forEach(comment => {
        const selectedHtml = comment.selectedText
          ? `<div class="comment-item-selected">${escapeHtml(comment.selectedText)}</div>`
          : '';

        // Both controls used to carry the file name, quoted into a handler
        // with `'` replaced by `\'` and nothing else -- so a name with a
        // backslash before the quote escaped the escape and ended the string
        // anyway. A comment's identity here is its position in `comments`,
        // and that is a number. See #46.
        const commentIndex = comments.indexOf(comment);
        // A comment is kept across comparisons -- switch from main -> feature
        // back to the last commit and a note on a file only the branch
        // touched is still yours. It just is not on screen, and a sidebar
        // entry that looks attached but does nothing when clicked reads as
        // lost. So it says where it stands.
        const elsewhere = !currentFiles.some(f => f.path === file);
        const elsewhereHtml = elsewhere
          ? '<div class="comment-item-elsewhere-note">Not in this view</div>'
          : '';
        html += `
          <div class="comment-item${elsewhere ? ' comment-item-elsewhere' : ''}">
            <button class="comment-item-delete" onclick="event.stopPropagation(); deleteCommentFromSidebar(${Number(commentIndex)})" title="Delete comment">×</button>
            <div class="comment-item-content" onclick="jumpToComment(${Number(commentIndex)})">
              <div class="comment-item-file">${escapeHtml(file)}</div>
              <div class="comment-item-line">Line ${comment.line}</div>
              <div class="comment-item-text">${escapeHtml(comment.text)}</div>
              ${selectedHtml}
              ${elsewhereHtml}
            </div>
          </div>
        `;
      });
  }

  commentsList.innerHTML = html;
}

// Delete comment from sidebar
function deleteCommentFromSidebar(commentIndex) {
  const target = comments[Number(commentIndex)];
  if (!target) return;

  const { file, diffLineIndex } = target;
  comments = comments.filter(c => !(c.file === file && c.diffLineIndex === diffLineIndex));

  // Auto-save to backend
  saveCommentsToBackend();

  // Update comments sidebar
  updateCommentsSidebar();

  // If we're currently viewing this file, reload it to remove the comment
  if (currentFile === file) {
    const fileIndex = currentFiles.findIndex(f => f.path === file);
    loadFile(file, fileIndex);
  }
}

// Jump to a specific comment
function jumpToComment(commentIndex) {
  const target = comments[Number(commentIndex)];
  if (!target) return;

  const { file, diffLineIndex } = target;

  // Find the file index
  const fileIndex = currentFiles.findIndex(f => f.path === file);
  if (fileIndex === -1) {
    // This used to return without a word, so clicking a comment did nothing
    // and looked broken. The comment is safe; the file is just not part of
    // what is being compared right now.
    showStatus(
      `${file} is not in the files you are looking at now, so this comment cannot be shown in place. ` +
      'It is kept, and will be back in place in any view that includes that file.',
      'loading'
    );
    return;
  }

  // Load the file
  loadFile(file, fileIndex).then(() => {
    // Scroll to the comment
    const lineEl = document.querySelector(`.line[data-diff-index="${diffLineIndex}"]`);
    if (lineEl) {
      lineEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Highlight briefly
      lineEl.style.backgroundColor = 'rgba(3, 102, 214, 0.1)';
      setTimeout(() => {
        lineEl.style.backgroundColor = '';
      }, 1000);
    }
  });
}

// Navigate to next/previous file
function navigateFiles(direction) {
  if (currentFiles.length === 0) return;

  let newIndex = currentFileIndex;

  // If no file is loaded yet, load the first file
  if (currentFileIndex === -1) {
    newIndex = 0;
  } else if (direction === 'up') {
    newIndex = currentFileIndex > 0 ? currentFileIndex - 1 : 0;
  } else if (direction === 'down') {
    newIndex = currentFileIndex < currentFiles.length - 1 ? currentFileIndex + 1 : currentFiles.length - 1;
  }

  if (newIndex !== currentFileIndex) {
    currentFileIndex = newIndex;
    const file = currentFiles[newIndex].path;
    loadFile(file, newIndex);
  }
}

// Navigate to comments in current file
function navigateComments(direction) {
  const commentElements = Array.from(document.querySelectorAll('.line.commented, .unmatched-comment-item'));
  if (commentElements.length === 0) return;

  const active = document.activeElement;
  const currentIndex = commentElements.findIndex(el => el === active || el.contains(active));

  let newIndex = currentIndex;
  if (currentIndex === -1) {
    newIndex = direction === 'next' ? 0 : commentElements.length - 1;
  } else {
    // stop at boundaries, matching existing file navigation style
    if (direction === 'next') {
      newIndex = Math.min(currentIndex + 1, commentElements.length - 1);
    } else {
      newIndex = Math.max(currentIndex - 1, 0);
    }
  }

  if (newIndex !== currentIndex && commentElements[newIndex]) {
    const target = commentElements[newIndex];
    target.focus();
    target.scrollIntoView({ block: 'nearest' });
  }
}

function handleCommentShortcut() {
  const active = document.activeElement;
  if (!active) return;
  const line = active.closest('.line');
  if (!line) return;
  const diffIndex = parseInt(line.dataset.diffIndex, 10);
  if (!isNaN(diffIndex)) {
    toggleCommentInput(diffIndex);
  }
}

/**
 * Pure function mapping keyboard events to application actions.
 * @param {string} key
 * @param {string} targetTagName
 * @param {{ctrl?: boolean, meta?: boolean, alt?: boolean}} [modifiers]
 * @returns {string|null} Action to take, or null if ignored.
 */
function getKeyboardShortcut(key, targetTagName, modifiers = {}) {
  if (modifiers.ctrl || modifiers.meta || modifiers.alt) return null;

  // Escape means "never mind" everywhere — including inside inputs — so it
  // must be checked before the typing guard.
  if (key === 'Escape') return 'escape';

  // SELECT as well as the text fields. With focus in one of the compare
  // pickers, a letter is the browser's type-ahead -- "c" jumps to the first
  // option starting with c -- and it also opened a comment box, because only
  // INPUT and TEXTAREA were excluded here when the pickers arrived in 2.12.
  if (targetTagName === 'INPUT' || targetTagName === 'TEXTAREA' || targetTagName === 'SELECT') {
    return null;
  }

  const map = {
    'ArrowUp': 'prevFile',
    'k': 'prevFile',
    'ArrowDown': 'nextFile',
    'j': 'nextFile',
    'n': 'nextComment',
    'p': 'prevComment',
    'c': 'commentFocus',
    '[': 'prevCommit',
    ']': 'nextCommit',
    '?': 'help'
  };

  return map[key] || null;
}

// Allow Enter key to load repo
/**
 * Tell the server this tab exists, by holding a connection open for as long
 * as it does.
 *
 * There is nothing to read from this stream. The point is the socket: the
 * browser closes it when the tab closes, which is the only notification of a
 * closed tab that arrives whether you quit the browser, kill the window or
 * lose the machine. `beforeunload` does not fire for all of those.
 *
 * EventSource reconnects on its own after a drop, which is what makes the
 * server's grace period work -- a flaky connection comes back inside it and
 * nothing is stopped.
 */
function watchFromThisTab() {
  try {
    new EventSource(`${API_BASE}/alive`);
  } catch {
    // Older browsers, or a page opened from a file:// URL. Losing this costs
    // an automatic exit, not a review, so there is nothing to report.
  }
}

document.addEventListener('DOMContentLoaded', () => {
  watchFromThisTab();

  document.getElementById('repoPath').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      loadRepo();
    }
  });

  // The commits list: click reviews one, shift-click the run to it. Enter
  // and shift+Enter do the same from the keyboard, since every row is
  // focusable.
  const commitsList = document.getElementById('commitsList');
  commitsList.addEventListener('click', (e) => {
    const item = e.target.closest('.commit-item');
    if (!item) return;
    // Shift-click also extends the browser's text selection across the rows
    // it passes; that is noise here, not a gesture anyone meant.
    if (e.shiftKey) window.getSelection()?.removeAllRanges();
    selectCommit(item.dataset.sha, e.shiftKey);
  });
  commitsList.addEventListener('keydown', (e) => {
    const item = e.target.closest('.commit-item');
    if (!item || e.key !== 'Enter') return;
    e.preventDefault();
    selectCommit(item.dataset.sha, e.shiftKey);
  });

  for (const end of ['base', 'head']) {
    document.getElementById(PICKERS[end].other).addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        compareNow();
      }
    });
  }

  // Initialize resize handle
  initResizeHandle();

  // Add keyboard navigation
  document.addEventListener('keydown', (e) => {
    const action = getKeyboardShortcut(e.key, e.target.tagName, { ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey });
    if (!action || action === 'escape') return; // escape is handled separately

    if (action === 'prevFile') {
      e.preventDefault();
      navigateFiles('up');
    } else if (action === 'nextFile') {
      e.preventDefault();
      navigateFiles('down');
    } else if (action === 'nextComment') {
      e.preventDefault();
      navigateComments('next');
    } else if (action === 'prevComment') {
      e.preventDefault();
      navigateComments('prev');
    } else if (action === 'commentFocus') {
      e.preventDefault();
      handleCommentShortcut();
    } else if (action === 'prevCommit') {
      e.preventDefault();
      stepCommit(-1);
    } else if (action === 'nextCommit') {
      e.preventDefault();
      stepCommit(1);
    } else if (action === 'help') {
      e.preventDefault();
      document.getElementById('helpButton').click();
    }
  });
  for (const id of ['recentList', 'browseList']) {
    const list = document.getElementById(id);
    list.addEventListener('click', onPickerActivate);
    list.addEventListener('keydown', onPickerActivate);
  }

  // Escape, and a click on the dimmed area around it, both mean "never mind"
  // -- but only when there is a review behind the picker to go back to.
  document.addEventListener('keydown', event => {
    if (getKeyboardShortcut(event.key, event.target.tagName, { ctrl: event.ctrlKey, meta: event.metaKey, alt: event.altKey }) !== 'escape') {
      return;
    }

    // Topmost first: the help sits over the picker, which sits over a review.
    if (!document.getElementById('helpModal').classList.contains('hidden')) {
      closeHelp();
      return;
    }

    const reviewModal = document.querySelector('.review-modal');
    if (reviewModal) {
      reviewModal.remove();
      return;
    }

    closePicker();
  });

  document.getElementById('picker').addEventListener('click', event => {
    if (event.target.id === 'picker') closePicker();
  });

  // `reviewer /path/to/repo` opens the page with the repository in the query
  // string, so the review is on screen without anyone typing a path.
  const requestedRepo = new URLSearchParams(window.location.search).get('repo');
  if (requestedRepo) {
    document.getElementById('repoPath').value = requestedRepo;
    // Hidden before the request goes out, so the picker does not flash up for
    // the fraction of a second it takes to load a repository that was named.
    hidePicker();
    loadRepo();
  } else {
    showPicker();
  }
});


/* Repository picker
 * ---------------------------------------------------------------------------
 * What the page shows before a repository is open. It used to show nothing but
 * an empty path box in the header, which asked you to already know the path you
 * were looking for -- and to type it exactly.
 */

/** Where the browse list is pointed. Null until the first listing arrives. */
let browseAt = null;
let browseParent = null;
let browseIsRepository = false;

/**
 * Show the picker.
 *
 * With nothing open it is the page. With a review open it is a layer over the
 * review, because being asked which repository you want should not cost you
 * the one you are reading.
 */
function showPicker() {
  const reviewing = currentRepoId !== null;

  document.getElementById('picker').classList.remove('hidden');
  document.getElementById('picker').classList.toggle('as-overlay', reviewing);
  document.getElementById('pickerClose').classList.toggle('hidden', !reviewing);

  loadRecent();
  loadBrowse(browseAt);
}

function hidePicker() {
  document.getElementById('picker').classList.add('hidden');
}

/** Dismiss the picker, which only means anything when there is something behind it. */
function closePicker() {
  if (currentRepoId !== null) hidePicker();
}

/**
 * Reveal the path box, for pasting a path or typing one you already know.
 *
 * Kept out of the way rather than removed: a navigator is the slow way round
 * when the path is already on your clipboard.
 */
function togglePathEntry() {
  const entry = document.getElementById('pathEntry');
  const toggle = document.getElementById('pathToggle');
  const showing = entry.classList.toggle('hidden') === false;

  toggle.setAttribute('aria-expanded', String(showing));

  if (showing) {
    const input = document.getElementById('repoPath');
    input.focus();
    input.select();
  }
}

/**
 * Name the repository on the button that opens the picker.
 *
 * @param {string|null} repoPath
 */
function setRepoButton(repoPath) {
  const name = repoPath ? repoPath.split(/[\\/]/).filter(Boolean).pop() : null;

  document.getElementById('repoButtonLabel').textContent = name ?? 'Open a repository';
  document.getElementById('repoButton').title = repoPath ?? 'Choose a repository';
}

/**
 * How long ago, in the least fussy words that are still true.
 *
 * @param {string} iso
 * @returns {string}
 */
function timeAgo(iso) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);

  if (!Number.isFinite(seconds) || seconds < 60) return 'just now';

  for (const [unit, size] of [['minute', 60], ['hour', 3600], ['day', 86400]]) {
    if (seconds < size * 60 || unit === 'day') {
      const count = Math.floor(seconds / size);
      if (unit === 'day' && count > 30) return new Date(iso).toLocaleDateString();
      return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
    }
  }
}

/** Repositories opened before, newest first. */
async function loadRecent() {
  const section = document.getElementById('recentSection');
  const list = document.getElementById('recentList');

  let projects;
  try {
    projects = (await (await fetch(`${API_BASE}/recent`)).json()).projects ?? [];
  } catch {
    // Not being able to remember is not worth an error message on a page whose
    // other half works. The browser below still opens anything.
    section.classList.add('hidden');
    return;
  }

  if (projects.length === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');
  list.innerHTML = projects
    .map(project => {
      const meta = project.exists
        ? [project.comments > 0 ? `${project.comments} comment${project.comments === 1 ? '' : 's'}` : '', timeAgo(project.openedAt)]
          .filter(Boolean)
          .join(' · ')
        : 'no longer there';

      return `
        <div class="picker-row${project.exists ? '' : ' missing'}"
             ${project.exists ? `role="button" tabindex="0" data-open="${escapeHtml(project.path)}"` : ''}
             title="${escapeHtml(project.path)}">
          <span class="picker-row-icon">${project.exists ? '▸' : '×'}</span>
          <span class="picker-row-name">${escapeHtml(project.name)}</span>
          <span class="picker-row-path">${escapeHtml(project.location ?? '')}</span>
          <span class="picker-row-meta">${escapeHtml(meta)}</span>
        </div>`;
    })
    .join('');
}

/**
 * List one directory.
 *
 * @param {string|null} path directory to list; the home directory when null
 */
async function loadBrowse(path) {
  const list = document.getElementById('browseList');

  let listing;
  try {
    const response = await fetch(`${API_BASE}/browse?path=${encodeURIComponent(path ?? '')}`);
    listing = await response.json();
    if (!response.ok) throw new Error(listing.error || 'Could not list that directory');
  } catch (error) {
    list.innerHTML = `<div class="picker-empty">${escapeHtml(error.message)}</div>`;
    return;
  }

  browseAt = listing.path;
  browseParent = listing.parent;
  browseIsRepository = listing.isRepository;

  document.getElementById('browsePath').textContent = listing.display ?? listing.path;
  document.getElementById('browseUpBtn').disabled = listing.parent === null;
  document
    .getElementById('browseOpenBtn')
    .classList.toggle('hidden', !listing.isRepository);

  if (listing.entries.length === 0) {
    list.innerHTML = '<div class="picker-empty">No folders in here.</div>';
    return;
  }

  // A repository row goes both ways: the row walks into it, the button opens
  // it. Walking in matters for the repository that has another one inside it,
  // and one click has to be enough for the ordinary case.
  list.innerHTML = listing.entries
    .map(
      entry => `
        <div class="picker-row" role="button" tabindex="0" data-into="${escapeHtml(entry.path)}"
             title="${escapeHtml(entry.path)}">
          <span class="picker-row-icon">${entry.isRepository ? '◉' : '▸'}</span>
          <span class="picker-row-name">${escapeHtml(entry.name)}</span>
          ${entry.isRepository ? '<span class="picker-badge">git</span>' : ''}
          <span class="picker-row-path"></span>
          ${entry.isRepository ? `<button class="picker-open" data-open="${escapeHtml(entry.path)}">Open</button>` : ''}
        </div>`
    )
    .join('');
}

function browseUp() {
  if (browseParent) loadBrowse(browseParent);
}

function openBrowsed() {
  if (browseIsRepository) openProject(browseAt);
}

/**
 * Load a repository the way typing its path and pressing the button would.
 *
 * @param {string} path
 */
function openProject(path) {
  document.getElementById('repoPath').value = path;
  loadRepo();
}

/**
 * One handler for both lists: open what carries `data-open`, walk into what
 * carries `data-into`. Delegation rather than an `onclick` per row, because a
 * path is not safe to interpolate into an attribute that is then evaluated.
 *
 * @param {Event} event
 */
function onPickerActivate(event) {
  if (event.type === 'keydown') {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
  }

  const open = event.target.closest('[data-open]');
  if (open) {
    event.stopPropagation();
    openProject(open.dataset.open);
    return;
  }

  const into = event.target.closest('[data-into]');
  if (into) loadBrowse(into.dataset.into);
}

/* How to review
 * ---------------------------------------------------------------------------
 * Shown once, on the first review this browser ever opens, and after that only
 * when asked for. The gestures here are not guessable -- a column of line
 * numbers does not look clickable -- but they are learned in one go, and a
 * panel that keeps explaining them afterwards is furniture.
 */

/** Set the first time the help has been seen. Per browser; a convenience, not state. */
const HELP_SEEN_KEY = 'reviewer.help.seen';

/** @returns {boolean} */
function helpWasSeen() {
  try {
    return window.localStorage.getItem(HELP_SEEN_KEY) === 'true';
  } catch {
    // Private window, or site data blocked. Showing it again is the harmless
    // direction to fail in.
    return false;
  }
}

function openHelp() {
  document.getElementById('helpModal').classList.remove('hidden');
  try {
    window.localStorage.setItem(HELP_SEEN_KEY, 'true');
  } catch {
    // Nothing to do; it opens again next time.
  }
}

function closeHelp() {
  document.getElementById('helpModal').classList.add('hidden');
}

/**
 * Offer it unprompted the first time, once a repository is actually on screen.
 *
 * Not at page load: with nothing open there is nothing to apply it to, and it
 * would be the first thing between somebody and the tool they just started.
 */
function offerHelpOnce() {
  if (helpWasSeen()) return;
  openHelp();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getKeyboardShortcut
  };
}
