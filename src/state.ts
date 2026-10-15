/**
 * On-disk layout of the published editor position.
 *
 * One file per editor window (`windows/<pid>.json`) instead of one shared file:
 * every VS Code window runs its own extension host, so per-pid files need no
 * locking and cannot clobber each other. Readers pick the newest mtime.
 */

import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Expand a leading `~` and resolve the state directory. */
export function resolveStateDir(configured?: string): string {
  const value = (configured ?? '').trim();
  if (value === '') return join(homedir(), '.editor-context');
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2));
  return value;
}

/** Path of one window's state file. */
export function windowFile(dir: string, pid: number): string {
  return join(dir, 'windows', `${pid}.json`);
}

/**
 * Atomically publish one window's state (write to a temp file, then rename).
 * @param dir - state directory.
 * @param pid - extension-host pid, which identifies the window.
 * @param payload - JSON-serializable state.
 */
export async function writeWindowState(dir: string, pid: number, payload: unknown): Promise<void> {
  const target = windowFile(dir, pid);
  await mkdir(join(dir, 'windows'), { recursive: true });
  const tmp = `${target}.tmp-${pid}`;
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await rename(tmp, target);
}

/** Drop one window's state file; called when the extension is disabled or unloads. */
export async function removeWindowState(dir: string, pid: number): Promise<void> {
  await rm(windowFile(dir, pid), { force: true });
}
