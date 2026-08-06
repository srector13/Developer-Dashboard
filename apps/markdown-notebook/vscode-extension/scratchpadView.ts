import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { resolveRoot, getOrCreateDailyNoteUri, yamlValue, DEFAULT_IGNORE } from './notebookView';
import { getTimestampChoices } from './editorToolbar';

const fsp = fs.promises;

export class ScratchpadViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'markdownNotebook.scratchpad';

  private _view?: vscode.WebviewView;
  private _watcher?: vscode.FileSystemWatcher;
  private _lastKnownContent = '';
  private _disposables: vscode.Disposable[] = [];

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _workspaceState: vscode.Memento
  ) {
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
        case 'getNotesList': {
          await this.sendNotesList();
          break;
        }
        case 'appendToNote': {
          await this.appendToNote(data.text, data.targetPath);
          break;
        }
        case 'appendToActive': {
          await this.appendToActiveEditor(data.text);
          break;
        }
        case 'getHistory': {
          await this.sendHistory();
          break;
        }
        case 'clearHistory': {
          await this.clearHistory();
          break;
        }
        case 'addToHistory': {
          await this.addToHistory(data.text);
          break;
        }
        case 'error': {
          vscode.window.showErrorMessage(`Scratchpad Webview Error: ${data.message} at line ${data.lineno}:${data.colno} (${data.filename})\nStack: ${data.error}`);
          break;
        }
        case 'selectLanguage': {
          console.log('Scratchpad backend: received selectLanguage request');
          const choices = [
            { label: '$(terminal) Inline Code (Default)', id: 'inline' },
            { label: '$(circle-outline) Plain Text Code Block', id: '' },
            { label: '$(symbol-method) Apex', id: 'apex' },
            { label: '$(file-binary) Assembly / ASM', id: 'asm' },
            { label: '$(globe) Astro', id: 'astro' },
            { label: '$(terminal) AWK', id: 'awk' },
            { label: '$(terminal) Bash / Shell', id: 'bash' },
            { label: '$(terminal) Batch / CMD', id: 'bat' },
            { label: '$(symbol-keyword) C', id: 'c' },
            { label: '$(symbol-keyword) C++', id: 'cpp' },
            { label: '$(symbol-keyword) C#', id: 'csharp' },
            { label: '$(symbol-keyword) Clojure', id: 'clojure' },
            { label: '$(tools) CMake', id: 'cmake' },
            { label: '$(symbol-keyword) COBOL', id: 'cobol' },
            { label: '$(symbol-keyword) CSS', id: 'css' },
            { label: '$(symbol-keyword) Dart', id: 'dart' },
            { label: '$(diff) Diff', id: 'diff' },
            { label: '$(file-binary) Dockerfile', id: 'dockerfile' },
            { label: '$(symbol-keyword) Elixir', id: 'elixir' },
            { label: '$(symbol-keyword) Erlang', id: 'erlang' },
            { label: '$(symbol-keyword) F#', id: 'fsharp' },
            { label: '$(symbol-keyword) Fortran', id: 'fortran' },
            { label: '$(symbol-keyword) Go', id: 'go' },
            { label: '$(tools) Gradle', id: 'gradle' },
            { label: '$(symbol-interface) GraphQL', id: 'graphql' },
            { label: '$(symbol-keyword) Groovy', id: 'groovy' },
            { label: '$(symbol-keyword) HTML', id: 'html' },
            { label: '$(symbol-keyword) Haskell', id: 'haskell' },
            { label: '$(symbol-object) INI Configuration', id: 'ini' },
            { label: '$(symbol-keyword) Java', id: 'java' },
            { label: '$(symbol-keyword) JavaScript', id: 'javascript' },
            { label: '$(symbol-object) JSON', id: 'json' },
            { label: '$(symbol-object) JSON5', id: 'json5' },
            { label: '$(symbol-keyword) Julia', id: 'julia' },
            { label: '$(symbol-keyword) Kotlin', id: 'kotlin' },
            { label: '$(file-text) LaTeX', id: 'latex' },
            { label: '$(symbol-keyword) Less CSS', id: 'less' },
            { label: '$(symbol-keyword) Lisp', id: 'lisp' },
            { label: '$(symbol-keyword) Lua', id: 'lua' },
            { label: '$(tools) Makefile', id: 'makefile' },
            { label: '$(file-text) Markdown', id: 'markdown' },
            { label: '$(symbol-keyword) MATLAB', id: 'matlab' },
            { label: '$(graph) Mermaid', id: 'mermaid' },
            { label: '$(server) Nginx Config', id: 'nginx' },
            { label: '$(symbol-keyword) Objective-C', id: 'objc' },
            { label: '$(symbol-keyword) OCaml', id: 'ocaml' },
            { label: '$(symbol-keyword) Perl', id: 'perl' },
            { label: '$(symbol-keyword) PHP', id: 'php' },
            { label: '$(database) PL/SQL', id: 'plsql' },
            { label: '$(terminal) PowerShell', id: 'powershell' },
            { label: '$(database) Prisma Schema', id: 'prisma' },
            { label: '$(symbol-object) Properties File', id: 'properties' },
            { label: '$(symbol-object) Protocol Buffers', id: 'proto' },
            { label: '$(symbol-keyword) Python', id: 'python' },
            { label: '$(symbol-keyword) R', id: 'r' },
            { label: '$(symbol-keyword) Ruby', id: 'ruby' },
            { label: '$(symbol-keyword) Rust', id: 'rust' },
            { label: '$(symbol-keyword) SAS', id: 'sas' },
            { label: '$(symbol-keyword) Scala', id: 'scala' },
            { label: '$(symbol-keyword) Scheme', id: 'scheme' },
            { label: '$(symbol-keyword) SCSS', id: 'scss' },
            { label: '$(symbol-keyword) Shader / GLSL', id: 'glsl' },
            { label: '$(symbol-keyword) Solidity', id: 'solidity' },
            { label: '$(database) SQL', id: 'sql' },
            { label: '$(globe) Svelte', id: 'svelte' },
            { label: '$(symbol-keyword) Swift', id: 'swift' },
            { label: '$(symbol-keyword) SystemVerilog', id: 'systemverilog' },
            { label: '$(symbol-object) TOML', id: 'toml' },
            { label: '$(symbol-keyword) TypeScript', id: 'typescript' },
            { label: '$(symbol-keyword) Visual Basic', id: 'vb' },
            { label: '$(globe) Vue', id: 'vue' },
            { label: '$(file-binary) WebAssembly', id: 'wasm' },
            { label: '$(code) XML', id: 'xml' },
            { label: '$(symbol-object) YAML', id: 'yaml' },
            { label: '$(symbol-keyword) Zig', id: 'zig' }
          ];
          const choice = await vscode.window.showQuickPick(choices, {
            placeHolder: 'Select programming language for syntax highlighting'
          });
          console.log('Scratchpad backend: showQuickPick finished. Choice:', choice);
          if (choice !== undefined) {
            console.log('Scratchpad backend: posting insertCodeBlock message to webview with language:', choice.id);
            webviewView.webview.postMessage({ type: 'insertCodeBlock', language: choice.id });
          }
          break;
        }
        case 'createTable': {
          const colsInput = await vscode.window.showInputBox({
            prompt: 'Enter number of columns for the table',
            value: '3',
            validateInput: (val) => {
              const num = Number(val);
              if (isNaN(num) || num <= 0 || !Number.isInteger(num)) {
                return 'Please enter a positive integer.';
              }
              if (num > 20) {
                return 'Maximum columns is 20.';
              }
              return null;
            }
          });
          if (colsInput === undefined) { return; }
          const cols = parseInt(colsInput, 10) || 3;

          const rowsInput = await vscode.window.showInputBox({
            prompt: 'Enter number of data rows for the table',
            value: '2',
            validateInput: (val) => {
              const num = Number(val);
              if (isNaN(num) || num <= 0 || !Number.isInteger(num)) {
                return 'Please enter a positive integer.';
              }
              if (num > 100) {
                return 'Maximum rows is 100.';
              }
              return null;
            }
          });
          if (rowsInput === undefined) { return; }
          const rows = parseInt(rowsInput, 10) || 2;

          let tableMd = '|';
          for (let c = 1; c <= cols; c++) {
            tableMd += ' H |';
          }
          tableMd += '\n|';
          for (let c = 1; c <= cols; c++) {
            tableMd += ' --- |';
          }
          for (let r = 1; r <= rows; r++) {
            tableMd += '\n|';
            for (let c = 1; c <= cols; c++) {
              tableMd += ' C |';
            }
          }
          tableMd += '\n';

          webviewView.webview.postMessage({ type: 'insertTable', text: tableMd });
          break;
        }
        case 'selectTimestamp': {
          const choices = getTimestampChoices();
          const choice = await vscode.window.showQuickPick(choices, {
            placeHolder: 'Select date/time format'
          });
          if (choice !== undefined) {
            webviewView.webview.postMessage({ type: 'insertTimestamp', text: choice.format });
          }
          break;
        }
        case 'selectHeading': {
          const choices = [
            { label: '$(list-ordered) Header (Heading 1)', format: '# ' },
            { label: '$(list-ordered) Subheader (Heading 2)', format: '## ' },
            { label: '$(list-ordered) Section Header (Heading 3)', format: '### ' }
          ];
          const choice = await vscode.window.showQuickPick(choices, {
            placeHolder: 'Select Heading Level'
          });
          if (choice !== undefined) {
            webviewView.webview.postMessage({ type: 'insertHeading', prefix: choice.format });
          }
          break;
        }
        case 'selectList': {
          const choices = [
            { label: '$(list-unordered) Bulleted List', prefix: '- ' },
            { label: '$(list-ordered) Numbered List', prefix: '1. ' }
          ];
          const choice = await vscode.window.showQuickPick(choices, {
            placeHolder: 'Select List Type'
          });
          if (choice !== undefined) {
            webviewView.webview.postMessage({ type: 'insertList', prefix: choice.prefix });
          }
          break;
        }
        case 'selectChart': {
          const choices = [
            { label: '$(organization) Flowchart', detail: 'A flowchart diagram (TD/LR orientation)', template: '```mermaid\nflowchart TD\n    A[Start] --> B(Process)\n    B --> C{Decision}\n    C -- Yes --> D[Result 1]\n    C -- No --> E[Result 2]\n```\n' },
            { label: '$(play) Sequence Diagram', detail: 'Interaction sequence diagram between actors', template: '```mermaid\nsequenceDiagram\n    Alice->>Bob: Hello Bob, how are you?\n    Bob-->>Alice: Jolly good!\n```\n' },
            { label: '$(calendar) Gantt Chart', detail: 'A gantt chart timeline', template: '```mermaid\ngantt\n    title A Gantt Chart\n    dateFormat YYYY-MM-DD\n    section Section\n    A task :a1, 2026-06-24, 30d\n    Another task :after a1, 20d\n```\n' },
            { label: '$(pie-chart) Pie Chart', detail: 'A percentage-based pie chart', template: '```mermaid\npie title Pets adopted by volunteers\n    "Dogs" : 386\n    "Cats" : 85\n    "Rats" : 15\n```\n' },
            { label: '$(symbol-class) Class Diagram', detail: 'Object-oriented class structure diagram', template: '```mermaid\nclassDiagram\n    Class01 <|-- Class02\n    Class03 *-- Class04\n    Class01 : size\n    Class01 : method()\n```\n' }
          ];
          const choice = await vscode.window.showQuickPick(choices, {
            placeHolder: 'Select Diagram Type to Insert'
          });
          if (choice !== undefined) {
            webviewView.webview.postMessage({ type: 'insertChart', text: choice.template });
          }
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

  private async appendTextToDocument(targetUri: vscode.Uri, text: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(targetUri);
    const docText = doc.getText();

    let insertText = '\n\n' + text.trim() + '\n';
    if (docText.length === 0) {
      insertText = text.trim() + '\n';
    } else if (docText.endsWith('\n\n')) {
      insertText = text.trim() + '\n';
    } else if (docText.endsWith('\n')) {
      insertText = '\n' + text.trim() + '\n';
    }

    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, new vscode.Position(doc.lineCount, 0), insertText);
    await vscode.workspace.applyEdit(edit);
    await doc.save();
  }

  private async appendToDailyNote(text: string) {
    if (!text.trim()) { return; }
    const result = await getOrCreateDailyNoteUri();
    if (!result) {
      return;
    }
    const { targetUri } = result;

    try {
      await this.appendTextToDocument(targetUri, text);
      vscode.window.showInformationMessage('Quick Notes appended to today\'s Daily Note!');
      
      // Update scratchpad backing file as empty and add to history
      await this.addToHistory(text);
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

    const tagMatches = text.match(/#(\w+)/g);
    const extraTags = tagMatches ? tagMatches.map(t => t.slice(1).toLowerCase()) : [];
    const uniqueTags = Array.from(new Set(['scratchpad', ...extraTags]));
    const tagsStr = uniqueTags.join(', ');

    const body = `---\ntitle: ${yamlValue(title)}\ncreated: ${createdDate}\n${authorLine}tags: [${tagsStr}]\n---\n\n${backlink}\n\n# ${title}\n\n${text}\n`;

    try {
      await vscode.workspace.fs.writeFile(targetUri, new TextEncoder().encode(body));
      
      // Clear scratchpad and add to history
      await this.addToHistory(text);
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

  private async sendNotesList() {
    const root = resolveRoot();
    if (!root) {
      this._view?.webview.postMessage({ type: 'notesList', notes: [] });
      return;
    }

    try {
      const pattern = new vscode.RelativePattern(root, '**/*.md');
      const uris = await vscode.workspace.findFiles(pattern);

      const scratchpadUri = this.getScratchpadUri();
      const cfg = vscode.workspace.getConfiguration('markdownNotebook');
      const ignoreFolders = cfg.get<string[]>('ignoreFolders', DEFAULT_IGNORE) ?? DEFAULT_IGNORE;
      const ignoreSet = new Set(ignoreFolders.map(s => s.toLowerCase()));

      const filtered = uris.filter(uri => {
        const fsPath = uri.fsPath;
        if (scratchpadUri && fsPath === scratchpadUri.fsPath) { return false; }
        const base = path.basename(fsPath).toLowerCase();
        if (base === '.toc.md' || base === '.tasks.md') { return false; }
        
        const relPath = path.relative(root.fsPath, fsPath);
        const parts = relPath.toLowerCase().split(/[/\\]/);
        if (parts.some(p => ignoreSet.has(p) || p.startsWith('.'))) {
          return false;
        }
        return true;
      });

      const notes = await Promise.all(
        filtered.map(async (uri) => {
          const relativePath = path.relative(root.fsPath, uri.fsPath);
          const title = await this.getNoteTitle(uri);
          return {
            title,
            relativePath,
            fullPath: uri.fsPath
          };
        })
      );

      notes.sort((a, b) => a.title.localeCompare(b.title));

      this._view?.webview.postMessage({ type: 'notesList', notes });
    } catch (err) {
      console.error('Error fetching notes list:', err);
      this._view?.webview.postMessage({ type: 'notesList', notes: [] });
    }
  }

  private async getNoteTitle(uri: vscode.Uri): Promise<string> {
    try {
      const data = await vscode.workspace.fs.readFile(uri);
      const content = new TextDecoder().decode(data);
      
      const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?=[ \t]*(?:\r?\n|$))/);
      if (fm) {
        const lines = fm[1].split(/\r?\n/);
        for (const line of lines) {
          const kv = line.match(/^title:\s*(.*)$/i);
          if (kv) {
            return kv[1].trim().replace(/^["']|["']$/g, '');
          }
        }
      }
      
      const h1 = content.match(/^#\s+(.+?)\s*$/m);
      if (h1) {
        return h1[1].trim();
      }
    } catch {}
    
    const base = path.basename(uri.fsPath, '.md');
    const pretty = base.replace(/_+/g, ' ').trim();
    return pretty.charAt(0).toUpperCase() + pretty.slice(1);
  }

  private async appendToNote(text: string, targetPath: string) {
    if (!text.trim() || !targetPath) { return; }
    const targetUri = vscode.Uri.file(targetPath);

    try {
      await this.appendTextToDocument(targetUri, text);
      const noteName = path.basename(targetPath, '.md').replace(/_+/g, ' ');
      vscode.window.showInformationMessage(`Quick Notes appended to ${noteName}!`);
      
      // Update scratchpad backing file as empty and add to history
      await this.addToHistory(text);
      await this.writeScratchpad('');
      this._view?.webview.postMessage({ type: 'clearConfirmed' });
    } catch (err) {
      vscode.window.showErrorMessage(`Scratchpad: Failed to append to note: ${String(err)}`);
    }
  }

  private getActiveDocumentUri(): vscode.Uri | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === 'markdown') {
      return editor.document.uri;
    }

    const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    if (!activeTab || !activeTab.input) {
      return undefined;
    }

    const input = activeTab.input as any;

    if (input.uri instanceof vscode.Uri) {
      return input.uri;
    }

    if (input.modified instanceof vscode.Uri) {
      return input.modified;
    }

    const label = activeTab.label;
    if (label) {
      const cleanName = label.replace(/^Preview\s+/i, '').trim();
      if (cleanName.toLowerCase().endsWith('.md')) {
        const docs = vscode.workspace.textDocuments;
        for (const doc of docs) {
          if (path.basename(doc.uri.fsPath).toLowerCase() === cleanName.toLowerCase()) {
            return doc.uri;
          }
        }
      }
    }

    return undefined;
  }

  private async appendToActiveEditor(text: string) {
    if (!text.trim()) { return; }
    
    const uri = this.getActiveDocumentUri();
    if (!uri) {
      vscode.window.showWarningMessage('No active Markdown document or preview open.');
      return;
    }

    try {
      await this.appendTextToDocument(uri, text);
      const noteName = path.basename(uri.fsPath, '.md').replace(/_+/g, ' ');
      vscode.window.showInformationMessage(`Quick Notes appended to ${noteName}!`);
      
      // Clear scratchpad and add to history
      await this.addToHistory(text);
      await this.writeScratchpad('');
      this._view?.webview.postMessage({ type: 'clearConfirmed' });
    } catch (err) {
      vscode.window.showErrorMessage(`Scratchpad: Failed to append to active document: ${String(err)}`);
    }
  }

  private async addToHistory(text: string) {
    if (!text || !text.trim()) { return; }
    try {
      const history = this._workspaceState.get<string[]>('scratchpadHistory', []);
      if (history.length > 0 && history[0] === text) { return; }
      
      history.unshift(text);
      if (history.length > 10) { history.pop(); }
      await this._workspaceState.update('scratchpadHistory', history);
    } catch (err) {
      console.error('Error adding to scratchpad history:', err);
    }
  }

  private async sendHistory() {
    try {
      const history = this._workspaceState.get<string[]>('scratchpadHistory', []);
      this._view?.webview.postMessage({ type: 'historyList', history });
    } catch (err) {
      console.error('Error sending scratchpad history:', err);
      this._view?.webview.postMessage({ type: 'historyList', history: [] });
    }
  }

  private async clearHistory() {
    try {
      await this._workspaceState.update('scratchpadHistory', []);
      this._view?.webview.postMessage({ type: 'historyList', history: [] });
      vscode.window.showInformationMessage('Scratchpad history cleared!');
    } catch (err) {
      console.error('Error clearing scratchpad history:', err);
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
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'scratchpad.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline';">
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

    .editor-card {
      flex-grow: 1;
      display: flex;
      flex-direction: column;
      background-color: var(--input-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
      position: relative;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }

    .editor-card.focused {
      border-color: var(--focus-border);
      box-shadow: 0 0 4px rgba(0, 122, 204, 0.25);
    }

    textarea {
      flex-grow: 1;
      width: 100%;
      background-color: transparent;
      color: var(--input-fg);
      border: none;
      padding: 12px;
      resize: none;
      box-sizing: border-box;
      outline: none;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: calc(var(--font-size) - 1px);
      line-height: 1.45;
    }

    textarea:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      margin-top: 10px;
      padding: 4px 6px;
      border: 1px solid var(--border);
      border-radius: 4px;
      background-color: rgba(128, 128, 128, 0.03);
      flex-shrink: 0;
      position: relative;
      z-index: 10;
    }

    .toolbar-group-left, .toolbar-group-right {
      display: flex;
      gap: 4px;
      align-items: center;
    }

    .btn {
      background-color: transparent;
      color: var(--fg);
      border: none;
      border-radius: 4px;
      width: 28px;
      height: 28px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background-color 0.15s ease, color 0.15s ease;
    }

    .btn:hover:not(:disabled) {
      background-color: rgba(128, 128, 128, 0.15);
    }

    .btn:disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }

    .btn svg {
      width: 16px;
      height: 16px;
    }

    /* Hover accent colors for toolbar actions */
    body.vscode-dark, body:not(.vscode-light) {
      --hover-clear-bg: rgba(239, 68, 68, 0.15);
      --hover-clear-fg: #ef4444;
      --hover-history-bg: rgba(56, 189, 248, 0.15);
      --hover-history-fg: #38bdf8;
      --hover-daily-bg: rgba(74, 222, 128, 0.15);
      --hover-daily-fg: #4ade80;
      --hover-active-bg: rgba(129, 140, 248, 0.15);
      --hover-active-fg: #818cf8;
      --hover-append-bg: rgba(245, 158, 11, 0.15);
      --hover-append-fg: #f59e0b;
      --hover-convert-bg: rgba(167, 139, 250, 0.15);
      --hover-convert-fg: #a78bfa;
    }

    body.vscode-light {
      --hover-clear-bg: rgba(220, 38, 38, 0.12);
      --hover-clear-fg: #dc2626;
      --hover-history-bg: rgba(2, 132, 199, 0.12);
      --hover-history-fg: #0284c7;
      --hover-daily-bg: rgba(22, 163, 74, 0.12);
      --hover-daily-fg: #16a34a;
      --hover-active-bg: rgba(79, 70, 229, 0.12);
      --hover-active-fg: #4f46e5;
      --hover-append-bg: rgba(217, 119, 6, 0.12);
      --hover-append-fg: #d97706;
      --hover-convert-bg: rgba(124, 58, 237, 0.12);
      --hover-convert-fg: #7c3aed;
    }

    #btn-clear:hover:not(:disabled) { background-color: var(--hover-clear-bg); color: var(--hover-clear-fg); }
    #btn-history:hover:not(:disabled) { background-color: var(--hover-history-bg); color: var(--hover-history-fg); }
    #btn-daily:hover:not(:disabled) { background-color: var(--hover-daily-bg); color: var(--hover-daily-fg); }
    #btn-append-active:hover:not(:disabled) { background-color: var(--hover-active-bg); color: var(--hover-active-fg); }
    #btn-append-to:hover:not(:disabled) { background-color: var(--hover-append-bg); color: var(--hover-append-fg); }
    #btn-convert:hover:not(:disabled) { background-color: var(--hover-convert-bg); color: var(--hover-convert-fg); }

    .undo-toast {
      position: absolute;
      bottom: 50px;
      left: 10px;
      right: 10px;
      background-color: var(--vscode-notifications-background, #252526);
      color: var(--vscode-notifications-foreground, #cccccc);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 8px 12px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      display: flex;
      justify-content: space-between;
      align-items: center;
      z-index: 100;
      transform: translateY(12px);
      opacity: 0;
      pointer-events: none;
      transition: transform 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity 0.25s ease;
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

    .picker-overlay {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background-color: var(--vscode-sideBar-background, var(--bg));
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      display: flex;
      flex-direction: column;
      padding: 12px;
      z-index: 150;
      opacity: 0;
      pointer-events: none;
      transform: scale(0.96) translateY(8px);
      transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease;
    }

    body.vscode-dark .picker-overlay {
      background-color: rgba(30, 30, 30, 0.75);
    }
    body.vscode-light .picker-overlay {
      background-color: rgba(243, 243, 243, 0.75);
    }

    .picker-overlay.show {
      opacity: 1;
      pointer-events: auto;
      transform: scale(1) translateY(0);
    }

    .picker-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
      flex-shrink: 0;
    }

    .close-btn {
      background: transparent;
      border: none;
      color: var(--fg);
      cursor: pointer;
      padding: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      transition: background-color 0.2s ease;
    }

    .close-btn:hover {
      background-color: rgba(128,128,128,0.2);
    }

    .close-btn svg {
      width: 14px;
      height: 14px;
    }

    #picker-input {
      width: 100%;
      background-color: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 6px 10px;
      box-sizing: border-box;
      outline: none;
      font-family: var(--font-family);
      font-size: var(--font-size);
      margin-bottom: 8px;
      flex-shrink: 0;
    }

    #picker-input:focus {
      border-color: var(--focus-border);
      box-shadow: 0 0 4px rgba(0, 122, 204, 0.3);
    }

    .picker-results {
      flex-grow: 1;
      overflow-y: auto;
      border: 1px solid var(--border);
      border-radius: 6px;
      background-color: rgba(128, 128, 128, 0.05);
      padding: 4px;
    }

    .picker-item {
      padding: 8px 10px;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      border-radius: 4px;
      margin-bottom: 2px;
      transition: background-color 0.15s ease, color 0.15s ease;
    }

    .picker-item:last-child {
      margin-bottom: 0;
    }

    .picker-item:hover {
      background-color: rgba(128, 128, 128, 0.1);
    }

    .picker-item.selected {
      background-color: var(--vscode-list-activeSelectionBackground, #007acc);
      color: var(--vscode-list-activeSelectionForeground, #ffffff) !important;
    }

    .picker-item.selected .picker-item-path {
      color: var(--vscode-list-activeSelectionForeground, #ffffff);
      opacity: 0.8;
    }

    .picker-item-title {
      font-weight: 500;
      font-size: 12px;
    }

    .picker-item-path {
      font-size: 10px;
      color: var(--desc-fg);
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .picker-status {
      padding: 12px;
      text-align: center;
      color: var(--desc-fg);
      font-size: 11px;
    }

    .formatting-tools {
      display: flex;
      gap: 4px;
      align-items: center;
    }

    .formatting-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 8px;
      background-color: rgba(128, 128, 128, 0.04);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      position: relative;
      z-index: 10;
    }

    .fmt-btn {
      background: transparent;
      border: none;
      color: var(--fg);
      cursor: pointer;
      width: 26px;
      height: 26px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      font-size: 11px;
      font-family: inherit;
      transition: background-color 0.15s;
    }

    .fmt-btn:hover {
      background-color: rgba(128, 128, 128, 0.15);
    }

    .fmt-btn svg {
      width: 15px;
      height: 15px;
    }

    /* Vibrant, themed colors for formatter buttons */
    body.vscode-dark, body:not(.vscode-light) {
      --color-bold: #818cf8;        /* indigo-400 */
      --color-italic: #c084fc;      /* purple-400 */
      --color-heading: #fb923c;     /* orange-400 */
      --color-code: #f59e0b;        /* amber-500 */
      --color-code-block: #2dd4bf;  /* teal-400 */
      --color-table: #fb7185;       /* rose-400 */
      --color-separator: #94a3b8;   /* slate-400 */
      --color-list: #4ade80;        /* green-400 */
      --color-task: #38bdf8;        /* sky-400 */
      --color-quote: #a78bfa;       /* violet-400 */
      --color-chart: #60a5fa;       /* blue-400 */
      --color-time: #f472b6;        /* pink-400 */
      --color-toggle-preview: #38bdf8; /* sky-400 */
      /* GitHub Preview Scoped Variables */
      --gh-fg: #e6edf3;
      --gh-muted: #9198a1;
      --gh-border: #3d444d;
      --gh-bg: #0d1117;
      --gh-code-bg: rgba(110, 118, 129, 0.16);
      --gh-code-fg: #e6edf3;
      --gh-block-bg: #151b23;
      --gh-accent: #4493f8;
      --gh-quote-fg: #9198a1;
      --gh-quote-border: #3d444d;
      --gh-table-stripe: #151b23;
      --gh-mark-bg: rgba(187, 128, 9, 0.15);
      --gh-mark-fg: #f8e3a1;
    }

    body.vscode-light {
      --color-bold: #4f46e5;        /* indigo-600 */
      --color-italic: #9333ea;      /* purple-600 */
      --color-heading: #ea580c;     /* orange-600 */
      --color-code: #d97706;        /* amber-600 */
      --color-code-block: #0d9488;  /* teal-600 */
      --color-table: #e11d48;       /* rose-600 */
      --color-separator: #64748b;   /* slate-600 */
      --color-list: #16a34a;        /* green-600 */
      --color-task: #0284c7;        /* sky-600 */
      --color-quote: #7c3aed;       /* violet-600 */
      --color-chart: #2563eb;       /* blue-600 */
      --color-time: #db2777;        /* pink-600 */
      --color-toggle-preview: #0284c7; /* sky-600 */
      /* GitHub Preview Scoped Variables */
      --gh-fg: #1f2328;
      --gh-muted: #59636e;
      --gh-border: #d1d9e0;
      --gh-bg: #ffffff;
      --gh-code-bg: #eff1f3;
      --gh-code-fg: #1f2328;
      --gh-block-bg: #f6f8fa;
      --gh-accent: #0969da;
      --gh-quote-fg: #59636e;
      --gh-quote-border: #d1d9e0;
      --gh-table-stripe: #f6f8fa;
      --gh-mark-bg: #fff8c5;
      --gh-mark-fg: #1f2328;
    }

    #fmt-bold { color: var(--color-bold); }
    #fmt-italic { color: var(--color-italic); }
    #fmt-heading { color: var(--color-heading); }
    #fmt-code-block { color: var(--color-code-block); }
    #fmt-table { color: var(--color-table); }
    #fmt-separator { color: var(--color-separator); }
    #fmt-list { color: var(--color-list); }
    #fmt-task { color: var(--color-task); }
    #fmt-quote { color: var(--color-quote); }
    #fmt-chart { color: var(--color-chart); }
    #fmt-time { color: var(--color-time); }
    #btn-toggle-preview { color: var(--color-toggle-preview); }

    .preview-container {
      flex-grow: 1;
      width: 100%;
      background-color: var(--bg);
      color: var(--fg);
      border: none;
      padding: 12px 16px;
      box-sizing: border-box;
      overflow-y: auto;
      font-size: calc(var(--font-size) - 1px);
      line-height: 1.5;
      display: none;
    }

    .preview-container.show {
      display: block;
    }

    .preview-empty {
      color: var(--desc-fg);
      text-align: center;
      padding: 20px;
      font-style: italic;
    }

    /* Preview elements styled below in Markdown styles block */
    
    .preview-task-item {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      margin-bottom: 6px;
    }

    .preview-task-item input[type="checkbox"] {
      margin-top: 3px;
      cursor: pointer;
    }

    .preview-task-item span {
      cursor: pointer;
    }

    .preview-task-item.checked span {
      text-decoration: line-through;
      opacity: 0.6;
    }

    .history-item {
      padding: 10px 12px;
      cursor: pointer;
      border-radius: 4px;
      border-bottom: none;
      margin-bottom: 4px;
      background-color: rgba(128, 128, 128, 0.03);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      white-space: pre-wrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-height: 80px;
      display: -webkit-box;
      -webkit-line-clamp: 4;
      -webkit-box-orient: vertical;
      transition: background-color 0.15s, border-color 0.15s;
      border: 1px solid transparent;
    }

    .history-item:hover {
      background-color: rgba(128, 128, 128, 0.08);
      border-color: var(--border);
    }

    .history-item-header {
      display: flex;
      justify-content: space-between;
      font-size: 9px;
      color: var(--desc-fg);
      margin-bottom: 4px;
      font-family: var(--font-family);
    }

    .clear-history-btn {
      width: 100%;
      background-color: transparent;
      border: 1px solid var(--border);
      color: var(--fg);
      padding: 6px;
      margin-top: 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 10px;
      transition: background-color 0.15s;
      flex-shrink: 0;
    }

    .clear-history-btn:hover {
      background-color: rgba(229, 57, 53, 0.1);
      border-color: rgba(229, 57, 53, 0.3);
      color: #f44336;
    }

    /* Custom CSS Tooltips */
    [data-tooltip] {
      position: relative;
    }

    [data-tooltip]::after {
      content: attr(data-tooltip);
      position: absolute;
      background-color: var(--vscode-notifications-background, #252526);
      color: var(--vscode-notifications-foreground, #cccccc);
      border: 1px solid var(--border);
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 500;
      white-space: nowrap;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.1s ease, transform 0.1s ease;
      box-shadow: 0 2px 6px rgba(0,0,0,0.2);
      z-index: 1000;
    }

    [data-tooltip]:hover::after {
      opacity: 1;
    }

    .tooltip-top::after {
      bottom: 125%;
      left: 50%;
      transform: translateX(-50%) translateY(4px);
    }
    .tooltip-top:hover::after {
      transform: translateX(-50%) translateY(0);
    }

    .tooltip-bottom::after {
      top: 125%;
      left: 50%;
      transform: translateX(-50%) translateY(-4px);
    }
    .tooltip-bottom:hover::after {
      transform: translateX(-50%) translateY(0);
    }

    /* Markdown Preview CSS Styles */
    .preview-container h1, .preview-container h2, .preview-container h3, .preview-container h4 {
      font-family: var(--font-family);
      font-weight: 600;
      color: var(--fg);
      margin-top: 16px;
      margin-bottom: 8px;
    }
    .preview-container h1 {
      font-size: 1.4em;
      border-bottom: 1px solid var(--gh-border);
      padding-bottom: 0.3em;
      margin-top: 8px;
    }
    .preview-container h2 {
      font-size: 1.25em;
      border-bottom: 1px solid var(--gh-border);
      padding-bottom: 0.3em;
    }
    .preview-container h3 {
      font-size: 1.15em;
    }
    .preview-container h4 {
      font-size: 1.0em;
    }
    .preview-container p {
      margin-top: 0;
      margin-bottom: 12px;
      line-height: 1.6;
    }
    .preview-container a {
      color: var(--gh-accent);
      text-decoration: none;
    }
    .preview-container a:hover {
      text-decoration: underline;
    }
    .preview-container ul, .preview-container ol {
      margin-top: 0;
      margin-bottom: 12px;
      padding-left: 20px;
    }
    .preview-container li {
      margin-bottom: 4px;
    }
    .preview-container blockquote {
      margin: 16px 0;
      padding: 0 1em;
      border-left: 0.25em solid var(--gh-quote-border);
      color: var(--gh-muted);
      background-color: transparent;
    }
    .preview-container pre {
      background-color: var(--gh-block-bg);
      border: 1px solid var(--gh-border);
      padding: 12px;
      border-radius: 6px;
      overflow: auto;
      line-height: 1.45;
      margin: 12px 0;
    }
    .preview-container code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 85%;
      background-color: var(--gh-code-bg);
      color: var(--gh-code-fg);
      padding: 0.2em 0.4em;
      border-radius: 6px;
    }
    .preview-container pre code {
      background-color: transparent;
      padding: 0;
      border-radius: 0;
      color: inherit;
      font-size: inherit;
    }
    .preview-container hr {
      border: 0;
      border-top: 1px solid var(--gh-border);
      height: 0;
      margin: 20px 0;
    }
    .preview-container mark {
      background-color: var(--gh-mark-bg);
      color: var(--gh-mark-fg);
      border-radius: 3px;
      padding: 0.1em 0.2em;
    }
    .preview-container table {
      border-collapse: collapse;
      width: 100%;
      margin: 12px 0 16px;
      font-size: calc(var(--font-size) - 1px);
    }
    .preview-container table th, .preview-container table td {
      border: 1px solid var(--gh-border);
      padding: 6px 10px;
    }
    .preview-container table tr:nth-child(2n) {
      background-color: var(--gh-table-stripe);
    }
    .preview-container table th {
      font-weight: 600;
      background-color: var(--gh-block-bg);
    }
  </style>
</head>
<body>
  <div class="scratchpad-container">
    <div class="editor-card" id="editor-card">
      <div class="formatting-bar" id="formatting-bar">
        <div class="formatting-tools" id="formatting-tools">
          <button class="fmt-btn tooltip-bottom" data-tooltip="Bold (Ctrl+B)" id="fmt-bold">
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path d="M4.12 2.7H7.7c1.78 0 2.92.83 2.92 2.18 0 1.05-.67 1.74-1.6 2.02v.06c1.19.23 2.05 1.01 2.05 2.27 0 1.58-1.29 2.47-3.23 2.47H4.12V2.7zm3.17 4.15c.87 0 1.4-.41 1.4-1.07 0-.67-.53-1.03-1.4-1.03H5.66v2.1h1.63zm.32 4.98c.95 0 1.58-.42 1.58-1.18 0-.75-.63-1.16-1.58-1.16H5.66v2.34h1.95z"/>
            </svg>
          </button>
          <button class="fmt-btn tooltip-bottom" data-tooltip="Italic (Ctrl+I)" id="fmt-italic">
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path d="M6 2h5v1.2H8.87l-2.6 9.6H8v1.2H3v-1.2h2.13l2.6-9.6H6V2z"/>
            </svg>
          </button>
          <button class="fmt-btn tooltip-bottom" data-tooltip="Heading (H1 / H2 / H3)" id="fmt-heading">
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path d="M5 2a.5.5 0 0 1 .5.5V5h5V2.5a.5.5 0 0 1 1 0V5h2a.5.5 0 0 1 0 1h-2v4h2a.5.5 0 0 1 0 1h-2v2.5a.5.5 0 0 1-1 0V11h-5v2.5a.5.5 0 0 1-1 0V11H2a.5.5 0 0 1 0-1h2V6H2a.5.5 0 0 1 0-1h2V2.5A.5.5 0 0 1 5 2zm1 4v4h5V6H6z"/>
            </svg>
          </button>
          <button class="fmt-btn tooltip-bottom" data-tooltip="Code (Inline / Block)" id="fmt-code-block">
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path fill-rule="evenodd" clip-rule="evenodd" d="M2 3.75A1.75 1.75 0 0 1 3.75 2h8.5A1.75 1.75 0 0 1 14 3.75v8.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5zM3.75 3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25h-8.5zM5.3 5.3a.5.5 0 0 1 .7.1L4.65 7.5l1.35 2.1a.5.5 0 1 1-.84.54l-1.7-2.64a.5.5 0 0 1 0-.54l1.7-2.64v-.02zm5.4 0a.5.5 0 0 1 0 .68L11.35 7.5l-1.35 2.1a.5.5 0 1 0 .84.54l1.7-2.64a.5.5 0 0 0 0-.54l-1.7-2.64a.5.5 0 0 0-.68-.02h.1zM7.3 10.3a.5.5 0 0 1-.68-.22l-1.5-4a.5.5 0 1 1 .94-.36l1.5 4a.5.5 0 0 1-.26.58z"/>
            </svg>
          </button>
          <button class="fmt-btn tooltip-bottom" data-tooltip="Table" id="fmt-table">
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path d="M1.5 2h13l.5.5v11l-.5.5h-13l-.5-.5v-11l.5-.5zM2 5h12V3H2v2zm3 9V6H2v8h3zm1 0h4V6H6v8zm5 0h3V6h-3v8z"/>
            </svg>
          </button>
          <button class="fmt-btn tooltip-bottom" data-tooltip="Line Separator (---)" id="fmt-separator">
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path fill-rule="evenodd" clip-rule="evenodd" d="M1 8a.5.5 0 0 1 .5-.5h13a.5.5 0 0 1 0 1h-13A.5.5 0 0 1 1 8z"/>
            </svg>
          </button>
          <button class="fmt-btn tooltip-bottom" data-tooltip="Lists (Bullet / Numbered)" id="fmt-list">
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path fill-rule="evenodd" d="M5 11.5a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5zm0-4a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5zm0-4a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5zm-3 1a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm0 4a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm0 4a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/>
            </svg>
          </button>
          <button class="fmt-btn tooltip-bottom" data-tooltip="Checkbox Task (- [ ])" id="fmt-task">
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path d="M14 2.5V14c0 .8-.7 1.5-1.5 1.5h-9c-.8 0-1.5-.7-1.5-1.5V2.5c0-.8.7-1.5 1.5-1.5h9c.8 0 1.5.7 1.5 1.5zM3.5 2a.5.5 0 0 0-.5.5v11.5c0 .3.2.5.5.5h9c.3 0 .5-.2.5-.5V2.5a.5.5 0 0 0-.5-.5h-9z"/>
              <path d="M10.854 6.146a.5.5 0 0 1 0 .708l-3 3a.5.5 0 0 1-.708 0l-1.5-1.5a.5.5 0 1 1 .708-.708L7.5 8.793l2.646-2.647a.5.5 0 0 1 .708 0z"/>
            </svg>
          </button>
          <button class="fmt-btn tooltip-bottom" data-tooltip="Blockquote (>)" id="fmt-quote">
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path d="M12 12a1 1 0 0 1-1 1H8.5a1 1 0 0 1-1-1V9.5a1 1 0 0 1 1-1h1.75a.25.25 0 0 0 .25-.25v-.5a.5.5 0 0 0-.5-.5H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v8zm-5 0a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1V9.5a1 1 0 0 1 1-1h1.75a.25.25 0 0 0 .25-.25v-.5a.5.5 0 0 0-.5-.5H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v8z"/>
            </svg>
          </button>
          <button class="fmt-btn tooltip-bottom" data-tooltip="Diagram / Chart..." id="fmt-chart">
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path d="M12.5 1a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM11 3.5a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0zm-7.5 4a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM2 9.5a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0zm10.5 1.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM11 12.5a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0zM4.17 8.23l6.57-4.23-.55-.86-6.57 4.23.55.86zm6.57 4.67-6.57-4.23-.55.86 6.57 4.23.55-.86z"/>
            </svg>
          </button>
          <button class="fmt-btn tooltip-bottom" data-tooltip="Insert Current Time" id="fmt-time">
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
              <path d="M7.5 3h1v5.25l4.5 2.25-.5.86-5-2.5V3z"/>
            </svg>
          </button>
        </div>
        
        <button class="fmt-btn tooltip-bottom" data-tooltip="Open Preview" id="btn-toggle-preview">
          <svg viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 3.5a5.5 5.5 0 0 0-4.95 3c.53.94 1.28 1.7 2.18 2.2l.6-.8A4.47 4.47 0 0 1 4.5 6.5c0-.85.34-1.63.9-2.2l.6.8a3.5 3.5 0 1 0 3.84-2.12c.54-.08 1.09-.08 1.63 0a4.5 4.5 0 1 1-5.97 3.32l-.6-.8A5.5 5.5 0 0 0 8 3.5zm0 2A1.5 1.5 0 1 0 8 8a1.5 1.5 0 0 0 0-3z"/>
          </svg>
        </button>
      </div>
      
      <textarea id="scratchpad" placeholder="Type quick notes here... Use buttons below to save or clear them."></textarea>
      <div class="preview-container" id="preview-container"></div>
    </div>

    <div class="toolbar">
      <div class="toolbar-group-left">
        <button class="btn tooltip-top" data-tooltip="Clear Scratchpad" id="btn-clear" disabled>
          <svg viewBox="0 0 16 16" fill="currentColor">
            <path fill-rule="evenodd" d="M6.5 1.75a.25.25 0 01.25-.25h2.5a.25.25 0 01.25.25V3h-3V1.75zm4.5 1.25V1.75A1.75 1.75 0 009.25 0h-2.5A1.75 1.75 0 005 1.75V3H1.75a.75.75 0 000 1.5H2v9.75A2.75 2.75 0 004.75 17h6.5A2.75 2.75 0 0014 14.25V4.5h.25a.75.75 0 000-1.5H11zM3.5 4.5h9v9.75c0 .69-.56 1.25-1.25 1.25h-6.5c-.69 0-1.25-.56-1.25-1.25V4.5z" clip-rule="evenodd"/>
          </svg>
        </button>
        <button class="btn tooltip-top" data-tooltip="Show Scratchpad History" id="btn-history">
          <svg viewBox="0 0 16 16" fill="currentColor">
            <path d="M8.51 7.218V3.5a.5.5 0 0 0-1 0v4.25a.5.5 0 0 0 .242.434l3.25 1.95a.5.5 0 0 0 .516-.856l-3.008-1.81z"/>
            <path d="M8 14.5A6.5 6.5 0 1 1 14.5 8c0 .5-.06 1.002-.18 1.488a.5.5 0 0 0 .97.243A7.5 7.5 0 1 0 8 15.5c.34 0 .676-.023 1.007-.068a.5.5 0 1 0-.134-.99C8.583 14.478 8.293 14.5 8 14.5z"/>
            <path d="M15.354 11.146a.5.5 0 0 1 0 .708l-2 2a.5.5 0 0 1-.708 0l-1-1a.5.5 0 1 1 .708-.708l.646.647 1.646-1.647a.5.5 0 0 1 .708 0z"/>
          </svg>
        </button>
      </div>
      
      <div class="toolbar-group-right">
        <button class="btn tooltip-top" data-tooltip="Append to Today's Daily Note" id="btn-daily" disabled>
          <svg viewBox="0 0 16 16" fill="currentColor">
            <path d="M11 7.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-1z"/>
            <path fill-rule="evenodd" d="M3.5 0a.5.5 0 0 1 .5.5V1h8V.5a.5.5 0 0 1 1 0V1h1a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2h1V.5a.5.5 0 0 1 .5-.5zM1 4v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V4H1z" clip-rule="evenodd"/>
          </svg>
        </button>
        <button class="btn tooltip-top" data-tooltip="Append to Active Editor Document" id="btn-append-active" disabled>
          <svg viewBox="0 0 16 16" fill="currentColor">
            <path d="M14 4.5V14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2h5.5L14 4.5zm-3 0V1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4.5h-2.5z"/>
            <path d="M4.5 12.5a.5.5 0 0 1 0-1h7a.5.5 0 0 1 0 1h-7zm0-2a.5.5 0 0 1 0-1h7a.5.5 0 0 1 0 1h-7zm0-2a.5.5 0 0 1 0-1h7a.5.5 0 0 1 0 1h-7zm0-2a.5.5 0 0 1 0-1h7a.5.5 0 0 1 0 1h-7z"/>
          </svg>
        </button>
        <button class="btn tooltip-top" data-tooltip="Append to Specific Note..." id="btn-append-to" disabled>
          <svg viewBox="0 0 16 16" fill="currentColor">
            <path d="M14 4.5V14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2h5.5L14 4.5zm-3 0V1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4.5h-2.5z"/>
            <path d="M8 5.5a.5.5 0 0 1 .5.5v1.5H10a.5.5 0 0 1 0 1H8.5V10a.5.5 0 0 1-1 0V8.5H6a.5.5 0 0 1 0-1h1.5V6a.5.5 0 0 1 .5-.5z"/>
          </svg>
        </button>
        <button class="btn tooltip-top" data-tooltip="Convert to New Note..." id="btn-convert" disabled>
          <svg viewBox="0 0 16 16" fill="currentColor">
            <path d="M8.5 1.5A1.5 1.5 0 0 0 7 3v9a1.5 1.5 0 0 0 1.5 1.5h5a1.5 1.5 0 0 0 1.5-1.5V5.414a1.5 1.5 0 0 0-.44-1.06l-2.914-2.915A1.5 1.5 0 0 0 10.586 1.5H8.5z"/>
            <path d="M3 5.5A1.5 1.5 0 0 1 4.5 4H6v1H4.5a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5H9v1H4.5A1.5 1.5 0 0 1 3 12.5v-7z"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- Search overlay for appending to a specific note -->
    <div id="picker-overlay" class="picker-overlay">
      <div class="picker-header">
        <span style="font-weight: 600;">Append to Note</span>
        <button id="btn-picker-close" class="close-btn" title="Cancel">
          <svg viewBox="0 0 16 16" fill="currentColor">
            <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
          </svg>
        </button>
      </div>
      <input type="text" id="picker-input" placeholder="Search note by title..." autocomplete="off">
      <div id="picker-results" class="picker-results"></div>
    </div>

    <!-- History overlay -->
    <div id="history-overlay" class="picker-overlay">
      <div class="picker-header">
        <span style="font-weight: 600;">Scratchpad History</span>
        <button id="btn-history-close" class="close-btn" title="Close">
          <svg viewBox="0 0 16 16" fill="currentColor">
            <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
          </svg>
        </button>
      </div>
      <div id="history-results" class="picker-results"></div>
      <button id="btn-clear-history" class="clear-history-btn">Clear History</button>
    </div>

    <div class="undo-toast" id="undo-toast">
      <span>Scratchpad cleared</span>
      <span class="undo-link" id="undo-link">Undo</span>
    </div>
  </div>

  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
