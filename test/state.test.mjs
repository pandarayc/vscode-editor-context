/**
 * Unit tests for the on-disk layout: the ambient window document, the public
 * mailbox, the subscriber registry and per-subscriber inboxes. Runs under plain
 * Node against `out/state.js`.
 *
 *   npm run compile && node --test test/state.test.mjs
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const require = createRequire(import.meta.url);
const {
  MAX_INBOX,
  MAX_REQUESTS,
  endpointFile,
  endpointsDir,
  isSafeSubscriberName,
  removeEndpoint,
  sweepEndpoints,
  writeEndpoint,
  readSubscribers,
  requestsDir,
  requestFile,
  subscriberInbox,
  subscribersDir,
  writeDelivery,
  writeWindowState,
} = require('../out/state.js');

const roots = [];

async function freshDir() {
  const dir = await mkdtemp(join(tmpdir(), 'editor-context-state-'));
  roots.push(dir);
  return dir;
}

/** A minimal stand-in for a delivery document. */
function document(overrides = {}) {
  return {
    version: 1,
    kind: 'editor-context/delivery',
    id: 'a',
    at: '2026-10-17T00:00:00.000Z',
    reason: 'explicit',
    target: null,
    pid: 4242,
    appName: 'Cursor',
    sig: 'src/auth.ts|sel|11-14',
    context: '[编辑器位置] /w/src/auth.ts 第 11-14 行',
    activeFile: '/w/src/auth.ts',
    relativePath: 'src/auth.ts',
    selection: { startLine: 11, endLine: 14, startColumn: 1, endColumn: 5, isEmpty: false },
    text: 'const a = 1\nconst b = 2\n',
    textTruncated: false,
    ...overrides,
  };
}

test('a mailbox document sorts chronologically and never collides', () => {
  const early = requestFile('/d', 1, 1_700_000_000_000, 1);
  const late = requestFile('/d', 1, 1_700_000_001_000, 1);
  const sameMs = requestFile('/d', 1, 1_700_000_000_000, 2);
  assert.ok(early < late, 'a lexical sort of the directory is a chronological one');
  assert.ok(early < sameMs, 'the sequence suffix breaks a same-millisecond tie');
  assert.notEqual(requestFile('/d', 1, 1_700_000_000_000, 1), requestFile('/d', 2, 1_700_000_000_000, 1));
  assert.equal(requestsDir('/d'), '/d/requests');
  assert.equal(subscribersDir('/d'), '/d/subscribers');
  assert.equal(subscriberInbox('/d', 'dsh'), '/d/subscribers/dsh/inbox');
});

test('a delivery to the public mailbox is the same document the rest carry', async () => {
  const dir = await freshDir();
  const payload = document();
  const written = await writeDelivery(dir, null, payload, 1_700_000_000_000);

  assert.equal(written.startsWith(requestsDir(dir)), true);
  assert.deepEqual(JSON.parse(await readFile(written, 'utf8')), payload, 'one schema, not a mailbox-specific one');
  assert.equal((await stat(written)).isFile(), true);
});

test('a targeted delivery lands in that subscriber inbox and nowhere else', async () => {
  const dir = await freshDir();
  const written = await writeDelivery(dir, 'dsh', document({ target: 'dsh' }), 1_700_000_000_000);

  assert.equal(written.startsWith(subscriberInbox(dir, 'dsh')), true);
  assert.deepEqual(await readdir(requestsDir(dir)).catch(() => []), [], 'a targeted send is not public');
});

test('an unsafe subscriber name is refused rather than escaped', async () => {
  const dir = await freshDir();
  for (const name of ['../escape', 'a/b', '.', '..', '', 'has space', '-lead']) {
    assert.equal(isSafeSubscriberName(name), false, name);
    await assert.rejects(() => writeDelivery(dir, name, document()), /unsafe subscriber name/);
  }
  for (const name of ['dsh', 'claude-code', 'a.b_c1']) assert.equal(isSafeSubscriberName(name), true, name);
});

test('both mailboxes are pruned, so neither can grow forever', async () => {
  const dir = await freshDir();
  const base = 1_700_000_000_000;
  for (let i = 0; i < MAX_REQUESTS + 5; i += 1) await writeDelivery(dir, null, document(), base + i);
  const publicLog = (await readdir(requestsDir(dir))).sort();
  assert.equal(publicLog.length, MAX_REQUESTS);
  assert.equal(publicLog[0].startsWith(String(base + 5)), true, 'the oldest five are gone');

  for (let i = 0; i < MAX_INBOX + 5; i += 1) await writeDelivery(dir, 'dsh', document(), base + i);
  assert.equal((await readdir(subscriberInbox(dir, 'dsh'))).length, MAX_INBOX);
});

