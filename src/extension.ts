import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { registerNotebook, resolveRoot, checkAndPromptMigration, updateTasksDashboard, updateTOC, updateMasterTOC, updateTOCsUpToRoot } from './notebookView';
import { registerPasteImport } from './pasteImport';
import { pickDestination } from './notebookFs';
import { extendMarkdownIt } from './markdownItExtensions';
import { registerPdfExport } from './pdfExport';
import { OutlineTreeDataProvider, OutlineNode } from './outlineView';
import { promptMetadata, NoteMetadata } from './metadataPrompt';
import { registerInsertCommands } from './editorToolbar';

const execFileAsync = promisify(execFile);
const fsp = fs.promises;

/** Map a lower-cased file extension to the pandoc input (reader) format. */
const FORMAT_MAP: Record<string, string> = {
  '.docx': 'docx',
  '.pptx': 'pptx',
  '.xlsx': 'xlsx',
  '.odt': 'odt',
  '.rtf': 'rtf',
  '.epub': 'epub',
  '.html': 'html',
  '.htm': 'html',
};

/** Reader formats that were only added to pandoc in 3.8.3. */
const REQUIRES_3_8_3 = new Set(['pptx', 'xlsx']);

/** Formats that can carry embedded images worth extracting. */
const MEDIA_FORMATS = new Set(['docx', 'pptx', 'odt', 'epub']);

const MIN_VERSION_FOR_OOXML_DATA = '3.8.3';

