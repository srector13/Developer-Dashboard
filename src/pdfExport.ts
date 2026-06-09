import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';

const fsp = require('fs').promises as typeof import('fs').promises;

interface NodeLike {
  resourceUri?: vscode.Uri;
  fsPath?: string;
  kind?: string;
}

export function registerPdfExport(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('markdownNotebook.exportPdf', (node?: NodeLike) =>
      exportPdf(node, context),
    ),
  );
}

async function exportPdf(node: NodeLike | undefined, context: vscode.ExtensionContext): Promise<void> {
  const srcUri = resolveSource(node);
  if (!srcUri) {
    vscode.window.showErrorMessage('Notebook: select a Markdown note to export, or open one in the editor.');
    return;
  }
  if (!srcUri.fsPath.toLowerCase().endsWith('.md')) {
    vscode.window.showErrorMessage('Notebook: PDF export works on Markdown (.md) files.');
    return;
  }

  const cfg = vscode.workspace.getConfiguration();
  const pandocPath = cfg.get<string>('pandocToMarkdown.pandocPath', 'pandoc');

  // Confirm pandoc is available.
  try {
    await run(pandocPath, ['--version'], undefined, 15000);
  } catch {
    vscode.window.showErrorMessage(
      'Pandoc could not be run. Install it, or set "pandocToMarkdown.pandocPath" to its full path.',
    );
    return;
  }

  // Ask where to save, defaulting next to the source.
  const defaultPdf = vscode.Uri.file(srcUri.fsPath.replace(/\.md$/i, '.pdf'));
  const dest = await vscode.window.showSaveDialog({
    defaultUri: defaultPdf,
    filters: { PDF: ['pdf'], HTML: ['html'] },
    saveLabel: 'Export',
  });
  if (!dest) {
    return;
  }
  const asHtml = dest.fsPath.toLowerCase().endsWith('.html');

  let success = false;
  let mermaidNote: string | undefined;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Exporting ${path.basename(srcUri.fsPath)}` },
    async (progress) => {
      try {
        const raw = await fsp.readFile(srcUri.fsPath, 'utf8');

        let markdown = raw;
        const engine = cfg.get<string>('markdownNotebook.pdfEngine', 'chrome');

        // Only pre-render Mermaid diagrams using mermaid-cli when NOT exporting with Chrome,
        // since Chrome/Puppeteer parses and renders diagrams natively in the browser!
        if (!asHtml && engine !== 'chrome') {
          progress.report({ message: 'rendering diagrams…' });
          const rendered = await prerenderMermaid(raw, srcUri.fsPath, cfg);
          markdown = rendered.markdown;
          mermaidNote = rendered.mermaidNote;
        }

        progress.report({ message: asHtml ? 'writing HTML…' : 'building PDF…' });
        const css = await loadThemeCss(context, cfg);

        if (asHtml) {
          await pandocToHtml(pandocPath, markdown, srcUri.fsPath, dest.fsPath, css);
        } else {
          if (engine === 'chrome') {
            await chromeToPdf(pandocPath, markdown, srcUri.fsPath, dest.fsPath, css, context);
          } else {
            await pandocToPdf(pandocPath, markdown, srcUri.fsPath, dest.fsPath, css, cfg);
          }
        }
        success = true;
      } catch (err) {
        handleExportError(err);
      }
    },
  );

  if (success) {
    const open = await vscode.window.showInformationMessage(
      `Exported ${path.basename(dest.fsPath)}.${mermaidNote ? ' ' + mermaidNote : ''}`,
      'Reveal',
    );
    if (open === 'Reveal') {
      vscode.commands.executeCommand('revealFileInOS', dest);
    }
  }
}

function resolveSource(node: NodeLike | undefined): vscode.Uri | undefined {
  if (node?.resourceUri) {
    return node.resourceUri;
  }
  if (node?.fsPath) {
    return vscode.Uri.file(node.fsPath);
  }
  const active = vscode.window.activeTextEditor?.document;
  if (active && active.languageId === 'markdown') {
    return active.uri;
  }
  return undefined;
}

/**
 * Pre-render ```mermaid blocks to inline SVG using mermaid-cli (mmdc) when it's
 * available, so diagrams appear in the PDF. Without mmdc we leave the diagram as
 * a fenced code block and return a note explaining how to enable rendering.
 */
async function prerenderMermaid(
  markdown: string,
  srcPath: string,
  cfg: vscode.WorkspaceConfiguration,
): Promise<{ markdown: string; mermaidNote?: string }> {
  const fence = /^[ \t]*```+[ \t]*mermaid[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```+[ \t]*$/gim;
  if (!fence.test(markdown)) {
    return { markdown };
  }
  fence.lastIndex = 0;

  const mmdc = cfg.get<string>('markdownNotebook.mermaidCliPath', 'mmdc') || 'mmdc';
  let haveMmdc = false;
  try {
    await run(mmdc, ['--version'], undefined, 15000);
    haveMmdc = true;
  } catch {
    haveMmdc = false;
  }

  if (!haveMmdc) {
    return {
      markdown,
      mermaidNote: 'Mermaid diagrams were left as code (install mermaid-cli `npm i -g @mermaid-js/mermaid-cli` for rendered diagrams).',
    };
  }

  const tmpDir = await fsp.mkdtemp(path.join(require('os').tmpdir(), 'nb-mermaid-'));
  let index = 0;
  const dark = (cfg.get<string>('markdownNotebook.previewTheme', 'github') || '').includes('dark');
  const replacements: Array<{ match: string; svg: string }> = [];

  let m: RegExpExecArray | null;
  while ((m = fence.exec(markdown)) !== null) {
    const code = m[1];
    const inFile = path.join(tmpDir, `d${index}.mmd`);
    const outFile = path.join(tmpDir, `d${index}.svg`);
    index++;
    try {
      await fsp.writeFile(inFile, code, 'utf8');
      await run(mmdc, ['-i', inFile, '-o', outFile, '-t', dark ? 'dark' : 'default', '-b', 'transparent'], tmpDir, 60000);
      const svg = await fsp.readFile(outFile, 'utf8');
      replacements.push({ match: m[0], svg });
    } catch {
      /* leave this one as code */
    }
  }

  let out = markdown;
  for (const r of replacements) {
    // Inline SVG via raw HTML block so pandoc passes it through.
    out = out.replace(r.match, `\n<div class="mermaid-svg">\n${r.svg}\n</div>\n`);
  }
  try {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
  return { markdown: out };
}

async function loadThemeCss(
  context: vscode.ExtensionContext,
  cfg: vscode.WorkspaceConfiguration,
): Promise<string> {
  const cssPath = path.join(context.extensionPath, 'media', 'github-markdown.css');
  let css = '';
  try {
    css = await fsp.readFile(cssPath, 'utf8');
  } catch {
    /* fall through to body class only */
  }
  // The CSS is scoped to body.notebook-github-theme; for export we force that
  // class and pick light/dark per the setting.
  const theme = cfg.get<string>('markdownNotebook.exportTheme', 'github');
  const forceDark = theme.includes('dark');
  const bodyClass = forceDark ? 'vscode-dark notebook-github-theme' : 'notebook-github-theme';
  return `<style>\n${css}\n.mermaid-svg{text-align:center;margin:12px 0;}\n.mermaid-svg svg{max-width:100%;height:auto;}\na[href$=".toc.md"], a[href$=".dashboard.md"] { display: none !important; }\n.mermaid { display: flex; justify-content: center; margin: 12px 0; }\n.mermaid svg { max-width: 100%; height: auto !important; }\n@media print {\n  @page {\n    margin: 0;\n  }\n  body {\n    padding: 20mm;\n    -webkit-print-color-adjust: exact !important;\n    print-color-adjust: exact !important;\n  }\n}\n</style>\n<script>document.addEventListener('DOMContentLoaded', () => { document.body.className='${bodyClass}'; });</script>`;
}

async function pandocToHtml(
  pandocPath: string,
  markdown: string,
  srcPath: string,
  outPath: string,
  headerHtml: string,
): Promise<void> {
  const variant = vscode.workspace.getConfiguration().get<string>('pandocToMarkdown.markdownVariant', 'gfm');
  const headerFile = path.join(require('os').tmpdir(), `nb-head-${Date.now()}.html`);
  await fsp.writeFile(headerFile, headerHtml, 'utf8');
  try {
    await run(
      pandocPath,
      [
        '-f', `${variant}+raw_html`,
        '-t', 'html5',
        '--standalone',
        '--embed-resources',
        '-H', headerFile,
        '--metadata', `title=${path.basename(srcPath, '.md')}`,
        '-o', outPath,
      ],
      path.dirname(srcPath),
      120000,
      markdown,
    );
  } finally {
    try {
      await fsp.rm(headerFile, { force: true });
    } catch {
      /* ignore */
    }
  }
}

async function pandocToPdf(
  pandocPath: string,
  markdown: string,
  srcPath: string,
  outPath: string,
  headerHtml: string,
  cfg: vscode.WorkspaceConfiguration,
): Promise<void> {
  const variant = cfg.get<string>('pandocToMarkdown.markdownVariant', 'gfm');
  const engine = cfg.get<string>('markdownNotebook.pdfEngine', 'auto');
  const headerFile = path.join(require('os').tmpdir(), `nb-head-${Date.now()}.html`);
  await fsp.writeFile(headerFile, headerHtml, 'utf8');

  const engines = engine === 'auto' ? ['weasyprint', 'wkhtmltopdf', 'prince'] : [engine];
  let lastErr: unknown;

  try {
    for (const eng of engines) {
      try {
        await run(
          pandocPath,
          [
            '-f', `${variant}+raw_html`,
            `--pdf-engine=${eng}`,
            '--standalone',
            '-H', headerFile,
            '--metadata', `title=${path.basename(srcPath, '.md')}`,
            '-o', outPath,
          ],
          path.dirname(srcPath),
          180000,
          markdown,
        );
        return; // success
      } catch (err) {
        lastErr = err;
        // If the engine simply isn't installed, try the next; otherwise rethrow.
        if (!isMissingEngine(err)) {
          throw err;
        }
      }
    }
    // No HTML-based engine found.
    const e = new Error('no-html-pdf-engine');
    (e as any).enginesTried = engines;
    (e as any).lastErr = lastErr;
    throw e;
  } finally {
    try {
      await fsp.rm(headerFile, { force: true });
    } catch {
      /* ignore */
    }
  }
}

function isMissingEngine(err: unknown): boolean {
  const s = `${(err as { stderr?: string })?.stderr ?? ''} ${(err as Error)?.message ?? ''}`.toLowerCase();
  return (
    s.includes('not found') ||
    s.includes('could not find') ||
    s.includes('enoent') ||
    s.includes('no such file') ||
    s.includes('pdflatex') || // pandoc complaining about a default latex engine
    s.includes('xelatex')
  );
}

function handleExportError(err: unknown): void {
  const errMsg = (err as Error)?.message || '';
  if (errMsg.includes('Local Chrome/Chromium installation not found') || errMsg.includes('download was cancelled')) {
    vscode.window.showErrorMessage(`Notebook: export failed. ${errMsg}`);
    return;
  }
  if ((err as Error)?.message === 'no-html-pdf-engine') {
    vscode.window
      .showErrorMessage(
        'No lightweight PDF engine found. Install WeasyPrint (`pip install weasyprint`) or wkhtmltopdf, or export to HTML instead.',
        'How to install',
        'Export HTML instead',
      )
      .then((pick) => {
        if (pick === 'How to install') {
          vscode.env.openExternal(vscode.Uri.parse('https://weasyprint.org/'));
        } else if (pick === 'Export HTML instead') {
          vscode.commands.executeCommand('markdownNotebook.exportPdf');
        }
      });
    return;
  }
  const msg = (err as { stderr?: string })?.stderr?.trim() || (err as Error)?.message || String(err);
  vscode.window.showErrorMessage(`Notebook: export failed. ${msg.split('\n').slice(0, 3).join(' ')}`);
}

async function getChromePath(context: vscode.ExtensionContext): Promise<string> {
  const fs = require('fs');
  const browsers = await import('@puppeteer/browsers');
  const platform = browsers.detectBrowserPlatform();
  if (!platform) {
    throw new Error('Unsupported platform for Chrome detection');
  }

  // 1. Try to find system Google Chrome
  try {
    const computed = browsers.computeSystemExecutablePath({
      browser: browsers.Browser.CHROME,
      platform: platform,
      channel: browsers.ChromeReleaseChannel.STABLE,
    });
    if (computed && fs.existsSync(computed)) {
      return computed;
    }
  } catch {
    // continue
  }

  // 2. Try to find system Chromium
  try {
    const computed = browsers.computeSystemExecutablePath({
      browser: browsers.Browser.CHROMIUM,
      platform: platform,
      channel: browsers.ChromeReleaseChannel.STABLE,
    });
    if (computed && fs.existsSync(computed)) {
      return computed;
    }
  } catch {
    // continue
  }

  // 3. Check if we already have a downloaded Chrome in persistent cache
  const cacheDir = path.join(context.globalStorageUri.fsPath, '.browser-cache');
  const buildId = '120.0.6099.109'; // A reliable, specific Chrome stable build ID
  const cachedPath = browsers.computeExecutablePath({
    cacheDir: cacheDir,
    browser: browsers.Browser.CHROME,
    buildId: buildId,
    platform: platform,
  });

  if (cachedPath && fs.existsSync(cachedPath)) {
    return cachedPath;
  }

  // 4. Prompt to download ChromeStable/Chromium if none found
  const answer = await vscode.window.showInformationMessage(
    'No local Google Chrome or Chromium installation was found. Would you like to download a lightweight Chromium instance for PDF exports? (Requires ~150MB download)',
    'Download',
    'Cancel'
  );

  if (answer !== 'Download') {
    throw new Error('Local Chrome/Chromium installation not found, and download was cancelled.');
  }

  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Downloading Chromium for PDF export',
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: 'starting download (this may take a minute)...' });
      const installed = await browsers.install({
        browser: browsers.Browser.CHROME,
        buildId: buildId,
        cacheDir: cacheDir,
        platform: platform,
      });
      progress.report({ message: 'completed!' });
      return installed.executablePath;
    }
  );
}

