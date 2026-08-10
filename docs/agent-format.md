# Handing a review to a coding agent

A review is only half the work. The other half is applying it, and that is the
part worth automating: the comments are already written, in one file, about one
repository.

```bash
reviewer export . --format prompt | claude -p "Apply this review to the repo."
```

`reviewer export` prints the review you saved in the UI, without a server
running and without submitting anything. Two formats:

- `--format json` (default) — the review document described below.
- `--format prompt` — the same content as instructions for a coding agent,
  ready to pipe.

Add `--file <repo-relative-path>` to export only one file's comments. The
document's `summary` is recalculated to describe the filtered output:

```bash
reviewer export . --file src/auth.js --format prompt
```

Submitting a review in the UI also writes the JSON form next to the `.txt`,
as `reviews/review_<repo>_<timestamp>.json`.

## Why not just hand over the `.txt`?

The `.txt` review is written for a person. An agent needs two things it does
not offer:

**A stable anchor.** Every comment records `anchor`, the exact text of the line
it was left on. Line numbers start going stale the moment the agent makes its
first edit — everything below it shifts — so an agent that navigates by line
number is working from coordinates it is actively invalidating. The anchor is
what survives. The `prompt` format says this to the agent explicitly, and tells
it to report rather than guess when an anchor has vanished.

**A schema.** `code-review/v1` is a fixed shape a tool can rely on, rather than
Markdown that has to be parsed back out of prose.

## The document

```json
{
  "schema": "code-review/v1",
  "generatedAt": "2026-08-10T17:54:51.899Z",
  "repository": {
    "path": "/work/api-service",
    "name": "api-service",
    "head": "abe3b3796fb8e2e943bcbed18400daa155fec500",
    "branch": "main"
  },
  "mode": "working",
  "summary": { "comments": 2, "files": 1 },
  "comments": [
    {
      "id": "src/auth.js:10",
      "file": "src/auth.js",
      "line": 10,
      "anchor": "  if (scheme !== SCHEME || !token) return null;",
      "selection": "scheme !== SCHEME",
      "body": "Reject an empty token too.",
      "followUps": [
        { "body": "Still open after the rebase", "at": "2026-08-10T14:00:00.000Z" }
      ]
    }
  ]
}
```

| Field | Notes |
|---|---|
| `schema` | `code-review/v1`. Check it before trusting the rest. |
| `generatedAt` | ISO 8601, when the document was produced. |
| `repository.path` | Absolute path of the reviewed repository. |
| `repository.name` | Directory name, sanitized for use in filenames. |
| `repository.head` | The commit reviewed, or `null` if git would not say. Compare it against the current `HEAD` to tell whether the tree has moved on. |
| `repository.branch` | Branch name, or `null`. |
| `mode` | `working` (working tree vs `HEAD`), `lastCommit` (`HEAD` vs its parent), or `null` when exported outside a session. |
| `summary` | `comments` and `files` counts. |
| `comments[].id` | `<file>:<line>`. Stable across exports of the same review. |
| `comments[].file` | Repo-relative path. |
| `comments[].line` | Line number when the comment was written — a hint, not an address. |
| `comments[].anchor` | The exact source line, or `null` if none was recorded. **Locate comments by this.** |
| `comments[].selection` | The snippet highlighted, when the reviewer selected one. Omitted otherwise. |
| `comments[].body` | The comment text. |
| `comments[].followUps` | Threaded replies, each `{ body, at? }`. Omitted when there are none. |

Optional fields are omitted rather than set to `null`, so `"selection" in
comment` is a meaningful test. Comments are grouped by file in the order the
files were first commented on, and ordered by line within a file.

## Notes for consumers

- **Check `repository.head`.** If it does not match the current `HEAD`, the
  code has changed since the review; anchors may not be found, and that is
  worth reporting rather than working around.
- **Treat a missing anchor as a question, not a licence to guess.** If the line
  is gone, the change it commented on may already have been made.
- Both formats are printed to stdout and nothing else is, so they pipe cleanly.
  Errors go to stderr with a non-zero exit.

## Ideas

Better integrations are exactly the kind of thing this project wants
contributions for — a watch mode that exports on every save, a `--since`
filter, writing results back so applied comments get marked resolved. See the
[open issues](https://github.com/dheerajjha/reviewer/issues).
