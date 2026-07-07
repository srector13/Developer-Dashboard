import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const fsp = fs.promises;

let mainWindow: BrowserWindow | null = null;
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const ORDER_FILE = '.notebook-order';

interface AppSettings {
  notebookRoot: string;
  defaultPageWidth: 'standard' | 'wide' | 'full';
  defaultMermaidZoom: number;
  previewTheme: 'github' | 'github-dark' | 'off';
  ignoreFolders: string[];
  templatesFolder: string;
  author: string;
  scratchpadFile: string;
  autoSaveEnabled: boolean;
}

const defaultSettings: AppSettings = {
  notebookRoot: '',
  defaultPageWidth: 'standard',
  defaultMermaidZoom: 100,
  previewTheme: 'github',
  ignoreFolders: ['_media', 'attachments', 'templates', 'node_modules', '.git', '.vscode'],
  templatesFolder: 'templates',
  author: '',
  scratchpadFile: 'scratchpad.md',
  autoSaveEnabled: false,
};

// Config manager helpers
async function readSettings(): Promise<AppSettings> {
  try {
    const data = await fsp.readFile(SETTINGS_FILE, 'utf8');
    return { ...defaultSettings, ...JSON.parse(data) };
  } catch {
    return defaultSettings;
  }
}

async function writeSettings(settings: Partial<AppSettings>): Promise<AppSettings> {
  const current = await readSettings();
  const updated = { ...current, ...settings };
  await fsp.writeFile(SETTINGS_FILE, JSON.stringify(updated, null, 2), 'utf8');
  return updated;
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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  updateWatcher();
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
    try {
      watcher = fs.watch(settings.notebookRoot, { recursive: true }, (event, filename) => {
        if (filename && (filename.startsWith('.') || filename.includes('node_modules') || filename.includes('.notebook-order'))) {
          return;
        }
        if (mainWindow) {
          mainWindow.webContents.send('files-changed');
        }
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


app.whenReady().then(() => {
  createWindow();

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
  };

  // Scan tasks
  const lines = content.split(/\r?\n/);
  for (const l of lines) {
    if (/^([ \t]*([-*+]\s+|\d+\.\s+)?)\[ \]/i.test(l)) {
      meta.openTasks++;
    } else if (/^([ \t]*([-*+]\s+|\d+\.\s+)?)\[x\]/i.test(l)) {
      meta.completedTasks++;
    }
  }

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

async function scanDirectory(
  dir: string,
  rootDir: string,
  ignore: Set<string>,
  scratchpadFile: string,
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
      const childSec = await scanDirectory(fullPath, rootDir, ignore, scratchpadFile);
      sectionNode.sections.push(childSec);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      // Skip scratchpad.md if it is in the section root
      if (entry.name === scratchpadFile && relative === '') {
        continue;
      }
      try {
        const text = await fsp.readFile(fullPath, 'utf8');
        const meta = parseNoteMeta(text, fullPath);
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
ipcMain.handle('save-settings', (event, settings) => writeSettings(settings));

ipcMain.handle('get-notebook-tree', async (event, rootPath, filterTag) => {
  if (!rootPath || !fs.existsSync(rootPath)) return null;
  const settings = await readSettings();
  const ignore = new Set(settings.ignoreFolders.map(s => s.toLowerCase()));
  const rootNode = await scanDirectory(rootPath, rootPath, ignore, settings.scratchpadFile);

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

ipcMain.handle('write-note', async (event, filePath, content) => {
  await fsp.writeFile(filePath, content, 'utf8');
  if (mainWindow) {
    mainWindow.webContents.send('files-changed');
  }
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

async function uniqueMd(dir: string, baseSlug: string): Promise<string> {
  let candidate = `${baseSlug}.md`;
  let i = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${baseSlug}-${i}.md`;
    i++;
  }
  return candidate;
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
    const templatesDir = path.isAbsolute(settings.templatesFolder)
      ? settings.templatesFolder
      : path.join(settings.notebookRoot, settings.templatesFolder);
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

  if (mainWindow) {
    mainWindow.webContents.send('files-changed');
  }
  return fullPath;
});

ipcMain.handle('create-section', async (event, dirPath, name) => {
  const fullPath = path.join(dirPath, name.trim());
  if (!fs.existsSync(fullPath)) {
    await fsp.mkdir(fullPath, { recursive: true });
    if (mainWindow) {
      mainWindow.webContents.send('files-changed');
    }
  }
  return fullPath;
});

ipcMain.handle('delete-node', async (event, filePath) => {
  if (fs.existsSync(filePath)) {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) {
      await fsp.rm(filePath, { recursive: true });
    } else {
      await fsp.unlink(filePath);
      // Remove from order file
      const dir = path.dirname(filePath);
      const name = path.basename(filePath);
      const ord = await readOrderFile(dir);
      const idx = ord.indexOf(name);
      if (idx !== -1) {
        ord.splice(idx, 1);
        await writeOrderFile(dir, ord);
      }
    }
    if (mainWindow) {
      mainWindow.webContents.send('files-changed');
    }
  }
  return true;
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

  if (mainWindow) {
    mainWindow.webContents.send('files-changed');
  }
  return true;
});

ipcMain.handle('move-node', async (event, dirPath, fileName, direction) => {
  const ord = await readOrderFile(dirPath);
  
  // If order file is empty, initialize it with current sorted pages order
  if (ord.length === 0) {
    const settings = await readSettings();
    const ignore = new Set(settings.ignoreFolders.map(s => s.toLowerCase()));
    const secNode = await scanDirectory(dirPath, settings.notebookRoot, ignore, settings.scratchpadFile);
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
  if (mainWindow) {
    mainWindow.webContents.send('files-changed');
  }
  return true;
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
  if (mainWindow) {
    mainWindow.webContents.send('files-changed');
  }
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

  if (mainWindow) {
    mainWindow.webContents.send('files-changed');
  }

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

  if (mainWindow) {
    mainWindow.webContents.send('files-changed');
  }

  return { success: true, filePath: fullPath };
});

function runPandocStdin(input: string, from: string, to: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Try homebrew path or direct path
    const pandocPath = process.platform === 'darwin' && fs.existsSync('/opt/homebrew/bin/pandoc')
      ? '/opt/homebrew/bin/pandoc'
      : 'pandoc';
      
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
  return new Promise((resolve, reject) => {
    const pandocPath = process.platform === 'darwin' && fs.existsSync('/opt/homebrew/bin/pandoc')
      ? '/opt/homebrew/bin/pandoc'
      : 'pandoc';

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

// PDF Native Export using Electron webContents.printToPDF
ipcMain.handle('export-to-pdf', async (event, filePath, htmlContent) => {
  const result = await dialog.showSaveDialog(mainWindow!, {
    title: 'Export to PDF',
    defaultPath: filePath.replace(/\.md$/i, '.pdf'),
    filters: [{ name: 'PDF Document', extensions: ['pdf'] }],
  });

  if (result.canceled || !result.filePath) return false;
  const pdfPath = result.filePath;

  // Render HTML in a hidden BrowserWindow
  const printWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Inject some minimal styled wrapper to look professional on page prints
  const styledHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
          color: #24292e;
          line-height: 1.6;
          padding: 40px;
          background: #ffffff;
        }
        h1, h2, h3, h4, h5, h6 {
          margin-top: 24px;
          margin-bottom: 16px;
          font-weight: 600;
          line-height: 1.25;
        }
        h1 { font-size: 2em; border-bottom: 1px solid #eaecef; padding-bottom: .3em; }
        h2 { font-size: 1.5em; border-bottom: 1px solid #eaecef; padding-bottom: .3em; }
        h3 { font-size: 1.25em; }
        pre, code {
          font-family: SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace;
          background-color: #f6f8fa;
          border-radius: 3px;
        }
        pre {
          padding: 16px;
          overflow: auto;
          font-size: 85%;
          line-height: 1.45;
        }
        code {
          padding: .2em .4em;
          margin: 0;
          font-size: 85%;
        }
        pre code {
          padding: 0;
          background-color: transparent;
        }
        blockquote {
          padding: 0 1em;
          color: #6a737d;
          border-left: .25em solid #dfe2e5;
          margin: 0 0 16px 0;
        }
        table {
          border-spacing: 0;
          border-collapse: collapse;
          width: 100%;
          margin-bottom: 16px;
        }
        table th, table td {
          padding: 6px 13px;
          border: 1px solid #dfe2e5;
        }
        table tr {
          background-color: #fff;
          border-top: 1px solid #c6cbd1;
        }
        table tr:nth-child(2n) {
          background-color: #f6f8fa;
        }
        img {
          max-width: 100%;
          box-sizing: content-box;
        }
        .task-checkbox {
          vertical-align: middle;
          margin-right: 8px;
        }
        a {
          color: #0366d6;
          text-decoration: none;
        }
        /* Page break controls */
        h1, h2, h3 { page-break-after: avoid; }
        pre, blockquote, table, img { page-break-inside: avoid; }
      </style>
    </head>
    <body>
      ${htmlContent}
    </body>
    </html>
  `;

  await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(styledHtml)}`);

  try {
    const data = await printWindow.webContents.printToPDF({
      printBackground: true,
      margins: {
        marginType: 'default',
      },
      pageSize: 'A4',
      preferCSSPageSize: true,
    });
    await fsp.writeFile(pdfPath, data);
    printWindow.destroy();
    return true;
  } catch (err) {
    console.error('Failed to print to PDF:', err);
    printWindow.destroy();
    return false;
  }
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
      if (mainWindow) {
        mainWindow.webContents.send('files-changed');
      }
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
