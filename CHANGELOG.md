# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`reviewer export --file <path>`** filters agent-ready JSON or prompt output
  to one repo-relative file and reports summary counts for what was emitted.

### Fixed

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

[Unreleased]: https://github.com/dheerajjha/reviewer/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/dheerajjha/reviewer/releases/tag/v2.0.0
[1.1.0]: https://github.com/dheerajjha/reviewer/releases/tag/v1.1.0
