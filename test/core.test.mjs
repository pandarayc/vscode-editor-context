/**
 * Unit tests for the pure core. Runs under plain Node against the compiled
 * `out/core.js`, with no VS Code host.
 *
 *   npm run compile && node --test test/core.test.mjs
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const {
  buildWindowState,
  globToRegExp,
  isExcluded,
  renderContext,
  signatureOf,
  toPosix,
} = require('../out/core.js');

/** A selected 4-line range in `src/auth.ts`. */
function input(overrides = {}) {
  return {
    pid: 4242,
    appName: 'Cursor',
    now: '2026-10-14T00:00:00.000Z',
    workspaceFolders: ['/w'],
    activeFile: '/w/src/auth.ts',
    relativePath: 'src/auth.ts',
    languageId: 'typescript',
    selection: { startLine: 11, endLine: 14, startColumn: 1, endColumn: 5, isEmpty: false },
    excludeGlobs: [],
    language: 'zh',
    ...overrides,
  };
}

test('globToRegExp: ** crosses separators, * does not', () => {
  assert.equal(globToRegExp('*.pem').test('a.pem'), true);
  assert.equal(globToRegExp('*.pem').test('nested/a.pem'), false);
  assert.equal(globToRegExp('**/.env').test('.env'), true);
  assert.equal(globToRegExp('**/.env').test('a/b/.env'), true);
  assert.equal(globToRegExp('**/node_modules/**').test('node_modules/x/y.ts'), true);
  assert.equal(globToRegExp('**/node_modules/**').test('p/node_modules/y.ts'), true);
  assert.equal(globToRegExp('src/*.ts').test('src/a.ts'), true);
  assert.equal(globToRegExp('src/*.ts').test('src/deep/a.ts'), false);
  // `.` must stay literal, not a wildcard.
  assert.equal(globToRegExp('a.b').test('axb'), false);
});

test('isExcluded: bare patterns match the file name, slashed ones the path', () => {
  const patterns = ['**/.env', '**/*.pem', 'id_rsa*', '**/node_modules/**'];
  assert.equal(isExcluded('src/auth.ts', patterns), false);
  assert.equal(isExcluded('deep/.env', patterns), true);
  assert.equal(isExcluded('.env', patterns), true);
  assert.equal(isExcluded('keys/server.pem', patterns), true);
  assert.equal(isExcluded('keys/id_rsa', patterns), true);
  assert.equal(isExcluded('node_modules/x/i.js', patterns), true);
  assert.equal(isExcluded('', patterns), false);
});

test('toPosix normalizes Windows separators', () => {
  assert.equal(toPosix('a\\b\\c.ts'), 'a/b/c.ts');
});

test('renderContext (zh): a selection names the range and the read hint', () => {
  const text = renderContext(input());
  assert.match(text, /Cursor/);
  assert.match(text, /src\/auth\.ts 第 11-14 行/);
  assert.match(text, /共 4 行/);
  assert.match(text, /offset=11, limit=4/);
  // The `@path:line` spelling is unreadable to DSH, so it must never appear.
  assert.doesNotMatch(text, /@src\/auth\.ts:11/);
});

test('renderContext (zh): a bare cursor is described differently', () => {
  const text = renderContext(
    input({ selection: { startLine: 42, endLine: 42, startColumn: 7, endColumn: 7, isEmpty: true } }),
  );
  assert.match(text, /把光标停在 src\/auth\.ts 第 42 行/);
  assert.doesNotMatch(text, /offset=/);
});

test('renderContext (en) switches language', () => {
  const text = renderContext(input({ language: 'en' }));
  assert.match(text, /selected lines 11-14 \(4 lines\)/);
  assert.match(text, /offset=11, limit=4/);
});

test('renderContext: an excluded path publishes nothing at all', () => {
  const text = renderContext(input({ relativePath: 'deep/.env', excludeGlobs: ['**/.env'] }));
  assert.equal(text, '');
});

test('buildWindowState: excluded position is scrubbed, not just blanked', () => {
  const state = buildWindowState(input({ relativePath: '.env', excludeGlobs: ['**/.env'] }));
  assert.equal(state.context, '');
  assert.equal(state.sig, '');
  assert.equal(state.activeFile, '');
  assert.equal(state.relativePath, '');
  assert.equal(state.selection, null);
  assert.equal(state.appName, 'Cursor', 'window identity survives so the hook can still clear its cache');
});

test('buildWindowState: a published position keeps its fields', () => {
  const state = buildWindowState(input());
  assert.equal(state.version, 1);
  assert.equal(state.pid, 4242);
  assert.equal(state.activeFile, '/w/src/auth.ts');
  assert.equal(state.selection.startLine, 11);
  assert.notEqual(state.sig, '');
});

test('signatureOf: stable across column-only moves, changes with the line range', () => {
  const base = input();
  const cols = input({
    selection: { startLine: 11, endLine: 14, startColumn: 3, endColumn: 9, isEmpty: false },
  });
  assert.equal(signatureOf(base), signatureOf(cols));

  const moved = input({
    selection: { startLine: 11, endLine: 15, startColumn: 1, endColumn: 5, isEmpty: false },
  });
  assert.notEqual(signatureOf(base), signatureOf(moved));
  assert.notEqual(signatureOf(base), signatureOf({ ...base, relativePath: 'src/other.ts' }));
  assert.equal(signatureOf({ relativePath: '', selection: null }), '');
});