type Outcome =
  | { status: 'ok'; uri: vscode.Uri; outPath: string }
  | { status: 'skipped'; uri: vscode.Uri; reason: string }
  | { status: 'error'; uri: vscode.Uri; reason: string };

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand(
    'pandocToMarkdown.convert',
    (uri?: vscode.Uri, uris?: vscode.Uri[]) => convertCommand(uri, uris),
  );
  context.subscriptions.push(disposable);

  context.subscriptions.push(
    vscode.commands.registerCommand('markdownNotebook.importDocument', () => importDocumentCommand()),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('markdownNotebook.importDroppedFiles', (uris: vscode.Uri[], destDirUri: vscode.Uri) => 
      importDroppedFilesCommand(uris, destDirUri)
    ),
  );

  // Notebook tree view (OneNote-style notes shell).
  registerNotebook(context);

  // Check and prompt workspace TOC / backlink migration
  checkAndPromptMigration(context);

  // Paste / clipboard → Markdown import.
  registerPasteImport(context, resolveRoot);

  // PDF export.
  registerPdfExport(context);

  // Markdown Formatter Toolbar insertion commands.
  registerInsertCommands(context);

  // Note Outline Panel
  const outlineProvider = new OutlineTreeDataProvider();
  const outlineTreeView = vscode.window.createTreeView('markdownNotebook.outline', {
    treeDataProvider: outlineProvider
  });
  context.subscriptions.push(outlineTreeView);

  // Helper to update active outline heading and trigger tree view refresh/reveal
  const updateActiveHeading = (line: number) => {
    const activeHeading = findActiveHeadingForLine(outlineProvider.getRootNodes(), line);
    if (activeHeading) {
      if (outlineProvider.activeHeadingLine !== activeHeading.line) {
        outlineProvider.activeHeadingLine = activeHeading.line;
        outlineProvider.refresh();
        outlineTreeView.reveal(activeHeading, { select: true, focus: false });
      }
    } else {
      if (outlineProvider.activeHeadingLine !== undefined) {
        outlineProvider.activeHeadingLine = undefined;
        outlineProvider.refresh();
      }
    }
  };

  // Sync scroll position from text editor to outline view
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
      if (e.textEditor.document.languageId !== 'markdown') { return; }
      const firstVisibleLine = e.visibleRanges[0].start.line;
      updateActiveHeading(firstVisibleLine);
    })
  );

  // Sync scroll position from markdown preview to outline view
  context.subscriptions.push(
    vscode.commands.registerCommand('markdownNotebook.outline.previewScrolled', async (line: number) => {
      updateActiveHeading(line);
    })
  );

  // Register Collapse All command for Outline view
  context.subscriptions.push(
    vscode.commands.registerCommand('markdownNotebook.outline.collapseAll', () => {
      outlineProvider.collapseAll();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('markdownNotebook.openPage', async (uri: vscode.Uri) => {
      outlineProvider.currentUri = uri;
      outlineProvider.refresh();
      // Use vscode.open uniformly to avoid the blank preview issue caused by markdown.showPreview
      // If alwaysShowPreview is active, syncEditorAssociations will ensure this opens the Custom Editor preview
      await vscode.commands.executeCommand('vscode.open', uri);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('markdownNotebook.openSource', async () => {
      let uri = outlineProvider.currentUri;

      if (!uri) {
        const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
        if (activeTab) {
          const root = resolveRoot();
          if (root) {
            const cleanName = activeTab.label.replace(/^Preview\s+/i, '').trim();
            if (cleanName) {
              uri = await findFileByName(root.fsPath, cleanName);
            }
          }
        }
      }

      if (uri) {
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: false });
      } else {
        vscode.window.showWarningMessage('Markdown Notebook: Could not determine the source file for this preview.');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('markdownNotebook.toggleTaskAtLine', async (...args: any[]) => {
      let targetFilePath: string = '';
      let line: number = -1;

      if (args.length === 1 && Array.isArray(args[0])) {
        targetFilePath = args[0][0] || '';
        line = typeof args[0][1] === 'number' ? args[0][1] : -1;
      } else if (args.length >= 2) {
        targetFilePath = args[0] || '';
        line = typeof args[1] === 'number' ? args[1] : -1;
      }

      let uri = outlineProvider.currentUri;

      if (!uri) {
        const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
        if (activeTab) {
          const root = resolveRoot();
          if (root) {
            const cleanName = activeTab.label.replace(/^Preview\s+/i, '').trim();
            if (cleanName) {
              uri = await findFileByName(root.fsPath, cleanName);
            }
          }
        }
      }
      
      if (!uri) return;

      let targetUri = uri;
      if (targetFilePath && typeof targetFilePath === 'string') {
        const currentDir = path.dirname(uri.fsPath);
        const decodedPath = targetFilePath.split('/').map(decodeURIComponent).join(path.sep);
        targetUri = vscode.Uri.file(path.resolve(currentDir, decodedPath));
      }

      // DEBUG
      // vscode.window.showInformationMessage(`ToggleTask: uri=${uri.fsPath}, target=${targetFilePath}, line=${line}, targetUri=${targetUri.fsPath}`);

      try {
        const doc = await vscode.workspace.openTextDocument(targetUri);
        if (line >= 0 && line < doc.lineCount) {
          const lineText = doc.lineAt(line).text;
          const checkboxRegex = /^([ \t]*([-*+]\s+|\d+\.\s+)?)\[([ xX])\]/;
          const checkboxMatch = lineText.match(checkboxRegex);
          if (checkboxMatch) {
            const prefix = checkboxMatch[1] || '';
            const checkedChar = checkboxMatch[3];
            const newChecked = (checkedChar === ' ' ? 'x' : ' ');
            const replacement = `${prefix}[${newChecked}]`;
            
            const edit = new vscode.WorkspaceEdit();
            const startChar = 0;
            const endChar = checkboxMatch[0].length;
            edit.replace(targetUri, new vscode.Range(line, startChar, line, endChar), replacement);
            
            await vscode.workspace.applyEdit(edit);
            await doc.save();
          } else {
             vscode.window.showWarningMessage(`ToggleTask: Regex didn't match line ${line}: "${lineText}"`);
          }
        } else {
             vscode.window.showWarningMessage(`ToggleTask: Invalid line ${line} (doc has ${doc.lineCount} lines)`);
        }
      } catch (err) {
        console.error(err);
        vscode.window.showErrorMessage(`ToggleTask Error: ${String(err)}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('markdownNotebook.toggleMermaidOrientationAtLine', async (...args: any[]) => {
      let targetFilePath: string = '';
      let line: number = -1;

      if (args.length === 1 && Array.isArray(args[0])) {
        targetFilePath = args[0][0] || '';
        line = typeof args[0][1] === 'number' ? args[0][1] : -1;
      } else if (args.length >= 2) {
        targetFilePath = args[0] || '';
        line = typeof args[1] === 'number' ? args[1] : -1;
      }

      let uri = outlineProvider.currentUri;

      if (!uri) {
        const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
        if (activeTab) {
          const root = resolveRoot();
          if (root) {
            const cleanName = activeTab.label.replace(/^Preview\s+/i, '').trim();
            if (cleanName) {
              uri = await findFileByName(root.fsPath, cleanName);
            }
          }
        }
      }
      
      if (!uri) return;

      let targetUri = uri;
      if (targetFilePath && typeof targetFilePath === 'string') {
        const currentDir = path.dirname(uri.fsPath);
        const decodedPath = targetFilePath.split('/').map(decodeURIComponent).join(path.sep);
        targetUri = vscode.Uri.file(path.resolve(currentDir, decodedPath));
      }

      try {
        const doc = await vscode.workspace.openTextDocument(targetUri);
        if (line >= 0 && line < doc.lineCount) {
          let foundMatch = false;
          // Search up to 10 lines from the start of the block to find the orientation
          for (let i = 0; i < 10 && line + i < doc.lineCount; i++) {
            const lineIdx = line + i;
            const text = doc.lineAt(lineIdx).text;
            if (i > 0 && text.trim() === '```') { break; } // reached end of block

            const regex = /^([ \t]*(?:graph|flowchart|direction)\s+)(TD|TB|LR|RL|BT)\b/im;
            const match = text.match(regex);
            
            if (match) {
              const map: Record<string, string> = {
                'TD': 'LR',
                'TB': 'LR',
                'LR': 'TD',
                'RL': 'BT',
                'BT': 'RL'
              };
              const newDir = map[match[2].toUpperCase()] || 'LR';
              const newText = text.replace(regex, `$1${newDir}`);
              
              const edit = new vscode.WorkspaceEdit();
              edit.replace(targetUri, new vscode.Range(lineIdx, 0, lineIdx, text.length), newText);
              await vscode.workspace.applyEdit(edit);
              await doc.save();
              foundMatch = true;
              break;
            }
          }

          if (!foundMatch) {
            vscode.window.showWarningMessage("No mermaid orientation (e.g. 'graph TD', 'direction LR') found in the selected block.");
          }
        }
      } catch (err) {
        console.error(err);
        vscode.window.showErrorMessage(`ToggleMermaid Error: ${String(err)}`);
      }
    })
  );


  context.subscriptions.push(
    vscode.commands.registerCommand('markdownNotebook.outline.goToLine', async (lineIndex: number) => {
      const editor = vscode.window.activeTextEditor;
      const cfg = vscode.workspace.getConfiguration('markdownNotebook');
      const alwaysPreview = cfg.get<boolean>('alwaysShowPreview', false);

      // Always write scroll command target to media/scroll-target.js
      const scrollFile = path.join(context.extensionPath, 'media', 'scroll-target.js');
      try {
        await fsp.writeFile(
          scrollFile,
          `window.notebookScrollTarget = { line: ${lineIndex}, timestamp: ${Date.now()} };`,
          'utf8'
        );
      } catch {
        /* ignore */
      }

      // If alwaysShowPreview is active, we scroll preview exclusively and never focus/expose raw markdown
      if (alwaysPreview) {
        return;
      }

      // If we don't have an active text editor, we are likely focusing on the Webview Preview.
      if (!editor && outlineProvider.currentUri) {
        // Also check if the editor is visible side-by-side and update its selection silently
        const visibleEditor = vscode.window.visibleTextEditors.find(
          (e) => e.document.uri.toString() === outlineProvider.currentUri?.toString()
        );
        if (visibleEditor) {
          const pos = new vscode.Position(lineIndex, 0);
          visibleEditor.selection = new vscode.Selection(pos, pos);
          visibleEditor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
        }
        return;
      }

      // Standard text editor navigation (when code view is open and focused)
      if (editor) {
        const pos = new vscode.Position(lineIndex, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
      }
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      outlineProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (vscode.window.activeTextEditor && e.document === vscode.window.activeTextEditor.document) {
        outlineProvider.refresh();
      }
    })
  );

  // Helper to sync Outline panel when preview tabs are changed or navigated
  async function syncOutlineForTab(label: string) {
    const root = resolveRoot();
    if (!root) { return; }

    const cleanName = label.replace(/^Preview\s+/i, '').trim();
    if (!cleanName) { return; }

    const targetUri = await findFileByName(root.fsPath, cleanName);
    if (targetUri && outlineProvider.currentUri?.toString() !== targetUri.toString()) {
      outlineProvider.currentUri = targetUri;
      outlineProvider.refresh();
    }
  }

  const handleTabChange = () => {
    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (activeTab && activeTab.isActive) {
      syncOutlineForTab(activeTab.label);
    }
  };

  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(handleTabChange)
  );

  // Synchronize dynamic preview settings and editor associations
  writePreviewSettings(context);
  syncEditorAssociations();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('markdownNotebook.defaultPageWidth') ||
        e.affectsConfiguration('markdownNotebook.defaultMermaidZoom')
      ) {
        writePreviewSettings(context);
      }
      if (e.affectsConfiguration('markdownNotebook.alwaysShowPreview')) {
        syncEditorAssociations();
      }
    })
  );

  // Auto-update Tasks Dashboard and TOCs when any markdown file inside the notebook is saved
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      if (document.languageId === 'markdown') {
        const root = resolveRoot();
        if (root) {
          const filePath = document.uri.fsPath;
          const baseName = path.basename(filePath).toLowerCase();
          if (baseName !== '.tasks.md' && baseName !== '.toc.md') {
            const relative = path.relative(root.fsPath, filePath);
            const isInside = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
            if (isInside) {
              const parentDir = path.dirname(filePath);
              await updateTOCsUpToRoot(parentDir, root.fsPath);
              await updateMasterTOC(root.fsPath);
              await updateTasksDashboard(root.fsPath);
            }
          }
        }
      }
    })
  );

  // Register command to open settings
  context.subscriptions.push(
    vscode.commands.registerCommand('markdownNotebook.openSettings', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:stephen-rector.markdown-notebook');
    })
  );

  // Register Outline utility commands
  context.subscriptions.push(
    vscode.commands.registerCommand('markdownNotebook.outline.expandAll', () => {
      outlineProvider.expandAll();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('markdownNotebook.outline.refresh', () => {
      outlineProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('markdownNotebook.outline.copyToc', async () => {
      const roots = outlineProvider.getRootNodes();
      if (roots.length === 0) {
        vscode.window.showWarningMessage('No outline headings to copy.');
        return;
      }

      const minDepth = Math.min(...roots.map((n) => n.depth), 1);
      const lines: string[] = [];

      function slugify(text: string): string {
        return text
          .toLowerCase()
          .replace(/[^\w\s-]/g, '')
          .trim()
          .replace(/\s+/g, '-');
      }

      function traverse(node: OutlineNode, indentLevel: number) {
        const slug = slugify(node.label);
        const indent = '  '.repeat(indentLevel);
        lines.push(`${indent}- [${node.label}](#${slug})`);
        for (const child of node.children) {
          traverse(child, indentLevel + 1);
        }
      }

      for (const root of roots) {
        traverse(root, Math.max(0, root.depth - minDepth));
      }

      const tocText = lines.join('\n');
      await vscode.env.clipboard.writeText(tocText);
      vscode.window.showInformationMessage('Table of Contents copied to clipboard!');
    })
  );

  // Enhance the built-in Markdown preview (mermaid, task lists, ==mark==, links).
  return { extendMarkdownIt };
}

export function deactivate(): void {
  /* nothing to clean up */
}

async function convertCommand(uri?: vscode.Uri, uris?: vscode.Uri[]): Promise<void> {
  const targets = resolveTargets(uri, uris);
  if (targets.length === 0) {
    vscode.window.showWarningMessage('Pandoc → Markdown: no file selected to convert.');
    return;
  }

  const cfg = vscode.workspace.getConfiguration('pandocToMarkdown');
  const pandocPath = cfg.get<string>('pandocPath', 'pandoc');

  // 1. Make sure pandoc exists and find out its version.
  let version: string;
  try {
    version = await getPandocVersion(pandocPath);
  } catch {
    const pick = await vscode.window.showErrorMessage(
      'Pandoc could not be run. Install it, or set "pandocToMarkdown.pandocPath" to its full path.',
      'Open Settings',
      'Install Guide',
    );
    if (pick === 'Open Settings') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'pandocToMarkdown.pandocPath');
    } else if (pick === 'Install Guide') {
      vscode.env.openExternal(vscode.Uri.parse('https://pandoc.org/installing.html'));
    }
    return;
  }

  // 2. Only keep files we can actually feed to pandoc.
  const localTargets = targets.filter((t) => t.scheme === 'file');
  if (localTargets.length === 0) {
    vscode.window.showErrorMessage(
      'Pandoc → Markdown: only local files can be converted (pandoc runs as a local process).',
    );
    return;
  }

  // 3. One-time delete confirmation, if the user opted in.
  let deleteOriginal = cfg.get<boolean>('deleteOriginal', true);
  if (deleteOriginal && cfg.get<boolean>('confirmDelete', false)) {
    const useTrash = cfg.get<boolean>('useTrash', true);
    const verb = useTrash ? 'move the original(s) to Trash' : 'permanently delete the original(s)';
    const answer = await vscode.window.showWarningMessage(
      `After converting, ${verb}?`,
      { modal: true },
      'Yes',
      'Keep originals',
    );
    if (answer === undefined) {
      return; // user cancelled the whole operation
    }
    deleteOriginal = answer === 'Yes';
  }

  // 4. Convert, with progress.
  const results = await vscode.window.withProgress<Outcome[]>(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Converting to Markdown',
      cancellable: false,
    },
    async (progress) => {
      const out: Outcome[] = [];
      const step = 100 / localTargets.length;
      for (const target of localTargets) {
        progress.report({ message: path.basename(target.fsPath), increment: step });
        out.push(await convertOne(target, cfg, pandocPath, version, deleteOriginal));
      }
      return out;
    },
  );

  await reportResults(results, cfg);
}

