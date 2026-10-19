# Internals

Engineering notes for `editor-context`. The user-facing story is in the
[README](../README.md); the original survey is in [design.md](design.md).

## Why the rendered text is one terse line

`context` used to be three lines of narration:

```
[编辑器位置] 用户当前在 Cursor 里选中了 src/auth.ts 第 11-14 行（共 4 行）。
绝对路径：/w/src/auth.ts
需要看内容时用 read 工具读该区间（offset=11, limit=4）。
```

It is now:

```
[编辑器位置] /w/src/auth.ts 第 11-14 行
```

Everything removed was derivable by the reader, which is a model — or not
actionable by it:

| Removed | Why it was noise |
|---|---|
| `（共 4 行）` | `11-14` is four lines; the reader subtracts |
| `offset=11, limit=4` | the reader can map a line range onto `read`'s parameters itself, and it is the reader that knows the tool's signature |
| `绝对路径：…` plus the relative path | the absolute path already ends in the relative one; printing both is a repeated substring |
| `Cursor` | which editor the path is open in changes nothing about how it is read. `appName` is still published in the state file for a human looking at it; it is not in the rendered line, and the DSH plugin's payload does not carry it either |
| `用户当前在…里选中了` | third-person narration of an address. Once it sits next to what the user actually typed, it reads like something they said |

Two consequences worth knowing:

- **A caret and a one-line selection render identically** (`第 7 行`). They address
  the same thing, so they read the same. The structured `selection.isEmpty` still
  distinguishes them on the wire for consumers that care.
- **The absolute path is what is rendered**, because `relativePath` is relative to
  the *editor's* workspace root, which is generally not the agent's working
  directory — a reader could not open it. `relativePath` stays in the JSON for
  display.

## Why `context: ''` means two different things

The empty string is the only "do not publish" signal on the wire, and two
situations produce it:

1. **an exclude glob matched** — the point is that not even the path escapes;
2. **no file is open** — there is simply nothing to say.

The second one used to render a sentence (`用户当前在 Cursor 中没有打开任何文件。`).
That was a bug in disguise: the hook fires on every prompt, so a user with no file
open got that line injected *every turn*. Silence is both shorter and correct.

`readPosition` in the DSH plugin therefore treats `context === ''` as "nothing to
report" and answers 404 — it never needs to tell the two cases apart, and the
route must not leak which one it was.

## The hook's four hard contracts

From the `@deepseek-ai/dsh-hook-protocol` type declarations. `hooks/editor_context.py`
satisfies all four; breaking one fails **silently**.

| Contract | What goes wrong |
|---|---|
| `type` must be `command` | `http` / `mcp_tool` / `prompt` / `agent` handlers are skipped with a warning |
| `hookSpecificOutput.hookEventName` must equal `"UserPromptSubmit"` | on a mismatch the event-domain fields, including `additionalContext`, are **dropped silently** |
| stdout must be JSON, not bare text | the Claude Code dialect renders bare stdout as *output*, not as context |
| write `timeout` explicitly | the bridge defaults to 600 seconds, not Claude Code's 30 |

`UserPromptSubmit` ignores matchers; matching hooks run serially and their context
accumulates in hook order.

### Where the dedup cache lives

Hooks are spawned through DSH's `ShellExecutor`, so they inherit the session's file
sandbox: `~/.editor-context` is **readable but not writable**. Writing the cache
there fails with `EROFS`, and a swallowed failure means "inject on every single
turn". So `cache_candidates` tries, in order:

1. `<state dir>/.injected-<session>`
2. `<session cwd>/.dsh/editor-context/<session>.sig`
3. `<session cwd>/.editor-context/<session>.sig`

The workspace fallbacks are why a `.dsh/` folder can appear in a project.

Environment: `EDITOR_CONTEXT_DIR` overrides the state directory,
`EDITOR_CONTEXT_MAX_AGE_SECONDS` (default 3600) ages a reading out. A file named
`disabled` in the state directory is an instant kill switch — hooks cannot persist
anything, so the flag has to live somewhere they can read.

## Why a hook and not just MCP

MCP is a **pull** interface: the model gets data when it calls a tool, and it cannot
push "you are looking at line 12" into the prompt. This is how Claude Code's own IDE
integration is split too — its IDE server exposes only two tools, and selection
sharing goes through harness-side context injection.

That leaves two faces, and only one is built:

| Face | Covers | Status |
|---|---|---|
| state file + hook | automatic knowledge every turn | shipped |
| MCP server | the model *asking* what you are looking at, and making the editor jump to a line | not built |

`dsh-hook-protocol`'s guidance makes the same point from the other side: if you are
only serving DSH, a native Cordis plugin is cleaner than the hook bridge, because
you get the full harness API. The hook face exists here so that **one script serves
Claude Code, DSH and Cursor alike** — and on DSH specifically, the native plugin is
[`dsh-editor-context`](https://github.com/pandarayc/dsh-editor-context).

## The publisher: subscribers, and why the text rule split in two

Up to 0.2.0 this extension had one consumer and one guarantee: the position is an
address, and **selected text is never collected**. Both changed together, and the
reason is the same in each case — the extension stopped deciding what a reading
means.

`windows/<pid>.json` is written on every caret move with no user intent behind it.
Anything in it is published continuously to anyone who can read `$HOME`, so it
stays an address, and that part of the guarantee is unchanged.

A delivery is different in kind. Someone asked for it. Once the extension is a
publisher rather than a component of one specific agent, the honest split is not
"text or no text" but **"did anyone ask just now"**:

| Path | When | Text |
|---|---|---|
| `windows/<pid>.json` | every caret move | never |
| `requests/` (public mailbox) | explicit Add to Bot | yes, if `sendText` |
| `subscribers/<name>/inbox/` | explicit send, any target | yes, unless that subscriber declined |
| `subscribers/<name>/inbox/` | selection change | only for a subscriber with `autoSelection: true` |

`autoSelection` defaults to `false` and that default is the whole safety argument
for the continuous case: an agent that wants a running feed of what the user
highlights has to say so in writing, in a file the user can read and delete.

### Two kinds of subscriber, on purpose

An in-process listener is free — no file, no manifest, no polling — so it hears
every changed selection. A file-based subscriber costs a write per event, so it
opts in. Encoding that asymmetry in the API rather than in a setting means the
cheap path needs no configuration and the expensive path cannot be enabled by
accident.

`subscribe()` is exported from `activate`, so a sibling extension reaches it with
`vscode.extensions.getExtension('pandarayc.editor-context').exports`. The
extension's own listener set is cleared on dispose; a throwing listener is caught
and ignored, because a subscriber's bug is not the publisher's problem.

### Why each window announces its own endpoint

A socket needs a port, and a port is a constant that only one process can hold.
The obvious design — "everyone dials 7788" — makes the second window of a
project silently unreachable, which is exactly what happened in practice.

So the configured port is a **preference**. The window tries it, and on
`EADDRINUSE` binds an ephemeral port instead, then writes
`endpoints/<pid>.json`: the port it actually got, who it is, and a heartbeat.
Announcing only after `listen` succeeds matters — an announcement for a port that
is not open is worse than no announcement, because it sends the reader somewhere
useless.

The reader's rule is the interesting half: keep an entry only when the pid is
alive **and** the heartbeat is recent. Pids are reused, so liveness alone can
point at an unrelated process; freshness alone would forgive a window that
crashed a minute ago. The directory is cleaned on activation, because a crashed
window cannot withdraw its own file.

### Details that are load-bearing

- **`excludeGlobs` produces no delivery**, not an empty one. The rule is about the
  path appearing in a message at all, so blanking the address would defeat it.
- **The text is bounded twice**: a selection over 5000 lines is read only that far
  before the byte budget applies, because a select-all in a generated file is
  megabytes and reading it in order to truncate it wastes the read.
- **The byte cap cuts on a character boundary.** A naive `Buffer.subarray` leaves
  a lone U+FFFD at the end; the trailing replacement characters are stripped
  instead.
- **Mailbox names carry a sequence suffix.** `<epoch-ms>-<pid>-<seq>.json` — the
  fixed-width timestamp keeps a lexical sort chronological, and the suffix stops
  two deliveries in one millisecond from overwriting each other. A silent
  overwrite is the kind of bug that is invisible until it matters.
- **Subscriber names are validated before use as a path segment** (`/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`),
  and an unsafe or unparseable manifest is skipped rather than escaped: one broken
  subscriber must not stop the others from being served.
- **The registry is cached for 3s** on the selection-change path only. Reading a
  directory to answer "is anyone listening continuously?" is not worth doing on
  every debounce tick; the explicit path always re-reads, because the picker is on
  screen.
