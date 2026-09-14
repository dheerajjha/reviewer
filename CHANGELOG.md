# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.4.0] - 2026-09-14

### Added

- **`reviewer | claude -p "Apply this review."`** — the whole loop in one
  command. Submitting the review in the browser writes it to stdout and exits,
  so whatever is reading the pipe receives it and starts work. There is nothing
  to copy and no second command.

  On a terminal there is nothing waiting, so submitting is not the end of
  anything: it says where the review was saved, how many comments it holds and
  what to run next, and keeps serving.

  Everything the command says to you now goes to **stderr** — the banner, the
  progress lines, all of it. stdout carries the review and nothing else, which
  is the only way a pipe can work. This is a change in where output appears,
  not in what appears: both streams go to your terminal when nothing is piping.

- **The review pane says how to use it.** Nothing on screen suggested that the
  column of line numbers was clickable, or that holding `Cmd`/`Ctrl` and
  dragging selects a snippet to quote. Both are obvious the second time and
  invisible the first. A **How to comment** strip above the diff says so, and
  collapses for good once you dismiss it.

### Changed

- **The submit dialog says where the review went.** It offered a download and
  nothing else, which is an odd thing to put in front of someone who started
  this from a terminal — the review is already a file, and where it is beats a
  second copy of it in `~/Downloads`. When something is waiting on a pipe it
  says that instead, because then the answer to "what now" is "nothing, it has
  already gone".

## [2.3.1] - 2026-09-14

### Fixed