/**
 * Import a document from anywhere on disk: pick the file, choose a destination
 * section in the notebook, copy it in, and convert it to Markdown there.
 * The original (outside the notebook) is never touched.
 */
async function importDocumentCommand(): Promise<void> {
  const root = resolveRoot();
  if (!root) {
    vscode.window.showErrorMessage('Notebook: open a folder first.');
    return;
  }

  const exts = Object.keys(FORMAT_MAP).map((e) => e.replace(/^\./, ''));
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: 'Import',
    filters: { Documents: exts, 'All files': ['*'] },
  });
  if (!picked || picked.length === 0) {
    return;
  }
  const source = picked[0];
  const ext = path.extname(source.fsPath).toLowerCase();
  if (!FORMAT_MAP[ext]) {
    vscode.window.showErrorMessage(
      `Notebook: "${path.basename(source.fsPath)}" isn't a supported document type.`,
    );
    return;
  }

  const cfg = vscode.workspace.getConfiguration('pandocToMarkdown');
  const pandocPath = cfg.get<string>('pandocPath', 'pandoc');
  let version: string;
  try {
    version = await getPandocVersion(pandocPath);
  } catch {
    vscode.window.showErrorMessage(
      'Pandoc could not be run. Install it, or set "pandocToMarkdown.pandocPath" to its full path.',
    );
    return;
  }

  const destDir = await pickDestination(root, 'Where should the imported document go?');
  if (!destDir) {
    return;
  }

  // Prompt for metadata (Title, Date, Tags)
  const base = path.basename(source.fsPath, ext);
  const metadata = await promptMetadata(humanize(base), 'Title for the imported document', humanize(base));
  if (!metadata) {
    return;
  }

  const slug = metadata.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || humanize(base);
  const baseSlug = metadata.dateStrForFilename ? `${slug}_${metadata.dateStrForFilename}` : slug;

  // Copy the document into the chosen section under a unique name, then convert
  // it in place. deleteOriginal here removes only our copy, leaving the source.
  const copyName = await uniquePath(destDir, baseSlug, ext);
  const copyUri = vscode.Uri.file(copyName);
  try {
    await vscode.workspace.fs.copy(source, copyUri, { overwrite: false });
  } catch (err) {
    vscode.window.showErrorMessage(`Notebook: could not copy the document in (${errMessage(err)}).`);
    return;
  }

  const result = await vscode.window.withProgress<Outcome>(
    { location: vscode.ProgressLocation.Notification, title: `Importing ${path.basename(source.fsPath)}` },
    () => convertOne(copyUri, cfg, pandocPath, version, /* deleteOriginal */ true, metadata),
  );

  if (result.status === 'ok') {
    if (cfg.get<boolean>('openAfterConvert', true)) {
      await vscode.commands.executeCommand('markdownNotebook.openPage', vscode.Uri.file(result.outPath));
    }
    vscode.window.showInformationMessage(`Imported ${path.basename(result.outPath)}.`);
  } else {
    const reason = result.status === 'error' ? result.reason : 'skipped';
    vscode.window.showErrorMessage(`Notebook: import failed — ${reason}`);
    // Clean up the stray copy if conversion never produced output.
    try {
      await vscode.workspace.fs.delete(copyUri, { useTrash: false });
    } catch {
      /* ignore */
    }
  }
}

