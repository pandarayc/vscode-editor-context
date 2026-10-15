# Changelog

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
