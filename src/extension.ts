/**
 * VS Code / Cursor entry point.
 *
 * This extension is a **publisher**. It knows how to describe the position the
 * user is looking at and how to hand that description to whoever asked for it;
 * it does not know what any consumer does with it. Two kinds of consumer:
 *
 *   - **in-process** — a sibling extension calls {@link subscribe} on this
 *     extension's exports and gets every event as it happens. No filesystem, no
 *     configuration, nothing on disk;
 *   - **out-of-process** — an agent drops `~/.editor-context/subscribers/<name>.json`
 *     and receives deliveries in the inbox beside it. The manifest is the whole
 *     registration protocol, so a new consumer appears without an extension
 *     update.
 *
 * The split matters for what lands on disk. An in-process listener is free, so it
 * hears every changed selection; a file-based subscriber has to opt in
 * (`autoSelection`), because otherwise selecting a password would write it to
 * `$HOME` with nobody having asked just then.
 */

import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { createPublisher, type Publisher } from './server';
import {
  buildDelivery,
  buildWindowState,
  recipients,
  signatureOf,
  type ContextLanguage,
  type Delivery,
  type DeliveryReason,
  type PositionInput,
  type SelectionInfo,
  type SubscriberManifest,
} from './core';
import {
  readSubscribers,
  removeWindowState,
  resolveStateDir,
  windowFile,
  writeDelivery,
  writeWindowState,
} from './state';

/** Pending debounced write. */
let debounce: NodeJS.Timeout | undefined;

/** State directory last resolved, so dispose can clean up without re-reading config. */
let lastDir = '';

/** Signature of the last selection fanned out, so a column move is not an event. */
let lastChangeSig = '';

/** In-process subscribers: sibling extensions. */
const listeners = new Set<(delivery: Delivery) => void>();

/** The WebSocket publisher, when it is running. */
let publisher: Publisher | undefined;

/** Signature of the last applied socket config, so a restart happens only on change. */
let publisherSignature = '';

/** An output channel, because a listening socket that failed to bind must say so. */
let channel: vscode.OutputChannel | undefined;

function log(message: string): void {
  channel ??= vscode.window.createOutputChannel('Editor Context');
  channel.appendLine(message);
}

/**
 * How much of a selection is read before the byte budget applies. A select-all in
 * a generated file is megabytes; reading it only to truncate it wastes the read.
 */
const MAX_SELECTION_LINES = 5000;

/** Default byte budget for the selected text. */
const DEFAULT_MAX_TEXT_BYTES = 20_000;

/** How long the subscriber registry is trusted while answering selection changes. */
const REGISTRY_TTL_MS = 3_000;

function configuration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('editorContext');
}

function stateDirOf(cfg: vscode.WorkspaceConfiguration): string {
  lastDir = resolveStateDir(cfg.get<string>('stateDir', ''));
  return lastDir;
}

/** Describe the active editor as a publishable position. */
function currentInput(pid: number, cfg: vscode.WorkspaceConfiguration): PositionInput {
  const excludeGlobs = cfg.get<string[]>('excludeGlobs', []);
  const language: ContextLanguage = cfg.get<string>('language', 'zh') === 'en' ? 'en' : 'zh';
  const base = {
    pid,
    appName: vscode.env.appName,
    now: new Date().toISOString(),
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    excludeGlobs,
    language,
  };
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.document.uri.scheme !== 'file') {
    return { ...base, activeFile: '', relativePath: '', languageId: '', selection: null };
  }
  const { document } = editor;
  const { selection: sel } = editor;
  const selection: SelectionInfo = {
    startLine: sel.start.line + 1,
    endLine: sel.end.line + 1,
    startColumn: sel.start.character + 1,
    endColumn: sel.end.character + 1,
    isEmpty: sel.isEmpty,
  };
  return {
    ...base,
    activeFile: document.uri.fsPath,
    relativePath: vscode.workspace.asRelativePath(document.uri, false),
    languageId: document.languageId,
    selection,
  };
}

/**
 * The selected text, bounded before it is materialized.
 * @param editor - the active editor.
 * @returns the text and whether it was cut short by the line bound.
 */