async function importDroppedFilesCommand(uris: vscode.Uri[], destDirUri: vscode.Uri): Promise<void> {
  const supportedUris = uris.filter(u => {
    const ext = path.extname(u.fsPath).toLowerCase();
    return FORMAT_MAP[ext] !== undefined;
  });

  if (supportedUris.length === 0) {
    vscode.window.showWarningMessage('No supported documents found in the dropped files.');
    return;
  }

  const msg = supportedUris.length === 1 
    ? `Convert "${path.basename(supportedUris[0].fsPath)}" to Markdown in this section?` 
    : `Convert ${supportedUris.length} documents to Markdown in this section?`;

  const answer = await vscode.window.showInformationMessage(msg, { modal: false }, 'Convert', 'Cancel');
  if (answer !== 'Convert') {
    return;
  }

  const cfg = vscode.workspace.getConfiguration('pandocToMarkdown');
  const pandocPath = cfg.get<string>('pandocPath', 'pandoc');
  let version: string;
  try {
    version = await getPandocVersion(pandocPath);
  } catch {
    vscode.window.showErrorMessage(
      'Pandoc could not be run. Install it, or set "pandocToMarkdown.pandocPath" to its full path.',
    );
    return;
  }

  const destDir = destDirUri.fsPath;
  const results = await vscode.window.withProgress<Outcome[]>(
    { location: vscode.ProgressLocation.Notification, title: `Importing Document${supportedUris.length > 1 ? 's' : ''}` },
    async (progress) => {
      const out: Outcome[] = [];
      const step = 100 / supportedUris.length;
      for (const source of supportedUris) {
        progress.report({ message: path.basename(source.fsPath), increment: step });
        
        const ext = path.extname(source.fsPath).toLowerCase();
        const base = path.basename(source.fsPath, ext);
        
        const slugStr = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || humanize(base);
        const copyName = await uniquePath(destDir, slugStr, ext);
        const copyUri = vscode.Uri.file(copyName);
        
        try {
          await vscode.workspace.fs.copy(source, copyUri, { overwrite: false });
        } catch (err) {
          out.push({ status: 'error', uri: source, reason: `copy failed: ${errMessage(err)}` });
          continue;
        }

        const metadata: NoteMetadata = {
          title: humanize(base),
          tags: ['imported'],
          dateKey: new Date().toISOString().slice(0, 10),
          dateStrForFilename: undefined
        };

        const result = await convertOne(copyUri, cfg, pandocPath, version, true, metadata);
        
        if (result.status !== 'ok') {
          try {
            await vscode.workspace.fs.delete(copyUri, { useTrash: false });
          } catch { /* ignore */ }
        }
        
        out.push(result);
      }
      return out;
    }
  );

  await reportResults(results, cfg);
}

