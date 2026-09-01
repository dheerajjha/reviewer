# Contributing

Thanks for taking the time. This is a small, dependency-light project and the
bar for a change is simple: it should be easy to read six months from now, and
it should come with a test that fails without it.

## Getting set up

```bash
git clone https://github.com/dheerajjha/reviewer.git
cd reviewer
npm install
npm test
```

There are three runtime dependencies and no dev dependencies, so this is a
small, fast install with no build step.

Run the app while you work:

```bash
npm start           # opens a browser on the current repository
npm run serve       # bare server, opens nothing
```

## Running the tests

```bash
npm test              # once
npm run test:watch    # re-run on change
npm run test:coverage # with coverage
```

The tests use the Node test runner, so there is no test framework to install
and no configuration file to learn. Two kinds of test live in `test/`:

- **Unit tests** for the modules in `lib/`. These are pure functions and a
  session store; they need no fixtures and run in milliseconds.
- **HTTP tests** in `test/server.test.js`. Each one creates a real repository in
  a temporary directory, runs real `git` commands against it, and drives the
  server over HTTP on an ephemeral port. Diff parsing and status mapping are
  exactly where a stub would be wrong in the same way the code is, so they are
  not stubbed.

`test/helpers/repo.js` has the fixtures: `createTempRepo`, `writeFiles`,
`commitFiles`, `cleanup`. Register cleanup with `t.after` so a failing test
still removes its directory.

## What a good change looks like

**Put logic in `lib/`, not in a request handler.** The handlers in `server.js`
should read as a list of steps: look up the session, do the thing, answer. If
you find yourself writing a loop or a branch inside one, that is a sign the
logic belongs in a module where it can be tested directly.

**Write the test that fails first.** Every bug fixed in 1.1.0 has a test named
after the symptom rather than the function — `parseDiff does not read a second
file header as content`, `GET /api/file refuses to read outside the
repository`. When the test name describes what a user would have noticed, the
next person can tell at a glance whether it still matters.

**Say why, not what, in comments.** The code says what it does. A comment earns
its place by explaining the constraint that is not visible from the code — why
a path is rejected, why a timestamp is ISO 8601, why a bucket order matters.

**Keep the dependency list short.** Three runtime dependencies today. A change
that adds a fourth should say in the pull request why the thing it does cannot
reasonably be done without it.

## Anything that touches paths

The server reads files out of whatever repository the user opened, so any code
that turns request input into a filesystem path goes through
`resolveRepoFile()` in `lib/paths.js`. If you add an endpoint that reads a
file, use it, and add a test that the endpoint refuses
`..%2f..%2fetc%2fpasswd`. There is one in `test/server.test.js` to copy.

## Commits and pull requests

- One logical change per pull request.
- Describe the symptom in the pull request body, not just the fix.
- Add a `CHANGELOG.md` entry under `## [Unreleased]` for anything a user would
  notice — a fixed bug, a new flag, a changed output format.
- If you add or remove a test, update the test-count badge in `README.md`.
  `test/readme.test.js` fails until you do. Use the number of `test(...)`
  declarations, which is what that test counts — not the total `node --test`
  prints, which is one higher because it scores `test/helpers/repo.js` as a
  test.
- CI must be green: tests run on Linux and macOS across Node 18, 20, and 22.
  Windows is not in the matrix — its runners never picked up a job on this
  repository — so if you are on Windows, say so in the pull request, since your
  local run is the only signal we get.

## Reporting a bug

Open an issue with the repository state that triggered it — was the tree clean
or dirty, was the file new, staged, deleted, renamed. Most of the interesting
bugs in this project have been a git state nobody had tried yet.

## Security

If you find a way to read a file outside the opened repository, or anything
else with a security impact, please report it privately through GitHub's
[security advisories](https://github.com/dheerajjha/reviewer/security/advisories/new)
rather than in a public issue.