function selectedTextOf(editor: vscode.TextEditor): { text: string; clipped: boolean } {
  const { selection } = editor;
  if (selection.isEmpty) return { text: '', clipped: false };
  const lines = selection.end.line - selection.start.line + 1;
  if (lines <= MAX_SELECTION_LINES) return { text: editor.document.getText(selection), clipped: false };
  const end = new vscode.Position(selection.start.line + MAX_SELECTION_LINES, 0);
  return { text: editor.document.getText(new vscode.Range(selection.start, end)), clipped: true };
}

/**
 * The registry, cached briefly.
 *
 * The selection-change path calls this on every debounce tick, and re-reading a
 * directory to answer "is anyone listening continuously?" is not worth doing ten
 * times a second. The explicit path always re-reads, because the user is looking
 * at the picker when it runs.
 * @param dir - state directory.
 * @returns the subscribers.
 */
let registryCache: { at: number; dir: string; subscribers: SubscriberManifest[] } | undefined;
async function subscribersCached(dir: string): Promise<SubscriberManifest[]> {
  const now = Date.now();
  if (registryCache !== undefined && registryCache.dir === dir && now - registryCache.at < REGISTRY_TTL_MS) {
    return registryCache.subscribers;
  }
  const subscribers = await readSubscribers(dir);
  registryCache = { at: now, dir, subscribers };
  return subscribers;
}

/** Hand one delivery to in-process subscribers. A throwing listener is not fatal. */
function emit(delivery: Delivery): void {
  for (const listener of [...listeners]) {
    try {
      listener(delivery);
    } catch {
      // A subscriber's bug is not the publisher's problem.
    }
  }
}

/** Outcome of one publish, for the message the user sees. */
interface PublishResult {
  ok: boolean;
  /** Why it failed, or which subscribers it reached. */
  detail: string;
  delivered: string[];
  /** What was sent, for the confirmation message. */
  label: string;
}

/**
 * Build and deliver one event.
 *
 * Excluded paths and "no file open" produce nothing at all: the exclusion rule
 * is about the path appearing in a message, so an empty delivery would defeat it.
 * @param pid - extension-host pid.
 * @param reason - `explicit` for a user gesture, `change` for a selection change.
 * @param target - a subscriber name for a targeted send, `null` for everyone.
 * @param cached - whether the registry may come from cache (the change path).
 * @returns what happened, for the caller's message.
 */
async function publish(
  pid: number,
  reason: DeliveryReason,
  target: string | null,
  cached = false,
): Promise<PublishResult> {
  const cfg = configuration();
  if (!cfg.get<boolean>('enabled', true)) {
    return { ok: false, detail: 'the extension is disabled (editorContext.enabled)', delivered: [], label: '' };
  }
  const input = currentInput(pid, cfg);
  const editor = vscode.window.activeTextEditor;
  const { text, clipped } = editor === undefined ? { text: '', clipped: false } : selectedTextOf(editor);
  const sendText = cfg.get<boolean>('sendText', true);
  const maxTextBytes = cfg.get<number>('maxTextBytes', DEFAULT_MAX_TEXT_BYTES);
  const dir = stateDirOf(cfg);
  const base = { ...input, selectedText: text, maxTextBytes };
  const id = randomUUID();

  const canonical = buildDelivery({ ...base, id, reason, target, includeText: sendText });
  if (canonical === undefined) {
    const why =
      input.relativePath === ''
        ? 'no file is open'
        : 'the path matches editorContext.excludeGlobs, so nothing at all is published';
    return { ok: false, detail: why, delivered: [], label: '' };
  }

  // In-process subscribers always hear about it, whether or not it is written.
  emit(clipped ? { ...canonical, textTruncated: true } : canonical);

  const subscribers = cached ? await subscribersCached(dir) : await readSubscribers(dir);
  registryCache = { at: Date.now(), dir, subscribers };
  const to = recipients(subscribers, reason, target);
  const isBroadcast = reason === 'explicit' && target === null;

  // The same routing rule, applied to the sockets. A subscriber that registered
  // on disk and also dialled in is served on both, and named once.
  const sockets = recipients(publisher?.clients() ?? [], reason, target);
  if (!isBroadcast && to.length === 0 && sockets.length === 0) {
    return { ok: true, detail: 'no subscriber asked for this', delivered: [], label: '' };
  }

  if (isBroadcast) {
    // The public mailbox: readable by consumers that cannot register — a hook
    // script only runs when a prompt is sent, so it has nowhere to put a manifest.
    await writeDelivery(dir, null, canonical);
  }
  for (const subscriber of to) {
    const delivery = buildDelivery({
      ...base,
      id,
      reason,
      target: subscriber.name,
      includeText: sendText && subscriber.includeText,
    });
    if (delivery === undefined) continue;
    await writeDelivery(dir, subscriber.name, clipped ? { ...delivery, textTruncated: true } : delivery);
  }

  for (const client of sockets) {
    const delivery = buildDelivery({
      ...base,
      id,
      reason,
      target: client.name,
      includeText: sendText && client.includeText,
    });
    if (delivery !== undefined) publisher?.send(client, clipped ? { ...delivery, textTruncated: true } : delivery);
  }

  const names = [...new Set([...to.map((subscriber) => subscriber.label), ...sockets.map((client) => client.label)])];
  if (isBroadcast) names.unshift('public mailbox');
  return { ok: true, detail: '', delivered: names, label: labelOf(canonical) };
}

