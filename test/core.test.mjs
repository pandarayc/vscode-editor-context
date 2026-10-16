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

test('renderContext (zh): one line, an absolute path and a range', () => {
  const text = renderContext(input());
  assert.equal(text, '[编辑器位置] /w/src/auth.ts 第 11-14 行');
  // Everything the reader can derive is left out on purpose.
  assert.doesNotMatch(text, /共 4 行/);
  assert.doesNotMatch(text, /offset=/);
  assert.doesNotMatch(text, /Cursor/, 'which editor the position came from is not actionable');
  assert.equal(text.split('auth.ts').length - 1, 1, 'the path appears once, not as an absolute and a relative pair');
  assert.equal(text.split('\n').length, 1, 'one line, not a paragraph');
});

test('renderContext (zh): a caret collapses to a single line number', () => {
  const text = renderContext(
    input({ selection: { startLine: 42, endLine: 42, startColumn: 7, endColumn: 7, isEmpty: true } }),
  );
  assert.equal(text, '[编辑器位置] /w/src/auth.ts 第 42 行');
});

test('renderContext (zh): a one-line selection reads the same as a caret', () => {
  const oneLine = renderContext(
    input({ selection: { startLine: 7, endLine: 7, startColumn: 1, endColumn: 9, isEmpty: false } }),
  );
  assert.equal(oneLine, '[编辑器位置] /w/src/auth.ts 第 7 行');
});

test('renderContext (en) switches language', () => {
  assert.equal(renderContext(input({ language: 'en' })), '[editor position] /w/src/auth.ts lines 11-14');
});

test('renderContext: an excluded path publishes nothing at all', () => {
  const text = renderContext(input({ relativePath: 'deep/.env', excludeGlobs: ['**/.env'] }));
  assert.equal(text, '');
});

test('renderContext: no file open publishes nothing either', () => {
  // Not prose. A per-turn reader would otherwise announce "no file is open"
  // every single turn, which is the loudest possible way to say nothing.
  const text = renderContext(input({ activeFile: '', relativePath: '', selection: null }));
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

test('buildWindowState: no file open is scrubbed the same way', () => {
  const state = buildWindowState(input({ activeFile: '', relativePath: '', selection: null }));
  assert.equal(state.context, '');
  assert.equal(state.sig, '');
  assert.equal(state.pid, 4242, 'the window still identifies itself, so "the extension is alive" stays readable');
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
