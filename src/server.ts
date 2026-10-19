/**
 * The WebSocket publisher: the same events, pushed over a socket instead of
 * written to a directory.
 *
 * The extension is the **server**, which is the shape every editor integration
 * converged on — the editor holds the data and the agent dials in — and it is
 * also the only split that keeps both halves cheap: Node ships a WebSocket
 * *client* but no server, so the half that needs a dependency is the one living
 * in a VSIX, where dependencies are normal, and the consumer side stays able to
 * be a zero-dependency plugin.
 *
 * What this buys over the mailbox: no polling, no watcher, no filesystem at all,
 * and the delivery arrives while the user is still holding the selection. What it
 * costs is a listening socket, which is why the defaults are loopback and a
 * non-loopback bind is refused unless a token is set.
 *
 * @module editor-context/server
 */

import { createServer, type Server } from 'node:http';

import { WebSocketServer, type WebSocket } from 'ws';

import {
  PROTOCOL,
  isLoopbackHost,
  policyFromFrame,
  type Delivery,
  type ServerFrame,
  type SubscribeFrame,
  type SubscriptionPolicy,
} from './core';

/** How long a socket may stay connected without subscribing. */
const SUBSCRIBE_TIMEOUT_MS = 5_000;

/** How often to ping, so a half-open socket is noticed rather than leaked. */
const HEARTBEAT_MS = 30_000;

/** One connected subscriber. */
export interface PublisherClient extends SubscriptionPolicy {
  /** Process-local identity, for diagnostics. */
  readonly id: number;
  /** Remote address as reported by the socket. */
  readonly origin: string;
}

/** A running publisher. */
export interface Publisher {
  /** The URL a subscriber should dial, or `''` when the port could not be bound. */
  readonly url: string;
  /** The port actually bound, or `0` when nothing is listening. */
  readonly port: number;
  /** A snapshot of the connected subscribers. */
  clients(): PublisherClient[];
  /** Send one frame to one client. A dead socket is dropped, not thrown. */
  send(client: PublisherClient, delivery: Delivery): void;
  /** Stop listening and drop every client. */
  dispose(): Promise<void>;
}

/** Options for {@link createPublisher}. */
export interface PublisherOptions {
  host: string;
  port: number;
  path: string;
  /** Shared secret. Empty means "loopback only". */
  token: string;
  appName: string;
  pid: number;
  workspaceFolders: () => string[];
  /** Where lifecycle problems go. Never throws. */
  log: (message: string) => void;
  /** How long a socket may stay connected without subscribing. */
  subscribeTimeoutMs?: number;
  /** Ping interval. */
  heartbeatMs?: number;
  /**
   * Bind an ephemeral port when the configured one is taken, instead of standing
   * down. Defaults to on: a second editor window should join the registry rather
   * than be told its socket is unavailable.
   */
  ephemeralFallback?: boolean;
}

/** Internal record: a policy plus the socket it arrived on. */
interface Connection extends PublisherClient {
  socket: WebSocket;
  alive: boolean;
  subscribed: boolean;
}

/**
 * Start the publisher.
 *
 * Never rejects for an operational reason — a port already in use must not stop
 * the extension from activating — so a failure to listen leaves {@link Publisher.url}
 * empty and says so through `log`.
 * @param options - bind address, identity, and the log sink.
 * @returns the publisher.
 */
