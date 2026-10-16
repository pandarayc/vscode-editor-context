/**
 * On-disk layout of the published editor position.
 *
 * One file per editor window (`windows/<pid>.json`) instead of one shared file:
 * every VS Code window runs its own extension host, so per-pid files need no
 * locking and cannot clobber each other. Readers pick the newest mtime.
 *
 * A *request* (`requests/<epoch-ms>-<pid>.json`) is the same document written
 * once, on purpose, instead of continuously. There is deliberately no second
 * schema: a request is a position reading that was asked for, and every consumer
 * parses both directories with the same code.
 */

import { mkdir, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';

import type { SubscriberManifest } from './core';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** How many request documents to keep; older ones are pruned on each write. */
export const MAX_REQUESTS = 20;

/** How many deliveries one subscriber's inbox keeps. */
export const MAX_INBOX = 50;

/**
 * Subscriber names become path segments, so they are restricted to a single
 * safe segment. Anything else is ignored rather than escaped: a manifest the
 * extension cannot trust is not worth reading.
 */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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

/** Directory holding one-shot request documents. */
export function requestsDir(dir: string): string {
  return join(dir, 'requests');
}

/**
 * Path of one document in the public mailbox.
 *
 * The name is `<epoch-ms>-<pid>-<seq>.json`: fixed-width timestamp first, so a
 * plain lexical sort of the directory is also a chronological one, and the
 * sequence suffix keeps two deliveries in the same millisecond from overwriting
 * each other — a silent overwrite being exactly the kind of bug nobody sees.
 * @param dir - state directory.
 * @param pid - extension-host pid.
 * @param at - epoch milliseconds.
 * @param seq - per-process delivery counter.
 * @returns the absolute path.
 */
export function requestFile(dir: string, pid: number, at: number, seq: number): string {
  return join(requestsDir(dir), `${at}-${pid}-${seq}.json`);
}

/** Write one JSON document atomically (temp file in the same directory, then rename). */
async function writeAtomic(target: string, payload: unknown): Promise<void> {
  const tmp = `${target}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await rename(tmp, target);
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
  await writeAtomic(target, payload);
}

/**
 * Keep the newest `keep` request documents.
 *
 * The directory is a mailbox, not a log: a consumer only ever wants the recent
 * ones, and pruning here means the producer owns the lifetime of its own files
 * rather than leaving that to a reader.
 * @param dir - state directory.
 * @param keep - how many to retain.
 */
export async function pruneRequests(dir: string, keep: number): Promise<void> {
  let names: string[];
  try {
    names = await readdir(requestsDir(dir));
  } catch {
    return;
  }
  const documents = names.filter((name) => name.endsWith('.json')).sort();
  for (const name of documents.slice(0, Math.max(0, documents.length - keep))) {
    await unlink(join(requestsDir(dir), name)).catch(() => undefined);
  }
}

/** Drop one window's state file; called when the extension is disabled or unloads. */
export async function removeWindowState(dir: string, pid: number): Promise<void> {
  await rm(windowFile(dir, pid), { force: true });
}

/* -------------------------------------------------------------------------- */
/*  Subscribers                                                                */
/* -------------------------------------------------------------------------- */

/** Directory holding subscriber manifests. */
export function subscribersDir(dir: string): string {
  return join(dir, 'subscribers');
}

/** Path of one subscriber's manifest. */
export function subscriberManifestFile(dir: string, name: string): string {
  return join(subscribersDir(dir), `${name}.json`);
}

/** Inbox a targeted delivery is written into. */
export function subscriberInbox(dir: string, name: string): string {
  return join(subscribersDir(dir), name, 'inbox');
}

/** Whether a name may be used as a path segment. */
export function isSafeSubscriberName(name: unknown): name is string {
  return typeof name === 'string' && SAFE_NAME.test(name) && name !== '.' && name !== '..';
}

/**
 * Read the registry.
 *
 * A manifest is the whole registration protocol, and it is written by the
 * subscriber: the extension never creates one, so it can gain a consumer without
 * being updated. A file it cannot parse, or whose name is unsafe, is skipped
 * silently — one broken subscriber must not stop the others from being served.
 * @param dir - state directory.
 * @returns the subscribers, sorted by name.
 */
export async function readSubscribers(dir: string): Promise<SubscriberManifest[]> {
  let names: string[];
  try {
    names = await readdir(subscribersDir(dir));
  } catch {
    return [];
  }
  const found: SubscriberManifest[] = [];
  for (const file of names.sort()) {
    if (!file.endsWith('.json')) continue;
    const name = file.slice(0, -'.json'.length);
    if (!isSafeSubscriberName(name)) continue;
    try {
      const raw: unknown = JSON.parse(await readFile(subscriberManifestFile(dir, name), 'utf8'));
      if (typeof raw !== 'object' || raw === null) continue;
      const record = raw as Record<string, unknown>;
      found.push({
        name,
        label: typeof record.label === 'string' && record.label.trim() !== '' ? record.label.trim() : name,
        // Text on unless the subscriber declined it: an explicit send carrying an
        // address and no content is rarely what anyone wanted. A *continuous*
        // feed is the opposite — opt-in, because it writes file contents to disk
        // without anyone having asked just then.
        includeText: record.includeText !== false,
        autoSelection: record.autoSelection === true,
      });
    } catch {
      continue;
    }
  }
  return found;
}

/**
 * Publish one delivery.
 *
 * `target === null` means the public mailbox: the log every consumer can read,
 * including ones that cannot register — a hook script runs only when a prompt is
 * sent, so it has nowhere to put a manifest.
 * @param dir - state directory.
 * @param target - subscriber name, or `null` for the public mailbox.
 * @param payload - the delivery.
 * @param at - epoch milliseconds; defaults to now.
 * @returns the path written.
 * @throws when `target` is not a safe path segment.
 */
export async function writeDelivery(
  dir: string,
  target: string | null,
  payload: unknown,
  at: number = Date.now(),
): Promise<string> {
  const seq = ++deliverySeq;
  if (target === null) {
    await mkdir(requestsDir(dir), { recursive: true });
    const to = requestFile(dir, process.pid, at, seq);
    await writeAtomic(to, payload);
    await pruneRequests(dir, MAX_REQUESTS);
    return to;
  }
  if (!isSafeSubscriberName(target)) throw new Error(`refusing unsafe subscriber name ${JSON.stringify(target)}`);
  const inbox = subscriberInbox(dir, target);
  await mkdir(inbox, { recursive: true });
  const to = join(inbox, `${at}-${process.pid}-${String(seq)}.json`);
  await writeAtomic(to, payload);
  await pruneInbox(inbox, MAX_INBOX);
  return to;
}

/** Monotonic suffix for delivery file names within this process. */
let deliverySeq = 0;

/** Keep the newest `keep` documents in one inbox. */
export async function pruneInbox(inbox: string, keep: number): Promise<void> {
  let names: string[];
  try {
    names = await readdir(inbox);
  } catch {
    return;
  }
  const documents = names.filter((name) => name.endsWith('.json')).sort();
  for (const name of documents.slice(0, Math.max(0, documents.length - keep))) {
    await unlink(join(inbox, name)).catch(() => undefined);
  }
}