/**
 * Figure out which files to act on.
 * From the Explorer context menu VS Code passes (clickedUri, allSelectedUris).
 * From the Command Palette both are undefined, so fall back to the active editor.
 */
function resolveTargets(uri?: vscode.Uri, uris?: vscode.Uri[]): vscode.Uri[] {
  if (uris && uris.length > 0) {
    return uris;
  }
  if (uri) {
    return [uri];
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  return active ? [active] : [];
}

async function getPandocVersion(pandocPath: string): Promise<string> {
  const { stdout } = await execFileAsync(pandocPath, ['--version'], { timeout: 15000 });
  const match = stdout.match(/pandoc(?:\.exe)?\s+(\d+\.\d+(?:\.\d+)?)/i);
  return match ? match[1] : '0.0.0';
}

/** Returns negative if a < b, 0 if equal, positive if a > b. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

async function convertOne(
  uri: vscode.Uri,
  cfg: vscode.WorkspaceConfiguration,
  pandocPath: string,
  version: string,
  deleteOriginal: boolean,
  metadata?: NoteMetadata,
): Promise<Outcome> {
  const ext = path.extname(uri.fsPath).toLowerCase();
  const format = FORMAT_MAP[ext];

  if (!format) {
    return { status: 'skipped', uri, reason: `unsupported file type (${ext || 'no extension'})` };
  }

  if (REQUIRES_3_8_3.has(format) && compareVersions(version, MIN_VERSION_FOR_OOXML_DATA) < 0) {
    return {
      status: 'error',
      uri,
      reason: `${format} input requires pandoc ${MIN_VERSION_FOR_OOXML_DATA}+ (you have ${version}). Word (.docx) still works.`,
    };
  }

  const dir = path.dirname(uri.fsPath);
  const base = path.basename(uri.fsPath, path.extname(uri.fsPath));
  const outPath = await uniquePath(dir, base, '.md');

  const variant = cfg.get<string>('markdownVariant', 'gfm');
  const wrap = cfg.get<string>('wrap', 'none');
  const args: string[] = [uri.fsPath, '-f', format, '-t', variant, '-o', outPath, `--wrap=${wrap}`];

  if (cfg.get<boolean>('standalone', false)) {
    args.push('--standalone');
  }
  if (cfg.get<boolean>('extractMedia', true) && MEDIA_FORMATS.has(format)) {
    // Relative path resolved against cwd (the file's folder) so links work next to the .md.
    args.push(`--extract-media=${base}_media`);
  }
  const extra = cfg.get<string[]>('extraArgs', []);
  if (Array.isArray(extra) && extra.length > 0) {
    args.push(...extra);
  }

  try {
    await execFileAsync(pandocPath, args, { cwd: dir, timeout: 120000 });
  } catch (err) {
    return { status: 'error', uri, reason: pandocErrorMessage(err) };
  }

  // Add Notebook-style frontmatter so the converted file lands as a first-class
  // titled note. Skip when --standalone is on, since pandoc writes its own YAML then.
  if (cfg.get<boolean>('addFrontmatter', true) && !cfg.get<boolean>('standalone', false)) {
    try {
      await addFrontmatter(outPath, base, metadata);
    } catch {
      /* the conversion itself succeeded; frontmatter is best-effort */
    }
  }

  if (deleteOriginal) {
    try {
      await vscode.workspace.fs.delete(uri, {
        recursive: false,
        useTrash: cfg.get<boolean>('useTrash', true),
      });
    } catch (err) {
      // Conversion worked; only cleanup failed. Surface it but don't call the whole thing a failure.
      vscode.window.showWarningMessage(
        `Converted ${path.basename(uri.fsPath)}, but could not remove the original: ${errMessage(err)}`,
      );
    }
  }

  return { status: 'ok', uri, outPath };
}