export async function createPublisher(options: PublisherOptions): Promise<Publisher> {
  const {
    host,
    port,
    path,
    token,
    appName,
    pid,
    log,
    subscribeTimeoutMs = SUBSCRIBE_TIMEOUT_MS,
    heartbeatMs = HEARTBEAT_MS,
    ephemeralFallback = true,
  } = options;
  if (!isLoopbackHost(host) && token === '') {
    log(`refusing to bind ${host} without a token: set editorContext.ws.token or bind 127.0.0.1`);
    return { url: '', port: 0, clients: () => [], send: () => undefined, dispose: async () => undefined };
  }

  let nextId = 0;
  const connections = new Map<WebSocket, Connection>();

  const server: Server = createServer((_req, res) => {
    // The publisher speaks WebSocket only. A plain HTTP request is a
    // misconfiguration, and saying so beats a socket that hangs.
    res.writeHead(426, { connection: 'close', 'content-type': 'text/plain; charset=utf-8' });
    res.end('editor-context: this endpoint speaks WebSocket only\n');
  });

  const wss = new WebSocketServer({ server, path });
  // An `error` on either object with no listener is an uncaught exception, which
  // in an editor means a broken extension host rather than a log line.
  wss.on('error', (error: Error) => {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') return;
    log(`socket server error — ${error.message}`);
  });
  server.on('error', (error: Error) => {
    // Kept attached for the server's whole life, not `once`: a second emission
    // finding no listener is exactly how this becomes a crash.
    // A taken port is expected — it is how the second window is recognised — and
    // the bind attempt either falls back or reports it, so repeating it here as
    // an "error" would make the normal case read like a crash.
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') return;
    log(`http server error — ${error.message}`);
  });

  const frame = (value: ServerFrame): string => JSON.stringify(value);

  wss.on('connection', (socket, request) => {
    const connection: Connection = {
      id: ++nextId,
      origin: request.socket.remoteAddress ?? 'unknown',
      socket,
      alive: true,
      subscribed: false,
      name: `ws-${String(nextId)}`,
      label: `ws-${String(nextId)}`,
      includeText: true,
      autoSelection: false,
    };
    connections.set(socket, connection);

    socket.on('pong', () => {
      connection.alive = true;
    });

    const subscribeTimer = setTimeout(() => {
      if (connection.subscribed) return;
      socket.send(frame({ type: 'error', message: 'no subscribe frame' }));
      socket.close(1008, 'no subscribe frame');
    }, subscribeTimeoutMs);

    socket.on('message', (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        socket.send(frame({ type: 'error', message: 'frame is not JSON' }));
        return;
      }
      const candidate = parsed as SubscribeFrame;
      if (candidate === null || typeof candidate !== 'object' || candidate.type !== 'subscribe') {
        socket.send(frame({ type: 'error', message: 'expected a subscribe frame' }));
        return;
      }
      if (connection.subscribed) {
        socket.send(frame({ type: 'error', message: 'already subscribed' }));
        return;
      }
      // The token is checked before the policy is applied, so a client that
      // guessed wrong learns nothing about what it would have received.
      if (token !== '' && candidate.token !== token) {
        socket.send(frame({ type: 'error', message: 'bad token' }));
        socket.close(1008, 'bad token');
        return;
      }
      const policy = policyFromFrame(candidate, `ws-${String(connection.id)}`);
      Object.assign(connection, policy, { subscribed: true });
      clearTimeout(subscribeTimer);
      socket.send(
        frame({
          type: 'subscribed',
          name: policy.name,
          includeText: policy.includeText,
          autoSelection: policy.autoSelection,
        }),
      );
    });

    socket.on('close', () => {
      clearTimeout(subscribeTimer);
      connections.delete(socket);
    });
    socket.on('error', () => {
      clearTimeout(subscribeTimer);
      connections.delete(socket);
    });

    socket.send(
      frame({
        type: 'hello',
        protocol: PROTOCOL,
        appName,
        pid,
        workspaceFolders: options.workspaceFolders(),
        requiresToken: token !== '',
      }),
    );
  });

  const heartbeat = setInterval(() => {
    for (const connection of connections.values()) {
      if (!connection.alive) {
        connection.socket.terminate();
        connections.delete(connection.socket);
        continue;
      }
      connection.alive = false;
      connection.socket.ping();
      // The ping keeps the TCP layer honest; this keeps the *client's* watchdog
      // honest, since a browser-style WebSocket never sees protocol pings.
      try {
        connection.socket.send(frame({ type: 'heartbeat', at: new Date().toISOString() }));
      } catch {
        // A socket that died since the last tick is dropped by its close handler.
      }
    }
  }, heartbeatMs);
  // A heartbeat must never be the reason the editor stays alive.
  heartbeat.unref?.();

  /**
   * One bind attempt.
   *
   * The error has to come back to the caller rather than being swallowed, because
   * "someone else holds this port" is a case we can still recover from, and it is
   * the normal state on the second window of a project.
   */
  const attemptListen = (target: number): Promise<{ port: number } | { error: NodeJS.ErrnoException }> =>
    new Promise((resolve) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        server.off('error', onError);
        resolve({ error });
      };
      server.on('error', onError);
      server.listen(target, host, () => {
        server.off('error', onError);
        const address = server.address();
        resolve({ port: typeof address === 'object' && address !== null ? address.port : target });
      });
    });

  let attempt = await attemptListen(port);
  if ('error' in attempt && ephemeralFallback && port !== 0 && attempt.error.code === 'EADDRINUSE') {
    log(
      `port ${String(port)} is already taken (another editor window?) — binding an ephemeral port and announcing it instead`,
    );
    attempt = await attemptListen(0);
  }

  if ('error' in attempt) {
    // A port someone else holds must not stop the extension from activating, and
    // must not leave a half-built server behind either.
    clearInterval(heartbeat);
    wss.close();
    log(`could not listen on ${host}:${String(port)} — ${attempt.error.message}`);
    return { url: '', port: 0, clients: () => [], send: () => undefined, dispose: async () => undefined };
  }

  const listening = attempt.port;

  const shown = host.includes(':') ? `[${host}]` : host;
  const url = `ws://${shown}:${String(listening)}${path}`;
  log(`listening on ${url}`);

  return {
    url,
    port: listening,
    clients() {
      return [...connections.values()].filter((connection) => connection.subscribed).map((connection) => ({
        id: connection.id,
        origin: connection.origin,
        name: connection.name,
        label: connection.label,
        includeText: connection.includeText,
        autoSelection: connection.autoSelection,
      }));
    },
    send(client, delivery) {
      for (const connection of connections.values()) {
        if (connection.id !== client.id || connection.socket.readyState !== connection.socket.OPEN) continue;
        try {
          connection.socket.send(frame({ type: 'delivery', delivery }));
        } catch {
          // A socket that died between the snapshot and the write is dropped by
          // its own `close` handler; there is nothing useful to do here.
        }
        return;
      }
    },
    async dispose() {
      clearInterval(heartbeat);
      for (const connection of connections.values()) connection.socket.terminate();
      connections.clear();
      await new Promise<void>((resolve) => {
        wss.close(() => {
          server.close(() => {
            resolve();
          });
        });
      });
    },
  };
}