async function chromeToPdf(
  pandocPath: string,
  markdown: string,
  srcPath: string,
  outPath: string,
  css: string,
  context: vscode.ExtensionContext,
): Promise<void> {
  const tempHtmlPath = path.join(require('os').tmpdir(), `nb-export-${Date.now()}.html`);
  
  // 1. Compile Markdown to a temporary standalone HTML file using Pandoc
  await pandocToHtml(pandocPath, markdown, srcPath, tempHtmlPath, css);

  // Read the actual exportTheme configuration setting directly to evaluate forceDark
  const exportTheme = vscode.workspace.getConfiguration().get<string>('markdownNotebook.exportTheme', 'github');
  const forceDark = exportTheme.includes('dark');

  let browser: any;
  try {
    // 2. Resolve or download Chrome
    const chromePath = await getChromePath(context);

    // 3. Launch Puppeteer
    const puppeteer = (await import('puppeteer-core')).default;
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.goto(vscode.Uri.file(tempHtmlPath).toString(), { waitUntil: 'networkidle0' });

    // Explicitly add body classes in Puppeteer to ensure style rules are immediately applied
    await page.evaluate((isDark: any) => {
      const doc = (globalThis as any).document;
      doc.body.classList.add('notebook-github-theme');
      if (isDark) {
        doc.body.classList.add('vscode-dark');
      } else {
        doc.body.classList.remove('vscode-dark');
      }
    }, forceDark);

    // 4. Inject and render Mermaid if there are any mermaid blocks in the DOM
    const hasMermaid = await page.evaluate(() => {
      const doc = (globalThis as any).document;
      return !!doc.querySelector('pre.mermaid, pre.language-mermaid, pre.notebook-mermaid, code.language-mermaid');
    });

    if (hasMermaid) {
      // Inject local mermaid.min.js
      const mermaidScriptPath = path.join(context.extensionPath, 'media', 'mermaid.min.js');
      await page.addScriptTag({ path: mermaidScriptPath });

      // Initialize and render all Mermaid diagrams dynamically
      await page.evaluate(async (isDark: any) => {
        const doc = (globalThis as any).document;
        const win = globalThis as any;
        const blocks = doc.querySelectorAll('pre.mermaid, pre.language-mermaid, pre.notebook-mermaid, code.language-mermaid');
        for (const block of Array.from(blocks) as any[]) {
          let code = block.textContent || '';
          let target = block;
          if (block.tagName.toLowerCase() === 'code') {
            target = block.parentElement || block;
          }
          target.className = 'mermaid';
          target.textContent = code;
        }
        win.mermaid.initialize({
          startOnLoad: false,
          theme: isDark ? 'dark' : 'default',
          securityLevel: 'loose',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        });
        await win.mermaid.run();
        
        // Fix whitespace: ensure SVGs use viewBox instead of fixed width/height
        const svgs = doc.querySelectorAll('.mermaid svg');
        for (const svg of Array.from(svgs) as any[]) {
          svg.removeAttribute('width');
          // Important: remove the height attribute because mermaid often sets it way too large 
          // or causes scrolling/blank pages in print media.
          svg.removeAttribute('height');
        }
      }, forceDark);
    }

    // 5. Generate high-fidelity PDF using A4 print margins handled via CSS padding
    await page.pdf({
      path: outPath,
      format: 'A4',
      printBackground: true,
      margin: {
        top: '0px',
        bottom: '0px',
        left: '0px',
        right: '0px',
      }
    });

  } finally {
    // 6. Safe cleanup of browser and temporary files
    if (browser) {
      await browser.close();
    }
    try {
      await fsp.rm(tempHtmlPath, { force: true });
    } catch {
      // ignore
    }
  }
}

function run(
  cmd: string,
  args: string[],
  cwd: string | undefined,
  timeout: number,
  stdin?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { cwd, timeout, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          (err as { stderr?: string }).stderr = stderr;
          reject(err);
        } else {
          resolve(stdout);
        }
      },
    );
    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    }
  });
}
