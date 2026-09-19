# Maintaining `reviewer`

Notes for whoever maintains this next. The architecture is readable from the
code, so this file is deliberately not about architecture — it is about the
things that cost someone a day to learn and are invisible in a diff.

Accurate as of 2.6.0 (2026-09-17).

## 1. What it is, in one sentence

`reviewer` gives you the pull-request review view of your own working
directory — inline comments anchored to exact lines, with no branch, no remote,
no push and no account — and then hands the marked-up review to a coding agent
to apply.

The last clause is the product. Everything else is a means to it:

```bash
reviewer | claude -p "Apply this review to the repo."
```

`reviewer` opens the browser, you comment, you press submit, and the review
leaves on stdout as an agent-ready prompt. What the agent receives is
`code-review/v1`:

```json
{
  "schema": "code-review/v1",
  "repository": { "name": "api-service", "head": "abe3b37", "branch": "main" },
  "mode": "working",
  "summary": { "comments": 2, "files": 1 },
  "comments": [
    { "id": "src/auth.js:10", "file": "src/auth.js", "anchor": "const token = req.headers.authorization" }
  ]
}
```

`anchor` is the load-bearing field. Line numbers go stale the moment the agent
makes its first edit; the anchor text survives. Anything you add to the export
should assume line numbers are already wrong.

## 2. Running it

```bash
npm ci
node --test          # 273 tests, ~5s, all green
npm start            # serves the UI for the current directory
```

Green looks like `pass 273 / fail 0` — while the README badge reads **272**,
and both of those are correct at the same time.

`node --test` prints 273 because it counts `test/helpers/repo.js` as a test
file. `countDeclaredTests()` in `test/readme.test.js` returns 272, and 272 is
what the badge and the Development block must say. I changed the badge to 273
on 2026-09-17 because the runner told me 273, and turned a green tree red; the
failing assertion's own message warns against exactly that number, and I did
not read it because the test had been passing before I broke it. **Trust the
test's number, not the runner's total.**

There is no linter and no build step;
three runtime dependencies, and the project would like to keep it that way.
CI is `ci.yml` on Linux and macOS across Node 18/20/22. Windows is absent on
purpose — its runners never picked up a job — and that is documented in the
workflow rather than left to be rediscovered.

## 3. Traps

These are the expensive ones. Each was a real defect, not a hypothetical.

**stdout is the product.** When stdout is not a TTY, the review is the only
thing allowed on it. A stray `console.log` anywhere in the server or libraries
corrupts the payload the agent parses. This is why there are no `console.log`
calls in `server.js`; diagnostics go to stderr via `note()`. If you add
logging, send it to stderr.

**The single newline in `bin/reviewer.js` is not decorative.** `claude -p`
waits three seconds for the *first byte* on piped stdin and then proceeds
without stdin at all — printing a warning and exiting **0**. Reviewing takes
minutes. So the handoff path writes one `\n` at startup to hold the stream
open, long before there is a review to send. Delete that line and
`reviewer | claude -p` silently does nothing useful while still exiting
successfully, so no test and no CI leg catches it. **This shipped broken in
2.4.0** — both halves were tested separately and never composed. The test that
guards it asserts the first byte is out *by the time the banner appears*; it is
a composition test and must stay one.

**`git diff -- <path>` from a subdirectory returns an empty string, not an
error.** `git status --porcelain` reports paths relative to the worktree root,
but a pathspec resolves relative to the process's directory. Run the two
together from a subdirectory and you get a clean, confident, wrong answer. Every
git call therefore resolves the worktree root first — `lib/repo.js`, via
`rev-parse --show-toplevel`. Do not reintroduce a raw `cwd` path into a
pathspec.

**`simpleGit()` throws synchronously at construction** when handed a path that
does not exist. The constructor has to be *inside* the `try`, not above it. The
usual shape (`const git = simpleGit(dir); try { ... }`) throws past your handler.

