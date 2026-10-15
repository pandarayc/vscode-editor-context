/**
 * Pure logic for the Editor Context extension.
 *
 * Deliberately free of any `vscode` import so it can be unit-tested under plain
 * Node after `tsc`. The extension wires VS Code events onto these functions; the
 * Python hook reads the files these functions describe.
 */

export type ContextLanguage = 'zh' | 'en';

/** One selection (or bare cursor) in 1-based editor coordinates. */
export interface SelectionInfo {
  /** 1-based first line. */
  startLine: number;
  /** 1-based last line, inclusive. */
  endLine: number;
  /** 1-based first column. */
  startColumn: number;
  /** 1-based last column. */
  endColumn: number;
  /** True when the selection is empty, i.e. a bare cursor. */
  isEmpty: boolean;
}

/** The JSON payload one editor window publishes into `windows/<pid>.json`. */
export interface WindowState {
  version: 1;
  pid: number;
  /** Editor product name, e.g. `Cursor` or `Visual Studio Code`. */
  appName: string;
  /** ISO-8601 timestamp of the last change. */
  updatedAt: string;
  /** Stable identity of the position, used by the hook for change detection. */
  sig: string;
  /** Text to inject into the next model request; empty means "say nothing". */
  context: string;
  workspaceFolders: string[];
  /** Absolute path, or empty when no file is open. */
  activeFile: string;
  /** Workspace-relative path with `/` separators, or empty. */
  relativePath: string;
  languageId: string;
  selection: SelectionInfo | null;
}

/** Everything needed to describe the position the user is looking at. */
export interface PositionInput {
  pid: number;
  appName: string;
  now: string;
  workspaceFolders: string[];
  activeFile: string;
  relativePath: string;
  languageId: string;
  selection: SelectionInfo | null;
  excludeGlobs: string[];
  language: ContextLanguage;
}

const GLOB_ESCAPE = /[.+^${}()|[\]\\]/g;

/**
 * Translate one glob into an anchored RegExp. Supported syntax is deliberately
 * small: `**` crosses path separators, `*` and `?` do not.
 * @param glob - the pattern.
 * @returns the compiled pattern.
 */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i] as string;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(GLOB_ESCAPE, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

/** Normalize a path to `/` separators so matching is platform-independent. */
export function toPosix(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * Whether a path is excluded from publishing.
 *
 * A pattern containing `/` is matched against the workspace-relative path; a
 * bare pattern is matched against the file name (gitignore-ish, single segment).
 * @param relativePath - workspace-relative path.
 * @param patterns - configured globs.
 * @returns true when the path must not be published at all.
 */
export function isExcluded(relativePath: string, patterns: readonly string[]): boolean {
  const rel = toPosix(relativePath);
  if (rel === '') return false;
  const parts = rel.split('/');
  const base = parts[parts.length - 1] ?? rel;
  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (trimmed === '') continue;
    const target = trimmed.includes('/') ? rel : base;
    if (globToRegExp(trimmed).test(target)) return true;
  }
  return false;
}

/**
 * Stable identity of one position. Moving the caret along the same lines, or
 * re-reading the same range, does not change it — which keeps the hook from
 * re-injecting an identical line every turn.
 * @param input - the position.
 * @returns an opaque signature.
 */
export function signatureOf(input: Pick<PositionInput, 'relativePath' | 'selection'>): string {
  const { relativePath, selection } = input;
  if (relativePath === '') return '';
  if (selection === null) return `${relativePath}|none`;
  const kind = selection.isEmpty ? 'cursor' : 'sel';
  return `${relativePath}|${kind}|${selection.startLine}-${selection.endLine}`;
}

function renderZh(input: PositionInput): string {
  const { relativePath, activeFile, appName, selection } = input;
  if (relativePath === '') {
    return `[编辑器位置] 用户当前在 ${appName} 中没有打开任何文件。`;
  }
  if (selection === null) {
    return `[编辑器位置] 用户当前在 ${appName} 里查看 ${relativePath}。\n绝对路径：${activeFile}`;
  }
  if (selection.isEmpty) {
    return (
      `[编辑器位置] 用户当前在 ${appName} 里把光标停在 ${relativePath} 第 ${selection.startLine} 行。\n` +
      `绝对路径：${activeFile}`
    );
  }
  const span = selection.endLine - selection.startLine + 1;
  return (
    `[编辑器位置] 用户当前在 ${appName} 里选中了 ${relativePath} 第 ${selection.startLine}-${selection.endLine} 行（共 ${span} 行）。\n` +
    `绝对路径：${activeFile}\n` +
    `需要看内容时用 read 工具读该区间（offset=${selection.startLine}, limit=${span}）。`
  );
}

function renderEn(input: PositionInput): string {
  const { relativePath, activeFile, appName, selection } = input;
  if (relativePath === '') {
    return `[editor position] The user has no file open in ${appName}.`;
  }
  if (selection === null) {
    return `[editor position] The user is looking at ${relativePath} in ${appName}.\nAbsolute path: ${activeFile}`;
  }
  if (selection.isEmpty) {
    return (
      `[editor position] The user's caret is on line ${selection.startLine} of ${relativePath} in ${appName}.\n` +
      `Absolute path: ${activeFile}`
    );
  }
  const span = selection.endLine - selection.startLine + 1;
  return (
    `[editor position] The user selected lines ${selection.startLine}-${selection.endLine} (${span} lines) of ${relativePath} in ${appName}.\n` +
    `Absolute path: ${activeFile}\n` +
    `Read that range with offset=${selection.startLine}, limit=${span} when its contents matter.`
  );
}

/**
 * Render the text the hook injects, or the empty string when nothing may be
 * published (excluded path).
 * @param input - the position.
 * @returns model-facing context text.
 */
export function renderContext(input: PositionInput): string {
  if (input.relativePath !== '' && isExcluded(input.relativePath, input.excludeGlobs)) {
    return '';
  }
  return input.language === 'en' ? renderEn(input) : renderZh(input);
}

/**
 * Build the full payload for one editor window.
 * @param input - the position plus its policy.
 * @returns the JSON-serializable state.
 */
export function buildWindowState(input: PositionInput): WindowState {
  const context = renderContext(input);
  return {
    version: 1,
    pid: input.pid,
    appName: input.appName,
    updatedAt: input.now,
    sig: context === '' ? '' : signatureOf(input),
    context,
    workspaceFolders: input.workspaceFolders,
    activeFile: context === '' ? '' : input.activeFile,
    relativePath: context === '' ? '' : input.relativePath,
    languageId: context === '' ? '' : input.languageId,
    selection: context === '' ? null : input.selection,
  };
}
