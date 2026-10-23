# editor-context-bridge

<img src="icon.png" width="96" alt="">

> **[English](README.md) · [中文](README.zh-CN.md)**

Publish the file and line range you are looking at in Cursor / VS Code, so an
agent running on the same machine can read exactly that range.

The extension is a producer only. It writes one small JSON file per editor window
and never talks to an agent:

```
~/.editor-context/windows/<extension-host pid>.json
```

```json
{
  "version": 1,
  "pid": 9931,
  "appName": "Cursor",
  "updatedAt": "2026-10-16T10:25:58.977Z",
  "sig": "src/auth.ts|sel|11-14",
  "context": "[编辑器位置] /w/src/auth.ts 第 11-14 行",
  "workspaceFolders": ["/w"],
  "activeFile": "/w/src/auth.ts",
  "relativePath": "src/auth.ts",
  "languageId": "typescript",
  "selection": { "startLine": 11, "endLine": 14, "startColumn": 1, "endColumn": 5, "isEmpty": false }
}
```

One file per window, so there is no lock to take and no window overwrites
another; a reader takes the newest by mtime. `selection` and `activeFile` are the
structured reading, `context` is the same thing pre-rendered as one line for
consumers that only want text, and `sig` changes when the position does — which
is what lets a reader avoid saying the same thing twice.

**The ambient file never contains your code.** `windows/<pid>.json` is rewritten
on every caret move, so it stays an address and nothing else. The selected text
travels only when you ask for it — an explicit **Add to Bot** — or to a subscriber
that opted into a continuous feed, and never for a path `excludeGlobs` rejects.

## Subscribers

The extension is a **publisher**. It describes where you are and hands that to
whoever asked; it does not know what any consumer does with it. There are two
kinds of subscriber, and the difference is what lands on disk.

**In process.** A sibling extension gets every event with no filesystem at all:

```ts
const api = vscode.extensions.getExtension('pandarayc.editor-context-bridge')?.exports;
const sub = api.subscribe((delivery) => { /* ... */ });
```

**Over a socket.** The extension runs a WebSocket publisher on
`ws://127.0.0.1:7788/editor-context` by default. A subscriber connects, gets a
`hello`, sends one `subscribe` frame, and then receives a `delivery` per event —
no filesystem, no polling, and the delivery arrives while you are still holding
the selection.

```jsonc
// ← { "type": "hello", "protocol": "editor-context/1", "requiresToken": false, … }
→ { "type": "subscribe", "name": "dsh", "label": "DSH", "includeText": true, "autoSelection": false }
// ← { "type": "subscribed", "name": "dsh", "includeText": true, "autoSelection": false }
// ← { "type": "delivery", "delivery": { … } }
```

The same two knobs as a manifest, so routing is one function whatever transport a
subscriber arrived on. **Editor Context: Show WebSocket Address** prints the URL
and the number of connected subscribers.

Every window also **announces where it is listening** in
`~/.editor-context/endpoints/<pid>.json` — the port it actually got, the app
name, the workspace folders, and a heartbeat every minute. The configured port is
a preference, not a rule: a second window that finds 7788 taken binds an
ephemeral port instead and announces that, so two windows of the same project
both stay reachable. A consumer reads the directory, ignores the entries whose
process is gone, and dials what is left — no fixed port to configure, and nothing
to re-coordinate when a window restarts.

A non-loopback `ws.host` is **refused unless `ws.token` is set**; the token is
checked before the policy is applied, so a client that guessed wrong learns
nothing about what it would have received.

**On disk.** An agent that cannot dial in registers by writing one manifest — that file is the whole
protocol, so a new consumer appears without an extension update:

```
~/.editor-context/
├── windows/<pid>.json                    where the caret is, always (address only)
├── requests/<ts>-<pid>-<seq>.json        the public mailbox: explicit sends
└── subscribers/
    ├── dsh.json                          the manifest, written by the subscriber
    └── dsh/inbox/<ts>-<pid>-<seq>.json   targeted deliveries
```

```json
{ "label": "DSH", "includeText": true, "autoSelection": false }
```

| Key | Default | Meaning |
|---|---|---|
| `label` | the file name | How the recipient picker names it |
| `includeText` | `true` | Whether deliveries carry the selected text. `false` sends the address only |
| `autoSelection` | `false` | Whether **every changed non-empty selection** is delivered, not only explicit sends |

**Editor Context: Add to Bot** — on the editor title bar, in the right-click menu
and in the palette — sends the current position to *every* registered subscriber
and to the public mailbox. **Add to Bot (choose recipient)…** sends to one, and
that delivery is private: it is not copied to the public mailbox.

The public mailbox exists for consumers that cannot register. A hook script runs
only when a prompt is sent, so it has nowhere to put a manifest; it just reads
`requests/`.

### What a subscriber receives

The position fields carry the same names as the ambient file, so a reader that
already parses `windows/<pid>.json` finds them where it expects:

```json
{
  "version": 1,
  "kind": "editor-context/delivery",
  "id": "0f0b2c1e-…",
  "at": "2026-10-17T06:12:00.000Z",
  "reason": "explicit",
  "target": "dsh",
  "activeFile": "/w/src/auth.ts",
  "relativePath": "src/auth.ts",
  "languageId": "typescript",
  "selection": { "startLine": 11, "endLine": 14, "startColumn": 1, "endColumn": 5, "isEmpty": false },
  "context": "[编辑器位置] /w/src/auth.ts 第 11-14 行",
  "text": "export function login(user: User) {\n  …",
  "textTruncated": false
}
```

`text` is cut to `editorContext.maxTextBytes` and `textTruncated` says so. A
selection longer than 5000 lines is not read at all beyond that point.

**`excludeGlobs` produces no delivery, not an empty one.** The rule is about the
path appearing in a message, so a payload with the address blanked out would
defeat it.

