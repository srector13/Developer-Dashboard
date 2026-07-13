import { app, BrowserWindow, ipcMain, dialog, shell, globalShortcut, Menu, MenuItemConstructorOptions } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const fsp = fs.promises;

let mainWindow: BrowserWindow | null = null;

// Portable mode: keep ALL app state (settings, window state, caches) next to
// the executable instead of %APPDATA%/~Library. Active when either
//  - running the electron-builder `portable` target (it sets
//    PORTABLE_EXECUTABLE_DIR to the folder holding the .exe), or
//  - a `MarkdownNotebookData` folder exists beside the executable (opt-in
//    for the zip distribution: create the folder once and the app is
//    self-contained from then on).
// Must run before anything derives a path from `userData`.
function resolvePortableUserData(): string | null {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableDir) return path.join(portableDir, 'MarkdownNotebookData');
  try {
    const sidecar = path.join(path.dirname(process.execPath), 'MarkdownNotebookData');
    if (fs.existsSync(sidecar)) return sidecar;
  } catch { /* sandboxed/odd execPath: fall through to the default */ }
  return null;
}
const portableUserData = resolvePortableUserData();
if (portableUserData) {
  try { fs.mkdirSync(portableUserData, { recursive: true }); } catch { /* fs errors surface on first write */ }
  app.setPath('userData', portableUserData);
}

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const ORDER_FILE = '.notebook-order';

type ThemeName = 'system' | 'light' | 'dark' | 'midnight' | 'forest' | 'sepia';

interface PdfExportOptions {
  theme: 'light' | 'dark' | 'minimal';
  pageSize: 'A4' | 'Letter' | 'Legal';
  openAfter: boolean;
  reveal: boolean;
}

interface AppSettings {
  notebookRoot: string;
  defaultPageWidth: 'standard' | 'wide' | 'full';
  defaultMermaidZoom: number;
  /** Legacy pre-theme-system field; migrated into `theme` on read. */
  previewTheme?: 'github' | 'github-dark' | 'off';
  theme: ThemeName;
  ignoreFolders: string[];
  templatesFolder: string;
  attachmentsFolder: string;
  author: string;
  scratchpadFile: string;
  autoSaveEnabled: boolean;
  pandocPath?: string;
  pdfExport: PdfExportOptions;
  /** Global (system-wide) quick-capture shortcut; empty string disables it. */
  quickCaptureShortcut: string;
}

const defaultSettings: AppSettings = {
  notebookRoot: '',
  defaultPageWidth: 'standard',
  defaultMermaidZoom: 100,
  theme: 'system',
  ignoreFolders: ['_media', 'attachments', 'templates', 'node_modules', '.git', '.vscode'],
  templatesFolder: 'templates',
  attachmentsFolder: 'attachments',
  author: '',
  scratchpadFile: 'scratchpad.md',
  autoSaveEnabled: false,
  pdfExport: { theme: 'light', pageSize: 'A4', openAfter: true, reveal: false },
  quickCaptureShortcut: 'CommandOrControl+Shift+N',
};

// Migrate settings written by older versions to the current shape
function migrateSettings(raw: Partial<AppSettings>): AppSettings {
  const merged: AppSettings = { ...defaultSettings, ...raw, pdfExport: { ...defaultSettings.pdfExport, ...(raw.pdfExport || {}) } };
  if (!raw.theme && raw.previewTheme) {
    merged.theme = raw.previewTheme === 'github-dark' ? 'dark' : raw.previewTheme === 'off' ? 'light' : 'system';
  }
  // The attachments folder must stay out of the notebook tree (same coupling
  // rule as the templates folder).
  if (merged.attachmentsFolder &&
      !merged.ignoreFolders.some(f => f.toLowerCase() === merged.attachmentsFolder.toLowerCase())) {
    merged.ignoreFolders = [...merged.ignoreFolders, merged.attachmentsFolder];
  }
  return merged;
}

// Config manager helpers. Settings are cached in memory: they're read on
// nearly every IPC call, and the disk copy only changes through writeSettings.
let settingsCache: AppSettings | null = null;

async function readSettings(): Promise<AppSettings> {
  if (settingsCache) return settingsCache;
  try {
    const data = await fsp.readFile(SETTINGS_FILE, 'utf8');
    settingsCache = migrateSettings(JSON.parse(data));
  } catch {
    settingsCache = { ...defaultSettings };
  }
  return settingsCache;
}

async function writeSettings(settings: Partial<AppSettings>): Promise<AppSettings> {
  const current = await readSettings();
  const updated = migrateSettings({ ...current, ...settings });
  await fsp.writeFile(SETTINGS_FILE, JSON.stringify(updated, null, 2), 'utf8');
  settingsCache = updated;
  return updated;
}

// Right-click menu with spelling corrections. Chromium's spell checker
// draws the red squiggles on its own, but its suggestions are only exposed
// through the context-menu event — without this handler there is no way to
// actually fix a flagged word.
function wireSpellcheckMenu(win: BrowserWindow) {
  win.webContents.on('context-menu', (event, params) => {
    const items: MenuItemConstructorOptions[] = [];

    if (params.misspelledWord) {
      const suggestions = (params.dictionarySuggestions || []).slice(0, 6);
      if (suggestions.length) {
        for (const suggestion of suggestions) {
          items.push({
            label: suggestion,
            click: () => win.webContents.replaceMisspelling(suggestion),
          });
        }
      } else {
        items.push({ label: 'No spelling suggestions', enabled: false });
      }
      items.push({ type: 'separator' });
      items.push({
        label: `Add "${params.misspelledWord}" to Dictionary`,
        click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      });
      items.push({ type: 'separator' });
    }

    // Standard edit actions so the menu is useful on any right-click
    if (params.isEditable) {
      items.push(
        { role: 'cut', enabled: params.selectionText.length > 0 },
        { role: 'copy', enabled: params.selectionText.length > 0 },
        { role: 'paste' },
        { type: 'separator' },
        { role: 'selectAll' },
      );
    } else if (params.selectionText) {
      items.push({ role: 'copy' });
    }

    if (items.length) {
      Menu.buildFromTemplate(items).popup({ window: win });
    }
  });
}

// Window manager
function createWindow() {
  const iconPath = path.join(__dirname, '../build/icon.png');
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 12, y: 20 },
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  wireSpellcheckMenu(mainWindow);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  updateWatcher();
}

// Notify the renderer that notebook files changed. Debounced: the renderer
// responds with a full notebook rescan, and a single save produces several
// watcher events (plus an explicit send from the write handler), so without
// coalescing one save costs 3+ full-notebook re-reads.
let filesChangedTimer: NodeJS.Timeout | null = null;
function notifyFilesChanged() {
  if (filesChangedTimer) clearTimeout(filesChangedTimer);
  filesChangedTimer = setTimeout(() => {
    filesChangedTimer = null;
    if (mainWindow) {
      mainWindow.webContents.send('files-changed');
    }
  }, 300);
}

// Watch for folder changes to emit update events automatically
let watcher: fs.FSWatcher | null = null;
async function updateWatcher() {
  const settings = await readSettings();
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (settings.notebookRoot && fs.existsSync(settings.notebookRoot)) {
    const ignoreSegments = new Set(settings.ignoreFolders.map(s => s.toLowerCase()));
    try {
      watcher = fs.watch(settings.notebookRoot, { recursive: true }, (event, filename) => {
        if (filename && (filename.startsWith('.') || filename.includes('node_modules') || filename.includes('.notebook-order'))) {
          return;
        }
        // Ignored folders (attachments, templates, _media, ...) don't appear
        // in the tree, so churn inside them shouldn't trigger rescans.
        if (filename) {
          const firstSegment = filename.split(/[\\/]/)[0].toLowerCase();
          if (ignoreSegments.has(firstSegment)) return;
        }
        notifyFilesChanged();
      });
    } catch (err) {
      console.error('Failed to start fs watcher:', err);
    }
  }
}

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return '';
  }
  const pathChosen = result.filePaths[0];
  await writeSettings({ notebookRoot: pathChosen });
  await updateWatcher();
  return pathChosen;
});


