import * as vscode from 'vscode';
import * as path from 'path';

const fsp = require('fs').promises as typeof import('fs').promises;
const DEFAULT_IGNORE = ['_media', 'attachments', 'templates', 'node_modules', '.git', '.vscode'];

interface SectionPick {
  label: string;
  description?: string;
  dir: string;
}

/**
 * Let the user choose a destination folder within the notebook. Returns an
 * absolute directory path, or undefined if cancelled. Includes the notebook
 * root plus every (non-ignored) subfolder, indented to show hierarchy.
 */
export async function pickDestination(
  root: vscode.Uri,
  placeHolder = 'Where should this note go?',
): Promise<string | undefined> {
  const cfg = vscode.workspace.getConfiguration('markdownNotebook');
  const ignore = new Set(
    (cfg.get<string[]>('ignoreFolders', DEFAULT_IGNORE) ?? DEFAULT_IGNORE).map((s) => s.toLowerCase()),
  );

  const picks: SectionPick[] = [{ label: '$(book) Notebook root', dir: root.fsPath }];
  await collectFolders(root.fsPath, ignore, 0, picks);
  picks.push({ label: '$(new-folder) New section…', dir: '\u0000new' });

  const chosen = await vscode.window.showQuickPick(picks, { placeHolder });
  if (!chosen) {
    return undefined;
  }
  if (chosen.dir === '\u0000new') {
    return createSection(root.fsPath);
  }
  return chosen.dir;
}

async function collectFolders(
  dir: string,
  ignore: Set<string>,
  depth: number,
  out: SectionPick[],
): Promise<void> {
  if (depth > 6) {
    return;
  }
  let entries: import('fs').Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !ignore.has(e.name.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const e of dirs) {
    const full = path.join(dir, e.name);
    out.push({
      label: `${'\u00a0\u00a0'.repeat(depth + 1)}$(folder) ${e.name}`,
      dir: full,
    });
    await collectFolders(full, ignore, depth + 1, out);
  }
}

async function createSection(rootDir: string): Promise<string | undefined> {
  const name = await vscode.window.showInputBox({
    prompt: 'Name for the new section',
    placeHolder: 'e.g. Meetings',
    validateInput: (v) => (/[\\/:*?"<>|]/.test(v) ? 'Name contains invalid characters.' : undefined),
  });
  if (!name || !name.trim()) {
    return undefined;
  }
  const dir = path.join(rootDir, name.trim());
  try {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
  } catch (err) {
    vscode.window.showErrorMessage(`Notebook: could not create section (${String(err)}).`);
    return undefined;
  }
  return dir;
}
