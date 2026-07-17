import { contextBridge, ipcRenderer, webUtils } from 'electron';
import * as path from 'path';
import { pathToFileURL } from 'url';

// The markdown pipeline (markdown-it + highlight.js) is built LAZILY on the
// first renderMarkdown call. Loading it at preload time delayed every app
// launch — the page can't even start until the preload finishes — and the
// first render happens well after first paint, so nothing is lost.
// highlight.js loads the "common" subset (~35 languages) instead of all ~190;
// dart and scala are the only dropdown languages outside that set.
let mdInstance: any = null;
function getMd(): any {
  if (mdInstance) return mdInstance;

  /* eslint-disable @typescript-eslint/no-var-requires */
  const MarkdownIt = require('markdown-it');
  const hljs = require('highlight.js/lib/common');
  try {
    hljs.registerLanguage('dart', require('highlight.js/lib/languages/dart'));
    hljs.registerLanguage('scala', require('highlight.js/lib/languages/scala'));
  } catch { /* highlighting falls back to plain <pre> for these */ }

// Custom Markdown-it renderer (typed as any to prevent circular type initializer warnings)
const md: any = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: true,
  highlight: (str: string, lang: string): string => {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return '<pre class="hljs"><code>' +
               hljs.highlight(str, { language: lang, ignoreIllegals: true }).value +
               '</code></pre>';
      } catch (__) {}
    }
    return '<pre class="hljs"><code>' + md.utils.escapeHtml(str) + '</code></pre>';
  }
});

// 1. Highlight Plugin: ==highlight== -> <mark>highlight</mark>
md.inline.ruler.after('emphasis', 'notebook-mark', (state: any, silent: boolean): boolean => {
  const start = state.pos;
  const src = state.src;
  if (src.charCodeAt(start) !== 0x3d /* = */ || src.charCodeAt(start + 1) !== 0x3d) {
    return false;
  }
  const end = src.indexOf('==', start + 2);
  if (end < 0 || end === start + 2 || end + 2 > state.posMax) {
    return false;
  }
  if (!silent) {
    const content = src.slice(start + 2, end);
    const tokenOpen = state.push('mark_open', 'mark', 1);
    tokenOpen.markup = '==';
    const tokenText = state.push('text', '', 0);
    tokenText.content = content;
    const tokenClose = state.push('mark_close', 'mark', -1);
    tokenClose.markup = '==';
  }
  state.pos = end + 2;
  return true;
});

// 2. Mermaid Code Blocks
const defaultFence = md.renderer.rules.fence || ((tokens: any[], idx: number, options: any, env: any, self: any) => self.renderToken(tokens, idx, options));
md.renderer.rules.fence = (tokens: any[], idx: number, options: any, env: any, self: any) => {
  const token = tokens[idx];
  const info = (token.info || '').trim().split(/\s+/g)[0].toLowerCase();
  const mapLine = token.map ? token.map[0] : -1;
  if (info === 'mermaid') {
    const code = token.content;
    return `<div class="mermaid-block-container" data-line="${mapLine}">
      <div class="mermaid-actions-bar">
        <button class="mermaid-action-btn" onclick="zoomMermaid(this, -15)" title="Zoom Out Diagram">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <button class="mermaid-action-btn" onclick="zoomMermaid(this, 15)" title="Zoom In Diagram">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <button class="mermaid-action-btn" onclick="popoutMermaid(this)" title="Pop Out Diagram Focus">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </button>
        <button class="mermaid-action-btn" onclick="window.api.toggleMermaidOrientation(${mapLine})" title="Toggle Diagram Orientation">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
        </button>
        <button class="mermaid-action-btn" onclick="editMermaidDiagram(this)" title="Edit Diagram in Builder">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        </button>
      </div>
      <pre class="notebook-mermaid" data-line="${mapLine}">${escapeHtml(code)}</pre>
    </div>\n`;
  }
  return defaultFence(tokens, idx, options, env, self);
};

