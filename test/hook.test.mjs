/**
 * End-to-end test of the UserPromptSubmit hook against a synthetic state file.
 * Verifies the four contract points that fail silently when wrong:
 * JSON on stdout, matching `hookEventName`, change detection, never blocking.
 *
 *   node --test test/hook.test.mjs
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOOK = join(ROOT, 'hooks', 'editor_context.py');

/**
 * Run the hook with the given stdin payload and state directory.
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
function runHook(stateDir, payload, extraEnv = {}) {
  const result = spawnSync('python3', [HOOK], {
    cwd: ROOT,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      EDITOR_CONTEXT_DIR: stateDir,
      ...extraEnv,
    },
  });
  assert.equal(result.status, 0, `hook must always exit 0, got ${String(result.status)}: ${result.stderr}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Publish one window state into a fresh temp directory. */
async function publish(state, { pid = 1, mtime } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'editor-context-'));
  await mkdir(join(dir, 'windows'), { recursive: true });
  const file = join(dir, 'windows', `${pid}.json`);
  await writeFile(file, JSON.stringify(state), 'utf8');
  if (mtime !== undefined) await utimes(file, mtime, mtime);
  return { dir, file };
}

const STATE = { version: 1, pid: 1, sig: 'src/auth.ts|sel|11-14', context: 'CTX-A' };

test('hook emits JSON with the exact event name', async () => {
  const { dir } = await publish(STATE);
  const { stdout } = runHook(dir, { session_id: 's1', prompt: 'hi' });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.equal(parsed.hookSpecificOutput.additionalContext, 'CTX-A');
});

test('hook injects once per position, then stays quiet', async () => {
  const { dir } = await publish(STATE);
  assert.notEqual(runHook(dir, { session_id: 's1' }).stdout, '');
  assert.equal(runHook(dir, { session_id: 's1' }).stdout, '', 'unchanged position must inject nothing');
});

test('hook re-injects when the position changes', async () => {
  const { dir, file } = await publish(STATE);
  assert.notEqual(runHook(dir, { session_id: 's1' }).stdout, '');
  await writeFile(
    file,
    JSON.stringify({ ...STATE, sig: 'src/auth.ts|sel|20-24', context: 'CTX-B' }),
    'utf8',
  );
  const { stdout } = runHook(dir, { session_id: 's1' });
  assert.equal(JSON.parse(stdout).hookSpecificOutput.additionalContext, 'CTX-B');
});

test('change detection is per session', async () => {
  const { dir } = await publish(STATE);
  assert.notEqual(runHook(dir, { session_id: 's1' }).stdout, '');
  assert.notEqual(runHook(dir, { session_id: 's2' }).stdout, '', 'another session has its own cache');
});

test('a scrubbed position clears the cache and injects nothing', async () => {
  const { dir, file } = await publish(STATE);
  assert.notEqual(runHook(dir, { session_id: 's1' }).stdout, '');
  await writeFile(file, JSON.stringify({ ...STATE, sig: '', context: '' }), 'utf8');
  assert.equal(runHook(dir, { session_id: 's1' }).stdout, '');
  // And the cleared state must not resurrect the old context.
  await writeFile(file, JSON.stringify({ ...STATE, sig: '', context: '' }), 'utf8');
  assert.equal(runHook(dir, { session_id: 's1' }).stdout, '');
});

test('stale state is ignored', async () => {
  const old = new Date(Date.now() - 7200 * 1000);
  const { dir } = await publish(STATE, { mtime: old });
  assert.equal(runHook(dir, { session_id: 's1' }).stdout, '');
});

test('missing state directory is a silent no-op', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'editor-context-empty-'));
  const { stdout } = runHook(dir, { session_id: 's1' });
  assert.equal(stdout, '');
});

test('malformed stdin and malformed state never break the turn', async () => {
  const { dir, file } = await publish(STATE);
  const broken = spawnSync('python3', [HOOK], {
    cwd: ROOT,
    input: 'not json at all',
    encoding: 'utf8',
    env: { ...process.env, EDITOR_CONTEXT_DIR: dir },
  });
  assert.equal(broken.status, 0);
  assert.notEqual(broken.stdout, '', 'a broken payload still yields the position');

  await writeFile(file, '{ this is not json', 'utf8');
  assert.equal(runHook(dir, { session_id: 's1' }).stdout, '');
});

test('read-only state dir: cache falls back into the session workspace', async () => {
  const { dir } = await publish(STATE);
  const cwd = await mkdtemp(join(tmpdir(), 'editor-context-cwd-'));
  // Readable state, unwritable cache home -- what DSH's file sandbox produces
  // for a hook that tries to write under $HOME.
  await chmod(dir, 0o500);

  try {
    assert.notEqual(runHook(dir, { session_id: 's1', cwd }).stdout, '', 'first sighting must inject');
    assert.equal(runHook(dir, { session_id: 's1', cwd }).stdout, '', 'dedup must work via the fallback');

    const cache = join(cwd, '.dsh', 'editor-context', 's1.sig');
    assert.equal(existsSync(cache), true, 'cache must land in the workspace fallback');
    assert.equal((await readFile(cache, 'utf8')).trim(), STATE.sig);
  } finally {
    await chmod(dir, 0o700);
  }
});

test('writable state dir wins and leaves the workspace clean', async () => {
  const { dir } = await publish(STATE);
  const cwd = await mkdtemp(join(tmpdir(), 'editor-context-cwd2-'));
  assert.notEqual(runHook(dir, { session_id: 's1', cwd }).stdout, '');
  assert.equal(existsSync(join(cwd, '.dsh')), false, 'no workspace litter when the primary cache works');
});

test('a `disabled` file in the state dir switches injection off', async () => {
  const { dir } = await publish(STATE);
  await writeFile(join(dir, 'disabled'), '', 'utf8');
  assert.equal(runHook(dir, { session_id: 's1' }).stdout, '', 'disabled means silent, even on a fresh position');
});
