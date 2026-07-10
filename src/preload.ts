import { contextBridge, ipcRenderer } from 'electron';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import * as path from 'path';

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

// API Expose
contextBridge.exposeInMainWorld('api', {
  // Config / App control
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings: any) => ipcRenderer.invoke('save-settings', settings),
  
  // Note / Notebook structure
  getNotebookTree: (rootPath: string, filterTag?: string) => ipcRenderer.invoke('get-notebook-tree', rootPath, filterTag),
  readNote: (filePath: string) => ipcRenderer.invoke('read-note', filePath),
  writeNote: (filePath: string, content: string) => ipcRenderer.invoke('write-note', filePath, content),
  createPage: (dirPath: string, title: string, templateName?: string, meta?: { created?: string; tags?: string[] }) => ipcRenderer.invoke('create-page', dirPath, title, templateName, meta),
  createSection: (dirPath: string, name: string) => ipcRenderer.invoke('create-section', dirPath, name),
  deleteNode: (filePath: string) => ipcRenderer.invoke('delete-node', filePath),
  renameNode: (filePath: string, newName: string) => ipcRenderer.invoke('rename-node', filePath, newName),
  relocateNode: (srcPath: string, destDir: string) => ipcRenderer.invoke('relocate-node', srcPath, destDir),
  moveNode: (dirPath: string, fileName: string, direction: 'up' | 'down') => ipcRenderer.invoke('move-node', dirPath, fileName, direction),
  
  // Quick Scratchpad
  readScratchpad: () => ipcRenderer.invoke('read-scratchpad'),
  appendScratchpad: (text: string) => ipcRenderer.invoke('append-scratchpad', text),

  // Templates
  listTemplates: () => ipcRenderer.invoke('list-templates'),
  createTemplate: (name: string) => ipcRenderer.invoke('create-template', name),
  
  // Imports / Exports
  importClipboard: (destDir: string, meta?: { title?: string; created?: string; tags?: string[] }) => ipcRenderer.invoke('import-clipboard', destDir, meta),
  importDocument: (destDir: string) => ipcRenderer.invoke('import-document', destDir),
  exportToPdf: (filePath: string, htmlContent: string) => ipcRenderer.invoke('export-to-pdf', filePath, htmlContent),
  
  // Utility events
  onFilesChanged: (callback: () => void) => {
    const subscription = () => callback();
    ipcRenderer.on('files-changed', subscription);
    return () => {
      ipcRenderer.removeListener('files-changed', subscription);
    };
  },
  
  // Inline actions in renderer
  toggleTaskAtLine: (filePath: string, line: number) => ipcRenderer.invoke('toggle-task-at-line', filePath, line),
  toggleMermaidOrientation: (line: number) => ipcRenderer.send('toggle-mermaid-orientation', line),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  resolveRelativePath: (basePath: string, relPath: string) => path.resolve(path.dirname(basePath), relPath),
  
  // Local Markdown rendering
  renderMarkdown: (text: string) => {
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
    
    return md.render(body);
  },
});

ipcRenderer.on('perform-mermaid-toggle', (event, lineIndex) => {
  window.dispatchEvent(new CustomEvent('perform-mermaid-toggle', { detail: lineIndex }));
});



