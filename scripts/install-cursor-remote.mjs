#!/usr/bin/env node
/**
 * Install this extension into a Cursor / VS Code **remote server** extension
 * directory (Remote-SSH, dev containers, WSL).
 *
 * In a remote window there is no `cursor`/`code` CLI on the host, so the usual
 * `--install-extension` route is unavailable. This script does what the server
 * itself does: unpack the VSIX into `extensions/<publisher>.<name>-<version>/`
 * and register it in `extensions/extensions.json`.
 *
 * Usage:
 *   node scripts/install-cursor-remote.mjs [--vsix <file>] [--server <dir>]
 *
 * Defaults: --vsix ./<name>-<version>.vsix, --server ~/.cursor-server
 * (falls back to ~/.vscode-server when --server is absent and only that exists).
 */

import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Parse `--key value` pairs. */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === undefined || !key.startsWith('--')) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) continue;
    out[key.slice(2)] = value;
    i += 1;
  }
  return out;
}

/** Pick the remote server directory, honoring an explicit override. */
function resolveServerDir(explicit) {
  if (explicit !== undefined) return resolve(explicit.replace(/^~(?=\/|$)/, homedir()));
  const candidates = [join(homedir(), '.cursor-server'), join(homedir(), '.vscode-server')];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'extensions'))) return candidate;
  }
  throw new Error(`no remote server directory found (looked for ${candidates.join(', ')})`);
}

/** Stamp a timestamped backup next to a file and return its path. */
async function backup(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `${file}.bak-editorcontext-${stamp}`;
  await cp(file, target);
  return target;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const id = `${manifest.publisher}.${manifest.name}`;
  const vsix = resolve(args.vsix ?? join(ROOT, `${manifest.name}-${manifest.version}.vsix`));
  const server = resolveServerDir(args.server);
  const extensionsDir = join(server, 'extensions');
  const target = join(extensionsDir, `${id}-${manifest.version}`);

  if (!existsSync(vsix)) throw new Error(`VSIX not found: ${vsix}`);

  // 1. Unpack the VSIX and lay the payload out the way the server does.
  const staging = await mkdtemp(join(tmpdir(), 'editor-context-install-'));
  try {
    const unzip = spawnSync('unzip', ['-q', '-o', vsix, '-d', staging], { encoding: 'utf8' });
    if (unzip.status !== 0) {
      throw new Error(`unzip failed (${String(unzip.status)}): ${unzip.stderr || 'is unzip installed?'}`);
    }
    const payload = join(staging, 'extension');
    if (!existsSync(payload)) throw new Error(`unexpected VSIX layout: ${payload} missing`);

    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    await cp(payload, target, { recursive: true });
    // The server stores the manifest under a dot-name.
    const vsixManifest = join(target, 'extension.vsixmanifest');
    if (existsSync(vsixManifest)) await rename(vsixManifest, join(target, '.vsixmanifest'));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  // 2. Register it in the extensions cache, replacing any previous entry.
  const cacheFile = join(extensionsDir, 'extensions.json');
  const cache = existsSync(cacheFile) ? JSON.parse(await readFile(cacheFile, 'utf8')) : [];
  if (!Array.isArray(cache)) throw new Error(`${cacheFile} is not a JSON array; refusing to rewrite it`);
  const kept = cache.filter((entry) => entry?.identifier?.id !== id);
  const uuid = randomUUID();
  kept.push({
    identifier: { id, uuid },
    version: manifest.version,
    location: { $mid: 1, path: target, scheme: 'file' },
    relativeLocation: `${id}-${manifest.version}`,
    metadata: {
      installedTimestamp: Date.now(),
      source: 'vsix',
      id: uuid,
      // The publisher's id, which for a VSIX is the manifest's publisher name.
      // This used to be the literal 'local', which silently went stale the
      // moment the manifest changed publisher and left the cache disagreeing
      // with the directory it had just written.
      publisherId: manifest.publisher,
      publisherDisplayName: manifest.publisher,
      targetPlatform: 'undefined',
      updated: false,
      isPreReleaseVersion: false,
      hasPreReleaseVersion: false,
    },
  });
  const saved = await backup(cacheFile);
  await writeFile(cacheFile, JSON.stringify(kept), 'utf8');

  console.log(`installed ${id}@${manifest.version}`);
  console.log(`  payload   ${target}`);
  console.log(`  manifest  ${join(target, '.vsixmanifest')}`);
  console.log(`  cache     ${cacheFile} (${kept.length} entries, backup ${saved})`);
  console.log('');
  console.log('next: in Cursor run "Developer: Reload Window", then open a file and check');
  console.log(`      ${join(homedir(), '.editor-context', 'windows')}/`);
}

main().catch((error) => {
  console.error(`install failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
