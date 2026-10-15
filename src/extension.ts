/**
 * VS Code / Cursor entry point: turn editor events into the published state file.
 *
 * The extension is a producer only — it never talks to an agent directly. Agents
 * read the file (via a hook) or, in a later milestone, call the MCP server.
 */

import * as vscode from 'vscode';
import {
  buildWindowState,
  type ContextLanguage,
  type PositionInput,
  type SelectionInfo,
} from './core';
import { removeWindowState, resolveStateDir, windowFile, writeWindowState } from './state';

/** Pending debounced write. */
let debounce: NodeJS.Timeout | undefined;

/** State directory last resolved, so dispose can clean up without re-reading config. */
let lastDir = '';

function configuration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('editorContext');
}

function stateDirOf(cfg: vscode.WorkspaceConfiguration): string {
  lastDir = resolveStateDir(cfg.get<string>('stateDir', ''));
  return lastDir;
}

/** Describe the active editor as a publishable position. */
function currentInput(pid: number, cfg: vscode.WorkspaceConfiguration): PositionInput {
  const excludeGlobs = cfg.get<string[]>('excludeGlobs', []);
  const language: ContextLanguage = cfg.get<string>('language', 'zh') === 'en' ? 'en' : 'zh';
  const base = {
    pid,
    appName: vscode.env.appName,
    now: new Date().toISOString(),
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    excludeGlobs,
    language,
  };
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.document.uri.scheme !== 'file') {
    return { ...base, activeFile: '', relativePath: '', languageId: '', selection: null };
  }
  const { document } = editor;
  const { selection: sel } = editor;
  const selection: SelectionInfo = {
    startLine: sel.start.line + 1,
    endLine: sel.end.line + 1,
    startColumn: sel.start.character + 1,
    endColumn: sel.end.character + 1,
    isEmpty: sel.isEmpty,
  };
  return {
    ...base,
    activeFile: document.uri.fsPath,
    relativePath: vscode.workspace.asRelativePath(document.uri, false),
    languageId: document.languageId,
    selection,
  };
}

/** Publish (or retract) this window's state. */
async function flush(pid: number): Promise<void> {
  const cfg = configuration();
  const dir = stateDirOf(cfg);
  if (!cfg.get<boolean>('enabled', true)) {
    await removeWindowState(dir, pid);
    return;
  }
  await writeWindowState(dir, pid, buildWindowState(currentInput(pid, cfg)));
}

/** Coalesce a burst of editor events into one write. */
function schedule(pid: number): void {
  if (debounce !== undefined) clearTimeout(debounce);
  const delay = Math.max(0, configuration().get<number>('debounceMs', 150));
  debounce = setTimeout(() => {
    void flush(pid);
  }, delay);
}

export function activate(context: vscode.ExtensionContext): void {
  const pid = process.pid;

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(() => {
      schedule(pid);
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      schedule(pid);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      schedule(pid);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('editorContext')) schedule(pid);
    }),
    vscode.commands.registerCommand('editorContext.showState', () => showState(pid)),
    vscode.commands.registerCommand('editorContext.copyContext', () => copyContext(pid)),
    {
      dispose: () => {
        if (debounce !== undefined) clearTimeout(debounce);
        const dir = lastDir === '' ? resolveStateDir() : lastDir;
        void removeWindowState(dir, pid);
      },
    },
  );

  schedule(pid);
}

export function deactivate(): void {
  // The disposable registered in activate() removes this window's state file.
}

async function showState(pid: number): Promise<void> {
  await flush(pid);
  const dir = stateDirOf(configuration());
  const file = windowFile(dir, pid);
  try {
    const document = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(document);
  } catch {
    void vscode.window.showWarningMessage(`Editor Context: state file not written yet (${file})`);
  }
}

async function copyContext(pid: number): Promise<void> {
  const context = buildWindowState(currentInput(pid, configuration())).context;
  if (context === '') {
    void vscode.window.showWarningMessage(
      'Editor Context: nothing to copy — no active file, or it matches editorContext.excludeGlobs.',
    );
    return;
  }
  await vscode.env.clipboard.writeText(context);
  void vscode.window.showInformationMessage('Editor Context: current position copied as context text.');
}
