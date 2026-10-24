'use strict';

const fs = require('fs');
const path = require('path');

/**
 * The Claude Code executable, as something `spawn` can start without a shell.
 *
 * Everywhere but Windows that is just the name: `spawn` searches the PATH.
 * On Windows `spawn` runs only `.exe` and `.com` files without a shell, and
 * refuses a `.cmd` outright (EINVAL, since Node 18.20.2 and 20.12.2). Claude
 * Code installed through npm is reached through exactly that, a `claude.cmd`
 * shim. The npm package carries the native `claude.exe` the shim starts,
 * though, so that is found and run directly.
 *
 * A shell is never the answer here. The arguments include a session's title
 * and an inline MCP config, and cmd.exe would read their quotes and
 * metacharacters as its own.
 *
 * @param {string} command `claude`, or a path from REVIEWER_CLAUDE
 * @param {object} [options] injectable for tests
 * @param {string} [options.platform]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {(file: string) => boolean} [options.exists]
 * @param {(file: string) => string} [options.read]
 * @returns {string}
 */
function resolveClaudeCommand(command, {
  platform = process.platform,
  env = process.env,
  exists = fs.existsSync,
  read = file => fs.readFileSync(file, 'utf-8')
} = {}) {
  if (platform !== 'win32') return command;
  const win = path.win32;

  const candidates = [];
  if (/[\\/]/.test(command)) {
    candidates.push(command);
  } else {
    const extensions = win.extname(command) ? [''] : ['.exe', '.com', '.cmd', '.bat'];
    for (const dir of (env.PATH ?? env.Path ?? '').split(';').filter(Boolean)) {
      for (const extension of extensions) candidates.push(win.join(dir, `${command}${extension}`));
    }
  }

  for (const candidate of candidates) {
    if (!exists(candidate)) continue;
    const extension = win.extname(candidate).toLowerCase();
    if (extension === '.exe' || extension === '.com') return candidate;
    if (extension === '.cmd' || extension === '.bat') {
      const target = shimTarget(candidate, { exists, read });
      if (target) return target;
    }
  }

  // Nothing better found: spawn fails, and the error says what to set.
  return command;
}

/**
 * The executable an npm `.cmd` shim starts.
 *
 * Where npm puts the package beside the shim, the binary is at a known
 * place. Otherwise the shim names it: npm's shims start the target as
 * `"%dp0%\path\to\target.exe"`, relative to the shim's own directory.
 *
 * @param {string} shim
 * @param {{exists: (file: string) => boolean, read: (file: string) => string}} io
 * @returns {string|null}
 */
function shimTarget(shim, { exists, read }) {
  const win = path.win32;
  const dir = win.dirname(shim);
  const packaged = win.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  if (exists(packaged)) return packaged;

  let text;
  try {
    text = read(shim);
  } catch {
    return null;
  }
  const named = text.match(/"%~?dp0%?\\([^"]+\.exe)"/i);
  if (!named) return null;
  const target = win.join(dir, named[1]);
  return exists(target) ? target : null;
}

module.exports = { resolveClaudeCommand };
