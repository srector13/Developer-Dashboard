// Markdown pipeline. In the Electron build this lived in the preload script;
// the Rust/Tauri shell has no preload, so it runs here in the page instead.
// Behaviour is deliberately identical — same markdown-it options, same six
// custom rules, same frontmatter/TOC/H1 stripping — so notes render the same
// either way. Kept synchronous because the renderer assigns the result
// straight into innerHTML.
//
// markdown-it and highlight.js are loaded from renderer/vendor as plain
// browser bundles (see index.html), so there is no build step.
(function () {
  'use strict';

  // --- Path helpers -------------------------------------------------------
  // Notes carry Windows paths (C:\notes\...) and relative POSIX-ish links, so
  // these normalise both rather than assuming one separator.

  function isAbsolutePath(p) {
    return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/');
  }

  function resolvePath(base, rel) {
    const useBackslash = /^[a-zA-Z]:[\\/]/.test(base) || base.startsWith('\\\\');
    const combined = isAbsolutePath(rel) ? rel : `${base}/${rel}`;
    const parts = combined.replace(/\\/g, '/').split('/');

    // Keep the root ("C:", "" for UNC/POSIX) out of the `..` walk so a link
    // with too many `..` can't escape past it.
    const root = parts.shift();
    const out = [];
    for (const part of parts) {
      if (part === '' || part === '.') continue;
      if (part === '..') out.pop();
      else out.push(part);
    }
    const joined = `${root}/${out.join('/')}`;
    return useBackslash ? joined.replace(/\//g, '\\') : joined;
  }

  // The page is served from the app's own origin, so an absolute filesystem
  // path has to go through Tauri's asset protocol to be loadable.
  function toAssetUrl(absPath) {
    const core = window.__TAURI__ && window.__TAURI__.core;
    if (core && typeof core.convertFileSrc === 'function') {
      return core.convertFileSrc(absPath);
    }
    // Fallback for a plain browser (renderer smoke tests)
    return `file://${absPath.replace(/\\/g, '/')}`;
  }

  function escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // --- Lazy pipeline construction ----------------------------------------
  // Building markdown-it costs real time and the first render happens well
  // after first paint, so it is deferred exactly as the preload deferred it.

  let mdInstance = null;

  function getMd() {
    if (mdInstance) return mdInstance;

    const hljs = window.hljs;

    const md = window.markdownit({
      html: true,
      linkify: true,
      breaks: true,
      highlight: (str, lang) => {
        if (lang && hljs && hljs.getLanguage(lang)) {
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
    md.inline.ruler.after('emphasis', 'notebook-mark', (state, silent) => {
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
    const defaultFence = md.renderer.rules.fence ||
      ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
    md.renderer.rules.fence = (tokens, idx, options, env, self) => {
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

    // 3. Wiki links: [[Page Name]] or [[Page Name|Label]]
    md.inline.ruler.after('link', 'notebook-wiki-link', (state, silent) => {
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

    // 3b. Image src resolution: the document is loaded from the app's own
    // origin, so relative image paths in notes would resolve to the wrong
    // place. When env.resourceBase is set (the active note's directory),
    // rewrite relative srcs to absolute asset-protocol URLs. Also fixes PDF
    // and HTML export, which resolve those URLs back to real files.
    const defaultImage = md.renderer.rules.image ||
      ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
    md.renderer.rules.image = (tokens, idx, options, env, self) => {
      const token = tokens[idx];
      const base = env && env.resourceBase;
      if (base) {
        const src = token.attrGet('src') || '';
        const isAbsoluteOrScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src) || src.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(src);
        if (src && !isAbsoluteOrScheme) {
          try {
            token.attrSet('src', toAssetUrl(resolvePath(base, decodeURI(src))));
          } catch {}
        }
      }

      // Obsidian-style width control: ![diagram|400](img.png) renders 400px
      // wide. The "|400" lives in the alt text, so strip it and emit a width.
      const widthMatch = (token.content || '').match(/^(.*?)\s*\|\s*(\d{2,4})\s*$/);
      if (widthMatch) {
        token.content = widthMatch[1];
        if (Array.isArray(token.children)) {
          token.children.forEach((child) => {
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
    const defaultLinkOpen = md.renderer.rules.link_open ||
      ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
    md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
      const href = tokens[idx].attrGet('href') || '';
      if (/^https?:\/\//i.test(href)) {
        tokens[idx].attrSet('target', '_blank');
        tokens[idx].attrSet('rel', 'noopener noreferrer');
      }
      return defaultLinkOpen(tokens, idx, options, env, self);
    };

    // 5. Checklist items
    md.core.ruler.after('inline', 'notebook-task-lists', (state) => {
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

    // highlight.js "common" ships ~35 languages; dart and scala are the only
    // languages in the app's dropdown outside that set, and their grammar
    // files (loaded from index.html) register themselves against `hljs`.

    mdInstance = md;
    return mdInstance;
  }

  // opts.resourceBase (the note's directory) enables relative image
  // resolution — see the image rule above.
  function render(text, opts) {
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

    // Strip first H1 heading if it is at the very start of the note body
    // (run after stripping TOC)
    body = body.replace(/^([ \t]*\r?\n)*#[ \t]+.+(\r?\n|$)/, '');

    return getMd().render(body, { resourceBase: (opts && opts.resourceBase) || '' });
  }

  window.NotebookMarkdown = { render, resolvePath, toAssetUrl };
})();
