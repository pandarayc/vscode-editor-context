/**
 * Tests for the WebSocket publisher.
 *
 * The client half uses Node's own built-in `WebSocket` — the same one the DSH
 * plugin will use — so this exercises the real protocol against a real socket
 * rather than a mock of either.
 *
 *   npm run compile && node --test test/server.test.mjs
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPublisher } from '../out/server.js';

/** Everything the publisher said, plus a way to wait for the next thing. */
function connect(url) {
  const socket = new WebSocket(url);
  const frames = [];
  const errors = [];
  socket.addEventListener('message', (event) => {
    frames.push(JSON.parse(event.data));
  });
  socket.addEventListener('error', (event) => {
    errors.push(event);
  });
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', () => {
      reject(new Error(`could not connect to ${url}`));
    });
  });
  const closed = new Promise((resolve) => {
    socket.addEventListener('close', (event) => resolve(event));
  });
  return {
    socket,
    frames,
    errors,
    opened,
    closed,
    send(value) {
      socket.send(JSON.stringify(value));
    },
    async next(predicate = () => true, timeoutMs = 3_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = frames.find(predicate);
        if (found !== undefined) return found;
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
      }
      throw new Error(`no frame matched within ${String(timeoutMs)}ms; saw ${JSON.stringify(frames)}`);
    },
  };
}

/** A publisher on an OS-assigned loopback port. */
async function publisher(overrides = {}) {
  const lines = [];
  const server = await createPublisher({
    host: '127.0.0.1',
    port: 0,
    path: '/editor-context',
    token: '',
    appName: 'Cursor',
    pid: 4242,
    workspaceFolders: () => ['/w'],
    log: (message) => lines.push(message),
    subscribeTimeoutMs: 400,
    heartbeatMs: 60_000,
    ...overrides,
  });
  servers.push(server);
  return { server, lines };
}

const servers = [];
const sockets = [];

function track(client) {
  sockets.push(client.socket);
  return client;
}

/** A delivery, as `buildDelivery` would produce it. */
function delivery(overrides = {}) {
  return {
    version: 1,
    kind: 'editor-context/delivery',
    id: 'id-1',
    at: '2026-10-17T00:00:00.000Z',
    reason: 'explicit',
    target: 'dsh',
    pid: 4242,
    appName: 'Cursor',
    updatedAt: '2026-10-17T00:00:00.000Z',
    sig: 'src/auth.ts|sel|11-14',
    workspaceFolders: ['/w'],
    activeFile: '/w/src/auth.ts',
    relativePath: 'src/auth.ts',
    languageId: 'typescript',
    selection: { startLine: 11, endLine: 14, startColumn: 1, endColumn: 5, isEmpty: false },
    address: '[编辑器位置] /w/src/auth.ts 第 11-14 行',
    text: 'const a = 1\n',
    textTruncated: false,
    ...overrides,
  };
}

test('the hello frame carries what a subscriber needs to decide', async () => {
  const { server } = await publisher();
  assert.match(server.url, /^ws:\/\/127\.0\.0\.1:\d+\/editor-context$/);
  const client = track(connect(server.url));
  await client.opened;

  const hello = await client.next((frame) => frame.type === 'hello');
  assert.equal(hello.protocol, 'editor-context/1');
  assert.equal(hello.appName, 'Cursor');
  assert.deepEqual(hello.workspaceFolders, ['/w']);
  assert.equal(hello.requiresToken, false);
});

test('a subscriber that declines text still gets its address', async () => {
  const { server } = await publisher();
  const client = track(connect(server.url));
  await client.opened;
  await client.next((frame) => frame.type === 'hello');

  client.send({ type: 'subscribe', name: 'dsh', label: 'DSH', includeText: false, autoSelection: true });
  const ack = await client.next((frame) => frame.type === 'subscribed');
  assert.deepEqual(ack, { type: 'subscribed', name: 'dsh', includeText: false, autoSelection: true });

  const [registered] = server.clients();
  assert.equal(registered.label, 'DSH');
  assert.equal(registered.includeText, false);
  assert.equal(registered.autoSelection, true, 'the policy the client asked for is what routing will use');

  server.send(registered, delivery({ text: '' }));
  const received = await client.next((frame) => frame.type === 'delivery');
  assert.equal(received.delivery.address, '[编辑器位置] /w/src/auth.ts 第 11-14 行');
  assert.deepEqual(received.delivery.selection, { startLine: 11, endLine: 14, startColumn: 1, endColumn: 5, isEmpty: false });
  assert.equal(received.delivery.text, '');
});

