/**
 * Pure logic for the Editor Context extension.
 *
 * Deliberately free of any `vscode` import so it can be unit-tested under plain
 * Node after `tsc`. The extension wires VS Code events onto these functions; the
 * Python hook reads the files these functions describe.
 */

export type ContextLanguage = 'zh' | 'en';

/** One selection (or bare cursor) in 1-based editor coordinates. */
export interface SelectionInfo {
  /** 1-based first line. */
  startLine: number;
  /** 1-based last line, inclusive. */
  endLine: number;
  /** 1-based first column. */
  startColumn: number;
  /** 1-based last column. */
  endColumn: number;
  /** True when the selection is empty, i.e. a bare cursor. */
  isEmpty: boolean;
}

/** The JSON payload one editor window publishes into `windows/<pid>.json`. */
export interface WindowState {
  version: 1;
  pid: number;
  /** Editor product name, e.g. `Cursor` or `Visual Studio Code`. */
  appName: string;
  /** ISO-8601 timestamp of the last change. */
  updatedAt: string;
  /** Stable identity of the position, used by the hook for change detection. */
  sig: string;
  /** Text to inject into the next model request; empty means "say nothing". */
  context: string;
  workspaceFolders: string[];
  /** Absolute path, or empty when no file is open. */
  activeFile: string;
  /** Workspace-relative path with `/` separators, or empty. */
  relativePath: string;
  languageId: string;
  selection: SelectionInfo | null;
}

/** Everything needed to describe the position the user is looking at. */
export interface PositionInput {
  pid: number;
  appName: string;
  now: string;
  workspaceFolders: string[];
  activeFile: string;
  relativePath: string;
  languageId: string;
  selection: SelectionInfo | null;
  excludeGlobs: string[];
  language: ContextLanguage;
}

const GLOB_ESCAPE = /[.+^${}()|[\]\\]/g;