/** Coalesce a burst of editor events into one write. */
function schedule(pid: number): void {
  if (debounce !== undefined) clearTimeout(debounce);
  const delay = Math.max(0, configuration().get<number>('debounceMs', 150));
  debounce = setTimeout(() => {
    void flush(pid);
  }, delay);
}

/**
 * Publish the ambient state, then fan out a selection change.
 *
 * Only a **non-empty** selection is fanned out. A caret is not a deliberate act,
 * and `autoSelection` subscribers are asking for code the user highlighted, not
 * for a running commentary on where they are reading.
 * @param pid - extension-host pid.
 */
async function flush(pid: number): Promise<void> {
  const cfg = configuration();
  const dir = stateDirOf(cfg);
  if (!cfg.get<boolean>('enabled', true)) {
    await removeWindowState(dir, pid);
    return;
  }
  const input = currentInput(pid, cfg);
  await writeWindowState(dir, pid, buildWindowState(input));

  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.selection.isEmpty) {
    lastChangeSig = '';
    return;
  }
  const sig = signatureOf(input);
  if (sig === lastChangeSig) return;
  lastChangeSig = sig;
  await publish(pid, 'change', null, true);
}

/** Short human label for a toast: workspace-relative path plus the line range. */
function labelOf(state: { relativePath: string; selection: SelectionInfo | null }): string {
  const selection = state.selection;
  if (selection === null) return state.relativePath;
  if (selection.startLine === selection.endLine) return `${state.relativePath}:${selection.startLine}`;
  return `${state.relativePath}:${selection.startLine}-${selection.endLine}`;
}

/** Add the current position (and selection) to every subscriber's inbox. */
async function addToBot(pid: number, target: string | null): Promise<void> {
  const result = await publish(pid, 'explicit', target);
  if (!result.ok) {
    void vscode.window.showWarningMessage(`Editor Context: nothing was sent — ${result.detail}.`);
    return;
  }
  const where = result.delivered.length === 0 ? 'no subscriber is registered' : result.delivered.join(', ');
  void vscode.window.showInformationMessage(`Editor Context: sent ${result.label} to ${where}.`);
}

/** Pick one subscriber, or everyone. */
async function addToBotPicker(pid: number): Promise<void> {
  const dir = stateDirOf(configuration());
  const subscribers = await readSubscribers(dir);
  const items: (vscode.QuickPickItem & { target: string | null })[] = [
    {
      label: '$(broadcast) All subscribers',
      description: `${String(subscribers.length)} registered`,
      target: null,
    },
    ...subscribers.map((subscriber) => ({
      label: `$(plug) ${subscriber.label}`,
      description: subscriber.autoSelection ? `${subscriber.name} · continuous` : subscriber.name,
      target: subscriber.name,
    })),
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Add to Bot',
    placeHolder: subscribers.length === 0 ? 'No subscriber has registered yet' : 'Choose a recipient',
  });
  if (picked === undefined) return;
  await addToBot(pid, picked.target);
}