test('the registry reads manifests the subscriber wrote', async () => {
  const dir = await freshDir();
  await mkdir(subscribersDir(dir), { recursive: true });
  await writeFile(
    join(subscribersDir(dir), 'dsh.json'),
    JSON.stringify({ label: 'DSH', includeText: true, autoSelection: true }),
    'utf8',
  );
  // Bare manifest: defaults must be "text on, continuous off".
  await writeFile(join(subscribersDir(dir), 'quiet.json'), JSON.stringify({}), 'utf8');
  await writeFile(join(subscribersDir(dir), 'explicit.json'), JSON.stringify({ includeText: false }), 'utf8');

  const found = await readSubscribers(dir);
  assert.deepEqual(
    found,
    [
      { name: 'dsh', label: 'DSH', includeText: true, autoSelection: true },
      { name: 'explicit', label: 'explicit', includeText: false, autoSelection: false },
      { name: 'quiet', label: 'quiet', includeText: true, autoSelection: false },
    ],
    'explicit sends carry text by default; a continuous feed is opt-in',
  );
});

test('an unreadable or unsafe manifest does not stop the others', async () => {
  const dir = await freshDir();
  await mkdir(subscribersDir(dir), { recursive: true });
  await writeFile(join(subscribersDir(dir), 'good.json'), JSON.stringify({ label: 'Good' }), 'utf8');
  await writeFile(join(subscribersDir(dir), 'broken.json'), '{ not json', 'utf8');
  await writeFile(join(subscribersDir(dir), 'not json.json'), 'x', 'utf8');
  await writeFile(join(subscribersDir(dir), '.json'), JSON.stringify({ label: 'nameless' }), 'utf8');
  await writeFile(join(subscribersDir(dir), 'notes.txt'), 'ignore me', 'utf8');

  assert.deepEqual((await readSubscribers(dir)).map((s) => s.name), ['good']);
  assert.deepEqual(await readSubscribers(join(dir, 'nowhere')), [], 'a missing directory is an empty registry');
});

test('the window document is untouched by all of this', async () => {
  const dir = await freshDir();
  await writeWindowState(dir, 7, document());
  await writeDelivery(dir, null, document());
  assert.deepEqual(await readdir(join(dir, 'windows')), ['7.json']);
  assert.equal((await readdir(requestsDir(dir))).length, 1);
});

test('an endpoint announcement round-trips and can be withdrawn', async () => {
  const dir = await freshDir();
  const record = {
    version: 1,
    pid: process.pid,
    port: 51234,
    url: 'ws://127.0.0.1:51234/editor-context',
    protocol: 'editor-context/1',
    appName: 'Cursor',
    extensionVersion: '0.5.0',
    workspaceFolders: ['/w'],
    requiresToken: false,
    updatedAt: '2026-10-19T00:00:00.000Z',
  };
  await writeEndpoint(dir, record);
  const file = endpointFile(dir, process.pid);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), record);
  assert.equal('token' in (JSON.parse(await readFile(file, 'utf8'))), false, 'a secret never goes in the registry');

  await removeEndpoint(dir, process.pid);
  await assert.rejects(stat(file), 'withdrawing removes the file rather than emptying it');
});

test('the sweep drops dead and stale announcements, and leaves everything else alone', async () => {
  const dir = await freshDir();
  await mkdir(endpointsDir(dir), { recursive: true });
  const at = (pid) => join(endpointsDir(dir), `${pid}.json`);
  const old = new Date(Date.now() - 3_600_000);

  await writeFile(at(100), '{}', 'utf8'); // alive, fresh
  await writeFile(at(200), '{}', 'utf8'); // pid gone
  await writeFile(at(300), '{}', 'utf8'); // pid alive but no heartbeat for an hour
  await writeFile(at(process.pid), '{}', 'utf8'); // our own
  await writeFile(join(endpointsDir(dir), 'notes.txt'), 'not ours', 'utf8');
  await utimes(at(300), old, old);

  const removed = await sweepEndpoints(dir, { isAlive: (pid) => pid === 100 || pid === 300 });
  assert.deepEqual(removed.sort(), [200, 300]);
  assert.deepEqual((await readdir(endpointsDir(dir))).sort(), ['100.json', `${String(process.pid)}.json`, 'notes.txt']);
  assert.deepEqual(await sweepEndpoints(join(dir, 'nowhere')), [], 'a missing directory is an empty registry');
});

after(async () => {
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
});