- **A deleted comment stays deleted, and an edited one is not duplicated.**
  ([#52](https://github.com/dheerajjha/reviewer/issues/52))

  The page kept a second copy of the review — a snapshot taken when the
  repository was opened and never updated — and re-matched against it on every
  render, adding back anything missing from the live list. Deleting reached
  disk and was then put back on screen, and the next save wrote it back over
  the deletion. Editing was worse: the text no longer matched the snapshot, so
  the pre-edit copy was re-added *alongside* the edited one, and
  `reviewer export` handed a coding agent two contradictory instructions about
  the same line.

  There is one list now. A comment that is not in it does not exist.

- **`POST /api/save-comments` rejects a comment with no file, line or text.**
  It answers 400 naming the field and the comment's index instead of saving it,
  so a malformed comment can no longer reach `reviewer export` as a comment on
  a file called `undefined`.
  ([#19](https://github.com/dheerajjha/reviewer/issues/19))

## [2.3.0] - 2026-09-14

### Added

- **A picker, for when you are not standing in a repository.** The page used to
  open on an empty path box, which asked you to already know the path you
  wanted and to type it exactly. It now offers two ways in: **Recent**, the
  repositories opened before, newest first and annotated with how many comments
  are saved against each; and **Browse**, walking the filesystem from your home
  directory with repositories marked so you can see where to stop.

  Only directory names are listed, never file names. Both endpoints refuse a
  request a browser reports as coming from another origin — they differ in kind
  from the rest of the surface, which answers about a repository whose path the
  caller already had.

  Hidden directories are left out of a listing, except the ones that are
  repositories, because `~/.dotfiles` is one of the most commonly reviewed
  repositories there is.

- **The header leads with the repository, not with a text box.** It used to
  say *"Enter local repository path..."*, which asks the one thing somebody
  opening this tool is least able to supply: the exact path, typed correctly,
  from memory. It is a button now, showing what you have open; clicking it
  brings up the picker over your review rather than instead of it. The path box
  is still there behind the icon beside it, because pasting a path is a real
  thing to want and a navigator is the slow way round when you already know.

- **The command is installed under both of its names.** The package is
  published as `git-reviewer` — that is what the install line says to type —
  and the only command it created was `reviewer`, so typing the name you had
  just installed answered `command not found`. Both names now point at the
  same entry point, which also hands it to git: `git reviewer` dispatches like
  any other subcommand.

### Fixed

- **A loaded repository shows a diff, instead of an empty pane.**
  ([#47](https://github.com/dheerajjha/reviewer/issues/47))

  The file list appeared and the code pane stayed blank until you clicked
  something, so the moment the tool finished its job it looked like it had
  failed. The first changed file opens on its own now — after the saved
  comments are in hand, or it would render without them. Reloading a
  repository keeps you on the file you were reading.

- **`reviewer` with no argument reviews the repository you are standing in.**

  `--help`, the README and the examples have all said it defaults to the
  current directory since the first release. The code never did: `repoPath`
  stayed null, the URL carried no repository, and the page opened on an empty
  path box waiting to be typed into. Naming a directory is unchanged, including
  being told when it is not a repository. Defaulting is answered differently —
  nobody asked for the current directory in particular, so when it is not
  inside a repository the page opens on its picker rather than on an error.

- **A subdirectory opens the repository above it, instead of a diff of the
  wrong content.** ([#43](https://github.com/dheerajjha/reviewer/issues/43))

  `git status --porcelain` reports paths relative to the repository root, but a
  pathspec is resolved relative to the process's directory — so a git rooted at
  `<repo>/src/deep` was asked to diff `src/deep/app.js`, matched nothing, and
  answered with an empty string rather than an error. The file was listed, and
  then opened showing its *committed* contents as though every line were newly
  added, with the actual change nowhere on screen. Saved reviews are keyed on
  the repository path too, so `reviewer export` one directory down reported no
  review for a repository it was standing inside. The server and `export` both
  resolve to the root of the working tree first.

- **The picker shows where a project lives, not all of where it lives.** Every
  row printed the whole absolute path, so the first forty characters were the
  same on each one and the part that identifies it was what got cut off. Rows
  now show the containing directory with the home directory as `~`, and keep
  the full path in the tooltip.

- **The URL the command prints is readable again.** `encodeURIComponent`
  escapes slashes, which a query value does not need — RFC 3986 has
  `query = *( pchar / "/" / "?" )` — so the most prominent line on screen read
  `?repo=%2FUsers%2Fyou%2Fwork%2Fapi`. Everything else is still encoded,
  including the characters that would otherwise end the query and take the rest
  of the path with them.

### Security

- **A file name is data, not the source of the handler that opens it.**
  ([#46](https://github.com/dheerajjha/reviewer/issues/46))

  The file rows, the comment controls and the comments sidebar built their
  `onclick` handlers by writing a value into a JavaScript string literal inside
  the attribute. A name carrying a quote ended that literal and the rest of the
  name ran when the row was clicked — and a name is chosen by whatever
  repository is open, which for this tool is the whole point: you are reviewing
  code you did not write.

  Escaping cannot close it, because a browser decodes the entities in an
  attribute before handing what is left to the JavaScript parser. Handlers take
  indices now and look the strings up in the page's own state; the one value
  that is not an index, a fragment of selected code, travels in a `data-`
  attribute and is read from the DOM when the handler runs. A test rejects any
  future handler built from a string, and any interpolation not wrapped in
  `Number(...)`.

  Two further problems turned up while fixing it. The file list drew the name
  into the row's *label* unescaped, so markup in a name rendered as markup with
  nothing clicked at all. And the two Edit buttons had become live when
  `escapeHtml` learned to escape quotes: the hand-rolled backslash escaping next
  to them stopped matching anything.

- **A file or folder name containing a quote can no longer break out of the
  attribute it is written into.** The page escapes values with `escapeHtml`,
  which escaped `&`, `<` and `>` — the DOM's own rules for a text node — and
  left both quote characters alone. Most of the callers are attributes, where
  a double quote ends the attribute early and everything after it in the name
  is read as markup. It now escapes quotes as well.

  This is the attribute half of the problem. Values interpolated into inline
  `onclick` handlers are a second, separate one: HTML escaping cannot fix a JS
  string context, because the entities are decoded before the handler is
  parsed. That is tracked and fixed separately.

## [2.2.0] - 2026-09-13

### Fixed

- **Two comments on the same line no longer export with the same `id`.**
  ([#26](https://github.com/dheerajjha/reviewer/issues/26))

  `comments[].id` was `<file>:<line>`, on the premise that the UI anchors one
  comment per line. In a diff the removed line and the line that replaced it
  can carry the same number, one on each side, and commenting on both is two
  ordinary clicks — so the document held two different comments under one id,
  and a consumer keyed by id silently kept one of them. The first comment on a
  line keeps the bare `<file>:<line>`; only a genuine collision gets a `#2`
  suffix, so nothing already consuming these ids churns.

- **A binary file is no longer served as decoded text.**
  ([#23](https://github.com/dheerajjha/reviewer/issues/23))

  `GET /api/file` decoded every blob as UTF-8, so a 2 KB PNG came back as ten
  `add` lines that were roughly 45% U+FFFD — and a comment left on one of them
  exported an `anchor` that can never match the file again, which is what
  `docs/agent-format.md` tells consumers to locate comments by. The response
  now carries `binary: true` with no lines, decided from git's own diff output
  rather than a second opinion about the bytes, and the UI says so.

- **`reviewer export --file` accepts the path however it is spelled.** `./src/auth.js`,
  `src//auth.js`, `src\auth.js` and absolute paths inside the repository used to
  fail with "no comments" because the match was literal; they now resolve to the
  stored repo-relative path.

## [2.1.0] - 2026-09-13

### Added

- **`reviewer export --file <path>`** filters agent-ready JSON or prompt output
  to one repo-relative file and reports summary counts for what was emitted.

- **`lib/export.js`**, so something other than the CLI can produce a
  `code-review/v1` document. `loadReviewDocument(reviewsDir, repoPath, {file})`
  is the chain that was previously assembled inside an un-exported function in
  `bin/reviewer.js`, and `listReviews(reviewsDir)` — which did not exist in any
  form — enumerates the repositories that have a saved review. Nothing in
  `lib/` knows about the CLI: the three conditions the terminal reports as
  usage errors are raised as domain errors and translated at the boundary.

### Fixed

- **Saved reviews are no longer destroyed by upgrading or uninstalling the
  package.** Reviews were written to a `reviews/` directory inside the
  installed package — a directory npm owns and replaces. Both of the ordinary
  things npm does to it deleted the user's work: `npm uninstall` took the
  reviews with it, and installing any newer version replaced the package
  directory and everything in it. `npx git-reviewer .`, the command the README
  leads with, wrote into the npx cache, which is pruned on npm's schedule
  rather than the user's. A *same-version* `npm i --force` did not wipe them,
  which made it worse rather than better: the loss fired only on upgrade,
  exactly when nobody is expecting it. Reviews now live in a per-user data
  directory — `~/Library/Application Support/git-reviewer` on macOS,
  `$XDG_DATA_HOME/git-reviewer` or `~/.local/share/git-reviewer` on Linux,
  `%LOCALAPPDATA%\git-reviewer` on Windows — overridable with
  `REVIEWER_DATA_DIR`. Reviews written by an older version are copied out of
  the install on first run, once, leaving the originals in place. This also
  makes `npx git-reviewer .` followed by `npx git-reviewer export .` work:
  before, those two commands could resolve to different directories and the
  second would answer "No saved review".

- **`docs/agent-format.md` no longer documents a staleness check that cannot
  fire.** It told consumers, in two places, to compare `repository.head`
  against the current `HEAD` to detect that the tree had moved on. `head` is
  read from the working tree when the document is produced, not recorded when
  the review was written, so that comparison is always current `HEAD` against
  itself and always agrees. The page now says what the field is and points at
  `comments[].anchor`, which is the mechanism that does work.

- **A comment anchored on a Markdown code fence no longer corrupts the agent
  prompt.** `reviewer export --format prompt` wrapped every anchor and
  selection in a hard-coded three-backtick fence. When the reviewed line was
  itself a bare ``` — one per code block in every Markdown file — the block
  closed on the anchor's own line, so the comment body the agent is told to act
  on was emitted as code, and the next comment's `###` heading was swallowed
  with it. The prompt format now picks a marker longer than any backtick run in
  the content, which is the rule the `.txt` review already used.

- **Two repositories with the same directory name no longer share one review.**
  Comment and review files were named from the repository's basename alone, so
  a second checkout called `api-service` wrote over the first one's review with
  no warning — and every read afterwards served the survivor to whichever
  repository asked, including `reviewer export`, which wrapped the wrong
  comments in the right repository's path and commit. Filenames now carry a
  fingerprint of the repository's canonical path. A review saved under the old
  name is adopted on first read when the file records that it belongs to the
  repository being opened, so nothing is lost in the move.

## [2.0.0] - 2026-08-10

Dropped the Electron wrapper. It added a few hundred megabytes and a
per-platform build pipeline in order to put a browser engine around a page your
browser already renders. `reviewer` is now a command that starts a local server
and opens a tab.

### Removed

- **The Electron desktop app**, along with `main.js`, `preload.js`, the
  `electron-builder` configuration, and the `build:mac` / `build:win` /
  `build:linux` scripts. There is nothing to package and nothing to sign.
- **Both dev dependencies.** The project now installs three runtime packages,
  about 6MB, in a couple of seconds.
- **`Cmd/Ctrl+O` and `Cmd/Ctrl+S`**, which were native menu accelerators with
  no browser equivalent. Opening a repository is an argument or the header
  field; submitting is the button. The in-page shortcuts (`Cmd/Ctrl+Enter`,
  `Escape`, `↑`/`↓`) are unchanged.

### Added

- **A `reviewer` command.** `reviewer [repository]` starts the server and opens
  a browser on that repository, which loads without anyone typing a path.
  `--port` chooses a port and falls back to a free one if it is taken, so two
  reviews at once just work; `--no-open` prints the URL instead.
- **`reviewer export`** — the review as machine-readable output, for handing to
  a coding agent once the review is done:

  ```bash
  reviewer export . --format prompt | claude -p "Apply this review to the repo."
  ```

  Every comment carries an `anchor`, the exact text of the line it was left on.
  Line numbers go stale the moment an agent makes its first edit, since
  everything below shifts; the anchor is what survives. The `prompt` format
  states this to the agent and tells it to report, not guess, when an anchor has
  vanished. Schema `code-review/v1` is documented in
  [docs/agent-format.md](docs/agent-format.md).

- **Submitting a review also writes the machine-readable form** beside the
  `.txt`, as `reviews/review_<repo>_<timestamp>.json`, and returns it from
  `POST /api/submit-review` as `review`.
- **A favicon**, so loading the page no longer logs a 404.

### Changed

- `npm start` runs the command; `npm run serve` starts the bare server without
  opening anything.
- The package exposes a `reviewer` binary and ships only `bin/`, `lib/`,
  `public/`, and `server.js`.

## [1.1.0] - 2026-08-10

The first release with a test suite. The behaviour of the app is unchanged for
anyone using it the way it was already used; everything below is either a bug
that could bite you or a change to a file the app writes.

### Added

- **A test suite.** 93 tests covering diff parsing, path confinement, git
  status mapping, comment normalization, review rendering, session handling,
  and the full HTTP surface. The HTTP tests run against real repositories
  created with real `git`, because diff parsing is exactly the place where a
  stub would be wrong in the same way the code is. Run them with `npm test` —
  no dependencies beyond what the app already ships, using the Node test
  runner.
- **CI on every push and pull request** across Linux and macOS on Node 18, 20,
  and 22.
- **`GET /api/health`.** The desktop shell now polls it to know the server is
  ready.
- **A `HOST` environment variable**, for deliberately exposing the web mode
  beyond loopback.

### Fixed

- **Opening a repository with no commits no longer fails with a 500.**
  Clicking any file in a freshly `git init`ed repository ran `git diff HEAD`
  against an unborn HEAD and returned a server error. Such a file is now shown
  as wholly new, which is what it is.
- **Deleted files appear in the review, and open.** Working-directory deletions
  were dropped from the changed-file list entirely, so a removed file could not
  be commented on. Deletions (`D`) and renames (`R`) are now listed — and
  opening one no longer fails, since a file that is gone from disk is read back
  out of `HEAD`, which is the whole point of reviewing it.
- **A comment with a reply no longer collapses into a narrow column.** The
  comment body was laid out as a flex row, so the follow-ups block competed
  with the comment text for width and squeezed it to about 90px the moment a
  single reply was added. The body is a vertical stack now, with the action
  buttons pinned top-right.
- **A path that names nothing answers 404** rather than 500 or, worse, an empty
  file.
- **A file claimed by two git buckets is listed once.** A file that was staged
  and then edited again appeared twice in the sidebar.
- **The diff parser no longer reads a second file's header as content.** Given
  multi-file diff text, the `---`/`+++` lines of every file after the first
  were parsed as deleted and added lines.
- **The desktop app starts reliably.** Readiness was inferred by matching a
  string in the server's stdout, with a 10-second timer that resolved anyway —
  so a server that failed to start showed an empty window. The shell now polls
  `/api/health` and fails loudly if the process dies.
- **The packaged desktop app starts at all.** It spawned `node` from `PATH`,
  which a packaged app cannot rely on; it now runs the server under Electron's
  own binary.
- **`package-lock.json` resolves to `registry.npmjs.org`.** Every entry pointed
  at a private Artifactory host that required authentication, so `npm install`
  failed for everyone outside that network. CI now fails if this recurs.

### Changed

- **The server binds to `127.0.0.1` by default** instead of every interface.
  It serves the contents of the repository under review, so reaching it should
  require being on the machine running it. Set `HOST=0.0.0.0` to opt out.
- **Follow-up timestamps in a submitted review are ISO 8601** rather than the
  server's locale format. A review gets committed and read on other machines;
  its shape should not depend on the reader.
- **Review filenames sanitize the repository name.** A repository directory can
  be named anything the filesystem allows, and that name went straight into a
  path.
- **Code snippets in a review are fenced with a wider fence when they contain
  one**, so a Markdown file under review no longer closes the block early and
  renders the rest of the review as prose.
- **`server.js` exports `createApp()` and `startServer()`** and only listens
  when run directly. Requiring it no longer binds a port.
- Logic moved out of the request handlers into `lib/`: `diff.js`, `paths.js`,
  `changes.js`, `comments.js`, `review.js`, `sessions.js`.

### Security

- **The file endpoints no longer read outside the repository.** `filePath`
  came straight from the URL and was joined onto the repository path, so
  `GET /api/file/:repoId/..%2f..%2fetc%2fpasswd` returned that file. Requests
  that resolve outside the opened repository are now refused with a 400.

## [1.0.0]

Initial release: Electron desktop app and web mode for reviewing local git
changes with inline comments, threaded follow-ups, persistent storage, and a
GitHub-style diff view.

[Unreleased]: https://github.com/dheerajjha/reviewer/compare/v2.4.0...HEAD
[2.4.0]: https://github.com/dheerajjha/reviewer/compare/v2.3.1...v2.4.0
[2.3.1]: https://github.com/dheerajjha/reviewer/compare/v2.3.0...v2.3.1
[2.3.0]: https://github.com/dheerajjha/reviewer/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/dheerajjha/reviewer/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/dheerajjha/reviewer/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/dheerajjha/reviewer/releases/tag/v2.0.0
[1.1.0]: https://github.com/dheerajjha/reviewer/releases/tag/v1.1.0
