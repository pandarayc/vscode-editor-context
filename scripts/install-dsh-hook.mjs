#!/usr/bin/env node
/**
 * Install the `UserPromptSubmit` hook that feeds the editor position to DSH.
 *
 * Copies `hooks/editor_context.py` next to the user's other DSH hooks and merges
 * a `UserPromptSubmit` entry into their `hooks.json`, preserving every existing
 * hook. Idempotent: re-running replaces this hook's entry instead of appending
 * a duplicate.
 *
 * Usage:
 *   node scripts/install-dsh-hook.mjs [--hooks-dir <dir>] [--timeout <seconds>]
 *   node scripts/install-dsh-hook.mjs --print     # show the entry without writing
 *
 * Defaults: --hooks-dir ~/.dsh/hooks, --timeout 5.
 *
 * NOTE: `configPath` is read once at DSH process start — restart dsh-web after
 * changing hooks.json. See ~/.dsh/profiles/web/cordis.patch.yml.
 */

import { cp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT_NAME = 'editor_context.py';
const MARKER = SCRIPT_NAME;

/** Parse `--key value` pairs and bare flags. */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === undefined || !key.startsWith('--')) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      out[key.slice(2)] = true;
      continue;
    }
    out[key.slice(2)] = value;
    i += 1;
  }
  return out;
}

/** Expand a leading `~`. */
function expand(path) {
  return resolve(path.replace(/^~(?=\/|$)/, homedir()));
}

/** Prefer a `$HOME`-relative spelling so the config survives on other machines. */
function shellCommandFor(scriptPath) {
  const home = homedir();
  if (scriptPath.startsWith(`${home}/`)) {
    return `python3 "$HOME/${scriptPath.slice(home.length + 1)}"`;
  }
  return `python3 "${scriptPath}"`;
}

/** The one group this installer owns. */
function buildEntry(scriptPath, timeout) {
  return {
    hooks: [
      {
        type: 'command',
        command: shellCommandFor(scriptPath),
        timeout,
      },
    ],
  };
}

/** Whether a group is the one this installer owns. */
function isOurs(group) {
  return (
    Array.isArray(group?.hooks) &&
    group.hooks.some((hook) => typeof hook?.command === 'string' && hook.command.includes(MARKER))
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const hooksDir = expand(typeof args['hooks-dir'] === 'string' ? args['hooks-dir'] : join(homedir(), '.dsh', 'hooks'));
  const timeout = Number(typeof args.timeout === 'string' ? args.timeout : 5);
  const source = join(ROOT, 'hooks', SCRIPT_NAME);
  const scriptPath = join(hooksDir, SCRIPT_NAME);
  const configPath = join(hooksDir, 'hooks.json');
  const entry = buildEntry(scriptPath, Number.isFinite(timeout) ? timeout : 5);

  if (!existsSync(source)) throw new Error(`hook script missing from the package: ${source}`);

  const config = existsSync(configPath) ? JSON.parse(await readFile(configPath, 'utf8')) : {};
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error(`${configPath} is not a JSON object; refusing to rewrite it`);
  }
  config.hooks = typeof config.hooks === 'object' && config.hooks !== null ? config.hooks : {};
  const existing = Array.isArray(config.hooks.UserPromptSubmit) ? config.hooks.UserPromptSubmit : [];
  config.hooks.UserPromptSubmit = [...existing.filter((group) => !isOurs(group)), entry];

  if (args.print === true) {
    console.log(JSON.stringify({ hooks: { UserPromptSubmit: [entry] } }, null, 2));
    return;
  }

  await cp(source, scriptPath);
  if (existsSync(configPath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await cp(configPath, `${configPath}.bak-editorcontext-${stamp}`);
    console.log(`backup    ${configPath}.bak-editorcontext-${stamp}`);
  }
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  console.log(`hook      ${scriptPath}`);
  console.log(`config    ${configPath}`);
  console.log(`entry     ${JSON.stringify(entry.hooks[0])}`);
  console.log(`kept      PreToolUse=${(config.hooks.PreToolUse ?? []).length} PostToolUse=${(config.hooks.PostToolUse ?? []).length} other UserPromptSubmit=${existing.filter((g) => !isOurs(g)).length}`);
  console.log('');
  console.log('next: RESTART dsh-web — configPath is read once at process start.');
  console.log(`verify: echo '{"session_id":"t1"}' | python3 ${scriptPath}`);
}

main().catch((error) => {
  console.error(`install failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
