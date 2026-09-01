# reviewer

[![CI](https://github.com/dheerajjha/reviewer/actions/workflows/ci.yml/badge.svg)](https://github.com/dheerajjha/reviewer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-163-brightgreen.svg)](test/)
[![Dependencies](https://img.shields.io/badge/dependencies-3-brightgreen.svg)](package.json)

![Plain grey code lines on the left resolving into colored diff stripes, with threaded comment markers attached in the right margin](docs/banner.jpg)

Review code before it becomes a pull request. `reviewer` opens any local git
repository in your browser, shows what changed, and lets you leave inline
comments with threaded follow-ups — against your working directory, without a
branch, a remote, a push, or an account. Comments persist between sessions and
survive the code moving underneath them, so you can review, edit, and come back
tomorrow to a review that still points at the right lines. When you are done it
writes a plain Markdown file you can paste anywhere.

```bash
cd ~/work/my-app
npx github:dheerajjha/reviewer .
```

That starts a local server and opens your browser on the repository you named.
There is nothing to install into the project, nothing to sign in to, and
nothing leaves your machine.

![The app reviewing a modified file: changed files on the left, a colour-coded diff in the middle with an inline comment and a threaded follow-up attached to line 10, and a comments sidebar on the right](docs/screenshot-comments.png)

Click a line number, write the note, keep going. Replies thread under the
comment they answer, and everything is saved as you type.

## Usage

```
reviewer [repository] [options]
reviewer export [repository] [--format json|prompt]

  repository        Path to a git repository (default: the current directory)

  -p, --port <n>    Port to listen on (default 4500; falls back to a free
                    port if that one is taken)
      --no-open     Print the URL instead of opening a browser
  -f, --format <f>  Export format: json (default) or prompt
  -h, --help        Show help
  -v, --version     Show the version
```

```bash
reviewer                    # review the repository you are standing in
reviewer ~/work/api         # review another one
reviewer . --no-open        # print the URL, open it yourself
reviewer . --port 8080      # somewhere other than 4500
```

Two at once is fine — the second one finds its own port.

To install it as a command rather than running it through `npx`:

```bash
git clone https://github.com/dheerajjha/reviewer.git
cd reviewer && npm install && npm link
```

## What it shows you

`reviewer` picks what to review based on the state of the repository, so there
is nothing to configure:

| Repository state | What you review |
|---|---|
| Uncommitted changes present | Your working directory against `HEAD` |
| Working directory clean | The last commit against its parent |
| No commits yet | Every tracked and untracked file, as wholly new |

Modified, added, deleted, renamed, and binary files are all listed, each marked
with its git status letter. Deleted lines are commentable too — the most useful
review note is often about the code someone removed. A file deleted outright is
shown in full, read back out of `HEAD`:

![The app showing a deleted file, every line rendered as a removal, recovered from HEAD because the file is no longer on disk](docs/screenshot-deleted.png)

## Reviewing

| Action | How |
|---|---|
| Comment on a line | Click the line number |
| Comment on a snippet | Hold `Cmd/Ctrl`, select code, then click the line number |
| Reply to a comment | Click **Reply** on it |
| Edit or delete | Hover the comment |
| Finish the review | Click **Submit Review** |

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl+Enter` | Save the comment being written |
| `Escape` | Cancel input |
| `↑` / `↓` | Move between files |

## What it writes

Two files, both under `reviews/`, both plain text you can read without this
app:

- **`.code-review-comments-<repo>.json`** — the live state of the review. It is
  written on every edit and is the source of truth; reopening the same
  repository restores exactly what is in it.
- **`review_<repo>_<timestamp>.txt`** — a submitted review, rendered from that
  JSON as Markdown, grouped by file and ordered by line:

````markdown
# Code Review

Repository: /work/my-app
Generated: 2026-08-10T12:30:45.678Z
Total Comments: 2

## src/auth.js

**Line 42:**
```
  const token = req.headers.authorization;
```
This trusts the header without checking the scheme.

**Follow-ups:**
  1. Still open after the rebase (2026-08-10T14:02:11.000Z)
````

Timestamps are ISO 8601 rather than a locale format on purpose: a review gets
committed, pasted into a pull request, and read on someone else's machine, so
its shape should not depend on the reader.

Submitting shows you exactly what was written, ready to download or copy:

![The Review Submitted dialog showing the rendered Markdown review, with a download button naming the file review_api-service_2026-08-10_17-40-48-989Z.txt](docs/screenshot-review.png)

## Handing the review to a coding agent

A review is only half the work; applying it is the other half. `reviewer
export` prints the review you saved — no server, no submit step — either as
JSON or as instructions ready to pipe:

```bash
reviewer export . --format prompt | claude -p "Apply this review to the repo."
reviewer export . | jq '.comments[].file'
```

Every comment carries an `anchor`: the exact text of the line it was left on.
Line numbers go stale the moment an agent makes its first edit, because
everything below shifts — so the anchor is what lets a comment still be found.
The prompt format says so to the agent explicitly, and tells it to report
rather than guess when an anchor has vanished.

```json
{
  "schema": "code-review/v1",
  "repository": { "path": "/work/api-service", "head": "abe3b37", "branch": "main" },
  "summary": { "comments": 2, "files": 1 },
  "comments": [
    {
      "id": "src/auth.js:10",
      "file": "src/auth.js",
      "line": 10,
      "anchor": "  if (scheme !== SCHEME || !token) return null;",
      "body": "Reject an empty token too.",
      "followUps": [{ "body": "Still open after the rebase", "at": "2026-08-10T14:00:00.000Z" }]
    }
  ]
}
```

Submitting in the UI writes this alongside the `.txt`. The full schema is in
[docs/agent-format.md](docs/agent-format.md).

## HTTP API

The UI is a client of this; nothing is hidden from you.

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Liveness, plus the number of open sessions |
| `POST /api/load-repo` | Open a repository; returns a `repoId` and the changed files |
| `GET /api/file/:repoId/:path` | The file's diff, as structured lines |
| `GET /api/file-full/:repoId/:path` | Every line of the file, for context |
| `POST /api/save-comments` | Persist the current comments |
| `GET /api/load-comments/:repoId` | Restore saved comments |
| `POST /api/submit-review` | Render the saved comments to a review file |
| `DELETE /api/cleanup/:repoId` | End the session; files on disk are untouched |

A `repoId` is a random per-session handle, not a path. Requests that resolve
outside the opened repository are refused, and a path that names nothing gets a
404.

`npm run serve` starts the server on its own, without opening a browser.

## Security

The server binds to `127.0.0.1`. It reads any file in the repository you
opened, so reaching it should require being on the machine running it — set
`HOST=0.0.0.0` only if you mean it. Every path that reaches the filesystem is
resolved through a check that it lands inside that repository, so a request for
`..%2f..%2fetc%2fpasswd` is refused rather than served.

If you find a way past that, please report it through
[security advisories](https://github.com/dheerajjha/reviewer/security/advisories/new)
rather than a public issue.

## Development

```bash
npm install           # 3 dependencies, no build step, ~6MB
npm test              # 150 tests
npm run test:watch
npm run test:coverage
```

```
bin/reviewer.js  the command: parse args, start server, open browser
server.js        Express app factory and routes
lib/
  cli.js           argument parsing and URL building
  browser.js       opening a URL on each platform
  diff.js          unified diff -> structured lines
  paths.js         confines request paths to the repository
  changes.js       git status and commit summaries -> changed files
  comments.js      the persisted comment shape
  review.js        rendering and naming review files
  sessions.js      repoId -> repository
public/          UI: index.html, style.css, app.js
test/            Node test runner; HTTP tests drive real git repositories
```

The request handlers hold no logic worth testing — it lives in `lib/`, and
`server.js` exports `createApp()` so a test can point an instance at a
temporary directory. The HTTP tests do not stub git: each one builds a real
repository in a temp directory and runs real `git` against it, because diff
parsing is exactly where a stub would be wrong in the same way the code is.

Tests run on Linux and macOS across Node 18, 20, and 22. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## Tech

Express, [simple-git](https://github.com/steveukx/git-js), and vanilla
JavaScript in the browser. Three runtime dependencies, no dev dependencies, no
build step for the frontend, no test framework — the tests use the one built
into Node.

Version 2.0 dropped the Electron wrapper. It added a few hundred megabytes and
a per-platform build pipeline to put a browser engine around a page your
browser already renders. See [CHANGELOG.md](CHANGELOG.md).

## Contributing

There is a list of [open issues](https://github.com/dheerajjha/reviewer/issues),
including some tagged
[good first issue](https://github.com/dheerajjha/reviewer/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).
The ones most likely to change how the tool feels:

- [#1](https://github.com/dheerajjha/reviewer/issues/1) — reviews are stored inside the install rather than with the repository
- [#2](https://github.com/dheerajjha/reviewer/issues/2) — give comments a state, so a review can be worked through and marked off
- [#3](https://github.com/dheerajjha/reviewer/issues/3) — report whether each anchor still matches the file
- [#4](https://github.com/dheerajjha/reviewer/issues/4) — expose the review over MCP, so an agent works through it interactively
- [#6](https://github.com/dheerajjha/reviewer/issues/6) — review a commit range, not just the working tree

[CONTRIBUTING.md](CONTRIBUTING.md) covers the setup and what a good change looks
like here.

## License

[MIT](LICENSE) © Dheeraj Jha