/**
 * Translate one glob into an anchored RegExp. Supported syntax is deliberately
 * small: `**` crosses path separators, `*` and `?` do not.
 * @param glob - the pattern.
 * @returns the compiled pattern.
 */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i] as string;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(GLOB_ESCAPE, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

/** Normalize a path to `/` separators so matching is platform-independent. */
export function toPosix(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * Whether a path is excluded from publishing.
 *
 * A pattern containing `/` is matched against the workspace-relative path; a
 * bare pattern is matched against the file name (gitignore-ish, single segment).
 * @param relativePath - workspace-relative path.
 * @param patterns - configured globs.
 * @returns true when the path must not be published at all.
 */
export function isExcluded(relativePath: string, patterns: readonly string[]): boolean {
  const rel = toPosix(relativePath);
  if (rel === '') return false;
  const parts = rel.split('/');
  const base = parts[parts.length - 1] ?? rel;
  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (trimmed === '') continue;
    const target = trimmed.includes('/') ? rel : base;
    if (globToRegExp(trimmed).test(target)) return true;
  }
  return false;
}

/**
 * Stable identity of one position. Moving the caret along the same lines, or
 * re-reading the same range, does not change it — which keeps the hook from
 * re-injecting an identical line every turn.
 * @param input - the position.
 * @returns an opaque signature.
 */
export function signatureOf(input: Pick<PositionInput, 'relativePath' | 'selection'>): string {
  const { relativePath, selection } = input;
  if (relativePath === '') return '';
  if (selection === null) return `${relativePath}|none`;
  const kind = selection.isEmpty ? 'cursor' : 'sel';
  return `${relativePath}|${kind}|${selection.startLine}-${selection.endLine}`;
}

/** The two languages differ only in the tag and in how a range is spelled. */
const LABELS: Record<ContextLanguage, { tag: string; line: (from: number, to?: number) => string }> = {
  zh: {
    tag: '[编辑器位置]',
    line: (from, to) => (to === undefined ? `第 ${from} 行` : `第 ${from}-${to} 行`),
  },
  en: {
    tag: '[editor position]',
    line: (from, to) => (to === undefined ? `line ${from}` : `lines ${from}-${to}`),
  },
};

/**
 * Render the position as a single address line.
 *
 * Deliberately terse. The reader is a model that already knows how to open a
 * path and how to count, so everything derivable from the address is left out
 * rather than spelled out: the span in lines, the `offset`/`limit` to hand to
 * `read`, the workspace-relative spelling of a path it was just given
 * absolutely, and which editor the position came from — a reader has no use for
 * the last one, because it acts on the path either way.
 *
 * @param input - the position.
 * @returns one line, or `''` when there is nothing to point at.
 */
function render(input: PositionInput): string {
  const { activeFile, relativePath, selection } = input;
  if (relativePath === '') return '';
  const { tag, line } = LABELS[input.language];
  const where = activeFile !== '' ? activeFile : relativePath;
  if (selection === null) return `${tag} ${where}`;
  // A caret and a one-line selection address the same thing, so they read alike.
  const to = selection.endLine === selection.startLine ? undefined : selection.endLine;
  return `${tag} ${where} ${line(selection.startLine, to)}`;
}

/**
 * Render the text the hook injects.
 *
 * The empty string means "publish nothing", and it is the only such signal on
 * the wire — the reader uses it as the exclusion flag as well. Two cases produce
 * it: a path an exclude glob rejects, and no file open at all. The second one is
 * not a detail: a reading with nothing to say must not narrate that fact, or a
 * hook that fires every turn announces "no file is open" every turn.
 *
 * @param input - the position.
 * @returns model-facing context text, or `''`.
 */
export function renderContext(input: PositionInput): string {
  if (input.relativePath !== '' && isExcluded(input.relativePath, input.excludeGlobs)) {
    return '';
  }
  return render(input);
}

/**
 * Build the full payload for one editor window.
 * @param input - the position plus its policy.
 * @returns the JSON-serializable state.
 */
export function buildWindowState(input: PositionInput): WindowState {
  const context = renderContext(input);
  return {
    version: 1,
    pid: input.pid,
    appName: input.appName,
    updatedAt: input.now,
    sig: context === '' ? '' : signatureOf(input),
    context,
    workspaceFolders: input.workspaceFolders,
    activeFile: context === '' ? '' : input.activeFile,
    relativePath: context === '' ? '' : input.relativePath,
    languageId: context === '' ? '' : input.languageId,
    selection: context === '' ? null : input.selection,
  };
}

/* -------------------------------------------------------------------------- */
/*  Deliveries: what a subscriber receives                                     */
/* -------------------------------------------------------------------------- */

/** Why a delivery was produced. */
export type DeliveryReason = 'change' | 'explicit';

/** Discriminator so a consumer can tell a delivery from an ambient state file. */
export const DELIVERY_KIND = 'editor-context/delivery';

/**
 * What one subscriber asked to receive.
 *
 * Every transport declares the same two knobs — over the filesystem in a
 * manifest, or over a socket in a `subscribe` frame — so routing is one function
 * regardless of how the subscriber arrived.
 */
export interface SubscriptionPolicy {
  /** Stable identity, used as the target of a named send. */
  name: string;
  /** How the recipient picker names it. */
  label: string;
  /** Wants the selected text, not only the address. */
  includeText: boolean;
  /** Wants every changed selection, not only explicit sends. */
  autoSelection: boolean;
}

/**
 * A subscriber registered on disk.
 *
 * Written by the *subscriber*, never by this extension: a file under
 * `subscribers/<name>.json` is the whole registration protocol. That keeps the
 * producer side free of a list of agents it would otherwise have to know about,
 * and lets a new consumer appear without an extension update.
 */
export interface SubscriberManifest extends SubscriptionPolicy {}

/**
 * One editor window, as announced in `endpoints/<pid>.json`.
 *
 * This is the *registry* half of the topology. The extension still serves its own
 * socket, but nothing may assume a fixed port any more: a window binds the
 * configured port when it is free and an ephemeral one when another window
 * already holds it, then writes the result here. A consumer reads the directory,
 * drops the entries whose process is gone, and dials what is left. That is what
 * makes a second window, a restart, or a crashed window need no coordination.
 *
 * The token is never written: a shared secret in a file is a secret the reader
 * then has to protect, and `requiresToken` is all a client needs to know.
 */
export interface EndpointRecord {
  version: 1;
  pid: number;
  /** The port actually bound — the configured one, or the ephemeral fallback. */
  port: number;
  /** A dialable URL, so a consumer never has to assemble one. */
  url: string;
  protocol: string;
  appName: string;
  extensionVersion: string;
  workspaceFolders: string[];
  requiresToken: boolean;
  /**
   * ISO-8601, refreshed on a heartbeat. A window with nothing to say writes
   * nothing to its state file, so without this a live-but-idle window and a dead
   * one would look identical to a reader.
   */
  updatedAt: string;
}

/** Input for {@link buildEndpointRecord}. */
export interface EndpointInput {
  pid: number;
  port: number;
  url: string;
  appName: string;
  extensionVersion: string;
  workspaceFolders: string[];
  requiresToken: boolean;
  now: string;
}

/**
 * Build the endpoint record a window announces.
 * @param input - identity, the bound port, and the timestamp.
 * @returns the record.
 */
export function buildEndpointRecord(input: EndpointInput): EndpointRecord {
  return {
    version: 1,
    pid: input.pid,
    port: input.port,
    url: input.url,
    protocol: PROTOCOL,
    appName: input.appName,
    extensionVersion: input.extensionVersion,
    workspaceFolders: [...input.workspaceFolders],
    requiresToken: input.requiresToken,
    updatedAt: input.now,
  };
}

/** Position fields plus the delivery envelope and its text policy. */
export interface DeliveryInput extends PositionInput {
  id: string;
  reason: DeliveryReason;
  /** Subscriber name for a targeted send, `null` for the public mailbox. */
  target: string | null;
  /** The buffer text inside the selection, as read by the caller. */
  selectedText: string;
  includeText: boolean;
  maxTextBytes: number;
}

/**
 * One message to one subscriber.
 *
 * A delivery is a **snapshot, not a pointer**. The text travels with the address
 * on purpose: a pointer goes stale the moment the file is edited, moved,
 * reverted or deleted, and the agent is then reasoning about code that no longer
 * exists. Shipping the text means the reader still has what the user was looking
 * at, and shipping the range means it also knows where that was — enough to
 * render a chip, and enough to tell how the two have since diverged.
 *
 * `address` is the rendered one-liner. It is deliberately not called `context`:
 * the ambient `WindowState` uses that name for its hook-facing text, and one key
 * meaning two things across two documents is how parsers go wrong.
 */
export interface Delivery {
  version: 1;
  kind: typeof DELIVERY_KIND;
  id: string;
  at: string;
  reason: DeliveryReason;
  target: string | null;
  pid: number;
  appName: string;
  updatedAt: string;
  sig: string;
  workspaceFolders: string[];
  activeFile: string;
  relativePath: string;
  languageId: string;
  selection: SelectionInfo | null;
  /** The rendered one-line address, as the ambient file renders it. */
  address: string;
  /** The selected text, or `''` when it was not requested or is empty. */
  text: string;
  /** True when `text` was cut short by `maxTextBytes`. */
  textTruncated: boolean;
}

/**
 * Cut the selected text to a byte budget.
 *
 * Bytes, not characters, because the budget exists to bound what lands on disk
 * and in a model's context, and both are measured in bytes. A partial trailing
 * character from the cut is dropped rather than left as U+FFFD.
 * @param text - the raw selection.
 * @param include - whether text was requested at all.
 * @param maxBytes - budget; non-positive or non-finite disables the cap.
 * @returns the text to ship and whether it was cut.
 */
export function fitText(text: string, include: boolean, maxBytes: number): { text: string; truncated: boolean } {
  if (!include || text === '') return { text: '', truncated: false };
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return { text, truncated: false };
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
  const cut = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/u, '');
  return { text: cut, truncated: true };
}

