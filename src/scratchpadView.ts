import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { resolveRoot, getOrCreateDailyNoteUri, yamlValue } from './notebookView';

const fsp = fs.promises;

export class ScratchpadViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'markdownNotebook.scratchpad';

  private _view?: vscode.WebviewView;
  private _watcher?: vscode.FileSystemWatcher;
  private _lastKnownContent = '';
  private _disposables: vscode.Disposable[] = [];

  constructor(private readonly _extensionUri: vscode.Uri) {
    // Listen for configuration changes to update the backing file watcher if needed
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('markdownNotebook.scratchpadFile') || e.affectsConfiguration('markdownNotebook.root')) {
        this._setupWatcher();
        this.syncFromFile();
      }
    }, null, this._disposables);

    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this._setupWatcher();
      this.syncFromFile();
    }, null, this._disposables);
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'saveScratchpad': {
          await this.writeScratchpad(data.text);
          break;
        }
        case 'appendToDaily': {
          await this.appendToDailyNote(data.text);
          break;
        }
        case 'convertToNote': {
          await this.convertToNewPage(data.text);
          break;
        }
        case 'webviewReady': {
          await this.syncFromFile();
          break;
        }
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.syncFromFile();
      }
    });

    this._setupWatcher();
    this.syncFromFile();
  }

  public focus() {
    if (this._view) {
      this._view.show?.(true); // Show the view
      this._view.webview.postMessage({ type: 'focusTextarea' });
    }
  }

  public dispose() {
    if (this._watcher) {
      this._watcher.dispose();
    }
    for (const d of this._disposables) {
      d.dispose();
    }
  }

  private getScratchpadUri(): vscode.Uri | undefined {
    const root = resolveRoot();
    if (!root) { return undefined; }
    const relativePath = vscode.workspace.getConfiguration('markdownNotebook').get<string>('scratchpadFile', 'scratchpad.md').trim();
    return vscode.Uri.joinPath(root, relativePath || 'scratchpad.md');
  }

  private async readScratchpad(): Promise<string> {
    const uri = this.getScratchpadUri();
    if (!uri) { return ''; }
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size === 0) { return ''; }
      const data = await vscode.workspace.fs.readFile(uri);
      return new TextDecoder().decode(data);
    } catch {
      return '';
    }
  }

  private async writeScratchpad(content: string): Promise<void> {
    const uri = this.getScratchpadUri();
    if (!uri) { return; }
    this._lastKnownContent = content;
    try {
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
    } catch (err) {
      console.error('Scratchpad write error:', err);
    }
  }

  private _setupWatcher() {
    if (this._watcher) {
      this._watcher.dispose();
    }
    const uri = this.getScratchpadUri();
    if (!uri) { return; }

    const dir = path.dirname(uri.fsPath);
    const pattern = new vscode.RelativePattern(dir, path.basename(uri.fsPath));
    this._watcher = vscode.workspace.createFileSystemWatcher(pattern);

    this._watcher.onDidChange(async () => {
      await this.syncFromFile();
    });
    this._watcher.onDidCreate(async () => {
      await this.syncFromFile();
    });
    this._watcher.onDidDelete(async () => {
      await this.syncFromFile();
    });
  }

  private async syncFromFile() {
    const root = resolveRoot();
    if (!root) {
      this._view?.webview.postMessage({ type: 'workspaceStatus', hasWorkspace: false });
      return;
    }
    const text = await this.readScratchpad();
    if (text !== this._lastKnownContent) {
      this._lastKnownContent = text;
      this._view?.webview.postMessage({ type: 'updateContent', text, hasWorkspace: true });
    } else {
      this._view?.webview.postMessage({ type: 'workspaceStatus', hasWorkspace: true });
    }
  }

  private async appendToDailyNote(text: string) {
    if (!text.trim()) { return; }
    const result = await getOrCreateDailyNoteUri();
    if (!result) {
      return;
    }
    const { targetUri } = result;

    try {
      const doc = await vscode.workspace.openTextDocument(targetUri);
      const existingText = doc.getText();

      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

      const format = vscode.workspace.getConfiguration('markdownNotebook').get<string>('scratchpadAppendFormat', '* **[{time}]** {content}');
      const formatted = format.replace('{time}', timeStr).replace('{content}', text.trim());

      let newContent = existingText;
      if (newContent.length > 0 && !newContent.endsWith('\n')) {
        newContent += '\n';
      }
      newContent += '\n' + formatted + '\n';

      await vscode.workspace.fs.writeFile(targetUri, new TextEncoder().encode(newContent));
      vscode.window.showInformationMessage('Quick Notes appended to today\'s Daily Note!');
      
      // Update scratchpad backing file as empty
      await this.writeScratchpad('');
      this._view?.webview.postMessage({ type: 'clearConfirmed' });
    } catch (err) {
      vscode.window.showErrorMessage(`Scratchpad: Failed to append to daily note: ${String(err)}`);
    }
  }

  private async convertToNewPage(text: string) {
    if (!text.trim()) { return; }
    const root = resolveRoot();
    if (!root) {
      vscode.window.showErrorMessage('Notebook: open a folder first.');
      return;
    }

    const title = await vscode.window.showInputBox({
      prompt: 'Enter title for the new note from scratchpad',
      placeHolder: 'e.g. Meeting Notes',
    });
    if (!title) { return; }

    const baseSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
    const uniqueFileName = await this.getUniqueMdName(root.fsPath, baseSlug);
    const targetUri = vscode.Uri.joinPath(root, uniqueFileName);

    const createdDate = new Date().toISOString().split('T')[0];
    const author = vscode.workspace.getConfiguration('markdownNotebook').get<string>('author', '').trim();
    const authorLine = author ? `author: ${yamlValue(author)}\n` : '';
    const parentDirName = path.basename(root.fsPath);
    const backlink = `[← ${parentDirName} TOC](.toc.md)`;

    const body = `---\ntitle: ${yamlValue(title)}\ncreated: ${createdDate}\n${authorLine}tags: [scratchpad]\n---\n\n${backlink}\n\n# ${title}\n\n${text}\n`;

    try {
      await vscode.workspace.fs.writeFile(targetUri, new TextEncoder().encode(body));
      
      // Clear scratchpad
      await this.writeScratchpad('');
      this._view?.webview.postMessage({ type: 'clearConfirmed' });

      // Refresh explorer & open page
      vscode.commands.executeCommand('markdownNotebook.refresh');
      await vscode.commands.executeCommand('markdownNotebook.openPage', targetUri);
      
      vscode.window.showInformationMessage(`Created new note: ${uniqueFileName}`);
    } catch (err) {
      vscode.window.showErrorMessage(`Scratchpad: Could not create note (${String(err)})`);
    }
  }

  private async getUniqueMdName(dir: string, baseSlug: string): Promise<string> {
    let candidate = `${baseSlug}.md`;
    let i = 1;
    while (await this.existsFile(path.join(dir, candidate))) {
      candidate = `${baseSlug}-${i}.md`;
      i++;
    }
    return candidate;
  }

  private async existsFile(p: string): Promise<boolean> {
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Quick Scratchpad</title>
  <style>
    :root {
      --font-family: var(--vscode-editor-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
      --font-size: var(--vscode-editor-font-size, 13px);
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --input-bg: var(--vscode-input-background, rgba(0,0,0,0.1));
      --input-fg: var(--vscode-input-foreground, var(--fg));
      --border: var(--vscode-input-border, rgba(128,128,128,0.2));
      --focus-border: var(--vscode-focusBorder, #007acc);
      --btn-bg: var(--vscode-button-background, #007acc);
      --btn-hover: var(--vscode-button-hoverBackground, #0062a3);
      --btn-fg: var(--vscode-button-foreground, #ffffff);
      --panel-bg: var(--vscode-sideBar-background, var(--bg));
      --desc-fg: var(--vscode-descriptionForeground, rgba(128,128,128,0.8));
    }

    body {
      background-color: var(--panel-bg);
      color: var(--fg);
      font-family: var(--font-family);
      font-size: var(--font-size);
      margin: 0;
      padding: 10px;
      display: flex;
      flex-direction: column;
      height: 100vh;
      box-sizing: border-box;
      overflow: hidden;
    }

    .scratchpad-container {
      display: flex;
      flex-direction: column;
      flex-grow: 1;
      position: relative;
    }

    textarea {
      flex-grow: 1;
      width: 100%;
      background-color: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 10px;
      resize: none;
      box-sizing: border-box;
      outline: none;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: calc(var(--font-size) - 1px);
      line-height: 1.4;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }

    textarea:focus {
      border-color: var(--focus-border);
      box-shadow: 0 0 4px rgba(0, 122, 204, 0.3);
    }

    textarea:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .toolbar {
      display: flex;
      justify-content: flex-end;
      gap: 6px;
      margin-top: 8px;
      flex-shrink: 0;
    }

    .btn {
      background-color: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      border-radius: 4px;
      padding: 6px 10px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      font-size: 11px;
      font-weight: 500;
      transition: background-color 0.2s ease, transform 0.1s ease;
    }

    .btn:hover:not(:disabled) {
      background-color: var(--btn-hover);
      transform: translateY(-1px);
    }

    .btn:active:not(:disabled) {
      transform: translateY(0);
    }

    .btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      transform: none !important;
    }

    .btn-secondary {
      background-color: transparent;
      border: 1px solid var(--border);
      color: var(--fg);
    }

    .btn-secondary:hover:not(:disabled) {
      background-color: rgba(128,128,128,0.1);
    }

    .btn svg {
      width: 12px;
      height: 12px;
    }

    .status-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 10px;
      color: var(--desc-fg);
      margin-top: 4px;
      flex-shrink: 0;
    }

    .undo-toast {
      position: absolute;
      bottom: 45px;
      left: 10px;
      right: 10px;
      background-color: var(--vscode-notifications-background, #252526);
      color: var(--vscode-notifications-foreground, #cccccc);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 8px 12px;
      box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
      display: flex;
      justify-content: space-between;
      align-items: center;
      z-index: 100;
      transform: translateY(20px);
      opacity: 0;
      pointer-events: none;
      transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity 0.3s ease;
    }

    .undo-toast.show {
      transform: translateY(0);
      opacity: 1;
      pointer-events: auto;
    }

    .undo-link {
      color: var(--focus-border);
      cursor: pointer;
      text-decoration: underline;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <div class="scratchpad-container">
    <textarea id="scratchpad" placeholder="Type quick notes here... Use buttons below to save or clear them."></textarea>
    
    <div class="status-bar">
      <span id="char-count">0 characters</span>
      <span id="sync-status">Draft</span>
    </div>

    <div class="toolbar">
      <button class="btn btn-secondary" id="btn-clear" title="Clear notes" disabled>
        <svg viewBox="0 0 16 16" fill="currentColor">
          <path fill-rule="evenodd" d="M6.5 1.75a.25.25 0 01.25-.25h2.5a.25.25 0 01.25.25V3h-3V1.75zm4.5 1.25V1.75A1.75 1.75 0 009.25 0h-2.5A1.75 1.75 0 005 1.75V3H1.75a.75.75 0 000 1.5H2v9.75A2.75 2.75 0 004.75 17h6.5A2.75 2.75 0 0014 14.25V4.5h.25a.75.75 0 000-1.5H11zM3.5 4.5h9v9.75c0 .69-.56 1.25-1.25 1.25h-6.5c-.69 0-1.25-.56-1.25-1.25V4.5z" clip-rule="evenodd"/>
        </svg>
        Clear
      </button>
      <button class="btn btn-secondary" id="btn-convert" title="Convert scratchpad to a new page" disabled>
        <svg viewBox="0 0 16 16" fill="currentColor">
          <path d="M8.5 1.5A1.5 1.5 0 0 0 7 3v9a1.5 1.5 0 0 0 1.5 1.5h5a1.5 1.5 0 0 0 1.5-1.5V5.414a1.5 1.5 0 0 0-.44-1.06l-2.914-2.915A1.5 1.5 0 0 0 10.586 1.5H8.5z"/>
          <path d="M3 5.5A1.5 1.5 0 0 1 4.5 4H6v1H4.5a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5H9v1H4.5A1.5 1.5 0 0 1 3 12.5v-7z"/>
        </svg>
        Convert...
      </button>
      <button class="btn" id="btn-daily" title="Send scratchpad notes to Daily Note" disabled>
        <svg viewBox="0 0 16 16" fill="currentColor">
          <path d="M11 7.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1z"/>
          <path fill-rule="evenodd" d="M3.5 0a.5.5 0 0 1 .5.5V1h8V.5a.5.5 0 0 1 1 0V1h1a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2h1V.5a.5.5 0 0 1 .5-.5zM1 4v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V4H1z" clip-rule="evenodd"/>
        </svg>
        Send to Daily
      </button>
    </div>

    <div class="undo-toast" id="undo-toast">
      <span>Scratchpad cleared</span>
      <span class="undo-link" id="undo-link">Undo</span>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const textarea = document.getElementById('scratchpad');
    const charCount = document.getElementById('char-count');
    const syncStatus = document.getElementById('sync-status');
    const btnClear = document.getElementById('btn-clear');
    const btnConvert = document.getElementById('btn-convert');
    const btnDaily = document.getElementById('btn-daily');
    const undoToast = document.getElementById('undo-toast');
    const undoLink = document.getElementById('undo-link');

    let saveTimeout = null;
    let preClearText = '';
    let toastTimeout = null;
    let hasWorkspaceActive = true;

    // Signal we are ready to receive initial contents
    vscode.postMessage({ type: 'webviewReady' });

    // Handle updates from extension
    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.type) {
        case 'workspaceStatus':
          setWorkspaceState(message.hasWorkspace);
          break;
        case 'updateContent':
          setWorkspaceState(message.hasWorkspace);
          // Only update if value is different (prevents losing focus/cursor position)
          if (textarea.value !== message.text) {
            textarea.value = message.text;
            updateStatusBar();
          }
          syncStatus.textContent = 'Saved';
          break;
        case 'focusTextarea':
          if (!textarea.disabled) {
            textarea.focus();
          }
          break;
        case 'clearConfirmed':
          textarea.value = '';
          updateStatusBar();
          break;
      }
    });

    textarea.addEventListener('input', () => {
      updateStatusBar();
      syncStatus.textContent = 'Typing...';
      
      // Debounce saving to extension backend
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        vscode.postMessage({
          type: 'saveScratchpad',
          text: textarea.value
        });
      }, 300);
    });

    btnClear.addEventListener('click', () => {
      if (textarea.disabled) return;
      const val = textarea.value;
      if (!val.trim()) return;

      preClearText = val;
      textarea.value = '';
      updateStatusBar();

      // Save empty text immediately
      vscode.postMessage({
        type: 'saveScratchpad',
        text: ''
      });

      // Show Undo Toast
      showToast();
    });

    btnDaily.addEventListener('click', () => {
      if (textarea.disabled) return;
      const val = textarea.value;
      if (!val.trim()) return;
      vscode.postMessage({
        type: 'appendToDaily',
        text: val
      });
    });

    btnConvert.addEventListener('click', () => {
      if (textarea.disabled) return;
      const val = textarea.value;
      if (!val.trim()) return;
      vscode.postMessage({
        type: 'convertToNote',
        text: val
      });
    });

    undoLink.addEventListener('click', () => {
      if (textarea.disabled) return;
      if (preClearText) {
        textarea.value = preClearText;
        updateStatusBar();
        vscode.postMessage({
          type: 'saveScratchpad',
          text: preClearText
        });
        preClearText = '';
        hideToast();
      }
    });

    function setWorkspaceState(hasWorkspace) {
      hasWorkspaceActive = hasWorkspace;
      if (hasWorkspace) {
        textarea.disabled = false;
        textarea.placeholder = "Type quick notes here... Use buttons below to save or clear them.";
        updateButtonStates();
      } else {
        textarea.value = '';
        textarea.disabled = true;
        textarea.placeholder = "Please open a folder to start taking quick notes.";
        btnClear.disabled = true;
        btnConvert.disabled = true;
        btnDaily.disabled = true;
        syncStatus.textContent = 'No workspace';
        charCount.textContent = '0 characters';
      }
    }

    function updateStatusBar() {
      const len = textarea.value.length;
      charCount.textContent = len + ' character' + (len === 1 ? '' : 's');
      updateButtonStates();
    }

    function updateButtonStates() {
      if (!hasWorkspaceActive) return;
      const isEmpty = !textarea.value.trim();
      btnClear.disabled = isEmpty;
      btnConvert.disabled = isEmpty;
      btnDaily.disabled = isEmpty;
    }

    function showToast() {
      if (toastTimeout) clearTimeout(toastTimeout);
      undoToast.classList.add('show');
      toastTimeout = setTimeout(() => {
        hideToast();
      }, 5000);
    }

    function hideToast() {
      undoToast.classList.remove('show');
      preClearText = '';
    }
  </script>
</body>
</html>`;
  }
}