app.whenReady().then(async () => {
  createWindow();

  // Register after the renderer loads so a registration failure (shortcut
  // taken by another app) can surface as a toast instead of vanishing.
  const settings = await readSettings();
  if (mainWindow) {
    mainWindow.webContents.once('did-finish-load', () => {
      registerQuickCaptureShortcut(settings.quickCaptureShortcut);
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Helper: YAML frontmatter list parsing
function parseInlineList(val: string): string[] {
  const clean = val.trim();
  if (clean.startsWith('[') && clean.endsWith(']')) {
    return clean.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(s => s);
  }
  return [clean];
}

function parseBlockList(lines: string[], startIdx: number): string[] {
  const list: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*- /.test(l)) {
      list.push(l.replace(/^\s*-\s*/, '').trim().replace(/^['"]|['"]$/g, ''));
    } else if (l.trim() === '' || /^\S+/.test(l)) {
      break;
    }
  }
  return list;
}

// Helper: clean dashes/underscores from display titles
function cleanDisplayName(raw: string): string {
  let name = raw.replace(/[-_]/g, ' ').trim();
  return name.split(/\s+/).map(word => {
    if (!word) return '';
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join(' ');
}

// Helper: parse title and tags from markdown frontmatter
function parseNoteMeta(content: string, filePath: string) {
  const meta = {
    title: cleanDisplayName(path.basename(filePath, '.md')),
    created: '',
    tags: [] as string[],
    pinned: false,
    openTasks: 0,
    completedTasks: 0,
    // Open-task lines are collected here, during the scan that already reads
    // every file, so landing pages never need to re-read notes for them.
    taskLines: [] as Array<{ text: string; line: number }>,
  };

  // Scan tasks
  const openTaskRegex = /^([ \t]*([-*+]\s+|\d+\.\s+)?)\[ \]/i;
  const lines = content.split(/\r?\n/);
  lines.forEach((l, index) => {
    if (openTaskRegex.test(l)) {
      meta.openTasks++;
      meta.taskLines.push({ text: l.replace(openTaskRegex, '').trim(), line: index });
    } else if (/^([ \t]*([-*+]\s+|\d+\.\s+)?)\[x\]/i.test(l)) {
      meta.completedTasks++;
    }
  });

  // Parse YAML Frontmatter
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?=[ \t]*(?:\r?\n|$))/);
  if (fmMatch) {
    const fmLines = fmMatch[1].split('\n');
    fmLines.forEach((line, index) => {
      const parts = line.split(':');
      if (parts.length >= 2) {
        const key = parts[0].trim().toLowerCase();
        const val = parts.slice(1).join(':').trim();
        if (key === 'title') {
          meta.title = cleanDisplayName(val.replace(/^['"]|['"]$/g, '').trim());
        } else if (key === 'created') {
          meta.created = val.replace(/^['"]|['"]$/g, '').trim();
        } else if (key === 'pinned') {
          meta.pinned = val.toLowerCase() === 'true';
        } else if (key === 'tags') {
          meta.tags = val ? parseInlineList(val) : parseBlockList(fmLines, index + 1);
        }
      }
    });
  }

  return meta;
}

// Helpers for manual order file
async function readOrderFile(dir: string): Promise<string[]> {
  try {
    const data = await fsp.readFile(path.join(dir, ORDER_FILE), 'utf8');
    return data.split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0);
  } catch {
    return [];
  }
}

async function writeOrderFile(dir: string, list: string[]): Promise<void> {
  const filepath = path.join(dir, ORDER_FILE);
  if (list.length === 0) {
    try {
      await fsp.unlink(filepath);
    } catch {}
    return;
  }
  await fsp.writeFile(filepath, list.join('\n') + '\n', 'utf8');
}

// Scan directories and order files
interface PageNode {
  kind: 'page';
  name: string;
  fsPath: string;
  relPath: string;
  title: string;
  created: string;
  tags: string[];
  pinned: boolean;
  openTasks: number;
  completedTasks: number;
  taskLines: Array<{ text: string; line: number }>;
  dailyKey?: string;
}

interface SectionNode {
  kind: 'section';
  name: string;
  fsPath: string;
  relPath: string;
  pages: PageNode[];
  sections: SectionNode[];
}

function parseDailyKey(filename: string): string | undefined {
  const m = filename.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : undefined;
}

// Full-text search index. Built as a side effect of the tree scan (which
// already reads every note) and swapped atomically per get-notebook-tree, so
// it is exactly as fresh as the sidebar and costs zero extra file reads.
interface SearchDoc {
  fsPath: string;
  relPath: string;
  title: string;
  lines: string[];
}
let searchIndex: Map<string, SearchDoc> = new Map();
const SEARCH_MAX_INDEXED_FILE = 1_000_000; // bytes; skip pathological files

// Scan cache: parsed metadata + search doc keyed on (mtime, size), so steady-
// state rescans only re-read files that actually changed. The searchIndex
// holds references to the SAME SearchDoc objects — note text lives once.
interface ScanCacheEntry {
  mtimeMs: number;
  size: number;
  meta: ReturnType<typeof parseNoteMeta>;
  doc: SearchDoc | null; // null when the file exceeds SEARCH_MAX_INDEXED_FILE
}
const scanCache = new Map<string, ScanCacheEntry>();
const SCAN_CACHE_MAX = 5000;
// Files modified in the last 2s are always re-read: sub-second mtime
// granularity on some filesystems plus the app's own write→rescan races.
const SCAN_CACHE_FRESHNESS_MS = 2000;

async function scanDirectory(
  dir: string,
  rootDir: string,
  ignore: Set<string>,
  scratchpadFile: string,
  shallow = false, // skip subdirectory recursion (move-node only needs one dir)
  collector?: Map<string, SearchDoc>, // populated only by get-notebook-tree
  seen?: Set<string>, // every .md path encountered; full scans prune the cache against it
): Promise<SectionNode> {
  const relative = path.relative(rootDir, dir).replace(/\\/g, '/');
  const sectionNode: SectionNode = {
    kind: 'section',
    name: cleanDisplayName(path.basename(dir) || 'Root'),
    fsPath: dir,
    relPath: relative,
    pages: [],
    sections: [],
  };

  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const entryNameLower = entry.name.toLowerCase();

    if (entry.name.startsWith('.') || ignore.has(entryNameLower)) {
      continue;
    }

    if (entry.isDirectory()) {
      if (!shallow) {
        const childSec = await scanDirectory(fullPath, rootDir, ignore, scratchpadFile, false, collector, seen);
        sectionNode.sections.push(childSec);
      }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      // Skip scratchpad.md if it is in the section root
      if (entry.name === scratchpadFile && relative === '') {
        continue;
      }
      try {
        if (seen) seen.add(fullPath);

        // Serve unchanged files from the scan cache — no read, no parse
        const st = await fsp.stat(fullPath);
        const cached = scanCache.get(fullPath);
        let meta: ReturnType<typeof parseNoteMeta>;
        let doc: SearchDoc | null;

        if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size &&
            Date.now() - st.mtimeMs > SCAN_CACHE_FRESHNESS_MS) {
          meta = cached.meta;
          doc = cached.doc;
        } else {
          const text = await fsp.readFile(fullPath, 'utf8');
          meta = parseNoteMeta(text, fullPath);
          doc = text.length <= SEARCH_MAX_INDEXED_FILE
            ? {
                fsPath: fullPath,
                relPath: path.relative(rootDir, fullPath).replace(/\\/g, '/'),
                title: meta.title,
                lines: text.split(/\r?\n/),
              }
            : null;
          scanCache.set(fullPath, { mtimeMs: st.mtimeMs, size: st.size, meta, doc });
        }

        if (collector && doc) {
          collector.set(fullPath, doc);
        }
        sectionNode.pages.push({
          kind: 'page',
          name: entry.name,
          fsPath: fullPath,
          relPath: path.relative(rootDir, fullPath).replace(/\\/g, '/'),
          title: meta.title,
          created: meta.created,
          tags: meta.tags,
          pinned: meta.pinned,
          openTasks: meta.openTasks,
          completedTasks: meta.completedTasks,
          taskLines: meta.taskLines,
          dailyKey: parseDailyKey(entry.name),
        });
      } catch (err) {
        console.error(`Error reading page ${entry.name}:`, err);
      }
    }
  }

  // Sort sections alphabetically
  sectionNode.sections.sort((a, b) => a.name.localeCompare(b.name));

  // Sort pages by ordering file or fallback sort
  const orderList = await readOrderFile(dir);
  const orderedPages: PageNode[] = [];
  const unlistedPages: PageNode[] = [];

  const orderMap = new Map<string, number>();
  orderList.forEach((n, i) => orderMap.set(n.toLowerCase(), i));

  for (const page of sectionNode.pages) {
    if (orderMap.has(page.name.toLowerCase())) {
      orderedPages.push(page);
    } else {
      unlistedPages.push(page);
    }
  }

  orderedPages.sort((a, b) => (orderMap.get(a.name.toLowerCase()) ?? 0) - (orderMap.get(b.name.toLowerCase()) ?? 0));

  // Default page sorter: Daily notes (newest first), then alphabetical
  const sortPagesDefault = (pages: PageNode[]) => {
    const daily = pages.filter(p => p.dailyKey);
    const regular = pages.filter(p => !p.dailyKey);
    daily.sort((a, b) => (b.dailyKey ?? '').localeCompare(a.dailyKey ?? ''));
    regular.sort((a, b) => a.title.localeCompare(b.title));
    return [...daily, ...regular];
  };

  const unlistedDaily = unlistedPages.filter(p => p.dailyKey);
  const unlistedRegular = unlistedPages.filter(p => !p.dailyKey);

  sectionNode.pages = [
    ...sortPagesDefault(unlistedDaily),
    ...orderedPages,
    ...sortPagesDefault(unlistedRegular),
  ];

  return sectionNode;
}

// IPC Operations API Setup
ipcMain.handle('get-settings', () => readSettings());
ipcMain.handle('save-settings', async (event, settings) => {
  const before = await readSettings();
  const updated = await writeSettings(settings);
  // Re-arm the watcher when anything it depends on changed (it used to be
  // re-armed only by select-folder, so ignoreFolders edits never applied)
  if (updated.notebookRoot !== before.notebookRoot ||
      JSON.stringify(updated.ignoreFolders) !== JSON.stringify(before.ignoreFolders)) {
    await updateWatcher();
  }
  if (updated.quickCaptureShortcut !== before.quickCaptureShortcut) {
    registerQuickCaptureShortcut(updated.quickCaptureShortcut);
  }
  return updated;
});

ipcMain.handle('get-notebook-tree', async (event, rootPath, filterTag) => {
  if (!rootPath || !fs.existsSync(rootPath)) return null;
  const settings = await readSettings();
  const ignore = new Set(settings.ignoreFolders.map(s => s.toLowerCase()));
  const collector = new Map<string, SearchDoc>();
  const seen = new Set<string>();
  const rootNode = await scanDirectory(rootPath, rootPath, ignore, settings.scratchpadFile, false, collector, seen);
  searchIndex = collector; // atomic swap: deleted files vanish from search

  // Prune cache entries for files that no longer exist (full scans only)
  for (const key of scanCache.keys()) {
    if (!seen.has(key)) scanCache.delete(key);
  }
  if (scanCache.size > SCAN_CACHE_MAX) {
    scanCache.clear(); // belt-and-braces bound; next scan rebuilds
  }

  // Apply Tag Filtering recursively if filterTag is present
  if (filterTag) {
    const tagLower = filterTag.toLowerCase();
    const filterSection = (sec: SectionNode): boolean => {
      // Keep pages with match
      sec.pages = sec.pages.filter(p => p.tags.map(t => t.toLowerCase()).includes(tagLower));
      // Keep child sections that have matching pages/subpages
      sec.sections = sec.sections.filter(s => filterSection(s));
      return sec.pages.length > 0 || sec.sections.length > 0;
    };
    filterSection(rootNode);
  }

  return rootNode;
});

ipcMain.handle('read-note', async (event, filePath) => {
  return await fsp.readFile(filePath, 'utf8');
});

// ==========================================
// NOTE HISTORY (bounded save snapshots under <root>/.history/)
// ==========================================

const HISTORY_MAX_SNAPSHOTS = 20;
const HISTORY_MIN_INTERVAL_MS = 5 * 60 * 1000;

interface HistoryIndex {
  relPath: string;
  entries: Array<{ id: string; savedAt: string; size: number }>;
}

function historyDirFor(root: string, filePath: string): string {
  const rel = path.relative(root, filePath).replace(/\\/g, '/');
  const hash = crypto.createHash('sha1').update(rel).digest('hex').slice(0, 12);
  return path.join(root, '.history', hash);
}

async function readHistoryIndex(dir: string, relPath: string): Promise<HistoryIndex> {
  try {
    const data = JSON.parse(await fsp.readFile(path.join(dir, 'index.json'), 'utf8'));
    if (Array.isArray(data.entries)) return { relPath: data.relPath || relPath, entries: data.entries };
  } catch {}
  return { relPath, entries: [] };
}

async function writeHistoryIndex(dir: string, index: HistoryIndex): Promise<void> {
  await fsp.writeFile(path.join(dir, 'index.json'), JSON.stringify(index, null, 2), 'utf8');
}

// Snapshot `content` (the note's PREVIOUS state) for filePath. Rate-limited
// unless force is set (used by restore, which must always be undoable).
async function snapshotNote(root: string, filePath: string, content: string, force = false): Promise<void> {
  const rel = path.relative(root, filePath).replace(/\\/g, '/');
  const dir = historyDirFor(root, filePath);
  await fsp.mkdir(dir, { recursive: true });
  const index = await readHistoryIndex(dir, rel);

  if (!force && index.entries.length > 0) {
    const newest = Date.parse(index.entries[0].savedAt);
    if (!isNaN(newest) && Date.now() - newest < HISTORY_MIN_INTERVAL_MS) return;
  }

  const savedAt = new Date().toISOString();
  const id = savedAt.replace(/[:.]/g, '-');
  await fsp.writeFile(path.join(dir, `${id}.md`), content, 'utf8');
  index.relPath = rel;
  index.entries.unshift({ id, savedAt, size: Buffer.byteLength(content, 'utf8') });

  // Prune oldest beyond the cap
  while (index.entries.length > HISTORY_MAX_SNAPSHOTS) {
    const dropped = index.entries.pop()!;
    await fsp.unlink(path.join(dir, `${dropped.id}.md`)).catch(() => {});
  }
  await writeHistoryIndex(dir, index);
}

// Shared write path: snapshots the previous on-disk content when it changed
// materially. History lives under dot-prefixed .history/, so these writes
// never wake the watcher.
async function writeNoteFile(filePath: string, content: string, opts: { snapshot?: boolean; forceSnapshot?: boolean } = {}): Promise<void> {
  if (opts.snapshot) {
    try {
      const settings = await readSettings();
      const root = settings.notebookRoot;
      if (root && !path.relative(root, filePath).startsWith('..')) {
        const prev = await fsp.readFile(filePath, 'utf8').catch(() => null);
        if (prev !== null && prev !== content) {
          await snapshotNote(root, filePath, prev, opts.forceSnapshot);
        }
      }
    } catch (err) {
      console.error('History snapshot failed:', err);
    }
  }
  await fsp.writeFile(filePath, content, 'utf8');
}

ipcMain.handle('write-note', async (event, filePath, content) => {
  await writeNoteFile(filePath, content, { snapshot: true });
  notifyFilesChanged();
  return true;
});

const HISTORY_ID_RE = /^[\w\-]+$/; // snapshot ids are ISO stamps with [:.]→-

ipcMain.handle('list-note-history', async (event, filePath: string) => {
  const settings = await readSettings();
  if (!settings.notebookRoot) return [];
  const dir = historyDirFor(settings.notebookRoot, filePath);
  const rel = path.relative(settings.notebookRoot, filePath).replace(/\\/g, '/');
  const index = await readHistoryIndex(dir, rel);
  return index.entries;
});

ipcMain.handle('read-note-history', async (event, filePath: string, id: string) => {
  const settings = await readSettings();
  if (!settings.notebookRoot || !HISTORY_ID_RE.test(id)) return '';
  const dir = historyDirFor(settings.notebookRoot, filePath);
  try {
    return await fsp.readFile(path.join(dir, `${id}.md`), 'utf8');
  } catch {
    return '';
  }
});

ipcMain.handle('restore-note-history', async (event, filePath: string, id: string) => {
  const settings = await readSettings();
  if (!settings.notebookRoot || !HISTORY_ID_RE.test(id)) return false;
  const dir = historyDirFor(settings.notebookRoot, filePath);
  let snapshot: string;
  try {
    snapshot = await fsp.readFile(path.join(dir, `${id}.md`), 'utf8');
  } catch {
    return false;
  }
  // Snapshot the current content first (bypassing the rate limit) so a
  // restore is itself undoable, then write the historical content.
  await writeNoteFile(filePath, snapshot, { snapshot: true, forceSnapshot: true });
  notifyFilesChanged();
  return true;
});

// Markdown utilities
function yamlValue(s: string): string {
  return /[:#\[\]{}",'`]|^[\s\-*&?>|%@!]|\s$|^$/.test(s) ? JSON.stringify(s) : s;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

async function uniqueFile(dir: string, base: string, ext: string): Promise<string> {
  let candidate = `${base}.${ext}`;
  let i = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${base}-${i}.${ext}`;
    i++;
  }
  return candidate;
}

async function uniqueMd(dir: string, baseSlug: string): Promise<string> {
  return uniqueFile(dir, baseSlug, 'md');
}

// Local date string (YYYY-MM-DD); toISOString() would shift the date near midnight
function localDateString(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

interface NoteMeta {
  title?: string;
  created?: string;
  tags?: string[];
}

function sanitizeMeta(meta: NoteMeta | undefined): { created: string; tags: string[] } {
  const created = meta?.created && /^\d{4}-\d{2}-\d{2}$/.test(meta.created) ? meta.created : localDateString();
  const tags = Array.isArray(meta?.tags)
    ? meta!.tags.map(t => String(t).trim().replace(/^#/, '')).filter(t => t)
    : [];
  return { created, tags };
}

function tagsYamlLine(tags: string[]): string {
  return tags.length ? `tags: [${tags.map(yamlValue).join(', ')}]` : 'tags: []';
}

ipcMain.handle('create-page', async (event, dirPath, title, templateName, meta?: NoteMeta) => {
  const settings = await readSettings();
  const { created: createdDate, tags } = sanitizeMeta(meta);
  let body = '';

  if (templateName) {
    const templatesDir = resolveTemplatesDir(settings);
    const templatePath = path.join(templatesDir, templateName);
    if (fs.existsSync(templatePath)) {
      let raw = await fsp.readFile(templatePath, 'utf8');
      // Replace variables
      const today = new Date();
      raw = raw.replace(/\{\{title\}\}/g, title);
      raw = raw.replace(/\{\{date\}\}/g, createdDate);
      raw = raw.replace(/\{\{time\}\}/g, today.toLocaleTimeString());
      raw = raw.replace(/\{\{datetime\}\}/g, today.toLocaleString());
      raw = raw.replace(/\{\{weekday\}\}/g, today.toLocaleDateString(undefined, { weekday: 'long' }));
      raw = raw.replace(/\{\{slug\}\}/g, slug(title));
      body = raw.replace(/\{\{cursor\}\}/g, '');
    }
  }

  const fm: string[] = ['---', `title: ${yamlValue(title)}`, `created: ${createdDate}`];
  if (settings.author) {
    fm.push(`author: ${yamlValue(settings.author)}`);
  }
  fm.push(tagsYamlLine(tags), '---', '', `# ${title}`, '', body);
  const content = fm.join('\n');

  const baseSlug = slug(title) || 'untitled';
  const filename = await uniqueMd(dirPath, baseSlug);
  const fullPath = path.join(dirPath, filename);

  await fsp.writeFile(fullPath, content, 'utf8');

  // Add to order file
  const ord = await readOrderFile(dirPath);
  ord.push(filename);
  await writeOrderFile(dirPath, ord);

  notifyFilesChanged();
  return fullPath;
});

ipcMain.handle('create-section', async (event, dirPath, name) => {
  const fullPath = path.join(dirPath, name.trim());
  if (!fs.existsSync(fullPath)) {
    await fsp.mkdir(fullPath, { recursive: true });
    notifyFilesChanged();
  }
  return fullPath;
});

// ==========================================
// TRASH (soft delete into <root>/.trash/ with sidecar metadata)
// ==========================================

function trashDirFor(root: string): string {
  return path.join(root, '.trash');
}

interface TrashMeta {
  originalRelPath: string;
  deletedAt: string;
  kind: 'page' | 'section';
  title: string;
}

// Move a file or whole folder into the trash; returns the trash entry name.
async function moveToTrash(root: string, filePath: string): Promise<string> {
  const trashDir = trashDirFor(root);
  await fsp.mkdir(trashDir, { recursive: true });

  const stat = await fsp.stat(filePath);
  const isDir = stat.isDirectory();
  const stamp = attachmentTimestamp();
  const base = path.basename(filePath);
  let trashName = `${stamp}-${base}`;
  let i = 1;
  while (fs.existsSync(path.join(trashDir, trashName))) {
    trashName = `${stamp}-${i}-${base}`;
    i++;
  }
  const dest = path.join(trashDir, trashName);

  try {
    await fsp.rename(filePath, dest);
  } catch {
    // Cross-device fallback
    await fsp.cp(filePath, dest, { recursive: true });
    await fsp.rm(filePath, { recursive: true });
  }

  let title = cleanDisplayName(isDir ? base : path.basename(base, '.md'));
  if (!isDir) {
    try {
      title = parseNoteMeta(await fsp.readFile(dest, 'utf8'), dest).title;
    } catch {}
  }
  const meta: TrashMeta = {
    originalRelPath: path.relative(root, filePath).replace(/\\/g, '/'),
    deletedAt: new Date().toISOString(),
    kind: isDir ? 'section' : 'page',
    title,
  };
  await fsp.writeFile(path.join(trashDir, `${trashName}.trashmeta.json`), JSON.stringify(meta, null, 2), 'utf8');
  return trashName;
}

ipcMain.handle('delete-node', async (event, filePath) => {
  if (!fs.existsSync(filePath)) return true;
  const settings = await readSettings();
  const root = settings.notebookRoot;
  const rel = root ? path.relative(root, filePath) : '..';

  if (!root || rel.startsWith('..') || path.isAbsolute(rel)) {
    // Outside the notebook (e.g. absolute templates dir): hard delete as before
    await fsp.rm(filePath, { recursive: true });
  } else {
    await moveToTrash(root, filePath);
  }

  // Remove pages from their folder's order file
  if (filePath.endsWith('.md')) {
    const dir = path.dirname(filePath);
    const name = path.basename(filePath);
    const ord = await readOrderFile(dir).catch(() => [] as string[]);
    const idx = ord.indexOf(name);
    if (idx !== -1) {
      ord.splice(idx, 1);
      await writeOrderFile(dir, ord);
    }
  }
  notifyFilesChanged();
  return true;
});

ipcMain.handle('list-trash', async () => {
  const settings = await readSettings();
  if (!settings.notebookRoot) return [];
  const trashDir = trashDirFor(settings.notebookRoot);

  let entries: fs.Dirent[] = [];
  try {
    entries = await fsp.readdir(trashDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const items: Array<TrashMeta & { trashName: string }> = [];
  for (const entry of entries) {
    if (entry.name.endsWith('.trashmeta.json')) continue;
    let meta: TrashMeta = {
      originalRelPath: entry.name.replace(/^\d{8}-\d{6}-/, ''),
      deletedAt: '',
      kind: entry.isDirectory() ? 'section' : 'page',
      title: cleanDisplayName(entry.name.replace(/^\d{8}-\d{6}-/, '').replace(/\.md$/i, '')),
    };
    try {
      meta = { ...meta, ...JSON.parse(await fsp.readFile(path.join(trashDir, `${entry.name}.trashmeta.json`), 'utf8')) };
    } catch {}
    items.push({ ...meta, trashName: entry.name });
  }
  items.sort((a, b) => (b.deletedAt || '').localeCompare(a.deletedAt || ''));
  return items;
});

// Trash entry names come back from list-trash; refuse anything path-like.
function safeTrashName(trashName: string): boolean {
  return !!trashName && !trashName.includes('/') && !trashName.includes('\\') && trashName !== '.' && trashName !== '..';
}

ipcMain.handle('restore-trash-item', async (event, trashName: string) => {
  const settings = await readSettings();
  if (!settings.notebookRoot || !safeTrashName(trashName)) return { success: false, reason: 'Invalid item.' };
  const trashDir = trashDirFor(settings.notebookRoot);
  const src = path.join(trashDir, trashName);
  if (!fs.existsSync(src)) return { success: false, reason: 'Item no longer in trash.' };

  let originalRelPath = trashName.replace(/^\d{8}-\d{6}-/, '');
  try {
    const meta = JSON.parse(await fsp.readFile(`${src}.trashmeta.json`, 'utf8'));
    if (meta.originalRelPath) originalRelPath = meta.originalRelPath;
  } catch {}

  let target = path.join(settings.notebookRoot, originalRelPath);
  await fsp.mkdir(path.dirname(target), { recursive: true });

  if (fs.existsSync(target)) {
    // Collision: uniquify
    const dir = path.dirname(target);
    const base = path.basename(target);
    if (base.toLowerCase().endsWith('.md')) {
      target = path.join(dir, await uniqueMd(dir, base.slice(0, -3)));
    } else {
      let i = 1;
      let candidate = `${base}-restored`;
      while (fs.existsSync(path.join(dir, candidate))) candidate = `${base}-restored-${i++}`;
      target = path.join(dir, candidate);
    }
  }

  try {
    await fsp.rename(src, target);
  } catch {
    await fsp.cp(src, target, { recursive: true });
    await fsp.rm(src, { recursive: true });
  }
  await fsp.unlink(`${src}.trashmeta.json`).catch(() => {});

  // Restored pages rejoin their folder's manual ordering
  if (target.endsWith('.md')) {
    const dir = path.dirname(target);
    const ord = await readOrderFile(dir);
    if (ord.length > 0 && !ord.includes(path.basename(target))) {
      ord.push(path.basename(target));
      await writeOrderFile(dir, ord);
    }
  }

  notifyFilesChanged();
  return { success: true, restoredPath: target };
});

ipcMain.handle('delete-trash-item', async (event, trashName: string) => {
  const settings = await readSettings();
  if (!settings.notebookRoot || !safeTrashName(trashName)) return false;
  const src = path.join(trashDirFor(settings.notebookRoot), trashName);
  await fsp.rm(src, { recursive: true, force: true });
  await fsp.unlink(`${src}.trashmeta.json`).catch(() => {});
  return true;
});

ipcMain.handle('empty-trash', async () => {
  const settings = await readSettings();
  if (!settings.notebookRoot) return { removed: 0 };
  const trashDir = trashDirFor(settings.notebookRoot);
  let removed = 0;
  try {
    for (const entry of await fsp.readdir(trashDir)) {
      if (!entry.endsWith('.trashmeta.json')) removed++;
      await fsp.rm(path.join(trashDir, entry), { recursive: true, force: true });
    }
  } catch {}
  return { removed };
});

// Rename / Wiki-link updating logic
function rewriteWikiLinks(text: string, oldBase: string, newBase: string, bareNameUnique: boolean, relDir: string): string {
  const oldLc = oldBase.toLowerCase();
  const relDirLc = relDir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

  return text.replace(/\[\[([^\[\]]+?)\]\]/g, (full, inner: string) => {
    const pipe = inner.indexOf('|');
    const target = pipe >= 0 ? inner.slice(0, pipe) : inner;
    const alias = pipe >= 0 ? inner.slice(pipe) : '';
    const subMatch = target.match(/[#^].*$/);
    const sub = subMatch ? subMatch[0] : '';
    const namePath = sub ? target.slice(0, target.length - sub.length) : target;
    const slashIdx = namePath.lastIndexOf('/');
    const dirPart = slashIdx >= 0 ? namePath.slice(0, slashIdx + 1) : '';
    const name = slashIdx >= 0 ? namePath.slice(slashIdx + 1) : namePath;
    const hasMd = /\.md$/i.test(name);
    const bare = hasMd ? name.slice(0, -3) : name;

    if (bare.trim().toLowerCase() !== oldLc) {
      return full;
    }

    if (dirPart) {
      const linkDirLc = dirPart.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      if (linkDirLc !== relDirLc) {
        return full;
      }
    } else if (!bareNameUnique) {
      return full; // ambiguous, don't rename
    }

    const rebuilt = newBase + (hasMd ? '.md' : '');
    return `[[${dirPart}${rebuilt}${sub}${alias}]]`;
  });
}

function updateOwnContent(text: string, oldTitle: string | undefined, newTitle: string, oldBase: string, newBase: string, renaming: boolean, bareNameUnique: boolean, relDir: string): string {
  let out = text;
  const fm = out.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)(?=[ \t]*(?:\r?\n|$))/);
  if (fm) {
    let block = fm[2];
    if (/^title:/m.test(block)) {
      block = block.replace(/^title:.*$/m, `title: ${yamlValue(newTitle)}`);
    } else {
      block = `title: ${yamlValue(newTitle)}` + (block ? '\n' + block : '');
    }
    out = fm[1] + block + fm[3] + out.slice(fm[0].length);
  }

  if (oldTitle) {
    out = out.replace(/^(#[ \t]+)(.+?)([ \t]*)$/m, (m, h: string, txt: string, tail: string) =>
      txt.trim() === oldTitle.trim() ? `${h}${newTitle}${tail}` : m
    );
  }

  if (renaming) {
    out = rewriteWikiLinks(out, oldBase, newBase, bareNameUnique, relDir);
  }
  return out;
}

// Recursive Markdown file collector
async function listMarkdownFiles(dir: string, ignore: Set<string>, rootDir: string): Promise<string[]> {
  let files: string[] = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.name.startsWith('.') || ignore.has(entry.name.toLowerCase())) continue;
    if (entry.isDirectory()) {
      files = files.concat(await listMarkdownFiles(full, ignore, rootDir));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(full);
    }
  }
  return files;
}

// Full-text search over the index built by the tree scan.
// A line matches when it contains every whitespace-separated term
// (case-insensitive). Results are capped and carry highlight ranges.
const SEARCH_MAX_FILES = 50;
const SEARCH_MAX_SNIPPETS = 3;
const SEARCH_MAX_LINE_MATCHES = 50;
const SEARCH_SNIPPET_WIDTH = 160;

function makeSearchSnippet(line: string, lower: string, terms: string[], lineIdx: number) {
  const firstHit = Math.min(...terms.map(t => {
    const i = lower.indexOf(t);
    return i === -1 ? Infinity : i;
  }));
  let start = 0;
  if (line.length > SEARCH_SNIPPET_WIDTH) {
    start = Math.max(0, Math.min(firstHit - 40, line.length - SEARCH_SNIPPET_WIDTH));
  }
  const text = line.substr(start, SEARCH_SNIPPET_WIDTH);
  const textLower = lower.substr(start, SEARCH_SNIPPET_WIDTH);

  const ranges: Array<[number, number]> = [];
  for (const term of terms) {
    let idx = 0;
    while ((idx = textLower.indexOf(term, idx)) !== -1) {
      ranges.push([idx, term.length]);
      idx += term.length;
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [s, l] of ranges) {
    const last = merged[merged.length - 1];
    if (last && s <= last[0] + last[1]) {
      last[1] = Math.max(last[1], s + l - last[0]);
    } else {
      merged.push([s, l]);
    }
  }
  return { line: lineIdx, text, ranges: merged };
}

ipcMain.handle('search-notes', async (event, query: string, opts?: { maxResults?: number }) => {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const terms = q.toLowerCase().split(/\s+/).filter(t => t);
  if (terms.length === 0) return [];
  const maxFiles = Math.min(Math.max(1, opts?.maxResults || SEARCH_MAX_FILES), SEARCH_MAX_FILES);

  const results: Array<{ fsPath: string; relPath: string; title: string; matchCount: number; snippets: any[] }> = [];
  for (const doc of searchIndex.values()) {
    let matchCount = 0;
    const snippets: any[] = [];
    for (let i = 0; i < doc.lines.length; i++) {
      const lower = doc.lines[i].toLowerCase();
      if (!terms.every(t => lower.includes(t))) continue;
      matchCount++;
      if (snippets.length < SEARCH_MAX_SNIPPETS) {
        snippets.push(makeSearchSnippet(doc.lines[i], lower, terms, i));
      }
      if (matchCount >= SEARCH_MAX_LINE_MATCHES) break;
    }
    if (matchCount > 0) {
      results.push({ fsPath: doc.fsPath, relPath: doc.relPath, title: doc.title, matchCount, snippets });
    }
  }

  results.sort((a, b) => b.matchCount - a.matchCount || a.title.localeCompare(b.title));
  return results.slice(0, maxFiles);
});

// Find notes that link to the given file ([[wiki-links]] or markdown links).
// One IPC round-trip with parallel reads in the main process replaces the
// renderer's old per-note IPC read loop.
ipcMain.handle('get-backlinks', async (event, filePath: string) => {
  const settings = await readSettings();
  if (!settings.notebookRoot || !filePath) return [];

  const escapeForRegex = (s: string) => s.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
  const base = escapeForRegex(path.basename(filePath, '.md'));
  const full = escapeForRegex(path.basename(filePath));
  const wikiRegex = new RegExp(`\\[\\[${base}(\\||#|\\]\\])`, 'i');
  const mdRegex = new RegExp(`\\(\\.*\\/?.*?${full}\\)`, 'i');

  const ignore = new Set(settings.ignoreFolders.map(s => s.toLowerCase()));
  let allFiles: string[] = [];
  try {
    allFiles = await listMarkdownFiles(settings.notebookRoot, ignore, settings.notebookRoot);
  } catch {
    return [];
  }

  const normalizedTarget = path.normalize(filePath);
  const results: string[] = [];
  await Promise.all(allFiles.map(async (file) => {
    if (path.normalize(file) === normalizedTarget) return;
    try {
      const text = await fsp.readFile(file, 'utf8');
      if (wikiRegex.test(text) || mdRegex.test(text)) {
        results.push(file);
      }
    } catch {}
  }));
  return results.sort();
});

ipcMain.handle('relocate-node', async (event, srcPath, destDir) => {
  if (!fs.existsSync(srcPath) || !fs.existsSync(destDir)) return false;
  const stat = await fsp.stat(destDir);
  if (!stat.isDirectory()) return false;
  const baseName = path.basename(srcPath);
  const destPath = path.join(destDir, baseName);
  if (path.normalize(srcPath) === path.normalize(destPath)) return false;
  
  // Prevent moving a folder into itself
  if (destPath.startsWith(srcPath + path.sep)) return false;

  try {
    await fsp.rename(srcPath, destPath);
    return true;
  } catch (err) {
    console.error('Error moving node:', err);
    return false;
  }
});

ipcMain.handle('rename-node', async (event, filePath, newName) => {
  if (!fs.existsSync(filePath)) return false;
  const stat = await fsp.stat(filePath);
  const dir = path.dirname(filePath);

  if (stat.isDirectory()) {
    const newPath = path.join(dir, newName.trim());
    await fsp.rename(filePath, newPath);
  } else {
    // Markdown page rename
    const oldBase = path.basename(filePath, '.md');
    const oldText = await fsp.readFile(filePath, 'utf8');
    const oldTitle = oldText.match(/^title:\s*(.*)$/m)?.[1]?.replace(/^['"]|['"]$/g, '') || oldBase;

    const newSlug = slug(newName) || oldBase;
    const renaming = newSlug.toLowerCase() !== oldBase.toLowerCase();
    
    let newPath = filePath;
    let finalBase = oldBase;
    
    if (renaming) {
      const fname = await uniqueMd(dir, newSlug);
      finalBase = path.basename(fname, '.md');
      newPath = path.join(dir, fname);
    }

    const settings = await readSettings();
    const ignore = new Set(settings.ignoreFolders.map(s => s.toLowerCase()));
    const allFiles = await listMarkdownFiles(settings.notebookRoot, ignore, settings.notebookRoot);
    
    // Check if base filename is unique
    const oldBaseLc = oldBase.toLowerCase();
    const duplicates = allFiles.filter(f => path.basename(f).toLowerCase() === `${oldBaseLc}.md` && path.normalize(f) !== path.normalize(filePath));
    const bareNameUnique = duplicates.length === 0;
    const relDir = path.relative(settings.notebookRoot, dir);

    // Update note's own contents
    const newOwn = updateOwnContent(oldText, oldTitle, newName, oldBase, finalBase, renaming, bareNameUnique, relDir);
    await fsp.writeFile(filePath, newOwn, 'utf8');

    // Update references in all other files
    if (renaming) {
      for (const otherFile of allFiles) {
        if (path.normalize(otherFile) === path.normalize(filePath)) continue;
        const text = await fsp.readFile(otherFile, 'utf8');
        const rewritten = rewriteWikiLinks(text, oldBase, finalBase, bareNameUnique, relDir);
        if (rewritten !== text) {
          await fsp.writeFile(otherFile, rewritten, 'utf8');
        }
      }

      // Rename the file on disk
      await fsp.rename(filePath, newPath);

      // Keep the note's history attached to its new path
      const oldHistDir = historyDirFor(settings.notebookRoot, filePath);
      if (fs.existsSync(oldHistDir)) {
        const newHistDir = historyDirFor(settings.notebookRoot, newPath);
        try {
          await fsp.rename(oldHistDir, newHistDir);
          const relNew = path.relative(settings.notebookRoot, newPath).replace(/\\/g, '/');
          const index = await readHistoryIndex(newHistDir, relNew);
          index.relPath = relNew;
          await writeHistoryIndex(newHistDir, index);
        } catch (err) {
          console.error('Failed to migrate note history on rename:', err);
        }
      }

      // Update folder manual ordering file
      const oldOrderName = path.basename(filePath).toLowerCase();
      const ord = await readOrderFile(dir);
      if (ord.some(n => n.toLowerCase() === oldOrderName)) {
        await writeOrderFile(
          dir,
          ord.map(n => n.toLowerCase() === oldOrderName ? path.basename(newPath) : n)
        );
      }
    }
  }

  notifyFilesChanged();
  return true;
});

ipcMain.handle('move-node', async (event, dirPath, fileName, direction) => {
  const ord = await readOrderFile(dirPath);
  
  // If order file is empty, initialize it with current sorted pages order
  if (ord.length === 0) {
    const settings = await readSettings();
    const ignore = new Set(settings.ignoreFolders.map(s => s.toLowerCase()));
    const secNode = await scanDirectory(dirPath, settings.notebookRoot, ignore, settings.scratchpadFile, true);
    secNode.pages.forEach(p => ord.push(p.name));
  }

  const idx = ord.findIndex(n => n.toLowerCase() === fileName.toLowerCase());
  if (idx === -1) return false;

  if (direction === 'up' && idx > 0) {
    const temp = ord[idx];
    ord[idx] = ord[idx - 1];
    ord[idx - 1] = temp;
  } else if (direction === 'down' && idx < ord.length - 1) {
    const temp = ord[idx];
    ord[idx] = ord[idx + 1];
    ord[idx + 1] = temp;
  }

  await writeOrderFile(dirPath, ord);
  notifyFilesChanged();
  return true;
});

// ==========================================
// ATTACHMENTS
// ==========================================

function resolveAttachmentsDir(settings: AppSettings): string {
  return path.isAbsolute(settings.attachmentsFolder)
    ? settings.attachmentsFolder
    : path.join(settings.notebookRoot, settings.attachmentsFolder);
}

const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;

function attachmentTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function sanitizeExt(name: string, fallback: string): string {
  const ext = path.extname(name).slice(1).toLowerCase().replace(/[^a-z0-9]/g, '');
  return ext || fallback;
}

async function storeAttachment(
  data: Buffer,
  baseName: string,
  defaultExt: string,
  notePath: string,
): Promise<{ success: boolean; fsPath?: string; relPath?: string; reason?: string }> {
  const settings = await readSettings();
  if (!settings.notebookRoot) return { success: false, reason: 'No notebook open.' };
  if (data.length === 0) return { success: false, reason: 'Empty attachment.' };
  if (data.length > ATTACHMENT_MAX_BYTES) return { success: false, reason: 'Attachment exceeds 50 MB.' };

  const dir = resolveAttachmentsDir(settings);
  await fsp.mkdir(dir, { recursive: true });

  const ext = sanitizeExt(baseName, defaultExt);
  const stem = slug(path.basename(baseName, path.extname(baseName))) || 'pasted-image';
  const filename = await uniqueFile(dir, `${attachmentTimestamp()}-${stem}`, ext);
  const fsPath = path.join(dir, filename);

  await fsp.writeFile(fsPath, data);
  // Deliberately no notifyFilesChanged: attachments aren't in the tree.

  const relPath = path.relative(path.dirname(notePath), fsPath).replace(/\\/g, '/');
  return { success: true, fsPath, relPath };
}

ipcMain.handle('save-attachment', async (event, payload: { baseName: string; bytes: ArrayBuffer; notePath: string }) => {
  try {
    return await storeAttachment(Buffer.from(payload.bytes), payload.baseName || 'pasted-image.png', 'png', payload.notePath);
  } catch (err: any) {
    return { success: false, reason: err?.message || String(err) };
  }
});

ipcMain.handle('import-attachment-file', async (event, payload: { sourcePath: string; notePath: string }) => {
  try {
    const data = await fsp.readFile(payload.sourcePath);
    return await storeAttachment(data, path.basename(payload.sourcePath), 'bin', payload.notePath);
  } catch (err: any) {
    return { success: false, reason: err?.message || String(err) };
  }
});

// Update a note's frontmatter metadata (created/tags/pinned) in place,
// preserving any other keys. The title is handled separately by rename-node
// since it can also change the filename and wiki-links.
ipcMain.handle('update-note-meta', async (event, filePath: string, meta: { created?: string; tags?: string[]; pinned?: boolean }) => {
  if (!fs.existsSync(filePath)) return false;
  let text = await fsp.readFile(filePath, 'utf8');

  const created = meta?.created && /^\d{4}-\d{2}-\d{2}$/.test(meta.created) ? meta.created : '';
  const tags = Array.isArray(meta?.tags)
    ? meta!.tags.map(t => String(t).trim().replace(/^#/, '')).filter(t => t)
    : [];
  const pinned = !!meta?.pinned;

  // Replaces "key: ..." (for tags: including a following block list) or appends
  const setKey = (block: string, key: string, value: string): string => {
    const re = key === 'tags'
      ? /^[ \t]*tags:.*(?:\r?\n[ \t]+-[ \t].*)*/m
      : new RegExp(`^[ \\t]*${key}:.*$`, 'm');
    if (re.test(block)) {
      return block.replace(re, `${key}: ${value}`);
    }
    return block + `\n${key}: ${value}`;
  };

  const fm = text.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)(?=[ \t]*(?:\r?\n|$))/);
  if (fm) {
    let block = fm[2];
    if (created) block = setKey(block, 'created', created);
    block = setKey(block, 'tags', `[${tags.map(yamlValue).join(', ')}]`);
    if (pinned || /^[ \t]*pinned:/m.test(block)) {
      block = setKey(block, 'pinned', pinned ? 'true' : 'false');
    }
    text = fm[1] + block + fm[3] + text.slice(fm[0].length);
  } else {
    // No frontmatter yet: create one
    const fmLines = ['---'];
    if (created) fmLines.push(`created: ${created}`);
    fmLines.push(tagsYamlLine(tags));
    if (pinned) fmLines.push('pinned: true');
    fmLines.push('---', '');
    text = fmLines.join('\n') + text;
  }

  await fsp.writeFile(filePath, text, 'utf8');
  notifyFilesChanged();
  return true;
});

// Templates management
function resolveTemplatesDir(settings: AppSettings): string {
  return path.isAbsolute(settings.templatesFolder)
    ? settings.templatesFolder
    : path.join(settings.notebookRoot, settings.templatesFolder);
}

ipcMain.handle('list-templates', async () => {
  const settings = await readSettings();
  if (!settings.notebookRoot) return [];
  const dir = resolveTemplatesDir(settings);

  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const templates: Array<{ name: string; fsPath: string; title: string }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const fullPath = path.join(dir, entry.name);
      let title = cleanDisplayName(path.basename(entry.name, '.md'));
      try {
        const meta = parseNoteMeta(await fsp.readFile(fullPath, 'utf8'), fullPath);
        title = meta.title;
      } catch {}
      templates.push({ name: entry.name, fsPath: fullPath, title });
    }
    templates.sort((a, b) => a.title.localeCompare(b.title));
    return templates;
  } catch {
    return []; // templates folder doesn't exist yet
  }
});

ipcMain.handle('create-template', async (event, name: string) => {
  const settings = await readSettings();
  if (!settings.notebookRoot) return null;
  const dir = resolveTemplatesDir(settings);
  await fsp.mkdir(dir, { recursive: true });

  // Templates are note *bodies*: create-page prepends its own frontmatter
  // and H1, so a starter template must not include those.
  const starter = [
    '## Overview',
    '',
    'Notes about {{title}}, started on {{weekday}} {{date}}.',
    '',
    '## Details',
    '',
    '- [ ] First action item',
    '',
  ].join('\n');

  const filename = await uniqueMd(dir, slug(name) || 'template');
  const fullPath = path.join(dir, filename);
  await fsp.writeFile(fullPath, starter, 'utf8');

  notifyFilesChanged();
  return fullPath;
});

// Quick Scratchpad backed by scratchpadFile
ipcMain.handle('read-scratchpad', async () => {
  const settings = await readSettings();
  if (!settings.notebookRoot) return '';
  const scratchPath = path.join(settings.notebookRoot, settings.scratchpadFile);
  try {
    return await fsp.readFile(scratchPath, 'utf8');
  } catch {
    return '';
  }
});

ipcMain.handle('append-scratchpad', async (event, text) => {
  const settings = await readSettings();
  if (!settings.notebookRoot) return false;
  const scratchPath = path.join(settings.notebookRoot, settings.scratchpadFile);
  
  let existing = '';
  try {
    existing = await fsp.readFile(scratchPath, 'utf8');
  } catch {}

  if (existing && !existing.endsWith('\n')) {
    existing += '\n';
  }
  existing += text + '\n';
  
  await fsp.writeFile(scratchPath, existing, 'utf8');
  notifyFilesChanged();
  return true;
});

// Clipboard and Document imports
function looksLikeHtml(text: string): boolean {
  const sample = text.slice(0, 4000);
  if (/<!DOCTYPE html|<html[\s>]|<body[\s>]|<table[\s>]|<blockquote[\s>]/i.test(sample)) {
    return true;
  }
  const tagHits = sample.match(/<(p|div|br|span|a|ul|ol|li|h[1-6]|tr|td)\b[^>]*>/gi);
  return !!tagHits && tagHits.length >= 3;
}

ipcMain.handle('import-clipboard', async (event, destDir, meta?: NoteMeta) => {
  const settings = await readSettings();
  const { clipboard } = require('electron');

  const html = clipboard.readHTML();
  const text = clipboard.readText();

  if (!text && !html) return { success: false, reason: 'Clipboard is empty.' };

  const isHtml = looksLikeHtml(html || text);
  const inputData = isHtml ? (html || text) : text;
  const fromFormat = isHtml ? 'html' : 'markdown';

  let body = '';
  try {
    body = await runPandocStdin(inputData, fromFormat, 'gfm');
  } catch (err: any) {
    return { success: false, reason: `Pandoc conversion failed: ${err.message || String(err)}` };
  }

  body = body.trim();
  // User-supplied title wins; otherwise auto-detect from the first heading
  const title = meta?.title?.trim() || body.match(/^#{1,6}\s+(.+?)\s*$/m)?.[1]?.trim() || 'Imported Note';
  const { created: createdDate, tags } = sanitizeMeta(meta);

  const fm: string[] = ['---', `title: ${yamlValue(title)}`, `created: ${createdDate}`];
  if (settings.author) {
    fm.push(`author: ${yamlValue(settings.author)}`);
  }
  fm.push(tagsYamlLine(tags.length ? tags : ['imported']), '---', '', body);
  const content = fm.join('\n');

  const baseSlug = `import-${slug(title) || Date.now()}`;
  const filename = await uniqueMd(destDir, baseSlug);
  const fullPath = path.join(destDir, filename);

  await fsp.writeFile(fullPath, content, 'utf8');

  // Update order file
  const ord = await readOrderFile(destDir);
  ord.push(filename);
  await writeOrderFile(destDir, ord);

  notifyFilesChanged();

  return { success: true, filePath: fullPath };
});

ipcMain.handle('import-document', async (event, destDir) => {
  const settings = await readSettings();
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile'],
    filters: [
      { name: 'Word Documents', extensions: ['docx', 'odt', 'rtf'] },
      { name: 'Powerpoint Presentations', extensions: ['pptx'] },
      { name: 'Excel Sheets', extensions: ['xlsx'] },
      { name: 'EPUB Books', extensions: ['epub'] },
      { name: 'HTML files', extensions: ['html', 'htm'] },
      { name: 'Plain Text & LaTeX', extensions: ['txt', 'text', 'tex'] },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) return null;
  const docPath = result.filePaths[0];

  const ext = path.extname(docPath).toLowerCase();
  const extToReader: Record<string, string> = {
    '.docx': 'docx',
    '.pptx': 'pptx',
    '.xlsx': 'xlsx',
    '.odt': 'odt',
    '.rtf': 'rtf',
    '.epub': 'epub',
    '.html': 'html',
    '.htm': 'html',
    '.tex': 'latex',
    '.txt': 'markdown',
    '.text': 'markdown',
  };

  const reader = extToReader[ext] || 'docx';
  let body = '';
  try {
    body = await runPandocFile(docPath, reader, 'gfm');
  } catch (err: any) {
    return { success: false, reason: `Pandoc file conversion failed: ${err.message || String(err)}` };
  }

  body = body.trim();
  const title = body.match(/^#{1,6}\s+(.+?)\s*$/m)?.[1]?.trim() || path.basename(docPath, ext);
  const createdDate = localDateString();

  const fm: string[] = ['---', `title: ${yamlValue(title)}`, `created: ${createdDate}`];
  if (settings.author) {
    fm.push(`author: ${yamlValue(settings.author)}`);
  }
  fm.push('tags: [imported]', '---', '', body);
  const content = fm.join('\n');

  const baseSlug = `import-${slug(title) || Date.now()}`;
  const filename = await uniqueMd(destDir, baseSlug);
  const fullPath = path.join(destDir, filename);

  await fsp.writeFile(fullPath, content, 'utf8');

  // Update order file
  const ord = await readOrderFile(destDir);
  ord.push(filename);
  await writeOrderFile(destDir, ord);

  notifyFilesChanged();

  return { success: true, filePath: fullPath };
});

function runPandocStdin(input: string, from: string, to: string): Promise<string> {
  return new Promise(async (resolve, reject) => {
    // Try homebrew path or direct path
    const settings = await readSettings();
    const pandocPath = settings.pandocPath || (process.platform === 'darwin' && fs.existsSync('/opt/homebrew/bin/pandoc')
      ? '/opt/homebrew/bin/pandoc'
      : 'pandoc');
      
    const child = execFile(
      pandocPath,
      ['-f', from, '-t', to, '--wrap=none'],
      { timeout: 30000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message));
        } else {
          resolve(stdout);
        }
      }
    );
    child.stdin?.end(input);
  });
}

function runPandocFile(filePath: string, from: string, to: string): Promise<string> {
  return new Promise(async (resolve, reject) => {
    const settings = await readSettings();
    const pandocPath = settings.pandocPath || (process.platform === 'darwin' && fs.existsSync('/opt/homebrew/bin/pandoc')
      ? '/opt/homebrew/bin/pandoc'
      : 'pandoc');

    execFile(
      pandocPath,
      [filePath, '-f', from, '-t', to, '--wrap=none'],
      { timeout: 30000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message));
        } else {
          resolve(stdout);
        }
      }
    );
  });
}

// PDF Native Export using Electron webContents.printToPDF.
// Theme-independent layout rules, written against --pdf-* tokens; each
// selectable PDF theme is just a token block layered on top.
const PDF_BASE_CSS = `
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    color: var(--pdf-text);
    line-height: 1.6;
    padding: 40px;
    background: var(--pdf-bg);
  }
  h1, h2, h3, h4, h5, h6 {
    margin-top: 24px;
    margin-bottom: 16px;
    font-weight: 600;
    line-height: 1.25;
    color: var(--pdf-heading);
  }
  h1 { font-size: 2em; border-bottom: 1px solid var(--pdf-border); padding-bottom: .3em; }
  h2 { font-size: 1.5em; border-bottom: 1px solid var(--pdf-border); padding-bottom: .3em; }
  h3 { font-size: 1.25em; }
  pre, code {
    font-family: SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace;
    background-color: var(--pdf-code-bg);
    border-radius: 3px;
  }
  /* Paper can't scroll: long code lines must WRAP, never clip behind an
     overflow container (which also paints a useless scrollbar into the PDF) */
  pre {
    padding: 16px;
    overflow: visible;
    font-size: 85%;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
  }
  code { padding: .2em .4em; margin: 0; font-size: 85%; word-break: break-word; }
  pre code { padding: 0; background-color: transparent; white-space: inherit; }
  blockquote {
    padding: 0 1em;
    color: var(--pdf-muted);
    border-left: .25em solid var(--pdf-border);
    margin: 0 0 16px 0;
  }
  table { border-spacing: 0; border-collapse: collapse; width: 100%; margin-bottom: 16px; }
  table th, table td { padding: 6px 13px; border: 1px solid var(--pdf-border); }
  table th { background-color: var(--pdf-head-bg); }
  table tr { background-color: var(--pdf-bg); border-top: 1px solid var(--pdf-border); }
  table tr:nth-child(2n) { background-color: var(--pdf-code-bg); }
  img { max-width: 100%; box-sizing: content-box; }
  .task-checkbox { vertical-align: middle; margin-right: 8px; }
  a { color: var(--pdf-link); text-decoration: none; }
  mark { background-color: var(--pdf-mark-bg); color: var(--pdf-text); padding: 1px 4px; border-radius: 3px; }

  /* Page break controls */
  h1, h2, h3 { page-break-after: avoid; }
  blockquote, table, img { page-break-inside: avoid; }
  pre { page-break-inside: avoid; max-height: none; }

  /* Mermaid diagrams: render at natural size, capped to one page, so a
     stretched SVG can't span multiple pages and leave blank gaps. */
  .mermaid-block-container {
    page-break-inside: avoid;
    margin: 16px 0;
    border: none;
    background: transparent;
  }
  .notebook-mermaid {
    background: transparent !important;
    border: none !important;
    padding: 0 !important;
    box-shadow: none !important;
    display: flex;
    justify-content: center;
    page-break-inside: avoid;
  }
  .notebook-mermaid svg {
    max-width: 100% !important;
    max-height: 8.5in;
    height: auto !important;
  }

  /* Batch export: table of contents + one note per section */
  .pdf-toc { page-break-after: always; }
  .pdf-toc ol { padding-left: 20px; }
  .pdf-toc li { margin-bottom: 6px; display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
  .pdf-toc a { color: var(--pdf-link); }
  .pdf-toc-path { color: var(--pdf-muted); font-size: 11px; }
  .pdf-note { page-break-before: always; }

  /* Hide notebook UI elements for clean write-up export */
  .toolbar, .code-header, .code-header-bar, .copy-btn, .copy-code-btn,
  .mermaid-actions-bar, .code-block-copy-btn,
  #note-header, .backlink-pill, .tag-pill, .status-indicator, #titlebar {
    display: none !important;
  }

  /* Code block wrapper chrome from the preview pane */
  .code-block-wrapper {
    border: 1px solid var(--pdf-border);
    border-radius: 6px;
    overflow: hidden;
    margin-bottom: 16px;
    page-break-inside: avoid;
  }
  .code-block-wrapper pre { margin: 0; }
  .code-block-header {
    padding: 4px 12px;
    background: var(--pdf-head-bg);
    border-bottom: 1px solid var(--pdf-border);
    font-size: 10px;
    font-family: SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace;
    text-transform: uppercase;
    color: var(--pdf-muted);
  }
`;

const PDF_THEMES: Record<PdfExportOptions['theme'], string> = {
  light: `
    :root { --pdf-bg: #ffffff; --pdf-text: #24292e; --pdf-heading: #1f2328; --pdf-muted: #6a737d;
            --pdf-border: #dfe2e5; --pdf-code-bg: #f6f8fa; --pdf-head-bg: #f0f2f4;
            --pdf-link: #0366d6; --pdf-mark-bg: #fff3b8; }
  `,
  dark: `
    :root { --pdf-bg: #0d1117; --pdf-text: #c9d1d9; --pdf-heading: #f0f6fc; --pdf-muted: #8b949e;
            --pdf-border: #30363d; --pdf-code-bg: #161b22; --pdf-head-bg: #161b22;
            --pdf-link: #58a6ff; --pdf-mark-bg: #4d3800; }
  `,
  minimal: `
    :root { --pdf-bg: #ffffff; --pdf-text: #1a1a1a; --pdf-heading: #000000; --pdf-muted: #666666;
            --pdf-border: #e5e5e5; --pdf-code-bg: #fafafa; --pdf-head-bg: #ffffff;
            --pdf-link: #1a56db; --pdf-mark-bg: #f5f0d8; }
    .code-block-wrapper { border: none; }
    .code-block-header { display: none; }
    pre { border: 1px solid var(--pdf-border); }
    table tr:nth-child(2n) { background-color: var(--pdf-bg); }
  `,
};

ipcMain.handle('export-to-pdf', async (event, filePath, htmlContent, options?: Partial<PdfExportOptions>) => {
  const settings = await readSettings();
  const opts: PdfExportOptions = { ...settings.pdfExport, ...(options || {}) };

  const result = await dialog.showSaveDialog(mainWindow!, {
    title: 'Export to PDF',
    defaultPath: filePath.replace(/\.md$/i, '.pdf'),
    filters: [{ name: 'PDF Document', extensions: ['pdf'] }],
  });

  if (result.canceled || !result.filePath) return { success: false, canceled: true };
  const pdfPath = result.filePath;

  // Remember the chosen options for next time
  await writeSettings({ pdfExport: opts });

  // Render HTML in a hidden BrowserWindow
  const printWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  const themeCss = PDF_THEMES[opts.theme] || PDF_THEMES.light;
  const styledHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>${themeCss}</style>
      <style>${PDF_BASE_CSS}</style>
    </head>
    <body>
      ${htmlContent}
    </body>
    </html>
  `;

  // Load via a temp file: data: URLs have practical size limits that notes
  // with large embedded images can exceed.
  const tempHtmlPath = path.join(app.getPath('temp'), `mdnb-export-${Date.now()}.html`);

  try {
    await fsp.writeFile(tempHtmlPath, styledHtml, 'utf8');
    await printWindow.loadFile(tempHtmlPath);

    const data = await printWindow.webContents.printToPDF({
      printBackground: true, // required for dark/tinted themes
      margins: { marginType: 'default' },
      pageSize: opts.pageSize || 'A4',
    });
    await fsp.writeFile(pdfPath, data);

    if (opts.openAfter) {
      await shell.openPath(pdfPath);
    }
    if (opts.reveal) {
      shell.showItemInFolder(pdfPath);
    }
    return { success: true, pdfPath };
  } catch (err: any) {
    console.error('Failed to print to PDF:', err);
    return { success: false, reason: err?.message || String(err) };
  } finally {
    printWindow.destroy();
    fsp.unlink(tempHtmlPath).catch(() => {});
  }
});

// --- Sharing: standalone HTML, DOCX (pandoc), rich-text clipboard ---

// Data-URI inlining caps: one oversized screenshot shouldn't balloon the
// exported HTML past what browsers/mail clients will open.
const HTML_INLINE_IMAGE_MAX = 10 * 1024 * 1024;
const HTML_INLINE_TOTAL_MAX = 40 * 1024 * 1024;
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp', '.avif': 'image/avif', '.ico': 'image/x-icon',
};

// Rewrite file:// image sources into data: URIs so the exported HTML is a
// single self-contained file. Images that are missing, non-image, or over
// the size caps keep their original src.
async function inlineFileImages(html: string): Promise<string> {
  let total = 0;
  const srcRe = /(<img\b[^>]*?\ssrc=")(file:\/\/[^"]+)(")/gi;
  const matches = [...html.matchAll(srcRe)];
  const replacements = new Map<string, string>();
  for (const m of matches) {
    const fileUrl = m[2];
    if (replacements.has(fileUrl)) continue;
    try {
      const decoded = decodeURI(fileUrl.replace(/^file:\/\//, ''));
      // Windows file URLs look like file:///C:/... — strip the leading slash
      const fsPath = process.platform === 'win32' && /^\/[a-zA-Z]:/.test(decoded)
        ? decoded.slice(1) : decoded;
      const mime = IMAGE_MIME[path.extname(fsPath).toLowerCase()];
      if (!mime) continue;
      const stat = await fsp.stat(fsPath);
      if (stat.size > HTML_INLINE_IMAGE_MAX || total + stat.size > HTML_INLINE_TOTAL_MAX) continue;
      const buf = await fsp.readFile(fsPath);
      total += stat.size;
      replacements.set(fileUrl, `data:${mime};base64,${buf.toString('base64')}`);
    } catch {
      // unreadable image: leave the original src in place
    }
  }
  if (!replacements.size) return html;
  return html.replace(srcRe, (whole, pre, url, post) =>
    replacements.has(url) ? pre + replacements.get(url) + post : whole);
}

ipcMain.handle('export-to-html', async (event, filePath, htmlContent, options?: { theme?: PdfExportOptions['theme'] }) => {
  const settings = await readSettings();
  const theme = options?.theme || settings.pdfExport.theme || 'light';

  const result = await dialog.showSaveDialog(mainWindow!, {
    title: 'Export to HTML',
    defaultPath: filePath.replace(/\.md$/i, '.html'),
    filters: [{ name: 'HTML Document', extensions: ['html'] }],
  });
  if (result.canceled || !result.filePath) return { success: false, canceled: true };

  try {
    const inlined = await inlineFileImages(htmlContent);
    const themeCss = PDF_THEMES[theme] || PDF_THEMES.light;
    const title = path.basename(filePath).replace(/\.md$/i, '');
    const doc = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</title>
<style>${themeCss}</style>
<style>${PDF_BASE_CSS}</style>
<style>body { max-width: 860px; margin: 0 auto; }</style>
</head>
<body>
${inlined}
</body>
</html>
`;
    await fsp.writeFile(result.filePath, doc, 'utf8');
    shell.showItemInFolder(result.filePath);
    return { success: true, htmlPath: result.filePath };
  } catch (err: any) {
    console.error('Failed to export HTML:', err);
    return { success: false, reason: err?.message || String(err) };
  }
});

// Convert an on-disk markdown file to another format with pandoc, writing
// straight to outPath. cwd is the note's folder so relative image links resolve.
function runPandocToFile(inputPath: string, outPath: string, format: string, cwd: string): Promise<void> {
  return new Promise(async (resolve, reject) => {
    const settings = await readSettings();
    const pandocPath = settings.pandocPath || (process.platform === 'darwin' && fs.existsSync('/opt/homebrew/bin/pandoc')
      ? '/opt/homebrew/bin/pandoc'
      : 'pandoc');
    execFile(
      pandocPath,
      [inputPath, '-f', 'gfm', '-t', format, '-o', outPath, '--wrap=none'],
      { timeout: 60000, cwd },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve();
      }
    );
  });
}

ipcMain.handle('export-to-docx', async (event, filePath) => {
  if (!fs.existsSync(filePath)) return { success: false, reason: 'Note file not found.' };

  const result = await dialog.showSaveDialog(mainWindow!, {
    title: 'Export to Word',
    defaultPath: filePath.replace(/\.md$/i, '.docx'),
    filters: [{ name: 'Word Document', extensions: ['docx'] }],
  });
  if (result.canceled || !result.filePath) return { success: false, canceled: true };

  // Pandoc's gfm reader would print the YAML frontmatter as a table, so hand
  // it a temp copy with the frontmatter stripped. Mermaid blocks come through
  // as plain code blocks — pandoc has no renderer for them.
  const raw = await fsp.readFile(filePath, 'utf8');
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const tempMd = path.join(app.getPath('temp'), `mdnb-docx-${Date.now()}.md`);
  try {
    await fsp.writeFile(tempMd, body, 'utf8');
    await runPandocToFile(tempMd, result.filePath, 'docx', path.dirname(filePath));
    shell.showItemInFolder(result.filePath);
    return { success: true, docxPath: result.filePath };
  } catch (err: any) {
    const msg = err?.message || String(err);
    const reason = /ENOENT/.test(msg)
      ? 'Pandoc is required for Word export but was not found. Install pandoc or set its path in Settings.'
      : `Pandoc conversion failed: ${msg}`;
    return { success: false, reason };
  } finally {
    fsp.unlink(tempMd).catch(() => {});
  }
});

ipcMain.handle('copy-rich-text', async (event, htmlContent, plainText) => {
  try {
    const { clipboard } = require('electron');
    const inlined = await inlineFileImages(htmlContent);
    clipboard.write({ html: inlined, text: plainText || '' });
    return { success: true };
  } catch (err: any) {
    return { success: false, reason: err?.message || String(err) };
  }
});

// --- Quick capture: global shortcut -> tiny always-on-top jot window ---

let captureWindow: BrowserWindow | null = null;
let registeredCaptureShortcut = '';

function createCaptureWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 520,
    height: 150,
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'capture-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, '../renderer/capture.html'));
  wireSpellcheckMenu(win); // corrections work in the quick-capture box too
  // A capture scratchpad shouldn't linger over other apps once you click away
  win.on('blur', () => win.hide());
  win.on('closed', () => {
    if (captureWindow === win) captureWindow = null;
  });
  return win;
}

function toggleCaptureWindow() {
  if (!captureWindow || captureWindow.isDestroyed()) {
    captureWindow = createCaptureWindow();
  }
  if (captureWindow.isVisible()) {
    captureWindow.hide();
  } else {
    captureWindow.center();
    captureWindow.show();
    captureWindow.focus();
  }
}

// (Re-)register the system-wide shortcut. Returns true when the accelerator
// is active, false when it's invalid or taken by another app; empty string
// just unregisters (feature off).
function registerQuickCaptureShortcut(accelerator: string): boolean {
  if (registeredCaptureShortcut) {
    try { globalShortcut.unregister(registeredCaptureShortcut); } catch { /* already gone */ }
    registeredCaptureShortcut = '';
  }
  const shortcut = (accelerator || '').trim();
  if (!shortcut) return true;
  try {
    if (globalShortcut.register(shortcut, toggleCaptureWindow)) {
      registeredCaptureShortcut = shortcut;
      return true;
    }
  } catch {
    // invalid accelerator string
  }
  if (mainWindow) {
    mainWindow.webContents.send('capture-shortcut-failed', shortcut);
  }
  return false;
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

ipcMain.on('hide-capture-window', () => {
  if (captureWindow && !captureWindow.isDestroyed()) captureWindow.hide();
});

// Append one captured line to today's daily note, creating it (and the
// "## Quick Capture" section) as needed. The daily note may live anywhere in
// the notebook; it's found by basename so movers keep their note.
ipcMain.handle('append-quick-capture', async (event, text: string) => {
  const settings = await readSettings();
  const root = settings.notebookRoot;
  if (!root || !fs.existsSync(root)) return { success: false, reason: 'No notebook folder is set.' };

  const trimmed = String(text || '').replace(/\s*\n\s*/g, ' ').trim();
  if (!trimmed) return { success: false, reason: 'Nothing to capture.' };

  const today = localDateString();
  const dailyName = `${today}.md`;

  // Find today's note anywhere in the tree
  const ignore = new Set(settings.ignoreFolders.map(s => s.toLowerCase()));
  const allFiles = await listMarkdownFiles(root, ignore, root);
  let notePath = allFiles.find(f => path.basename(f).toLowerCase() === dailyName) || '';

  if (!notePath) {
    // Same skeleton as create-page, title = the date
    const fm: string[] = ['---', `title: ${yamlValue(today)}`, `created: ${today}`];
    if (settings.author) fm.push(`author: ${yamlValue(settings.author)}`);
    fm.push(tagsYamlLine([]), '---', '', `# ${today}`, '');
    notePath = path.join(root, await uniqueMd(root, today));
    await fsp.writeFile(notePath, fm.join('\n'), 'utf8');
    const ord = await readOrderFile(root);
    ord.push(path.basename(notePath));
    await writeOrderFile(root, ord);
  }

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const entry = `- ${pad(now.getHours())}:${pad(now.getMinutes())} ${trimmed}`;

  const content = await fsp.readFile(notePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const headingIdx = lines.findIndex(l => /^##\s+Quick Capture\s*$/i.test(l));

  if (headingIdx === -1) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push('', '## Quick Capture', '', entry, '');
  } else {
    // End of the section: the next heading of any level, else EOF
    let end = lines.length;
    for (let i = headingIdx + 1; i < lines.length; i++) {
      if (/^#{1,6}\s/.test(lines[i])) { end = i; break; }
    }
    let insertAt = end;
    while (insertAt > headingIdx + 1 && lines[insertAt - 1].trim() === '') insertAt--;
    lines.splice(insertAt, 0, entry);
  }

  await writeNoteFile(notePath, lines.join('\n'), { snapshot: true });
  notifyFilesChanged();
  return { success: true, notePath };
});

// Inline helper: toggle checkboxes inside markdown file text
ipcMain.handle('toggle-task-at-line', async (event, filePath, lineIndex) => {
  if (!fs.existsSync(filePath)) return false;
  const content = await fsp.readFile(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  
  if (lineIndex >= 0 && lineIndex < lines.length) {
    const lineText = lines[lineIndex];
    const checkboxRegex = /^([ \t]*([-*+]\s+|\d+\.\s+)?)\[([ xX])\]/;
    const m = lineText.match(checkboxRegex);
    if (m) {
      const prefix = m[1] || '';
      const checkedChar = m[3];
      const newChecked = (checkedChar === ' ' ? 'x' : ' ');
      lines[lineIndex] = lineText.replace(checkboxRegex, `${prefix}[${newChecked}]`);
      await fsp.writeFile(filePath, lines.join('\n'), 'utf8');
      notifyFilesChanged();
      return true;
    }
  }
  return false;
});

// Toggle Mermaid block orientation at line
ipcMain.on('toggle-mermaid-orientation', async (event, lineIndex) => {
  // Let the renderer handle finding the current page path, since the main process doesn't track active note
  // So we send an IPC message to renderer to tell us what page is open and then toggle it
  if (mainWindow) {
    mainWindow.webContents.send('perform-mermaid-toggle', lineIndex);
  }
});

ipcMain.handle('open-external', async (event, url) => {
  await shell.openExternal(url);
  return true;
});
