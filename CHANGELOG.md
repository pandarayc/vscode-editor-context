# Changelog

## 0.4.0 — 2026-10-17

Publish over a socket, so a subscriber does not need the filesystem at all.

- **Added** — a **WebSocket publisher**, on by default on `127.0.0.1:7788`.
  The extension is the **server**; this is the shape editor integrations
  converged on, and it is also the split that keeps both halves cheap: Node ships
  a WebSocket *client* but no server, so the dependency lands in the VSIX, where
  dependencies are ordinary, and the consumer side can stay a zero-dependency
  plugin.
- **Added** — the wire protocol `editor-context/1`: `hello` on connect,
  `subscribe` from the client, `subscribed` to acknowledge, `delivery` per event,
  `error` for anything malformed. A client that has not subscribed is not a
  recipient, and is dropped after 5s of silence.
- **Added** — a token, and a refusal to bind a **non-loopback** address without
  one. A listening socket that anyone on the network can read code from is not a
  default worth having.
- **Changed** — a delivery's rendered one-liner is now `address`, not `context`.
  The ambient `WindowState` uses `context` for the text its hook injects, and one
  key meaning two things across two documents is how parsers go wrong. The
  selected text is `text`, and the position stays in `selection`.
- **Added** — `ws` as a runtime dependency (8.22.0), plus `@types/ws` for the
  build. The extension previously had none.
- **Fixed** — a failed `listen` left the HTTP server and the WebSocket server
  half-built, and the `once('error')` handler meant a second emission had no
  listener at all — an uncaught exception in the extension host. Both are
  attached for the server's whole life now, and a taken port is a log line rather
  than a broken editor.


## 0.3.0 — 2026-10-17

The extension becomes a publisher, and the selected text starts travelling.

- **Added** — a **subscriber model** with two kinds of consumer. A sibling
  extension calls `exports.subscribe(listener)` and receives every event in
  process, with no filesystem involved. An out-of-process agent writes one
  manifest, `~/.editor-context/subscribers/<name>.json`, and receives deliveries
  in the inbox beside it; that file is the whole registration protocol, so a new
  consumer appears without an extension update.
- **Added** — **Add to Bot**, which sends the current position to every
  registered subscriber and to the public mailbox, and **Add to Bot (choose
  recipient)…**, which sends to one subscriber privately. Both replace
  *Send Current Position to Agent*, whose command id remains registered as an
  alias so existing keybindings keep working.
- **Added** — deliveries carry the **selected text** alongside the address, path
  and line range, matching what an editor-side agent gets in its own process.
  `editorContext.sendText` turns it off; `editorContext.maxTextBytes` bounds it
  and sets `textTruncated`.
- **Changed** — **the privacy scope of "no selected text" narrowed.** It used to
  be absolute. It is now: the ambient `windows/<pid>.json` is still an address and
  never content, and `excludeGlobs` still produces no delivery at all — but an
  explicit send, or a subscriber that opted into `autoSelection`, does carry the
  text. Continuous delivery is opt-in per subscriber precisely because it writes
  file contents to disk without anyone having asked just then.
- **Changed** — `writeRequestState` folded into `writeDelivery`, which now owns
  both mailboxes. Mailbox file names gained a per-process sequence suffix:
  `<epoch-ms>-<pid>-<seq>.json` keeps two deliveries in the same millisecond from
  silently overwriting each other.
- **Fixed** — subscriber names are validated before use as a path segment. A
  manifest calling itself `../escape` is refused rather than escaped.


## 0.2.0 — 2026-10-16

Point at something on purpose.

- **Added** — the `Editor Context: Send Current Position to Agent` command, on the
  editor title bar, in the editor context menu and in the palette. It writes
  `requests/<epoch-ms>-<pid>.json`: **the same document** the window file carries,
  written once instead of continuously. There is no second schema and no second
  parser, so a consumer that reads `windows/` reads `requests/` unchanged.
- **Added** — pruning: the newest 20 requests are kept. The directory is a
  mailbox, not a log, and the producer owns the lifetime of its own files.
- **Changed** — the hook serves a request before the ambient reading, and treats
  one as one-shot. `windows/` says where the caret is; `requests/` says where the
  user pointed, so the deliberate act wins a race with whatever the caret did
  next — and does not repeat.
- **Fixed** — the hook's change cache held one signature, which is not enough for
  two documents: a request and the ambient reading would take turns looking "new"
  and both would be re-injected forever. The cache now has a slot for the last
  ambient signature plus a bounded list of consumed request names. A pre-0.2
  cache (a bare signature) is still read correctly.

## 0.1.1 — 2026-10-16

The rendered text says the same thing in one line instead of three.

- **Changed** — `context` is now `[编辑器位置] /w/src/auth.ts 第 11-14 行`
  (`[editor position] /w/src/auth.ts lines 11-14` in English). Dropped: the line
  count, the `offset`/`limit` hint for the `read` tool, the workspace-relative
  path that the absolute path already contains, the editor's own name, and the
  third-person narration. All of it was derivable by the reader, or not
  actionable by it.
- **Fixed** — **no file open is now silent** (`context: ''`) instead of rendering
  `用户当前在 Cursor 中没有打开任何文件。`. A hook that fires on every prompt was
  injecting that sentence on every turn, for as long as no file was open.
- **Changed** — a caret and a one-line selection render identically, because they
  address the same range. `selection.isEmpty` still tells them apart on the wire.
- **Changed** — `context: ''` now carries two meanings (an exclude glob matched,
  or nothing is open). Readers already treated it as "publish nothing".

## 0.1.0 — 2026-10-15

First public release.

- **State file** — one JSON file per editor window under
  `~/.editor-context/windows/<pid>.json`, written atomically and debounced by
  150 ms. Each window owns its file, so no lock is needed and no window
  overwrites another; readers take the newest by mtime.
- **Rendered text in the state file** — formatting lives in one place
  (TypeScript) and the hook assembles nothing, so the two cannot drift apart in
  wording.
- **Stable position identity** — `sig` is file + range + selection-or-caret, so
  moving left and right inside one line is not a change.
- **Exclusion before publication** — `excludeGlobs` is enforced before anything
  is written: a matching path publishes nothing at all, not even its name.
- **Commands** — `Editor Context: Show State File`, and
  `Copy Current Position as Context`.
- **Remote-SSH installer** — `scripts/install-cursor-remote.mjs`, because a
  remote window has no `cursor` CLI. It backs up `extensions.json` and is
  idempotent.
- **Claude Code / DSH hook** — `hooks/editor_context.py`, a zero-dependency
  `UserPromptSubmit` hook, installed by `scripts/install-dsh-hook.mjs`.
- **No selected text is collected.** The extension publishes which lines, not
  what is on them.

### Notes

- For DSH specifically, prefer the native plugin
  [`dsh-editor-context`](https://github.com/pandarayc/dsh-editor-context) over
  the hook. The hook injects on every prompt, which on DSH appends one durable
  user message per turn once the cursor moves often.
- The hook's dedup cache may fall back to `<session cwd>/.dsh/editor-context/`,
  because DSH's shell sandbox makes `~/.editor-context` readable but not
  writable.
