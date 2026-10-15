# editor-context

> **[English](README.md) · [中文](README.zh.md)**

Publish which lines you are looking at in Cursor / VS Code, so any agent on the same machine can know.

One extension, one collector, several consumers: a **state file** (what ships today), a **Claude Code hook**, and — for DSH — a separate plugin that turns the reading into a chip in the composer.

> Why not just emit `@path:11-14`: DSH's `@` mention grammar is **path-only**; line numbers exist only in markdown links (`#L11-L14`). This extension therefore publishes a plain description rather than an `@` token, which DSH would read as a file literally named `src/auth.ts:11-14`.

---

## What it does

On every caret move, selection change or file switch, the extension atomically writes the current position to:

```
~/.editor-context/
└── windows/
    └── <extension host pid>.json     # one file per editor window
```

**Each window writes its own file.** VS Code / Cursor run one extension host per window, so there is no lock to take and no window overwrites another; readers take the newest by mtime.

One window file looks like this:

```json
{
  "version": 1,
  "pid": 9931,
  "appName": "Cursor",
  "updatedAt": "2026-10-14T10:30:33.921Z",
  "sig": "editor-context/src/core.ts|sel|11-14",
  "context": "[编辑器位置] 用户当前在 Cursor 里选中了 editor-context/src/core.ts 第 11-14 行（共 4 行）。\n绝对路径：/data/project/dsh-plugin/editor-context/src/core.ts\n需要看内容时用 read 工具读该区间（offset=11, limit=4）。",
  "workspaceFolders": ["/data/project/dsh-plugin"],
  "activeFile": "/data/project/dsh-plugin/editor-context/src/core.ts",
  "relativePath": "editor-context/src/core.ts",
  "languageId": "typescript",
  "selection": { "startLine": 11, "endLine": 14, "startColumn": 1, "endColumn": 40, "isEmpty": false }
}
```

- `context` is the **already rendered** injection text. Formatting lives in exactly one place (TypeScript); the hook script assembles nothing, so two authors cannot drift apart in wording.
- `sig` is the stable identity of a position (file + range + selection-or-caret). A column change is not a change, so moving left and right inside one line does not re-inject.
- **Selected text is never collected.** This version publishes which lines, not what is on them.

---

## Install

### Option 1: Remote-SSH (Cursor runs on another machine)

A remote window has **no** `cursor` CLI — that lives on the client machine — so the extension must be placed in the **server-side** extension directory. Use the bundled script:

```bash
node scripts/install-cursor-remote.mjs --vsix ./editor-context-0.1.0.vsix
```

It does the two things the server would otherwise do for you: unpacks the VSIX into `~/.cursor-server/extensions/<publisher>.editor-context-0.1.0/` (renaming `.vsixmanifest` to the dotted form) and writes the entry into `extensions/extensions.json` — **backing it up first**, and idempotently, so re-running replaces the entry instead of appending a duplicate. It probes `~/.cursor-server` and falls back to `~/.vscode-server`; pass `--server <dir>` to be explicit.

**Measured: no manual restart is needed.** Cursor's extension host activates it on its own, and `~/.editor-context/windows/` shows a file immediately.

### Option 2: A local window (Cursor / VS Code on this machine)

```bash
cursor --install-extension editor-context-0.1.0.vsix
# or: Command Palette → Extensions: Install from VSIX…
```

VS Code is the same API: `code --install-extension`.

### Option 3: Development mode

```bash
cd editor-context
npm install --cache ../.npm-cache
npm run compile
# open this folder in Cursor and press F5 for an Extension Development Host
```

Then open any file, select a few lines, and:

```bash
cat ~/.editor-context/windows/*.json
```

---

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `editorContext.enabled` | `true` | Turning it off **deletes** this window's state file |
| `editorContext.stateDir` | empty → `~/.editor-context` | Move the directory |
| `editorContext.excludeGlobs` | `.env` / `*.pem` / `*.key` / `id_rsa*` / `id_ed25519*` / `.ssh/**` / `node_modules/**` | A match publishes **nothing at all, not even the path** (this is not about hiding the text). A pattern containing `/` matches the workspace-relative path; a bare pattern matches the file name |
| `editorContext.language` | `zh` | Language of the rendered text: `zh` / `en` |
| `editorContext.debounceMs` | `150` | Coalescing window for caret jitter |

Two commands are also registered: `Editor Context: Show State File`, and `Copy Current Position as Context` (puts the description on the clipboard so you can paste it to any agent by hand).

---

## Connecting to DSH