// Helper for HTML escaping
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 3. Wiki links: [[Page Name]] or [[Page Name|Label]]
md.inline.ruler.after('link', 'notebook-wiki-link', (state: any, silent: boolean): boolean => {
  const src = state.src;
  const pos = state.pos;
  if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) { // [[
    return false;
  }
  const end = src.indexOf(']]', pos + 2);
  if (end < 0) {
    return false;
  }
  if (!silent) {
    const content = src.slice(pos + 2, end);
    const parts = content.split('|');
    const target = parts[0].trim();
    const label = parts[1] ? parts[1].trim() : target;

    const token = state.push('link_open', 'a', 1);
    token.attrs = [
      ['href', '#'],
      ['class', 'wiki-link'],
      ['data-page', target.endsWith('.md') ? target : `${target}.md`],
    ];

    const textToken = state.push('text', '', 0);
    textToken.content = label;

    state.push('link_close', 'a', -1);
  }
  state.pos = end + 2;
  return true;
});

// 3b. Image src resolution: the document is loaded from the app's renderer
// directory, so relative image paths in notes would resolve to the wrong
// place. When env.resourceBase is set (the active note's directory), rewrite
// relative srcs to absolute file:// URLs. Also fixes PDF export, whose temp
// print HTML inherits the absolute URLs.
const defaultImage = md.renderer.rules.image || ((tokens: any[], idx: number, options: any, env: any, self: any) => self.renderToken(tokens, idx, options));
md.renderer.rules.image = (tokens: any[], idx: number, options: any, env: any, self: any) => {
  const token = tokens[idx];
  const base = env && env.resourceBase;
  if (base) {
    const src = token.attrGet('src') || '';
    const isAbsoluteOrScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src) || src.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(src);
    if (src && !isAbsoluteOrScheme) {
      try {
        token.attrSet('src', pathToFileURL(path.resolve(base, decodeURI(src))).href);
      } catch {}
    }
  }

  // Obsidian-style width control: ![diagram|400](img.png) renders 400px wide.
  // The "|400" lives in the alt text, so strip it and emit a width style.
  const widthMatch = (token.content || '').match(/^(.*?)\s*\|\s*(\d{2,4})\s*$/);
  if (widthMatch) {
    token.content = widthMatch[1];
    if (Array.isArray(token.children)) {
      token.children.forEach((child: any) => {
        if (child.type === 'text' && typeof child.content === 'string') {
          child.content = child.content.replace(/\s*\|\s*\d{2,4}\s*$/, '');
        }
      });
    }
    token.attrJoin('style', `width: ${widthMatch[2]}px;`);
  }

  let html = defaultImage(tokens, idx, options, env, self);

  // A quoted title (![alt](src "caption")) becomes a visible figcaption
  const title = token.attrGet('title');
  if (title) {
    html = `<figure class="notebook-figure">${html}<figcaption>${md.utils.escapeHtml(title)}</figcaption></figure>`;
  }
  return html;
};

// 4. External link target blank
const defaultLinkOpen = md.renderer.rules.link_open || ((tokens: any[], idx: number, options: any, env: any, self: any) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens: any[], idx: number, options: any, env: any, self: any) => {
  const href = tokens[idx].attrGet('href') || '';
  if (/^https?:\/\//i.test(href)) {
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noopener noreferrer');
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

// 5. Checklist items
md.core.ruler.after('inline', 'notebook-task-lists', (state: any) => {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'inline') continue;
    
    // Find parent list item opening to fetch source line maps
    let parent = null;
    for (let j = i - 1; j >= 0; j--) {
      if (tokens[j].type === 'list_item_open') {
        parent = tokens[j];
        break;
      }
      if (tokens[j].type === 'list_item_close') break;
    }
    if (!parent) continue;

    const text = tokens[i].content;
    const m = text.match(/^\[([ xX])\]\s+/);
    const targetLine = parent.map ? parent.map[0] : -1;

    if (m) {
      const checked = m[1].toLowerCase() === 'x';
      const children = tokens[i].children || [];
      
      // Inject standard markup for checkbox link
      const linkOpen = new state.Token('link_open', 'a', 1);
      linkOpen.attrs = [
        ['href', '#'],
        ['class', 'task-checkbox-link'],
        ['data-line', String(targetLine)],
        ['style', 'text-decoration: none; color: inherit; cursor: pointer;']
      ];
      
      const checkboxHtml = new state.Token('html_inline', '', 0);
      checkboxHtml.content = `<input class="task-checkbox" type="checkbox"${checked ? ' checked' : ''} style="cursor: pointer; margin-right: 8px;">`;
      
      const linkClose = new state.Token('link_close', 'a', -1);
      
      children.unshift(linkOpen, checkboxHtml, linkClose);
      
      // Strip [ ] / [x] from the following text token
      for (const c of children.slice(3)) {
        if (c.type === 'text') {
          c.content = c.content.replace(/^\[([ xX])\]\s+/, '');
          break;
        }
      }
      tokens[i].children = children;
    }
  }
});

  mdInstance = md;
  return mdInstance;
}

