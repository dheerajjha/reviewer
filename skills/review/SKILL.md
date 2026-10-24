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

## Answering the reviewer while they review

The user may want to ask you about the code as they read it, rather than
hand you a finished review. You are the agent that wrote it, so you can say
why it is the way it is. Follow the review and answer in its threads:

1. Run this in the background, so that you hear about every line it prints.
   In Claude Code, use the Monitor tool:

   ```bash
   npx -y git-reviewer@latest watch
   ```

   Each line is one comment waiting for you, as JSON: its `key`, `file`,
   `line`, the reviewer's latest message in `text`, and the whole `thread`.
2. For each one, read the code it points at and answer. The answer goes on
   stdin, so quotes, backticks and new lines need no escaping:

   ```bash
   npx -y git-reviewer@latest reply <key> - <<'EOF'
   <your answer>
   EOF
   ```

   The answer appears under the comment in the user's browser straight away.
   Keep it short, explain your reasoning, and do not change files unless the
   comment asks you to; say what you would change instead.
3. Keep going until the user says they are done, then stop the watch.

The user can also connect a session from the review page (**Ask Claude
Code**) or with `npx git-reviewer connect` in a terminal; then the comments
come to that session without any of this.

## Applying the review

- Work through every comment, including the threaded replies under it.
- Line numbers can be out of date if the code moved; find the code the
  comment quotes, not just the line number.
- If you disagree with a comment, say so and why instead of skipping it.
- Then reply with what you changed for each comment, and run the project's
  checks before you say it is done.