test('an unsubscribed socket is not a recipient and is dropped for silence', async () => {
  const { server } = await publisher();
  const client = track(connect(server.url));
  await client.opened;
  await client.next((frame) => frame.type === 'hello');
  assert.deepEqual(server.clients(), [], 'a socket that has not subscribed is not in the routing table');

  const refusal = await client.next((frame) => frame.type === 'error');
  assert.match(refusal.message, /no subscribe frame/);
  const gone = await client.closed;
  assert.equal(gone.code, 1008);
});

test('a token, when set, is checked before anything else is said', async () => {
  const { server } = await publisher({ token: 'sekrit' });
  const wrong = track(connect(server.url));
  await wrong.opened;
  const hello = await wrong.next((frame) => frame.type === 'hello');
  assert.equal(hello.requiresToken, true);

  wrong.send({ type: 'subscribe', name: 'dsh', token: 'nope' });
  const refusal = await wrong.next((frame) => frame.type === 'error');
  assert.match(refusal.message, /bad token/);
  assert.equal((await wrong.closed).code, 1008);
  assert.deepEqual(server.clients(), [], 'a client that guessed wrong learns nothing');

  const right = track(connect(server.url));
  await right.opened;
  await right.next((frame) => frame.type === 'hello');
  right.send({ type: 'subscribe', name: 'dsh', token: 'sekrit' });
  await right.next((frame) => frame.type === 'subscribed');
  assert.equal(server.clients().length, 1);
});

test('a frame that is not a subscription is refused without dropping the socket', async () => {
  const { server } = await publisher();
  const client = track(connect(server.url));
  await client.opened;
  await client.next((frame) => frame.type === 'hello');

  client.socket.send('{ not json');
  assert.match((await client.next((f) => f.type === 'error')).message, /not JSON/);
  client.send({ type: 'delivery', delivery: {} });
  assert.match((await client.next((f) => f.type === 'error' && /subscribe/.test(f.message))).message, /expected a subscribe/);

  // Still usable, which matters because a mistake on the wire should be a
  // message, not a dropped connection.
  client.send({ type: 'subscribe', name: 'late' });
  assert.equal((await client.next((f) => f.type === 'subscribed')).name, 'late');
});

test('a closed socket leaves the routing table', async () => {
  const { server } = await publisher();
  const client = track(connect(server.url));
  await client.opened;
  await client.next((frame) => frame.type === 'hello');
  client.send({ type: 'subscribe', name: 'dsh' });
  await client.next((frame) => frame.type === 'subscribed');
  assert.equal(server.clients().length, 1);

  client.socket.close();
  await client.closed;
  const deadline = Date.now() + 2_000;
  while (server.clients().length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  assert.deepEqual(server.clients(), []);
});

test('binding a non-loopback address without a token is refused, not attempted', async () => {
  const { server, lines } = await publisher({ host: '0.0.0.0' });
  assert.equal(server.url, '');
  assert.match(lines.join('\n'), /refusing to bind 0\.0\.0\.0 without a token/);
});

test('a plain HTTP request is told what this endpoint speaks', async () => {
  const { server } = await publisher();
  const response = await fetch(server.url.replace('ws://', 'http://'));
  assert.equal(response.status, 426);
  assert.match(await response.text(), /WebSocket only/);
});

test('a port already in use is reported, not thrown', async () => {
  const first = await publisher();
  const busy = Number(new URL(first.server.url).port);
  const second = await publisher({ port: busy });
  assert.equal(second.server.url, '', 'a taken port must not stop the editor from working');
  assert.match(second.lines.join('\n'), /could not listen/);
});

test.after(async () => {
  for (const socket of sockets) socket.close();
  for (const server of servers) await server.dispose();
});