> **Read this first if you are using DSH.** There are two ways in, and the hook is the wrong one for DSH.
>
> The plugin **[`dsh-editor-context`](https://github.com/pandarayc/dsh-editor-context)** reads these state files and offers the position as a chip in the composer — text you type, into your own message.
>
> The hook below injects automatically on every prompt. Measured on DSH, that **appends one durable user message per turn** whenever the cursor moves often: the dedup key is the exact position, and a high-cardinality dedup key is no dedup at all. It is kept for editors that are not driving DSH.

The bundled script is idempotent, **backs up** `hooks.json` first, and preserves any `PreToolUse` / `PostToolUse` you already have:

```bash
node scripts/install-dsh-hook.mjs            # add --print to see what it would write
```

It copies `hooks/editor_context.py` into `~/.dsh/hooks/` and merges a `UserPromptSubmit` entry into `~/.dsh/hooks/hooks.json`:

```json
{
  "UserPromptSubmit": [
    {
      "hooks": [
        { "type": "command", "command": "python3 \"$HOME/.dsh/hooks/editor_context.py\"", "timeout": 5 }
      ]
    }
  ]
}
```

Doing it by hand is the same two steps: copy the script, merge the object above into `hooks`.

**Then restart dsh-web** — `configPath` is read once at DSH process start (a note in `~/.dsh/profiles/web/cordis.patch.yml` says so).

### Four hard contracts (getting one wrong fails silently)

Taken from the `@deepseek-ai/dsh-hook-protocol` type declarations. The bundled script satisfies all four; do not break them when editing:

| Contract | Why |
|---|---|
| `type` must be `command` | `http` / `mcp_tool` / `prompt` / `agent` handlers are skipped with a warning |
| `hookSpecificOutput.hookEventName` must equal `"UserPromptSubmit"` | On a mismatch the event-domain fields (including `additionalContext`) are **dropped silently** |
| It must be JSON, not bare stdout | The Claude Code dialect renders bare stdout as *output*, not as context |
| Write `timeout` explicitly | The bridge defaults to 600 seconds, not Claude Code's 30 |

`UserPromptSubmit` ignores matchers; matching hooks run serially and their context accumulates in hook order.

### Verifying

```bash
echo '{"session_id":"t1"}' | python3 ~/.dsh/hooks/editor_context.py   # prints JSON when there is a position
echo '{"session_id":"t1"}' | python3 ~/.dsh/hooks/editor_context.py   # position unchanged → no output (0 bytes)
```

`EDITOR_CONTEXT_DIR` overrides the state directory; a reading older than `EDITOR_CONTEXT_MAX_AGE_SECONDS` (default 3600) is treated as stale and not injected.

---

## Connecting to Claude Code

The same script, dropped into `~/.claude/settings.json` (Claude Code reads that format natively). Note that Claude Code's `UserPromptSubmit` accepts both bare-stdout context and JSON; the JSON form used here works in both places.

---

## Why a hook, and not just MCP

MCP is a **pull** interface: the model gets data when it calls a tool, and it cannot push "you are looking at line 12" into the prompt. Claude Code's own IDE integration is split the same way — its IDE server exposes only two tools to the model, and selection sharing goes through harness-side context injection.

So the division is:

| Face | Covers | Status |
|---|---|---|
| State file + hook | automatic knowledge every turn (the model need not ask) | ✅ this version |
| MCP server | the model asking "what am I looking at", and making the IDE jump to a line | not built |

The `dsh-hook-protocol` guidance makes the same point from the other side: if you are only serving DSH, a **native Cordis plugin** is cleaner than going through the hook bridge, because you get the full harness API. The hook face is chosen here so that **one script serves Claude Code, DSH and Cursor alike** — and for DSH specifically, `dsh-editor-context` is the native plugin.

---

## Layout

```
src/core.ts         pure logic: position model, glob exclusion, rendering (no vscode import, unit-testable)
src/state.ts        atomic write of windows/<pid>.json
src/extension.ts    VS Code event wiring
hooks/editor_context.py   UserPromptSubmit hook (zero-dependency Python 3.8+)
test/core.test.mjs        10 pure-logic cases
test/hook.test.mjs        11 hook end-to-end cases
```

```bash
npm run compile && npm test    # 21 passed
```

## Known limitations

- **The hook's "only when it changed" cache may have to live in your workspace.** Hooks are launched by DSH's `ShellExecutor` (`@deepseek-ai/dsh-shell`) and inherit the session's file sandbox: `~/.editor-context` is **readable but not writable**. The dedup cache therefore tries locations in order — the state directory first, then `<session cwd>/.dsh/editor-context/<session>.sig`. A `.dsh/editor-context/` appearing in your project is that; add it to `.gitignore`. With nowhere writable it falls back to injecting every turn rather than failing silently.
- **Single-line jumps only.** Highlighting a whole 12-15 range is not attempted here: DSH's `#L` fragment itself carries one line (`WorkspaceFileParams.line`). Range highlighting would need the IDE side to do it.
- **Injects only on change.** An unchanged position is not re-injected, to save tokens. The side effect: after a compaction, if the position has not moved, that description may no longer be in context. Move the caret to get it back.
- **With several windows, the most recently updated one wins.** There is no cross-process notion of "the active window".