## Pick your agent

| Agent | Install | Where the position lands |
|---|---|---|
| **DSH** | [`dsh-editor-context`](https://github.com/pandarayc/dsh-editor-context) | a chip in the composer — from `@`, or straight from the button — **use this one** |
| **Claude Code** | [the hook](#the-hook-not-recommended) | injected on the next prompt, on a changed position |
| anything else | nothing | read the JSON |

### The hook (not recommended)

The repository ships a `UserPromptSubmit` hook for editors that have no
extension API, or for agents that only ever read a prompt. **On DSH, skip it.**
Measured, it appends one durable user message per turn whenever the cursor is
moving — a position is a high-cardinality dedup key, so the "only when it
changed" cache never fires. The chip exists because of that measurement.

```bash
node scripts/install-dsh-hook.mjs              # copy the script, merge hooks.json
node scripts/install-dsh-hook.mjs --print      # show the entry without writing
```

It preserves every existing hook and is idempotent. To remove it again, delete
the `UserPromptSubmit` entry from `~/.dsh/hooks/hooks.json` and the copied
`editor_context.py`; DSH reads that file once at process start, so either
direction needs a restart.

A request is served *before* the ambient reading by every consumer that reads the
state directory, and exactly once: `windows/` is where the caret is, `requests/` is
where you pointed.

## Install

### From the Marketplace

```
pandarayc.editor-context-bridge
```

`code --install-extension pandarayc.editor-context-bridge` (or `cursor` in place
of `code`), or search for **Editor Context** in the Extensions panel.

### Remote-SSH — Cursor runs on another machine

A remote window has **no** `cursor` CLI: that lives on the client machine. So the
extension has to be placed in the server-side extension directory, and the script
that does it ships in this repository rather than in the VSIX — the machine that
needs it is precisely the one that cannot run `cursor`.

```bash
node scripts/install-cursor-remote.mjs --vsix ./editor-context-bridge-<version>.vsix
```

It unpacks the VSIX into
`~/.cursor-server/extensions/<publisher>.editor-context-bridge-<version>/`
and adds the entry to `extensions/extensions.json`, backing that file up first and
replacing an existing entry rather than appending a duplicate. It probes
`~/.cursor-server` and falls back to `~/.vscode-server`; `--server <dir>` is
explicit. No restart is needed — the extension host picks it up on its own.

### A window on this machine

```bash
cursor --install-extension editor-context-bridge-<version>.vsix
# or: Command Palette → Extensions: Install from VSIX…
```

VS Code is the same API: `code --install-extension`.

### Development

```bash
npm install --cache ../.npm-cache
npm run compile
# open this folder in Cursor and press F5 for an Extension Development Host
```

Then open a file, select a few lines, and:

```bash
cat ~/.editor-context/windows/*.json
```

## Settings

| Key | Default | Meaning |
|---|---|---|
| `editorContext.enabled` | `true` | Turning it off **deletes** this window's state file |
| `editorContext.excludeGlobs` | `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `.ssh/**`, `node_modules/**` | A match publishes **nothing at all, not even the path**. A pattern containing `/` matches the workspace-relative path; a bare one matches the file name |
| `editorContext.language` | `zh` | Language of the `context` line: `zh` / `en` |
| `editorContext.sendText` | `true` | Include the selected text in deliveries. Never affects the ambient file |
| `editorContext.maxTextBytes` | `20000` | Byte budget for that text; `0` disables the cap |
| `editorContext.ws.enabled` | `true` | Run the WebSocket publisher |
| `editorContext.ws.host` | `127.0.0.1` | Bind address. Non-loopback is refused without a token |
| `editorContext.ws.port` | `7788` | Preferred port. If it is taken, the window binds an ephemeral one and announces it in `endpoints/<pid>.json`; `0` always asks for an ephemeral port |
| `editorContext.ws.path` | `/editor-context` | Endpoint path |
| `editorContext.ws.token` | empty | Shared secret required in the `subscribe` frame |
| `editorContext.stateDir` | empty → `~/.editor-context` | Move the directory |
| `editorContext.debounceMs` | `150` | Quiet period before a caret move is written |

Five commands are registered: **Add to Bot** and **Add to Bot (choose
recipient)…** (above), **Show WebSocket Address** (the URL and the subscriber
count), **Show State File** (opens the file this window is writing), and **Copy
Current Position as Context** (puts the `context` line on the clipboard).

`editorContext.sendToAgent` is still registered as an alias of **Add to Bot**, so
a keybinding written against 0.2.0 keeps working.

## Limitations

- **Whole ranges are not highlighted**, only addressed. Jumping the editor to a
  range would need an inbound channel, and the extension has none.
- **With several windows open the most recently updated one wins.** There is no
  cross-process notion of the focused window.

The hook has its own caveats — the change cache may have to live inside your
project, and an unchanged position is never re-injected — which is part of why
it is not the recommended path; see [The hook](#the-hook-not-recommended).

## Under the hood

`src/core.ts` is pure logic — position model, glob exclusion, rendering, the
delivery model — with no `vscode` import, so it unit-tests under plain Node.
`src/state.ts` is the on-disk layout: window files, the public mailbox, the
subscriber registry and its inboxes. `src/server.ts` is the WebSocket publisher;
`src/extension.ts` is the event wiring and the fan-out. `hooks/editor_context.py` is a zero-dependency Python 3.8+
`UserPromptSubmit` hook.

```bash
npm run compile && npm test    # 63 passed
```

For why the rendering is one terse line, why `context: ''` means two different
things, and the four contracts the hook must not break:
[docs/internals.md](docs/internals.md). The original survey and design record is
[docs/design.md](docs/design.md) (Chinese).

## License

MIT
