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


def state_dir() -> str:
    override = os.environ.get("EDITOR_CONTEXT_DIR", "").strip()
    if override:
        return os.path.expanduser(override)
    return os.path.join(os.path.expanduser("~"), ".editor-context")


def newest_state(directory: str) -> tuple[str, float]:
    """Return the most recently modified window state file, or ('', -1)."""
    best_path = ""
    best_mtime = -1.0
    for path in glob.glob(os.path.join(directory, "windows", "*.json")):
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

    path, mtime = newest_state(directory)
    if not path or (max_age >= 0 and time.time() - mtime > max_age):
        return

    try:
        with open(path, encoding="utf-8") as handle:
            state = json.load(handle)
    except Exception:
        return
    if not isinstance(state, dict):
        return

    signature = str(state.get("sig") or "")
    context = str(state.get("context") or "").strip()

    session_id = str(payload.get("session_id") or payload.get("sessionId") or "default")
    candidates = cache_candidates(directory, session_id, cwd)
    if signature != "" and any(read_text(candidate).strip() == signature for candidate in candidates):
        return

    if signature != "":
        for candidate in candidates:
            try:
                os.makedirs(os.path.dirname(candidate), exist_ok=True)
                with open(candidate, "w", encoding="utf-8") as handle:
                    handle.write(signature)
                break
            except OSError:
                continue

    if context == "":
        return

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