/** Restart the socket publisher when its configuration changed, and only then. */
async function syncPublisher(pid: number): Promise<void> {
  const cfg = configuration();
  const enabled = cfg.get<boolean>('ws.enabled', true);
  const options = {
    host: cfg.get<string>('ws.host', '127.0.0.1'),
    port: cfg.get<number>('ws.port', 7788),
    path: cfg.get<string>('ws.path', '/editor-context'),
    token: cfg.get<string>('ws.token', ''),
  };
  const signature = JSON.stringify({ enabled, ...options });
  if (signature === publisherSignature) return;
  publisherSignature = signature;

  await publisher?.dispose();
  publisher = undefined;
  if (!enabled) {
    log('WebSocket publisher disabled (editorContext.ws.enabled)');
    return;
  }
  publisher = await createPublisher({
    ...options,
    appName: vscode.env.appName,
    pid,
    workspaceFolders: () => (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    log,
  });
}

/** Show the address a subscriber should dial. */
async function showSocket(pid: number): Promise<void> {
  await syncPublisher(pid);
  if (publisher === undefined || publisher.url === '') {
    void vscode.window.showWarningMessage(
      'Editor Context: the WebSocket publisher is not listening — see the Editor Context output channel.',
    );
    return;
  }
  const clients = publisher.clients();
  const picked = await vscode.window.showInformationMessage(
    `Editor Context: ${publisher.url} — ${String(clients.length)} subscriber(s) connected`,
    'Copy URL',
    'Show Output',
  );
  if (picked === 'Copy URL') await vscode.env.clipboard.writeText(publisher.url);
  if (picked === 'Show Output') channel?.show();
}

export function activate(context: vscode.ExtensionContext): {
  subscribe: (listener: (delivery: Delivery) => void) => vscode.Disposable;
} {
  const pid = process.pid;

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(() => {
      schedule(pid);
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      schedule(pid);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      schedule(pid);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('editorContext')) {
        registryCache = undefined;
        if (event.affectsConfiguration('editorContext.ws')) void syncPublisher(pid);
        schedule(pid);
      }
    }),
    vscode.commands.registerCommand('editorContext.addToBot', () => addToBot(pid, null)),
    vscode.commands.registerCommand('editorContext.addToBotTargeted', () => addToBotPicker(pid)),
    // Kept so a keybinding written against 0.2.0 keeps working; the palette entry
    // is gone, because "add to bot" says the same thing better.
    vscode.commands.registerCommand('editorContext.sendToAgent', () => addToBot(pid, null)),
    vscode.commands.registerCommand('editorContext.showSocket', () => showSocket(pid)),
    vscode.commands.registerCommand('editorContext.showState', () => showState(pid)),
    vscode.commands.registerCommand('editorContext.copyContext', () => copyContext(pid)),
    {
      dispose: () => {
        if (debounce !== undefined) clearTimeout(debounce);
        listeners.clear();
        void publisher?.dispose();
        publisher = undefined;
        const dir = lastDir === '' ? resolveStateDir() : lastDir;
        void removeWindowState(dir, pid);
      },
    },
  );

  schedule(pid);
  void syncPublisher(pid);

  return {
    /**
     * Subscribe to every event, in process.
     *
     * A sibling extension gets the selection changes and the explicit sends with
     * no manifest, no inbox and no polling; it is the cheapest way to consume
     * this and the one an editor-side agent should use if it lives in the same
     * window.
     * @param listener - called for each delivery.
     * @returns a disposable removing the subscription.
     */
    subscribe(listener: (delivery: Delivery) => void): vscode.Disposable {
      listeners.add(listener);
      return new vscode.Disposable(() => listeners.delete(listener));
    },
  };
}

export function deactivate(): void {
  // The disposable registered in activate() removes this window's state file.
}

async function showState(pid: number): Promise<void> {
  const dir = stateDirOf(configuration());
  await writeWindowState(dir, pid, buildWindowState(currentInput(pid, configuration())));
  const file = windowFile(dir, pid);
  try {
    const document = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(document);
  } catch {
    void vscode.window.showWarningMessage(`Editor Context: state file not written yet (${file})`);
  }
}

async function copyContext(pid: number): Promise<void> {
  const context = buildWindowState(currentInput(pid, configuration())).context;
  if (context === '') {
    void vscode.window.showWarningMessage(
      'Editor Context: nothing to copy — no active file, or it matches editorContext.excludeGlobs.',
    );
    return;
  }
  await vscode.env.clipboard.writeText(context);
  void vscode.window.showInformationMessage('Editor Context: current position copied as context text.');
}