// API Expose
contextBridge.exposeInMainWorld('api', {
  // Platform ('darwin' | 'win32' | 'linux') so the UI can show the right
  // modifier keys (⌘ on macOS, Ctrl elsewhere)
  platform: process.platform,

  // Config / App control
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings: any) => ipcRenderer.invoke('save-settings', settings),
  
  // Note / Notebook structure
  getNotebookTree: (rootPath: string, filterTag?: string) => ipcRenderer.invoke('get-notebook-tree', rootPath, filterTag),
  readNote: (filePath: string) => ipcRenderer.invoke('read-note', filePath),
  writeNote: (filePath: string, content: string) => ipcRenderer.invoke('write-note', filePath, content),
  createPage: (dirPath: string, title: string, templateName?: string, meta?: { created?: string; tags?: string[] }, customVars?: Record<string, string>) => ipcRenderer.invoke('create-page', dirPath, title, templateName, meta, customVars),
  getTemplateVariables: (templateName: string) => ipcRenderer.invoke('get-template-variables', templateName),
  createSection: (dirPath: string, name: string, description?: string) => ipcRenderer.invoke('create-section', dirPath, name, description),
  setSectionMeta: (dirPath: string, description: string) => ipcRenderer.invoke('set-section-meta', dirPath, description),
  deleteNode: (filePath: string) => ipcRenderer.invoke('delete-node', filePath),
  renameNode: (filePath: string, newName: string) => ipcRenderer.invoke('rename-node', filePath, newName),
  updateNoteMeta: (filePath: string, meta: { created?: string; tags?: string[]; pinned?: boolean }) => ipcRenderer.invoke('update-note-meta', filePath, meta),
  relocateNode: (srcPath: string, destDir: string) => ipcRenderer.invoke('relocate-node', srcPath, destDir),
  moveNode: (dirPath: string, fileName: string, direction: 'up' | 'down') => ipcRenderer.invoke('move-node', dirPath, fileName, direction),
  setNodeOrder: (dirPath: string, orderedNames: string[]) => ipcRenderer.invoke('set-node-order', dirPath, orderedNames),
  
  // Quick Scratchpad
  readScratchpad: () => ipcRenderer.invoke('read-scratchpad'),
  appendScratchpad: (text: string) => ipcRenderer.invoke('append-scratchpad', text),

  // Templates
  listTemplates: () => ipcRenderer.invoke('list-templates'),
  createTemplate: (name: string) => ipcRenderer.invoke('create-template', name),
  
  // Imports / Exports
  importClipboard: (destDir: string, meta?: { title?: string; created?: string; tags?: string[] }) => ipcRenderer.invoke('import-clipboard', destDir, meta),
  importDocument: (destDir: string) => ipcRenderer.invoke('import-document', destDir),
  exportToPdf: (filePath: string, htmlContent: string, options?: { theme?: string; pageSize?: string; openAfter?: boolean; reveal?: boolean }) => ipcRenderer.invoke('export-to-pdf', filePath, htmlContent, options),
  exportToHtml: (filePath: string, htmlContent: string, options?: { theme?: string }) => ipcRenderer.invoke('export-to-html', filePath, htmlContent, options),
  exportToDocx: (filePath: string) => ipcRenderer.invoke('export-to-docx', filePath),
  copyRichText: (htmlContent: string, plainText: string) => ipcRenderer.invoke('copy-rich-text', htmlContent, plainText),

  // Backlinks (computed in the main process in one pass)
  getBacklinks: (filePath: string) => ipcRenderer.invoke('get-backlinks', filePath),

  // Full-text search over note contents
  searchNotes: (query: string, opts?: { maxResults?: number }) => ipcRenderer.invoke('search-notes', query, opts),

  // Attachments
  saveAttachment: (payload: { baseName: string; bytes: ArrayBuffer; notePath: string }) => ipcRenderer.invoke('save-attachment', payload),
  importAttachmentFile: (payload: { sourcePath: string; notePath: string }) => ipcRenderer.invoke('import-attachment-file', payload),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),

  // Trash
  listTrash: () => ipcRenderer.invoke('list-trash'),
  restoreTrashItem: (trashName: string) => ipcRenderer.invoke('restore-trash-item', trashName),
  deleteTrashItem: (trashName: string) => ipcRenderer.invoke('delete-trash-item', trashName),
  emptyTrash: () => ipcRenderer.invoke('empty-trash'),

  // Note history
  listNoteHistory: (filePath: string) => ipcRenderer.invoke('list-note-history', filePath),
  readNoteHistory: (filePath: string, id: string) => ipcRenderer.invoke('read-note-history', filePath, id),
  restoreNoteHistory: (filePath: string, id: string) => ipcRenderer.invoke('restore-note-history', filePath, id),
  
  // Utility events
  onFilesChanged: (callback: () => void) => {
    const subscription = () => callback();
    ipcRenderer.on('files-changed', subscription);
    return () => {
      ipcRenderer.removeListener('files-changed', subscription);
    };
  },
  onCaptureShortcutFailed: (callback: (shortcut: string) => void) => {
    ipcRenderer.on('capture-shortcut-failed', (_event, shortcut: string) => callback(shortcut));
  },
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  getAppVersion: () => ipcRenderer.invoke('app-version'),

  // Local AI (Ollama / LM Studio) — optional, disabled by default
  aiListModels: () => ipcRenderer.invoke('ai-list-models'),
  aiTransform: (mode: string, text: string) => ipcRenderer.invoke('ai-transform', mode, text),
  aiComplete: (context: string) => ipcRenderer.invoke('ai-complete', context),
  
  // Inline actions in renderer
  toggleTaskAtLine: (filePath: string, line: number) => ipcRenderer.invoke('toggle-task-at-line', filePath, line),
  toggleMermaidOrientation: (line: number) => ipcRenderer.send('toggle-mermaid-orientation', line),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  resolveRelativePath: (basePath: string, relPath: string) => path.resolve(path.dirname(basePath), relPath),
  
  // Local Markdown rendering. opts.resourceBase (the note's directory)
  // enables relative image resolution — see the image rule above.
  renderMarkdown: (text: string, opts?: { resourceBase?: string }) => {
    let body = text;
    // Strip YAML frontmatter (the closing --- must sit on its own line, so a
    // horizontal rule or table row later in the note can't truncate content)
    const fmMatch = body.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
    if (fmMatch) {
      body = body.slice(fmMatch[0].length);
    }
    // Strip TOC navigation backlinks lines like "[← Daily TOC](.toc.md)" first
    body = body.replace(/^([ \t]*\r?\n)*\[[^\]]*\]\([^)]*\.toc\.md\)([ \t]*\r?\n)*/gmi, '\n');
    body = body.replace(/\[[^\]]*\]\([^)]*\.toc\.md\)/gmi, '');

    // Strip first H1 heading if it is at the very start of the note body (run after stripping TOC)
    body = body.replace(/^([ \t]*\r?\n)*#[ \t]+.+(\r?\n|$)/, '');

    return getMd().render(body, { resourceBase: opts?.resourceBase || '' });
  },
});

ipcRenderer.on('perform-mermaid-toggle', (event, lineIndex) => {
  window.dispatchEvent(new CustomEvent('perform-mermaid-toggle', { detail: lineIndex }));
});