async function addFrontmatter(outPath: string, fallbackBase: string, metadata?: NoteMetadata): Promise<void> {
  const original = await fsp.readFile(outPath, 'utf8');

  // Don't double-stamp if a YAML block is somehow already present.
  if (/^\uFEFF?---\r?\n/.test(original)) {
    return;
  }

  let body = original;
  let title = metadata?.title;

  // Promote a leading H1 to the title (and drop it from the body, since the
  // title now lives in frontmatter — avoids a duplicated heading in the note).
  const h1 = body.match(/^\uFEFF?[ \t]*#[ \t]+(.+?)[ \t]*\r?\n+/);
  if (h1) {
    if (!title) {
      title = h1[1].trim();
    }
    body = body.slice(h1[0].length);
  } else if (!title) {
    const firstLine = body.split(/\r?\n/).find((l) => l.trim().length > 0);
    if (firstLine && firstLine.trim().length <= 120) {
      title = firstLine.trim().replace(/^#+\s*/, '');
    }
  }
  if (!title) {
    title = humanize(fallbackBase);
  }

  const createdDate = metadata?.dateKey || new Date().toISOString().slice(0, 10);
  const author = vscode.workspace.getConfiguration('markdownNotebook').get<string>('author', '').trim();
  const lines = ['---', `title: ${yamlValue(title)}`, `created: ${createdDate}`];
  if (author) {
    lines.push(`author: ${yamlValue(author)}`);
  }
  
  const finalTags = Array.from(new Set(['converted', ...(metadata?.tags || [])]));
  lines.push(`tags: [${finalTags.join(', ')}]`, '---', '', body.replace(/^\r?\n+/, ''));

  await fsp.writeFile(outPath, lines.join('\n'), 'utf8');
}

function humanize(base: string): string {
  const s = base.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : base;
}

function yamlValue(s: string): string {
  return /[:#\[\]{}",]|^\s|\s$/.test(s) ? JSON.stringify(s) : s;
}

async function uniquePath(dir: string, base: string, ext: string): Promise<string> {
  let candidate = path.join(dir, base + ext);
  let i = 1;
  while (await pathExists(candidate)) {
    candidate = path.join(dir, `${base}-${i}${ext}`);
    i++;
  }
  return candidate;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function pandocErrorMessage(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  const stderr = (e.stderr ?? '').trim();
  if (stderr) {
    return stderr.split('\n').slice(0, 4).join(' ').trim();
  }
  return errMessage(err);
}

function errMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

async function reportResults(results: Outcome[], cfg: vscode.WorkspaceConfiguration): Promise<void> {
  const ok = results.filter((r): r is Extract<Outcome, { status: 'ok' }> => r.status === 'ok');
  const errors = results.filter((r) => r.status === 'error');
  const skipped = results.filter((r) => r.status === 'skipped');

  // Open the converted file(s).
  if (cfg.get<boolean>('openAfterConvert', true) && ok.length > 0) {
    try {
      await vscode.commands.executeCommand('markdownNotebook.openPage', vscode.Uri.file(ok[0].outPath));
    } catch {
      /* opening is best-effort */
    }
  }

  if (errors.length === 0 && skipped.length === 0) {
    const msg =
      ok.length === 1
        ? `Converted ${path.basename(ok[0].outPath)}.`
        : `Converted ${ok.length} files to Markdown.`;
    vscode.window.showInformationMessage(`Pandoc → Markdown: ${msg}`);
    return;
  }

  const parts: string[] = [];
  if (ok.length > 0) {
    parts.push(`${ok.length} converted`);
  }
  if (skipped.length > 0) {
    parts.push(`${skipped.length} skipped`);
  }
  if (errors.length > 0) {
    parts.push(`${errors.length} failed`);
  }

  const detail = [...errors, ...skipped]
    .map((r) => {
      const reason = r.status === 'error' ? r.reason : (r as Extract<Outcome, { status: 'skipped' }>).reason;
      return `• ${path.basename(r.uri.fsPath)}: ${reason}`;
    })
    .join('\n');

  if (errors.length > 0) {
    vscode.window
      .showErrorMessage(`Pandoc → Markdown: ${parts.join(', ')}.`, 'Show details')
      .then((pick) => {
        if (pick === 'Show details') {
          vscode.window.showErrorMessage(detail, { modal: true });
        }
      });
  } else {
    vscode.window.showWarningMessage(`Pandoc → Markdown: ${parts.join(', ')}.\n${detail}`);
  }
}

async function writePreviewSettings(context: vscode.ExtensionContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('markdownNotebook');
  const pageWidth = cfg.get<string>('defaultPageWidth', 'standard');
  const mermaidZoom = cfg.get<number>('defaultMermaidZoom', 100);

  const filePath = path.join(context.extensionPath, 'media', 'preview-settings.js');
  const content = `window.notebookSettings = {
  defaultPageWidth: ${JSON.stringify(pageWidth)},
  defaultMermaidZoom: ${mermaidZoom}
};`;

  try {
    await fsp.writeFile(filePath, content, 'utf8');
  } catch {
    /* ignore */
  }
}

async function syncEditorAssociations(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('markdownNotebook');
  const alwaysPreview = cfg.get<boolean>('alwaysShowPreview', false);

  const workbenchConfig = vscode.workspace.getConfiguration();
  const associations = workbenchConfig.get<any>('workbench.editorAssociations') || {};

  if (alwaysPreview) {
    if (associations['*.md'] !== 'vscode.markdown.preview.editor') {
      const updated = { ...associations, '*.md': 'vscode.markdown.preview.editor' };
      await workbenchConfig.update('workbench.editorAssociations', updated, vscode.ConfigurationTarget.Workspace);
    }
  } else {
    if (associations['*.md'] === 'vscode.markdown.preview.editor') {
      const updated = { ...associations };
      delete updated['*.md'];
      const finalVal = Object.keys(updated).length ? updated : undefined;
      await workbenchConfig.update('workbench.editorAssociations', finalVal, vscode.ConfigurationTarget.Workspace);
    }
  }
}

async function findFileByName(rootPath: string, targetName: string): Promise<vscode.Uri | undefined> {
  const searchName = targetName.toLowerCase().endsWith('.md') ? targetName : targetName + '.md';

  async function search(dir: string): Promise<string | undefined> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') { continue; }
        const res = await search(fullPath);
        if (res) { return res; }
      } else if (entry.isFile()) {
        if (entry.name.toLowerCase() === searchName.toLowerCase()) {
          return fullPath;
        }
      }
    }
    return undefined;
  }

  const foundPath = await search(rootPath);
  return foundPath ? vscode.Uri.file(foundPath) : undefined;
}

function findActiveHeadingForLine(nodes: OutlineNode[], line: number): OutlineNode | undefined {
  let best: OutlineNode | undefined = undefined;

  function traverse(node: OutlineNode) {
    if (node.line <= line) {
      if (!best || node.line > best.line) {
        best = node;
      }
    }
    for (const child of node.children) {
      traverse(child);
    }
  }

  for (const root of nodes) {
    traverse(root);
  }
  return best;
}
