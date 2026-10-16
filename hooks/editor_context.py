#!/usr/bin/env python3
"""UserPromptSubmit hook: tell the agent which lines the user is looking at.

Reads the newest `windows/<pid>.json` written by the Editor Context extension and
emits it as hook-provided context. Injects only when the position changed, so a
long session does not accumulate an identical line every turn.

Contract notes (see @deepseek-ai/dsh-hook-protocol, lib/types/types.d.ts):

* the payload must be JSON on stdout, and `hookSpecificOutput.hookEventName`
  must equal ``UserPromptSubmit`` -- on mismatch the event-scoped fields,
  including ``additionalContext``, are DISCARDED silently;
* plain stdout is not context (the Claude Code dialect renders it as output);
* any failure must stay non-blocking: this script always exits 0 and prints
  nothing rather than risking the user's prompt.

WHY THE CACHE HAS SEVERAL HOMES: hooks are spawned through DSH's `ShellExecutor`,
so they inherit the session's file sandbox -- the state directory under `$HOME` is
READABLE but not WRITABLE. Writing the change-detection cache there fails with
EROFS, and a silently swallowed failure means "inject on every single turn". So
the cache falls back to a dotted directory inside the session workspace, which the
sandbox does allow. See `cache_candidates`.

Environment:
  EDITOR_CONTEXT_DIR              override the state directory (default ~/.editor-context)
  EDITOR_CONTEXT_MAX_AGE_SECONDS  ignore state older than this (default 3600)
"""

from __future__ import annotations

import glob
import json
import os
import sys
import time

EVENT_NAME = "UserPromptSubmit"
DEFAULT_MAX_AGE_SECONDS = 3600.0
MAX_CONSUMED_REQUESTS = 32


def state_dir() -> str:
    override = os.environ.get("EDITOR_CONTEXT_DIR", "").strip()
    if override:
        return os.path.expanduser(override)
    return os.path.join(os.path.expanduser("~"), ".editor-context")


def newest_in(leaf: str) -> tuple[str, float]:
    """Return the most recently modified JSON document in one leaf directory."""
    best_path = ""
    best_mtime = -1.0
    for path in glob.glob(os.path.join(leaf, "*.json")):
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            continue
        if mtime > best_mtime:
            best_path, best_mtime = path, mtime
    return best_path, best_mtime


def safe_name(session_id: str) -> str:
    """Collapse a session id into one filesystem-safe token."""
    cleaned = "".join(ch if (ch.isalnum() or ch in "-_") else "_" for ch in session_id)
    return (cleaned or "default")[:80]


def cache_candidates(directory: str, session_id: str, cwd: str) -> list[str]:
    """Cache locations in priority order.

    The state directory is the natural home, but hooks run inside the session's
    file sandbox and usually cannot write outside the workspace. The workspace
    locations are the fallback that keeps change detection working; they are
    namespaced under a dotted directory so a project only ever gains one hidden
    folder.
    """
    name = safe_name(session_id)
    out = [os.path.join(directory, ".injected-{}".format(name))]
    if cwd:
        out.append(os.path.join(cwd, ".dsh", "editor-context", "{}.sig".format(name)))
        out.append(os.path.join(cwd, ".editor-context", "{}.sig".format(name)))
    return out


def read_text(path: str) -> str:
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read()
    except OSError:
        return ""


def load(path: str) -> dict:
    """Parse one published document, or {} when it is not usable."""
    try:
        with open(path, encoding="utf-8") as handle:
            state = json.load(handle)
    except Exception:
        return {}
    return state if isinstance(state, dict) else {}


def parse_cache(text: str) -> tuple[str, list[str]]:
    """Read the change cache: the last ambient signature, and consumed requests.

    One slot is not enough. An explicit request and the ambient reading are two
    different documents, so remembering only the most recent signature makes them
    take turns being "new" and the hook injects both forever.

    A bare value is a pre-0.2 cache, which held one signature.
    """
    last_sig = ""
    consumed: list[str] = []
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("sig="):
            last_sig = line[4:]
        elif line.startswith("req="):
            consumed.append(line[4:])
        elif line and last_sig == "":
            last_sig = line
    return last_sig, consumed


def render_cache(last_sig: str, consumed: list[str]) -> str:
    """Serialize the cache, keeping consumed request names bounded."""
    lines = ["sig={}".format(last_sig)] if last_sig else []
    for name in consumed[-MAX_CONSUMED_REQUESTS:]:
        lines.append("req={}".format(name))
    return "\n".join(lines) + "\n"


def main() -> None:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        if not isinstance(payload, dict):
            payload = {}
    except Exception:
        payload = {}

    directory = state_dir()
    # Instant kill switch: hooks cannot persist anything (their writes are
    # swallowed by the session sandbox), so the enable/disable flag lives in the
    # READABLE state directory and is toggled from outside the hook.
    if os.path.exists(os.path.join(directory, "disabled")):
        return
    cwd = str(payload.get("cwd") or "").strip() or os.getcwd()
    try:
        max_age = float(os.environ.get("EDITOR_CONTEXT_MAX_AGE_SECONDS", "") or DEFAULT_MAX_AGE_SECONDS)
    except ValueError:
        max_age = DEFAULT_MAX_AGE_SECONDS

    session_id = str(payload.get("session_id") or payload.get("sessionId") or "default")
    candidates = cache_candidates(directory, session_id, cwd)
    last_sig = ""
    consumed: list[str] = []
    for candidate in candidates:
        text = read_text(candidate)
        if text.strip():
            last_sig, consumed = parse_cache(text)
            break

    def fresh(mtime: float) -> bool:
        return max_age < 0 or time.time() - mtime <= max_age

    def wanted(path: str, mtime: float, is_request: bool) -> bool:
        """Whether this document has something new to say."""
        if not path or not fresh(mtime):
            return False
        state = load(path)
        if str(state.get("context") or "").strip() == "":
            # The editor's "publish nothing": an excluded path, or no file open.
            return False
        if is_request:
            # A request is one-shot, tracked by file name so it stays consumed
            # even after the ambient reading has been injected in between.
            return os.path.basename(path) not in consumed
        signature = str(state.get("sig") or "")
        return signature == "" or signature != last_sig

    # `windows/` is where the caret is; `requests/` is where the user pointed.
    # Same schema, different intent, and the deliberate act is served first.
    chosen = ""
    is_request = False
    for leaf in ("requests", "windows"):
        path, mtime = newest_in(os.path.join(directory, leaf))
        wanted_request = leaf == "requests"
        if wanted(path, mtime, wanted_request):
            chosen, is_request = path, wanted_request
            break
    if chosen == "":
        return

    state = load(chosen)
    context = str(state.get("context") or "").strip()

    if is_request:
        consumed.append(os.path.basename(chosen))
    else:
        last_sig = str(state.get("sig") or "")

    cache_text = render_cache(last_sig, consumed)
    for candidate in candidates:
        try:
            os.makedirs(os.path.dirname(candidate), exist_ok=True)
            with open(candidate, "w", encoding="utf-8") as handle:
                handle.write(cache_text)
            break
        except OSError:
            continue

    sys.stdout.write(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": EVENT_NAME,
                    "additionalContext": context,
                }
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    try:
        main()
    except Exception:  # never break the turn
        pass
    sys.exit(0)