**`escapeHtml` cannot secure a JavaScript string context.** HTML entities are
decoded *before* the attribute is parsed as JavaScript, so an escaped quote
inside `onclick="..."` is still a quote by the time the JS parser sees it — a
crafted *filename* was enough to execute script. The fix is structural: every
interpolation into an inline handler is wrapped in `Number(...)`, and strings
travel in `data-` attributes instead. `test/page.test.js` scans for both rules.
If that test fails, do not relax it — it is the control, not a style
preference.

**Do not merge on a green-looking check list before the checks have
registered.** `gh pr checks` reports success against an empty set. I merged
two PRs this way (#39, #61) before the runs existed. Gate on a non-empty pass
list, not on the absence of failures. The Node 18 legs take 3–5 minutes.

**Fork-PR CI approval was loosened here on 2026-09-17, with Dheeraj's
authorisation.** The setting is `first_time_contributors_new_to_github`, so
only accounts brand new to GitHub are held; anyone with history gets CI
immediately. `mcp-migrate` has been on the same setting since August, so the
two repos now match — but check rather than assume, because they did not match
for a month and the handover written that morning got it wrong:

    gh api repos/dheerajjha/reviewer/actions/permissions/fork-pr-contributor-approval

Why it was changed: on the strict setting a first-time contributor's run parks
in `action_required` until someone approves it by hand — no failure, no
notification, just a pull request that looks ignored. With 2 forks and
distribution as the binding constraint (§8), the first outside pull request
this project ever gets was exactly the one most likely to be lost that way.

**This is safe because of specific facts, and it stops being safe if they
change.** Audited 2026-09-17, all holding: `ci.yml` is the only fork-reachable
workflow; it triggers on `pull_request`, **not** `pull_request_target`, so fork
code gets a read-only token and no secrets; `ci.yml` references no secrets at
all; `release.yml` holds the only real credential (`id-token: write`) and is
tags-only, so it is unreachable from a fork; the repo default workflow
permission is `read` and `can_approve_pull_request_reviews` is false.

**Re-audit if anyone adds `pull_request_target` or a custom secret.** There is
no "never require approval" option at repo level, so this is as open as it
goes — and the policy change does not retroactively release runs already
queued.

If you do find a held run:

    gh run list --repo dheerajjha/reviewer --status action_required

Two cautions on that list. A queued `action_required` run and a blocked
contributor look identical, and leftovers from superseded commits sit there
looking like emergencies — but do **not** separate them by asking whether the
run still has a PR attached. A run's `pull_requests` field is empty for every
fork-originated run, so that test discards every real outside contributor.
Run 35443947808 was PR #71's live blocked run and reported `pull_requests: []`.
Compare the run's `head_sha` to the head SHAs of open PRs instead; it is a live
block when it matches one and that SHA has no check-runs. And
approving a run *executes a contributor's code on the owner's compute*, which
for an agent acting on someone else's public repo is an outward-facing act.
Surface it; approve it if you are the owner or the owner has cleared you.

## 4. Releasing

Standing instruction from the owner: **if `main` is ahead of the published
version, cut the release.** A merge that never ships is an unfinished merge.

```bash
git log v$(npm view git-reviewer version)..main --oneline    # anything here?
```

Publishing is OIDC trusted publishing on a `v*` tag. **There is no npm token in
this repository and there must not be one** — the existing tokens are revoked
and will 401 if you try. The whole release is: changelog, version bump, PR,
merge, tag, push tag.

Three things must keep matching npm's trust record or the publish is rejected:
the repository, the *filename* `release.yml`, and the absence of an
environment. Renaming that workflow file is a breaking change.

**Two guards on that rule, both learned the hard way:**

*Ahead is necessary, not sufficient.* Check that CI is **green on `main`**, and
that the run you are reading is the one for the commit you are about to tag —
`gh run list --branch main --limit 1` reports `in_progress` with no conclusion,
which is not a pass. On 2026-09-17 `main` was one commit ahead of `v2.6.0` and
*red*, because that commit broke the badge test; "ahead" alone would have
published a red tree over OIDC, and OIDC needs no human at the keyboard to stop
it.

*Docs-only and test-only commits do not need a release of their own.* Being
ahead by a README fix is not a reason to publish. Behaviour changes are.

Verify by installing the published artifact fresh. Not by reading the green
tick.

Docs-only and test-only commits do not need a release of their own. Behaviour
changes do.

**README images are a free channel.** npm rewrites relative image paths to
`https://raw.githubusercontent.com/<repo>/HEAD/<path>`, so replacing
`docs/demo.gif` on `main` updates the npm listing without a release. Verified
live, not assumed.

## 5. The demo

The README leads with `docs/demo.gif` / `docs/demo.mp4`. The harness that
produces them is **not in this repository** — it needs playwright and ffmpeg,
and this package ships three dependencies. It lives on the owner's machine at
`~/.oss-sweep/demo-harness/` with its own README.

Re-record when the UI changes; a demo of a version that no longer exists is
worse than no demo. Two traps are written up there: the three segments share
one repository and one review, so the comments the closing segment exports must
be the ones the middle segment was filmed writing; and the folder picker lists
the real home directory, which is why the demo loads its repository directly
instead of going through the picker.

`docs/demo.*` currently predates the 2.6.0 "say which files you have commented
on" change. Not misleading, but not current either.

## 6. What not to do

- **Do not open the CORS hole.** The owner assessed it and declined the fix.
  It is a settled decision, not an oversight; do not re-file it.
- **Do not create an npm token.** See §4. The tag is the mechanism.
- **Do not post to the owner's community accounts** (Reddit, HN, X) without his
  explicit go-ahead on the specific text. Those posts go out in his voice, from
  his account. There is a drafted and *unsent* r/ClaudeAI post; it stays unsent
  until he says otherwise in his own words.
- **Do not weaken `test/page.test.js`.** See §3.
- **Do not add dependencies casually.** The count is a documented feature.

## 7. Open work, in priority order

1. **#20 and #25** — both `good first issue`, both real, and they are one bug
   in **one line**: `lib/changes.js:81`, in `collectCommitChanges`, passes
   simple-git's `file.file` straight through. In `lastCommit` mode git hands
   that field back with renames written as `old => new` (#25) and non-ASCII
   names octal-escaped and quoted, e.g. `"caf\303\251.js"` (#20). Either way
   the path is not a path, so the file opens to an empty diff and can never be
   reviewed.

   Contrast `collectWorkingChanges` at `:41-42`, which *does* unwrap
   `{ from, to }`. The working-tree path is already correct — that asymmetry is
   the bug, and it is why this only shows in `lastCommit` mode.

   A fix that handles one encoding and not the other passes its own test and
   leaves the other symptom in place, which is why these must be done together.
   Re-verified at `08293a5`; the file is untouched since `79082e1`.
2. **#32** — `repository.head` is read live at export time, so the documented
   staleness check cannot work. The docs describe a guarantee the code does not
   provide.
3. **#28** — a comment body can forge a file heading in the prompt export,
   inventing a section for a file nobody reviewed.
4. **#3 / #2 / #4** — the agent-integration arc, and they are ordered: `#3`
   (report whether each anchor still matches) is the prerequisite for `#2`
   (comment state / `resolve`), which is the prerequisite for `#4` (MCP).
   Doing #4 first produces an MCP surface over an unstable identity.
5. **#15** — Express 5 removes the `:filePath(*)` route syntax. Not urgent,
   but it is a dependency cliff rather than a feature.

**Known unresolved design question, now public as [Discussion #63]:** whether a
review should live outside the repo (where moving the checkout orphans it, per
#17) or inside it (where it shows up in `git status`). Do not unilaterally pick
one — it is open for community input on purpose.

**Waiting on a human:** @GoodJobwilliam's schema questions on #4 were answered
on 2026-09-17; the `id`-stability gap that answer exposed is real and should be
settled before any MCP work begins.

## 8. Honest state

1 star. 2 forks. Effectively zero npm downloads. The tool works and is
released; almost nobody has been told it exists. That, not the code, is the
binding constraint — and it is not one more bug fix away.

[Discussion #63]: https://github.com/dheerajjha/reviewer/discussions/63
