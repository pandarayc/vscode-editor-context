/**
 * Unit tests for the delivery model: what a subscriber receives, how much text
 * it carries, and which subscribers an event reaches. Pure logic from
 * `out/core.js`.
 *
 *   npm run compile && node --test test/delivery.test.mjs
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { DELIVERY_KIND, buildDelivery, fitText, isLoopbackHost, policyFromFrame, recipients, renderContext } = require('../out/core.js');

/** A four-line selection in `src/auth.ts`, plus the delivery envelope. */
function input(overrides = {}) {
  return {
    pid: 4242,
    appName: 'Cursor',
    now: '2026-10-17T00:00:00.000Z',
    workspaceFolders: ['/w'],
    activeFile: '/w/src/auth.ts',
    relativePath: 'src/auth.ts',
    languageId: 'typescript',
    selection: { startLine: 11, endLine: 14, startColumn: 1, endColumn: 5, isEmpty: false },
    excludeGlobs: [],
    language: 'zh',
    id: 'id-1',
    reason: 'explicit',
    target: null,
    selectedText: 'const a = 1\nconst b = 2\n',
    includeText: true,
    maxTextBytes: 20_000,
    ...overrides,
  };
}

/** A subscriber manifest. */
function subscriber(name, overrides = {}) {
  return { name, label: name, includeText: true, autoSelection: false, ...overrides };
}

test('fitText: nothing is shipped unless it was asked for', () => {
  assert.deepEqual(fitText('hello', false, 100), { text: '', truncated: false });
  assert.deepEqual(fitText('', true, 100), { text: '', truncated: false });
  assert.deepEqual(fitText('hello', true, 100), { text: 'hello', truncated: false });
});

test('fitText cuts on a byte budget without leaving a broken character', () => {
  const cut = fitText('a'.repeat(50), true, 10);
  assert.equal(cut.truncated, true);
  assert.equal(cut.text.length, 10);

  // A multi-byte character straddling the budget must not become U+FFFD, which
  // is what a naive `subarray` leaves behind.
  const chinese = fitText('中文'.repeat(20), true, 7);
  assert.equal(chinese.truncated, true);
  assert.equal(chinese.text.includes('\uFFFD'), false);
  assert.equal(Buffer.byteLength(chinese.text, 'utf8') <= 7, true);

  assert.deepEqual(fitText('anything', true, 0), { text: 'anything', truncated: false }, 'zero disables the cap');
});

test('a delivery carries the address, the text, and the reason', () => {
  const delivery = buildDelivery(input());
  assert.equal(delivery.kind, DELIVERY_KIND);
  assert.equal(delivery.version, 1);
  assert.equal(delivery.id, 'id-1');
  assert.equal(delivery.reason, 'explicit');
  assert.equal(delivery.target, null);
  assert.equal(delivery.text, 'const a = 1\nconst b = 2\n');
  assert.equal(delivery.textTruncated, false);
  assert.equal(delivery.address, '[编辑器位置] /w/src/auth.ts 第 11-14 行');
  assert.equal(delivery.activeFile, '/w/src/auth.ts');
  assert.deepEqual(delivery.selection, { startLine: 11, endLine: 14, startColumn: 1, endColumn: 5, isEmpty: false });
  assert.equal(delivery.sig, 'src/auth.ts|sel|11-14');
});

test('a delivery shares its position field names with the ambient window file', () => {
  // A consumer that already parses `windows/<pid>.json` must find what it expects.
  const delivery = buildDelivery(input());
  for (const field of ['pid', 'appName', 'updatedAt', 'sig', 'workspaceFolders', 'activeFile', 'relativePath', 'languageId', 'selection']) {
    assert.equal(field in delivery, true, field);
  }
  assert.equal(delivery.address, renderContext(input()), 'the address is rendered once, by the same function');
  assert.equal(
    'context' in delivery,
    false,
    'the ambient file calls its hook text `context`; one key meaning two things is how parsers go wrong',
  );
});

test('the text and the range together survive the file changing underneath', () => {
  // The point of shipping the text: a pointer goes stale, a snapshot does not.
  const delivery = buildDelivery(input({ selectedText: 'export function login(u) {\n  return u;\n}' }));
  assert.equal(delivery.text.includes('return u;'), true, 'the agent has the code as it was');
  assert.deepEqual(delivery.selection, { startLine: 11, endLine: 14, startColumn: 1, endColumn: 5, isEmpty: false });
  assert.equal(delivery.at, '2026-10-17T00:00:00.000Z', 'and when it was, so the two can be compared later');
});

test('policyFromFrame fills in the safe defaults', () => {
  assert.deepEqual(policyFromFrame({ type: 'subscribe' }, 'ws-1'), {
    name: 'ws-1',
    label: 'ws-1',
    includeText: true,
    autoSelection: false,
  });
  assert.deepEqual(policyFromFrame({ type: 'subscribe', name: 'dsh', label: 'DSH' }, 'ws-1'), {
    name: 'dsh',
    label: 'DSH',
    includeText: true,
    autoSelection: false,
  });
  assert.equal(policyFromFrame({ type: 'subscribe', includeText: false }, 'ws-1').includeText, false);
  assert.equal(policyFromFrame({ type: 'subscribe', autoSelection: true }, 'ws-1').autoSelection, true);
  assert.equal(policyFromFrame({ type: 'subscribe', name: '  ' }, 'ws-1').name, 'ws-1', 'blank falls back');
});

test('only a loopback bind is allowed to go without a token', () => {
  for (const host of ['127.0.0.1', '::1', 'localhost', 'LOCALHOST', ' 127.0.0.1 ']) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ['0.0.0.0', '192.168.1.5', '::', 'example.com']) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});

test('an excluded path produces no delivery at all, not an empty one', () => {
  assert.equal(buildDelivery(input({ relativePath: '.env', excludeGlobs: ['**/.env'] })), undefined);
  assert.equal(
    buildDelivery(input({ activeFile: '', relativePath: '', selection: null, selectedText: '' })),
    undefined,
    'and neither does having nothing open',
  );
});

test('a subscriber that declines text still gets the address', () => {
  const quiet = buildDelivery(input({ includeText: false, target: 'quiet' }));
  assert.equal(quiet.text, '');
  assert.equal(quiet.textTruncated, false);
  assert.equal(quiet.address, '[编辑器位置] /w/src/auth.ts 第 11-14 行');
  assert.equal(quiet.target, 'quiet');
});

test('an explicit send reaches everyone; a named one reaches only that subscriber', () => {
  const all = [subscriber('dsh'), subscriber('claude', { autoSelection: true }), subscriber('quiet')];
  assert.deepEqual(recipients(all, 'explicit', null).map((s) => s.name), ['dsh', 'claude', 'quiet']);
  assert.deepEqual(recipients(all, 'explicit', 'claude').map((s) => s.name), ['claude']);
  assert.deepEqual(recipients(all, 'explicit', 'nobody'), [], 'an unknown target reaches nobody, silently');
  assert.deepEqual(recipients([], 'explicit', null), []);
});

test('a selection change reaches only the subscribers that asked for a feed', () => {
  const all = [subscriber('dsh'), subscriber('claude', { autoSelection: true }), subscriber('watcher', { autoSelection: true })];
  assert.deepEqual(recipients(all, 'change', null).map((s) => s.name), ['claude', 'watcher']);
  assert.deepEqual(recipients([subscriber('dsh')], 'change', null), [], 'nobody opted in, so nothing is written to disk');
  // `target` is meaningless for a change, and must not widen the set.
  assert.deepEqual(recipients(all, 'change', 'dsh').map((s) => s.name), ['claude', 'watcher']);
});
