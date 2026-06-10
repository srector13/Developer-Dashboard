import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { pickDestination } from './notebookFs';
import { promptMetadata, localDateKey } from './metadataPrompt';

/**
 * Import arbitrary copied text (email chains, web snippets, rich text) into a
 * Markdown note. Reads the clipboard, detects whether the content is HTML or
 * plain text, and runs it through pandoc via stdin.
 */
export function registerPasteImport(
  context: vscode.ExtensionContext,
  resolveRoot: () => vscode.Uri | undefined,
  afterCreate?: (uri: vscode.Uri) => void,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('markdownNotebook.importFromClipboard', () =>
      importFromClipboard(resolveRoot, afterCreate),
    ),
  );
}

async function importFromClipboard(
  resolveRoot: () => vscode.Uri | undefined,
  afterCreate?: (uri: vscode.Uri) => void,
): Promise<void> {
  const text = await vscode.env.clipboard.readText();
  if (!text || !text.trim()) {
    vscode.window.showWarningMessage('Notebook: the clipboard is empty.');
    return;
  }
  await runImport(text, resolveRoot, afterCreate);
}


async function runImport(
  text: string,
  resolveRoot: () => vscode.Uri | undefined,
  afterCreate?: (uri: vscode.Uri) => void,
): Promise<void> {
  const root = resolveRoot();
  if (!root) {
    vscode.window.showErrorMessage('Notebook: open a folder first.');
    return;
  }

  const cfg = vscode.workspace.getConfiguration();
  const pandocPath = cfg.get<string>('pandocToMarkdown.pandocPath', 'pandoc');
  const variant = cfg.get<string>('pandocToMarkdown.markdownVariant', 'gfm');
  const author = cfg.get<string>('markdownNotebook.author', '').trim();

  const isHtml = looksLikeHtml(text);
  const fromFormat = isHtml ? 'html' : 'markdown';

  let body: string;
  try {
    body = await pandocStdin(pandocPath, text, fromFormat, variant);
  } catch (err) {
    const msg = (err as { stderr?: string }).stderr?.trim() || String(err);
    vscode.window.showErrorMessage(`Notebook: import failed. ${msg}`);
    return;
  }
  body = body.trim();

  // Guessed title from the first heading/line.
  const guessed = firstHeadingOrLine(body) || 'Imported note';
  const metadata = await promptMetadata(guessed, 'Title for the imported note', guessed.slice(0, 120));
  if (!metadata) {
    return; // cancelled
  }

  const { title, dateKey, dateStrForFilename, tags } = metadata;

  // Destination: let the user place it anywhere in the tree, defaulting to the import folder.
  const destDir = await pickDestination(root, 'Where should this note go?');
  if (!destDir) {
    return;
  }

  const createdDate = dateKey || localDateKey();
  const fm: string[] = ['---', `title: ${yamlValue(title)}`, `created: ${createdDate}`];
  if (author) {
    fm.push(`author: ${yamlValue(author)}`);
  }
  
  // Ensure we tag it 'imported' along with any chosen tags!
  const finalTags = Array.from(new Set(['imported', ...tags]));
  const backlink = `[← ${path.basename(destDir)} TOC](.toc.md)`;
  fm.push(`tags: [${finalTags.join(', ')}]`, '---', '', backlink, '', body, '');
  const content = fm.join('\n');

  await vscode.workspace.fs.createDirectory(vscode.Uri.file(destDir));

  // Determine unique filename (append date if date context is provided)
  let baseSlug = slug(title) || `import-${Date.now()}`;
  if (dateStrForFilename) {
    baseSlug = `${baseSlug}_${dateStrForFilename}`;
  }

  const fileName = await uniqueMd(destDir, baseSlug);
  const target = vscode.Uri.file(path.join(destDir, fileName));

  try {
    await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
  } catch (err) {
    vscode.window.showErrorMessage(`Notebook: could not write note (${String(err)}).`);
    return;
  }

  afterCreate?.(target);
  await vscode.commands.executeCommand('markdownNotebook.openPage', target);
  vscode.window.showInformationMessage(
    `Imported as ${fileName}${isHtml ? ' (detected rich text/HTML)' : ''}.`,
  );
}

function pandocStdin(
  pandocPath: string,
  input: string,
  from: string,
  to: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      pandocPath,
      ['-f', from, '-t', to, '--wrap=none'],
      { timeout: 60000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          (err as { stderr?: string }).stderr = stderr;
          reject(err);
        } else {
          resolve(stdout);
        }
      },
    );
    child.stdin?.end(input);
  });
}

/** Heuristic: does this text carry real HTML markup (as a copied email chain would)? */
function looksLikeHtml(text: string): boolean {
  const sample = text.slice(0, 4000);
  if (/<!DOCTYPE html|<html[\s>]|<body[\s>]|<table[\s>]|<blockquote[\s>]/i.test(sample)) {
    return true;
  }
  // Several distinct block/inline tags strongly suggest HTML rather than stray <angle> text.
  const tagHits = sample.match(/<(p|div|br|span|a|ul|ol|li|h[1-6]|tr|td)\b[^>]*>/gi);
  return !!tagHits && tagHits.length >= 3;
}

function firstHeadingOrLine(body: string): string | undefined {
  const heading = body.match(/^#{1,6}\s+(.+?)\s*$/m);
  if (heading) {
    return heading[1].trim();
  }
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim().replace(/^[#>*\-\s]+/, '');
    if (t) {
      return t;
    }
  }
  return undefined;
}

function yamlValue(s: string): string {
  return /[:#\[\]{}",]|^\s|\s$/.test(s) ? JSON.stringify(s) : s;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

async function uniqueMd(dir: string, baseSlug: string): Promise<string> {
  let candidate = `${baseSlug}.md`;
  let i = 1;
  while (await exists(path.join(dir, candidate))) {
    candidate = `${baseSlug}-${i}.md`;
    i++;
  }
  return candidate;
}

async function exists(p: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(p));
    return true;
  } catch {
    return false;
  }
}