/**
 * Build one delivery, or `undefined` when nothing may be published.
 *
 * Excluded paths produce no delivery at all — not an empty one — because the
 * exclusion rule is about the path existing in a message, not about its content.
 * @param input - the position, the text, and the policy.
 * @returns the payload, or `undefined`.
 */
export function buildDelivery(input: DeliveryInput): Delivery | undefined {
  const address = renderContext(input);
  if (address === '') return undefined;
  const { text, truncated } = fitText(input.selectedText, input.includeText, input.maxTextBytes);
  return {
    version: 1,
    kind: DELIVERY_KIND,
    id: input.id,
    at: input.now,
    reason: input.reason,
    target: input.target,
    pid: input.pid,
    appName: input.appName,
    updatedAt: input.now,
    sig: signatureOf(input),
    address,
    workspaceFolders: input.workspaceFolders,
    activeFile: input.activeFile,
    relativePath: input.relativePath,
    languageId: input.languageId,
    selection: input.selection,
    text,
    textTruncated: truncated,
  };
}

/**
 * Who an event reaches.
 *
 * An explicit send goes to everyone unless the user named one subscriber; a
 * selection change reaches only the subscribers that asked for a continuous
 * feed, because that is the only case where text lands on disk without anyone
 * asking for it just then.
 * @param subscribers - the registry.
 * @param reason - why the delivery is being produced.
 * @param target - a subscriber name for a targeted send, or `null`.
 * @returns the recipients.
 */
