---
name: review
description: Open the working-directory changes in the user's browser as a pull-request-style review, wait for them to submit it, then apply every comment. Use when the user asks to review your changes, wants to comment on the diff before you go on, or says "let me review".
---

# Review the changes in the browser

The user reads the diff in a pull-request view, leaves comments on the exact
lines they mean, and presses **Submit Review**. The review then comes back to
you as text. No branch, no push and no account are involved.

## Claude Code

1. Run this with `run_in_background: true`, because it waits for the user:

   ```bash
   npx -y git-reviewer@latest
   ```

   Add `--staged` to review only staged changes, or pass a path to review
   another repository.
2. Tell the user the review is open in their browser. If no browser opened
   (a remote machine), the command prints the address on stderr: give it to
   them. Say you will act on the review when they press **Submit Review**.
3. Wait. Do not edit files while the user is reading; it moves the lines they
   are commenting on.
4. When the command finishes, read its output. That output is the review:
   each comment names a file and a line and says what to change.

## Other agents

If your shell tool cannot leave a command running while you wait, ask the user
to run `npx git-reviewer` in their own terminal, review, and press **Submit
Review**. Then read the review with:

```bash
npx -y git-reviewer@latest export . --format prompt
```

## Applying the review

- Work through every comment, including the threaded replies under it.
- Line numbers can be out of date if the code moved; find the code the
  comment quotes, not just the line number.
- If you disagree with a comment, say so and why instead of skipping it.
- Then reply with what you changed for each comment, and run the project's
  checks before you say it is done.