export function recipients<T extends SubscriptionPolicy>(
  subscribers: readonly T[],
  reason: DeliveryReason,
  target: string | null,
): T[] {
  if (reason === 'change') return subscribers.filter((subscriber) => subscriber.autoSelection);
  if (target === null) return [...subscribers];
  return subscribers.filter((subscriber) => subscriber.name === target);
}

/* -------------------------------------------------------------------------- */
/*  Wire protocol                                                              */
/* -------------------------------------------------------------------------- */

/** Protocol version carried by the `hello` frame. */
export const PROTOCOL = 'editor-context/1';

/** A frame the publisher sends. */
export type ServerFrame =
  | {
      type: 'hello';
      protocol: typeof PROTOCOL;
      appName: string;
      pid: number;
      workspaceFolders: string[];
      /** Whether the subscriber must present a token before it is served. */
      requiresToken: boolean;
    }
  | { type: 'subscribed'; name: string; includeText: boolean; autoSelection: boolean }
  | { type: 'delivery'; delivery: Delivery }
  | { type: 'error'; message: string };

/**
 * The one frame a subscriber sends.
 *
 * Everything is optional: a bare `{"type":"subscribe"}` is a valid registration
 * that receives explicit sends with text and no continuous feed, which is the
 * safe default in both directions.
 */
export interface SubscribeFrame {
  type: 'subscribe';
  name?: string;
  label?: string;
  includeText?: boolean;
  autoSelection?: boolean;
  token?: string;
}

/**
 * Turn a subscribe frame into a policy, filling in the safe defaults.
 * @param frame - the received frame.
 * @param fallbackName - identity to use when the frame omits one.
 * @returns the policy.
 */
export function policyFromFrame(frame: SubscribeFrame, fallbackName: string): SubscriptionPolicy {
  const name = typeof frame.name === 'string' && frame.name.trim() !== '' ? frame.name.trim() : fallbackName;
  const label = typeof frame.label === 'string' && frame.label.trim() !== '' ? frame.label.trim() : name;
  return {
    name,
    label,
    includeText: frame.includeText !== false,
    autoSelection: frame.autoSelection === true,
  };
}

/** Whether a bind address is loopback, and therefore needs no token. */
export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  return value === '127.0.0.1' || value === '::1' || value === 'localhost' || value === '127.0.0.0/8';
}
