import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { promptMetadata, localDateKey } from './metadataPrompt';
import { invalidFolderNameReason } from './notebookFs';

const fsp = fs.promises;

const DEFAULT_IGNORE = ['_media', 'attachments', 'templates', 'node_modules', '.git', '.vscode'];
const MAX_PARSE_BYTES = 512 * 1024; // don't slurp huge files just to read a title
const PINNED_SCAN_BUDGET = 2000; // safety cap on the recursive pinned scan
const ORDER_FILE = '.notebook-order'; // per-folder manual ordering sidecar
const DND_MIME = 'application/vnd.code.tree.markdownnotebook';
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
// The closing fence must be a line of exactly "---", so lines like "----" or
// "--- continued" inside the block don't end the frontmatter early. The
// lookahead keeps the match length identical to the old, unanchored form.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?=[ \t]*(?:\r?\n|$))/;

type NodeKind = 'section' | 'page';

interface NoteMeta {
  title?: string;
  pinned: boolean;
  tags: string[];
  openTasks: number;
  completedTasks: number;
  date?: string;
}

function getIconUri(name: string): vscode.Uri | vscode.ThemeIcon {
  const ext = vscode.extensions.getExtension('stephen-rector.markdown-notebook');
  if (ext) {
    return vscode.Uri.joinPath(ext.extensionUri, 'resources', `${name}.svg`);
  }
  return new vscode.ThemeIcon(
    name === 'section'
      ? 'book'
      : name === 'pinned'
      ? 'star-full'
      : name === 'daily'
      ? 'calendar'
      : 'note',
  );
}

function getSectionIcon(folderName: string): vscode.Uri | vscode.ThemeIcon {
  const lower = folderName.toLowerCase();
  if (/meeting|sync|call|calendar|discussion|1on1|1:1/.test(lower)) {
    return getIconUri('section-meetings');
  }
  if (/email|newsletter|mail|inbox|sent|outbox/.test(lower)) {
    return getIconUri('section-emails');
  }
  if (/project|task|todo|board|scrum|sprint|kanban|milestone/.test(lower)) {
    return getIconUri('section-projects');
  }
  if (/archive|vault|old|backup|history|deprecated|bin/.test(lower)) {
    return getIconUri('section-archive');
  }
  if (/document|documents|doc|docs|paper|report|file|files/.test(lower)) {
    return getIconUri('section-documents');
  }
  return getIconUri('section');
}

function makeTaskProgressBar(open: number, completed: number): string {
  const total = open + completed;
  if (total === 0) { return ''; }
  const percent = Math.round((completed / total) * 100);
  const length = 5;
  const filled = Math.round((completed / total) * length);
  const bar = '▰'.repeat(filled) + '▱'.repeat(length - filled);
  return `${bar} ${percent}%`;
}

/** A node in the notebook tree — either a section (folder) or a page (.md file). */
class NoteNode extends vscode.TreeItem {
  constructor(
    public readonly fsPath: string,
    public readonly kind: NodeKind,
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly dailyKey?: string, // YYYY-MM-DD when this is a daily note, for sorting
    collapseVersion: number = 0,
  ) {
    super(label, collapsibleState);
    this.resourceUri = vscode.Uri.file(fsPath);
    this.id = fsPath + '-' + collapseVersion;
  }
}

export class NotebookProvider implements vscode.TreeDataProvider<NoteNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<NoteNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  public activeTagFilter: string | undefined = undefined;
  public collapseVersion = 0;

  constructor(private readonly getRoot: () => vscode.Uri | undefined) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: NoteNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: NoteNode): Promise<NoteNode[]> {
    const cfg = vscode.workspace.getConfiguration('markdownNotebook');
    const ignore = new Set(
      (cfg.get<string[]>('ignoreFolders', DEFAULT_IGNORE) ?? DEFAULT_IGNORE).map((s) => s.toLowerCase()),
    );
    const dailyRegexes = getDailyRegexes(cfg);

    const root = this.getRoot();
    if (!root) {
      return [];
    }

    const masterTOCPath = path.join(root.fsPath, '.toc.md');

    if (element) {
      if (element.contextValue === 'masterTOC') {
        // Children of the Master TOC (Notebook Dashboard): return pinned files, sections, and root pages
        let { sections, pages } = await readFolder(root.fsPath, ignore, dailyRegexes, this.collapseVersion);
        const pinnedAnywhere = await scanPinned(root.fsPath, ignore, dailyRegexes, { count: 0 }, 0, this.collapseVersion);
        const rootLevelPinnedPaths = new Set(
          pages.filter((p) => p.contextValue === 'pinnedPage').map((p) => p.fsPath),
        );
        let deeperPinned = pinnedAnywhere.filter((p) => !rootLevelPinnedPaths.has(p.fsPath));
        let nonPinned = pages.filter((p) => p.contextValue !== 'pinnedPage');

        // Apply active tag filter
        if (this.activeTagFilter) {
          const tag = this.activeTagFilter;
          const tagLower = tag.toLowerCase();

          const filteredSecs: NoteNode[] = [];
          for (const sec of sections) {
            if (await hasPagesWithTag(sec.fsPath, tag, ignore)) {
              filteredSecs.push(sec);
            }
          }
          sections = filteredSecs;

          const filteredPages: NoteNode[] = [];
          for (const p of pages) {
            const meta = await readMeta(p.fsPath);
            if (meta.tags.map(t => t.toLowerCase()).includes(tagLower)) {
              filteredPages.push(p);
            }
          }
          pages = filteredPages;

          const filteredPinned: NoteNode[] = [];
          for (const p of deeperPinned) {
            const meta = await readMeta(p.fsPath);
            if (meta.tags.map(t => t.toLowerCase()).includes(tagLower)) {
              filteredPinned.push(p);
            }
          }
          deeperPinned = filteredPinned;

          const filteredNonPinned: NoteNode[] = [];
          for (const p of nonPinned) {
            const meta = await readMeta(p.fsPath);
            if (meta.tags.map(t => t.toLowerCase()).includes(tagLower)) {
              filteredNonPinned.push(p);
            }
          }
          nonPinned = filteredNonPinned;
        }

        return [
          ...sortPages(pages.filter((p) => p.contextValue === 'pinnedPage')),
          ...deeperPinned,
          ...sections,
          ...(await orderPages(root.fsPath, nonPinned)),
        ];
      }

      // Children of a section folder.
      let { sections, pages } = await readFolder(element.fsPath, ignore, dailyRegexes, this.collapseVersion);
      
      // Apply active tag filter
      if (this.activeTagFilter) {
        const tag = this.activeTagFilter;
        const tagLower = tag.toLowerCase();

        const filteredSecs: NoteNode[] = [];
        for (const sec of sections) {
          if (await hasPagesWithTag(sec.fsPath, tag, ignore)) {
            filteredSecs.push(sec);
          }
        }
        sections = filteredSecs;

        const filteredPages: NoteNode[] = [];
        for (const p of pages) {
          const meta = await readMeta(p.fsPath);
          if (meta.tags.map(t => t.toLowerCase()).includes(tagLower)) {
            filteredPages.push(p);
          }
        }
        pages = filteredPages;
      }

      return [...sections, ...(await orderPages(element.fsPath, pages))];
    }

    // Root level: return ONLY the single bolded Notebook Dashboard node (expanded by default)!
    try {
      await updateMasterTOC(root.fsPath);
    } catch { /* ignore */ }

    // Bold the label using Unicode Mathematical Bold Sans-Serif characters: 𝗡𝗼𝘁𝗲𝗯𝗼𝗼𝗸
    const boldLabel = '𝗡𝗼𝘁𝗲𝗯𝗼𝗼𝗸';
    const masterTOCNode = new NoteNode(
      masterTOCPath,
      'page',
      boldLabel,
      vscode.TreeItemCollapsibleState.Expanded,
      undefined,
      this.collapseVersion
    );
    // Get rid of the icon
    masterTOCNode.iconPath = undefined;
    masterTOCNode.command = {
      command: 'markdownNotebook.openPage',
      title: 'Open Dashboard',
      arguments: [masterTOCNode.resourceUri]
    };
    masterTOCNode.contextValue = 'masterTOC';
    if (this.activeTagFilter) {
      masterTOCNode.description = `Active Filter: #${this.activeTagFilter}`;
    }

    return [masterTOCNode];
  }
}


/**
 * Parse a date fragment matched by a daily-note pattern into a YYYY-MM-DD key.
 * Accepts year-first (2026-06-10) and US-first with 2- or 4-digit years
 * (6-10-26), and validates month/day ranges so e.g. 31-12-2026 isn't taken
 * for month 31.
 */
function parseDailyKey(fragment: string): string | undefined {
  let y: number;
  let m: number;
  let d: number;
  const yearFirst = fragment.match(/(\d{4})[-_](\d{1,2})[-_](\d{1,2})/);
  if (yearFirst) {
    y = +yearFirst[1];
    m = +yearFirst[2];
    d = +yearFirst[3];
  } else {
    const usFirst = fragment.match(/(\d{1,2})[-_](\d{1,2})[-_](\d{4}|\d{2})(?!\d)/);
    if (!usFirst) {
      return undefined;
    }
    m = +usFirst[1];
    d = +usFirst[2];
    y = usFirst[3].length === 2 ? 2000 + +usFirst[3] : +usFirst[3];
  }
  if (m < 1 || m > 12 || d < 1 || d > 31) {
    return undefined;
  }
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function computeDisplayTitle(name: string, meta: NoteMeta, dailyRegexes: RegExp[]): string {
  let isDaily = false;
  let dailyKey: string | undefined = undefined;
  let matchedDateStr: string | undefined = undefined;

  for (const re of dailyRegexes) {
    const match = name.match(re);
    if (match && parseDailyKey(match[0])) {
      isDaily = true;
      matchedDateStr = match[0];
      break;
    }
  }

  // Clean up date string from the custom title if it exists.
  let cleanTitle = meta.title?.trim();
  if (cleanTitle && isDaily && matchedDateStr) {
    if (cleanTitle.includes(matchedDateStr)) {
      cleanTitle = cleanTitle.replace(matchedDateStr, '');
    } else {
      for (const re of dailyRegexes) {
        const m = cleanTitle.match(re);
        if (m) {
          cleanTitle = cleanTitle.replace(m[0], '');
          break;
        }
      }
    }
    cleanTitle = cleanTitle.replace(/^[-_\s]+|[-_\s]+$/g, '').trim();
  }

  // Determine the display label for the note.
  let label: string;
  if (isDaily) {
    if (cleanTitle) {
      label = cleanTitle;
    } else {
      let cleanName = name.replace(/\.md$/i, '');
      if (matchedDateStr) {
        cleanName = cleanName.replace(matchedDateStr, '');
        cleanName = cleanName.replace(/^[-_\s]+|[-_\s]+$/g, '').trim();
      }
      if (cleanName) {
        label = prettyName(cleanName);
      } else {
        label = name.replace(/\.md$/i, '');
      }
    }
  } else {
    label = cleanTitle || prettyName(name);
  }
  
  // Turn all underscores in final displayed tree labels into visually appealing spaces
  return label.replace(/_+/g, ' ');
}

async function readFolder(
  dir: string,
  ignore: Set<string>,
  dailyRegexes: RegExp[],
  collapseVersion = 0,
): Promise<{ sections: NoteNode[]; pages: NoteNode[] }> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return { sections: [], pages: [] };
  }

  const sections: NoteNode[] = [];
  const pages: NoteNode[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (ignore.has(entry.name.toLowerCase())) {
        continue;
      }
      const label = prettyName(entry.name);
      const childCount = await countPages(full, ignore);
      const collapsibleState = childCount > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
      
      const node = new NoteNode(full, 'section', label, collapsibleState, undefined, collapseVersion);
      node.iconPath = getSectionIcon(entry.name);
      node.contextValue = 'section';
      node.command = {
        command: 'markdownNotebook.openDashboard',
        title: 'Open Table of Contents',
        arguments: [node],
      };
      if (childCount > 0) {
        node.description = String(childCount);
      }
      node.tooltip = full;
      sections.push(node);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      pages.push(await makePage(full, entry.name, dailyRegexes, collapseVersion));
    }
  }

  sections.sort((a, b) => collator.compare(String(a.label), String(b.label)));
  return { sections, pages };
}



async function makePage(full: string, name: string, dailyRegexes: RegExp[], collapseVersion = 0): Promise<NoteNode> {
  const meta = await readMeta(full);
  let isDaily = false;
  let dailyKey: string | undefined = undefined;

  for (const re of dailyRegexes) {
    const match = name.match(re);
    if (match) {
      const key = parseDailyKey(match[0]);
      if (key) {
        isDaily = true;
        dailyKey = key;
        break;
      }
    }
  }

  const label = computeDisplayTitle(name, meta, dailyRegexes);

  const node = new NoteNode(full, 'page', label, vscode.TreeItemCollapsibleState.None, dailyKey, collapseVersion);
  node.command = { command: 'markdownNotebook.openPage', title: 'Open Page', arguments: [node.resourceUri] };

  // Icon + classification (pinned wins over daily wins over tag-matched wins over plain page).
  let matchedIcon = 'page';
  if (meta.pinned) {
    node.iconPath = getIconUri('pinned');
    node.contextValue = 'pinnedPage';
  } else if (isDaily) {
    node.iconPath = getIconUri('daily');
    node.contextValue = 'dailyPage';
  } else {
    // Dynamic page icon resolution based on matching tag keywords
    for (const tag of meta.tags) {
      const lower = tag.toLowerCase();
      if (/email|emails|mail|inbox|sent/.test(lower)) {
        matchedIcon = 'page-emails';
        break;
      }
      if (/project|projects|task|tasks|todo|todos|board/.test(lower)) {
        matchedIcon = 'page-projects';
        break;
      }
      if (/archive|old|deprecated|history|vault/.test(lower)) {
        matchedIcon = 'page-archive';
        break;
      }
      if (/meeting|meetings|sync|call|1on1/.test(lower)) {
        matchedIcon = 'page-meetings';
        break;
      }
      if (/document|documents|doc|docs|converted|imported/.test(lower)) {
        matchedIcon = 'page-documents';
        break;
      }
    }
    node.iconPath = getIconUri(matchedIcon);
    node.contextValue = 'notePage';
  }

  // Inline description: event/tagged date, task counts, and non-semantic tag pills.
  const bits: string[] = [];

  // 1. Show date ONLY if it is parsed from the filename (dailyKey) or tagged in frontmatter (meta.date)
  if (isDaily && dailyKey) {
    bits.push(formatDateContext(dailyKey));
  } else if (meta.date) {
    const match = meta.date.match(/(\d{4})[-_](\d{1,2})[-_](\d{1,2})/);
    if (match) {
      bits.push(formatDateContext(`${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`));
    } else {
      bits.push(meta.date);
    }
  }

  // 2. Skip semantic tags from appearing as #tag text pills to keep description tidy
  const SEMANTIC_CATEGORIES = new Set([
    'meetings', 'meeting', 'sync', 'call', '1on1',
    'emails', 'email', 'mail', 'inbox', 'sent',
    'projects', 'project', 'task', 'tasks', 'todo', 'todos', 'board',
    'archive', 'old', 'deprecated', 'history', 'vault',
    'documents', 'document', 'doc', 'docs'
  ]);
  const displayTags = meta.tags.filter((t) => !SEMANTIC_CATEGORIES.has(t.toLowerCase()));
  if (displayTags.length > 0) {
    bits.push(displayTags.slice(0, 2).map((t) => `#${t}`).join(' '));
  }

  if (meta.openTasks > 0 || meta.completedTasks > 0) {
    const total = meta.openTasks + meta.completedTasks;
    const progress = makeTaskProgressBar(meta.openTasks, meta.completedTasks);
    bits.push(`${progress} (${meta.completedTasks}/${total})`);
  }
  node.description = bits.join(' · ');

  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${escapeMd(label)}**\n\n`);
  if (meta.tags.length) {
    md.appendMarkdown(`Tags: ${meta.tags.map((t) => `\`#${t}\``).join(' ')}\n\n`);
  }
  md.appendMarkdown(`\`${full}\``);
  node.tooltip = md;

  return node;
}

/** Recursively collect pinned pages from anywhere under root (depth- and budget-limited). */
async function scanPinned(
  dir: string,
  ignore: Set<string>,
  dailyRegexes: RegExp[],
  budget: { count: number },
  depth = 0,
  collapseVersion = 0,
): Promise<NoteNode[]> {
  if (depth > 6 || budget.count > PINNED_SCAN_BUDGET) {
    return [];
  }
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: NoteNode[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    budget.count++;
    if (budget.count > PINNED_SCAN_BUDGET) {
      break;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (ignore.has(entry.name.toLowerCase())) {
        continue;
      }
      found.push(...(await scanPinned(full, ignore, dailyRegexes, budget, depth + 1, collapseVersion)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      const meta = await readMeta(full);
      if (meta.pinned) {
        const page = await makePage(full, entry.name, dailyRegexes, collapseVersion);
        // The same note also appears as a child of its section; tree item ids
        // must be unique, so the pinned copy gets its own id.
        page.id = `${page.id}-pinned`;
        found.push(page);
      }
    }
  }
  return found;
}

async function countPages(dir: string, ignore: Set<string>): Promise<number> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let n = 0;
  for (const e of entries) {
    if (e.name.startsWith('.')) {
      continue;
    }
    if (e.name.toLowerCase() === '.toc.md') {
      continue;
    }
    if (e.isDirectory() && !ignore.has(e.name.toLowerCase())) {
      n++;
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      n++;
    }
  }
  return n;
}

async function hasPagesWithTag(dirPath: string, tag: string, ignore: Set<string>, depth = 0): Promise<boolean> {
  if (depth > 8) {
    return false; // depth cap also guards against cyclic symlinks
  }
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) { continue; }
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (ignore.has(entry.name.toLowerCase())) { continue; }
      if (await hasPagesWithTag(full, tag, ignore, depth + 1)) {
        return true;
      }
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md') && entry.name !== '.toc.md') {
      const meta = await readMeta(full);
      if (meta.tags.map(t => t.toLowerCase()).includes(tag.toLowerCase())) {
        return true;
      }
    }
  }
  return false;
}

async function readMeta(full: string): Promise<NoteMeta> {
  const meta: NoteMeta = { pinned: false, tags: [], openTasks: 0, completedTasks: 0 };
  let content = '';
  try {
    const stat = await fsp.stat(full);
    if (stat.size > MAX_PARSE_BYTES) {
      return meta;
    }
    content = await fsp.readFile(full, 'utf8');
  } catch {
    return meta;
  }

  // Frontmatter block.
  const fm = content.match(FRONTMATTER_RE);
  if (fm) {
    const lines = fm[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const kv = lines[i].match(/^(\w[\w-]*):\s*(.*)$/);
      if (!kv) {
        continue;
      }
      const key = kv[1].toLowerCase();
      const value = kv[2].trim();
      if (key === 'title') {
        meta.title = stripQuotes(value);
      } else if (key === 'pinned') {
        meta.pinned = /^(true|yes)$/i.test(value);
      } else if (key === 'tags') {
        meta.tags = value ? parseInlineList(value) : parseBlockList(lines, i + 1);
      } else if (key === 'created' || key === 'date') {
        meta.date = stripQuotes(value);
      }
    }
  }

  if (!meta.title) {
    const body = fm ? content.slice(fm[0].length) : content;
    const h1 = body.match(/^#\s+(.+?)\s*$/m);
    if (h1) {
      meta.title = h1[1].trim();
    }
  }

  const tasks = content.match(/^[ \t]*[-*]\s+\[ \]/gm);
  meta.openTasks = tasks ? tasks.length : 0;

  const completed = content.match(/^[ \t]*[-*]\s+\[[xX]\]/gm);
  meta.completedTasks = completed ? completed.length : 0;

  return meta;
}

function sortPages(pages: NoteNode[]): NoteNode[] {
  const daily = pages.filter((p) => p.dailyKey);
  const rest = pages.filter((p) => !p.dailyKey);
  daily.sort((a, b) => (b.dailyKey ?? '').localeCompare(a.dailyKey ?? '')); // newest first
  rest.sort((a, b) => collator.compare(String(a.label), String(b.label)));
  return [...daily, ...rest];
}

/** Apply a folder's manual order (.notebook-order sidecar); unlisted pages fall back to sortPages. */
async function orderPages(dir: string, pages: NoteNode[]): Promise<NoteNode[]> {
  const order = await readOrderFile(dir);
  if (order.length === 0) {
    return sortPages(pages);
  }
  const index = new Map<string, number>();
  order.forEach((name, i) => index.set(name.toLowerCase(), i));
  const listed: NoteNode[] = [];
  const rest: NoteNode[] = [];
  for (const p of pages) {
    (index.has(path.basename(p.fsPath).toLowerCase()) ? listed : rest).push(p);
  }
  listed.sort(
    (a, b) =>
      (index.get(path.basename(a.fsPath).toLowerCase()) ?? 0) -
      (index.get(path.basename(b.fsPath).toLowerCase()) ?? 0),
  );
  // Daily notes sort newest-first by design, so new (unlisted) dailies go
  // before the manually ordered entries — otherwise one manual reorder would
  // freeze the list and every future daily note would land at the bottom.
  const restDaily = rest.filter((p) => p.dailyKey);
  const restOther = rest.filter((p) => !p.dailyKey);
  return [...sortPages(restDaily), ...listed, ...sortPages(restOther)];
}

async function readOrderFile(dir: string): Promise<string[]> {
  try {
    const txt = await fsp.readFile(path.join(dir, ORDER_FILE), 'utf8');
    return txt.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

async function writeOrderFile(dir: string, names: string[]): Promise<void> {
  const target = path.join(dir, ORDER_FILE);
  if (names.length === 0) {
    try {
      await fsp.unlink(target);
    } catch {
      /* nothing to remove */
    }
    return;
  }
  await fsp.writeFile(target, names.join('\n') + '\n', 'utf8');
}

/** The page nodes in the exact order the tree currently shows them for a folder. */
async function displayOrderNodes(dir: string): Promise<NoteNode[]> {
  const cfg = vscode.workspace.getConfiguration('markdownNotebook');
  const ignore = new Set(
    (cfg.get<string[]>('ignoreFolders', DEFAULT_IGNORE) ?? DEFAULT_IGNORE).map((s) => s.toLowerCase()),
  );
  const dailyRegexes = getDailyRegexes(cfg);
  const { pages } = await readFolder(dir, ignore, dailyRegexes);
  return orderPages(dir, pages);
}

/** The page basenames in the exact order the tree currently shows them for a folder. */
async function displayOrder(dir: string): Promise<string[]> {
  return (await displayOrderNodes(dir)).map((p) => path.basename(p.fsPath));
}

/** YAML block-style list (the common Obsidian form): `tags:` followed by indented `- item` lines. */
function parseBlockList(lines: string[], startIdx: number): string[] {
  const items: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const m = lines[i].match(/^\s+-\s*(.+)$/);
    if (!m) {
      break;
    }
    const item = stripQuotes(m[1].trim()).replace(/^#/, '');
    if (item) {
      items.push(item);
    }
  }
  return items;
}

function parseInlineList(value: string): string[] {
  const inline = value.match(/^\[(.*)\]$/);
  const raw = inline ? inline[1] : value;
  return raw
    .split(',')
    .map((s) => stripQuotes(s.trim()).replace(/^#/, ''))
    .filter((s) => s.length > 0);
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, '');
}

function prettyName(name: string): string {
  const base = name.replace(/\.md$/i, '').replace(/_+/g, ' ').trim();
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function formatDailyLabel(key: string): string | undefined {
  const d = new Date(`${key}T00:00:00`);
  if (isNaN(d.getTime())) {
    return undefined;
  }
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Compact date for use beside a title; adds the year only when it isn't the current one. */
function formatDateContext(key: string): string {
  const d = new Date(`${key}T00:00:00`);
  if (isNaN(d.getTime())) {
    return key;
  }
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === new Date().getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' };
  return d.toLocaleDateString('en-US', opts);
}

function relativeDay(key: string): string {
  const d = new Date(`${key}T00:00:00`);
  if (isNaN(d.getTime())) {
    return key;
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - d.getTime()) / 86400000);
  if (diff === 0) {
    return 'today';
  }
  if (diff === 1) {
    return 'yesterday';
  }
  if (diff > 1) {
    return `${diff} days ago`;
  }
  return diff === -1 ? 'tomorrow' : `in ${-diff} days`;
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}\[\]()#+\-.!]/g, '\\$&');
}

function safeRegExp(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

function getDailyRegexes(cfg: vscode.WorkspaceConfiguration): RegExp[] {
  const rawPattern = cfg.get<any>('dailyNotePattern');
  let patterns: string[] = [];
  if (Array.isArray(rawPattern)) {
    patterns = rawPattern;
  } else if (typeof rawPattern === 'string') {
    patterns = [rawPattern];
  } else {
    patterns = ['^\\d{4}-\\d{2}-\\d{2}'];
  }
  return patterns.map((p) => safeRegExp(p)).filter((r): r is RegExp => !!r);
}

/** Resolve the notebook root from settings, falling back to the first workspace folder. */
export function resolveRoot(): vscode.Uri | undefined {
  const folders = vscode.workspace.workspaceFolders;
  const configured = vscode.workspace.getConfiguration('markdownNotebook').get<string>('root', '').trim();
  if (configured) {
    if (path.isAbsolute(configured)) {
      return vscode.Uri.file(configured);
    }
    if (folders && folders.length > 0) {
      return vscode.Uri.joinPath(folders[0].uri, configured);
    }
  }
  return folders && folders.length > 0 ? folders[0].uri : undefined;
}

// ───────────────────────── Index regeneration (TOCs, dashboard) ─────────────────────────
// Every write to .toc.md / .tasks.md goes through a single lock so concurrent
// triggers (file watchers, saves, renames) can't interleave writes to the same file.
let indexLock: Promise<unknown> = Promise.resolve();
function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = indexLock.then(fn, fn);
  indexLock = run.catch(() => undefined);
  return run;
}

function dirChainToRoot(startDir: string, rootDir: string): string[] {
  const root = path.normalize(rootDir);
  const chain: string[] = [];
  let currentDir = path.normalize(startDir);
  // Require a separator boundary so a sibling like "/notes-archive" is not
  // mistaken for being inside a root of "/notes".
  while (currentDir === root || currentDir.startsWith(root + path.sep)) {
    chain.push(currentDir);
    if (currentDir === root) break;
    const parent = path.dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }
  return chain;
}

// Helper to update TOCs up the chain
export async function updateTOCsUpToRoot(startDir: string, rootDir: string) {
  await withIndexLock(async () => {
    for (const dir of dirChainToRoot(startDir, rootDir)) {
      await updateTOCImpl(dir);
    }
  });
}

// Debounced, coalesced refresh of all indexes affected by a set of changed
// directories. Watcher and save events funnel through here, so a burst of
// changes (git checkout, bulk import) results in a single notebook-wide pass.
const pendingIndexDirs = new Set<string>();
const pendingIndexCallbacks = new Set<() => void>();
let pendingIndexRoot: string | undefined;
let pendingIndexTimer: ReturnType<typeof setTimeout> | undefined;

export function scheduleIndexUpdate(startDir: string, rootDir: string, onDone?: () => void): void {
  pendingIndexDirs.add(startDir);
  pendingIndexRoot = rootDir;
  if (onDone) {
    pendingIndexCallbacks.add(onDone);
  }
  if (pendingIndexTimer) {
    clearTimeout(pendingIndexTimer);
  }
  pendingIndexTimer = setTimeout(() => {
    pendingIndexTimer = undefined;
    const dirs = [...pendingIndexDirs];
    pendingIndexDirs.clear();
    const root = pendingIndexRoot!;
    const callbacks = [...pendingIndexCallbacks];
    pendingIndexCallbacks.clear();
    void withIndexLock(async () => {
      const chain = new Set<string>();
      for (const d of dirs) {
        for (const c of dirChainToRoot(d, root)) {
          chain.add(c);
        }
      }
      for (const dir of chain) {
        await updateTOCImpl(dir);
      }
      await updateMasterTOCImpl(root);
      await updateTasksDashboardImpl(root);
    })
      .catch((err) => console.error('Notebook: index update failed:', err))
      .finally(() => {
        for (const cb of callbacks) {
          cb();
        }
      });
  }, 500);
}

export function registerNotebook(context: vscode.ExtensionContext): void {
  const provider = new NotebookProvider(resolveRoot);
  const view = vscode.window.createTreeView('markdownNotebook.view', {
    treeDataProvider: provider,
    dragAndDropController: new NotebookDnD(provider),
  });
  context.subscriptions.push(view);

  context.subscriptions.push(
    vscode.commands.registerCommand('markdownNotebook.collapseAll', () => {
      provider.collapseVersion++;
      provider.refresh();
    }),
    vscode.commands.registerCommand('markdownNotebook.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('markdownNotebook.openDashboard', async (node?: NoteNode) => {
      let dirPath: string | undefined;
      if (node && node.kind === 'section') {
        dirPath = node.fsPath;
      } else {
        dirPath = resolveRoot()?.fsPath;
      }
      if (!dirPath) { return; }
      const tocPath = path.join(dirPath, '.toc.md');
      await updateTOC(dirPath);
      const uri = vscode.Uri.file(tocPath);
      await vscode.commands.executeCommand('markdownNotebook.openPage', uri);
    }),
    vscode.commands.registerCommand('markdownNotebook.newPage', (node?: NoteNode) =>
      newPage(node, provider),
    ),
    vscode.commands.registerCommand('markdownNotebook.newSection', (node?: NoteNode) =>
      newSection(node, provider),
    ),
    vscode.commands.registerCommand('markdownNotebook.newDailyNote', () =>
      newDailyNote(provider),
    ),
    vscode.commands.registerCommand('markdownNotebook.revealInExplorer', (node?: NoteNode) => {
      if (node) {
        vscode.commands.executeCommand('revealInExplorer', node.resourceUri);
      }
    }),
    vscode.commands.registerCommand('markdownNotebook.deleteNode', (node?: NoteNode) =>
      deleteNode(node, provider),
    ),
    vscode.commands.registerCommand('markdownNotebook.newFromTemplate', (node?: NoteNode) =>
      newFromTemplate(node, provider),
    ),
    vscode.commands.registerCommand('markdownNotebook.renamePage', (node?: NoteNode) =>
      renamePage(node, provider),
    ),
    vscode.commands.registerCommand('markdownNotebook.renameSection', (node?: NoteNode) =>
      renameSection(node, provider),
    ),
    vscode.commands.registerCommand('markdownNotebook.moveUp', (node?: NoteNode) =>
      movePage(node, -1, provider),
    ),
    vscode.commands.registerCommand('markdownNotebook.moveDown', (node?: NoteNode) =>
      movePage(node, 1, provider),
    ),
    vscode.commands.registerCommand('markdownNotebook.addNewMenu', async (node?: NoteNode) => {
      const selection = await vscode.window.showQuickPick([
        { label: '$(file-add) New Note', description: 'Create a new markdown note document', id: 'page' },
        { label: '$(new-folder) New Section', description: 'Create a new folder section', id: 'section' },
        { label: '$(diff-added) New Daily Note', description: 'Create or open today\'s daily task note', id: 'daily' },
        { label: '$(symbol-snippet) New from Template', description: 'Create a note from a pre-made template', id: 'template' }
      ], {
        placeHolder: 'Add New Note or Section'
      });

      if (!selection) { return; }
      if (selection.id === 'page') {
        await vscode.commands.executeCommand('markdownNotebook.newPage', node);
      } else if (selection.id === 'section') {
        await vscode.commands.executeCommand('markdownNotebook.newSection', node);
      } else if (selection.id === 'daily') {
        await vscode.commands.executeCommand('markdownNotebook.newDailyNote');
      } else if (selection.id === 'template') {
        await vscode.commands.executeCommand('markdownNotebook.newFromTemplate', node);
      }
    }),
    vscode.commands.registerCommand('markdownNotebook.importMenu', async (node?: NoteNode) => {
      const selection = await vscode.window.showQuickPick([
        { label: '$(clippy) Import Clipboard as Note', description: 'Convert clipboard text/link directly into a note', id: 'clipboard' },
        { label: '$(desktop-download) Import Document (Pandoc)', description: 'Convert Word/HTML/Office document to markdown note', id: 'pandoc' }
      ], {
        placeHolder: 'Import Note Content'
      });

      if (!selection) { return; }
      if (selection.id === 'clipboard') {
        await vscode.commands.executeCommand('markdownNotebook.importFromClipboard', node);
      } else if (selection.id === 'pandoc') {
        await vscode.commands.executeCommand('markdownNotebook.importDocument', node);
      }
    }),
    vscode.commands.registerCommand('markdownNotebook.openTasksDashboard', async () => {
      const root = resolveRoot();
      if (!root) {
        vscode.window.showErrorMessage('Notebook: open a folder first.');
        return;
      }
      const tasksPath = path.join(root.fsPath, '.tasks.md');
      await updateTasksDashboard(root.fsPath);
      const uri = vscode.Uri.file(tasksPath);
      await vscode.commands.executeCommand('markdownNotebook.openPage', uri);
    }),

    vscode.commands.registerCommand('markdownNotebook.filterByTag', async () => {
      const root = resolveRoot();
      if (!root) {
        vscode.window.showErrorMessage('Notebook: open a folder first.');
        return;
      }
      
      const cfg = vscode.workspace.getConfiguration('markdownNotebook');
      const ignore = new Set(
        (cfg.get<string[]>('ignoreFolders', DEFAULT_IGNORE) ?? DEFAULT_IGNORE).map((s) => s.toLowerCase()),
      );
      
      const files = await listMarkdown(root.fsPath, ignore);
      const tagSet = new Set<string>();
      for (const f of files) {
        try {
          const meta = await readMeta(f);
          for (const t of meta.tags) {
            tagSet.add(t.toLowerCase());
          }
        } catch {}
      }

      interface TagQuickPickItem extends vscode.QuickPickItem {
        tag?: string;
      }

      const items: TagQuickPickItem[] = [
        {
          label: '$(clear-all) Clear Tag Filter',
          detail: 'Show all pages in the notebook',
          tag: undefined
        }
      ];

      const SEMANTIC_ITEMS: { name: string; icon: string; label: string }[] = [
        { name: 'meetings', icon: 'page-meetings', label: 'Meetings' },
        { name: 'emails', icon: 'page-emails', label: 'Emails' },
        { name: 'projects', icon: 'page-projects', label: 'Projects' },
        { name: 'archive', icon: 'page-archive', label: 'Archive' },
        { name: 'documents', icon: 'page-documents', label: 'Documents' }
      ];

      items.push({ label: 'Main Categories', kind: vscode.QuickPickItemKind.Separator });

      for (const item of SEMANTIC_ITEMS) {
        items.push({
          label: item.label,
          description: `#${item.name}`,
          iconPath: getIconUri(item.icon),
          tag: item.name
        });
        tagSet.delete(item.name);
      }

      if (tagSet.size > 0) {
        items.push({ label: 'Custom Tags', kind: vscode.QuickPickItemKind.Separator });
        const sortedCustom = Array.from(tagSet).sort();
        for (const tag of sortedCustom) {
          items.push({
            label: tag.charAt(0).toUpperCase() + tag.slice(1),
            description: `#${tag}`,
            iconPath: new vscode.ThemeIcon('tag'),
            tag: tag
          });
        }
      }

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a tag to filter the notebook'
      });

      if (picked === undefined) {
        return;
      }

      provider.activeTagFilter = picked.tag;
      provider.refresh();
    }),
  );

  // File watchers to update TOCs on create/delete/rename of markdown files.
  // Watcher events (including bursts from git checkouts or bulk copies) are
  // coalesced into a single debounced, serialized index update. Note files
  // are never modified from here — backlinks are written only by the code
  // paths that create notes, so externally created files stay untouched.
  // Watchers are rebuilt when the notebook root or workspace folders change.
  const refresh = () => provider.refresh();
  let watcherDisposables: vscode.Disposable[] = [];

  const setupWatchers = () => {
    for (const d of watcherDisposables) {
      d.dispose();
    }
    watcherDisposables = [];

    const root = resolveRoot();
    if (!root) {
      return;
    }

    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*.md'));
    watcher.onDidCreate((uri) => {
      const base = path.basename(uri.fsPath);
      if (base.startsWith('.')) { return; }
      scheduleIndexUpdate(path.dirname(uri.fsPath), root.fsPath, refresh);
    });
    watcher.onDidDelete((uri) => {
      const base = path.basename(uri.fsPath);
      if (base.startsWith('.')) { return; }
      scheduleIndexUpdate(path.dirname(uri.fsPath), root.fsPath, refresh);
    });
    watcher.onDidChange((uri) => {
      const base = path.basename(uri.fsPath);
      if (base.startsWith('.')) { return; }
      scheduleIndexUpdate(path.dirname(uri.fsPath), root.fsPath, refresh);
    });
    watcherDisposables.push(watcher);

    const folderWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/'));
    folderWatcher.onDidCreate((uri) => {
      scheduleIndexUpdate(uri.fsPath, root.fsPath, refresh);
    });
    folderWatcher.onDidDelete((uri) => {
      scheduleIndexUpdate(path.dirname(uri.fsPath), root.fsPath, refresh);
    });
    watcherDisposables.push(folderWatcher);
  };

  setupWatchers();
  context.subscriptions.push(
    new vscode.Disposable(() => {
      for (const d of watcherDisposables) {
        d.dispose();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      setupWatchers();
      provider.refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('markdownNotebook.root')) {
        setupWatchers();
        provider.refresh();
      } else if (
        e.affectsConfiguration('markdownNotebook.ignoreFolders') ||
        e.affectsConfiguration('markdownNotebook.dailyNotePattern')
      ) {
        provider.refresh();
      }
    }),
  );
}

async function newPage(node: NoteNode | undefined, provider: NotebookProvider): Promise<void> {
  const targetDir = node?.kind === 'section' ? node.fsPath : resolveRoot()?.fsPath;
  if (!targetDir) {
    vscode.window.showErrorMessage('Notebook: open a folder first.');
    return;
  }

  const metadata = await promptMetadata(undefined, 'Title for the new note', 'e.g. Q3 Migration Plan');
  if (!metadata) {
    return;
  }

  const { title, dateKey, dateStrForFilename, tags } = metadata;
  
  // Append date to slug filename if date context is provided
  let baseSlug = slug(title) || 'untitled';
  if (dateStrForFilename) {
    baseSlug = `${baseSlug}_${dateStrForFilename}`;
  }

  const fileName = await uniqueMd(targetDir, baseSlug);
  const createdDate = dateKey || localDateKey();
  const author = vscode.workspace.getConfiguration('markdownNotebook').get<string>('author', '').trim();
  const authorLine = author ? `author: ${yamlValue(author)}\n` : '';
  const parentDirName = path.basename(targetDir);
  const backlink = `[← ${parentDirName} TOC](.toc.md)`;

  const tagsStr = tags.length > 0 ? `tags: [${tags.map(yamlValue).join(', ')}]\n` : 'tags: []\n';

  const body = `---\ntitle: ${yamlValue(title)}\ncreated: ${createdDate}\n${authorLine}${tagsStr}---\n\n${backlink}\n\n# ${title}\n\n`;
  const target = vscode.Uri.file(path.join(targetDir, fileName));
  try {
    await vscode.workspace.fs.writeFile(target, Buffer.from(body, 'utf8'));
  } catch (err) {
    vscode.window.showErrorMessage(`Notebook: could not create note (${String(err)}).`);
    return;
  }
  provider.refresh();
  await vscode.commands.executeCommand('markdownNotebook.openPage', target);
}

async function newSection(node: NoteNode | undefined, provider: NotebookProvider): Promise<void> {
  const parentDir = node?.kind === 'section' ? node.fsPath : resolveRoot()?.fsPath;
  if (!parentDir) {
    vscode.window.showErrorMessage('Notebook: open a folder first.');
    return;
  }
  const name = await vscode.window.showInputBox({
    prompt: 'Name for the new section',
    placeHolder: 'e.g. Projects',
    validateInput: (v) => invalidFolderNameReason(v),
  });
  if (!name || invalidFolderNameReason(name)) {
    return;
  }
  const newDirPath = path.join(parentDir, name.trim());
  try {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(newDirPath));
    await updateTOC(newDirPath);
    await updateTOCsUpToRoot(parentDir, resolveRoot()!.fsPath);
    await updateMasterTOC(resolveRoot()!.fsPath);
  } catch (err) {
    vscode.window.showErrorMessage(`Notebook: could not create section (${String(err)}).`);
    return;
  }
  provider.refresh();
}

async function newDailyNote(provider: NotebookProvider): Promise<void> {
  const root = resolveRoot();
  if (!root) {
    vscode.window.showErrorMessage('Notebook: open a folder first.');
    return;
  }

  const dailyDir = path.join(root.fsPath, 'Daily');
  try {
    await fsp.mkdir(dailyDir, { recursive: true });
  } catch (err) {
    vscode.window.showErrorMessage(`Notebook: could not create Daily folder (${String(err)}).`);
    return;
  }

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const filename = `${dateStr}.md`;
  const filePath = path.join(dailyDir, filename);
  const targetUri = vscode.Uri.file(filePath);

  if (await exists(filePath)) {
    // If it already exists, just open it!
    await vscode.commands.executeCommand('markdownNotebook.openPage', targetUri);
    return;
  }

  // Check if daily template exists in templatesFolder
  const tdir = templatesDir();
  let text = '';
  let cursorOffset = -1;

  if (tdir) {
    const templatePath = path.join(tdir, 'daily.md');
    if (await exists(templatePath)) {
      try {
        const raw = await fsp.readFile(templatePath, 'utf8');
        const title = `Daily Note: ${dateStr}`;
        const res = applyTemplate(raw, title);
        text = res.text;
        cursorOffset = res.cursorOffset;
      } catch {
        /* fallback to starter */
      }
    }
  }

  const backlink = `[← Daily TOC](.toc.md)`;

  if (!text) {
    // Write dynamic fallback daily note content
    const author = vscode.workspace.getConfiguration('markdownNotebook').get<string>('author', '').trim();
    const authorLine = author ? `author: ${yamlValue(author)}\n` : '';
    text = `---\ntitle: ${yamlValue(`Daily Note: ${dateStr}`)}\ncreated: ${dateStr}\n${authorLine}tags: [daily]\n---\n\n${backlink}\n\n# Daily Note: ${dateStr}\n\n## Tasks\n- [ ] \n`;
  } else {
    // Inject backlink into template content
    const fm = text.match(/^(---\r?\n[\s\S]*?\r?\n---)(?=[ \t]*(?:\r?\n|$))/);
    let injectedLength = 0;
    if (fm) {
      const fmEndIndex = fm[0].length;
      text = text.slice(0, fmEndIndex) + `\n\n${backlink}\n` + text.slice(fmEndIndex);
      injectedLength = `\n\n${backlink}\n`.length;
    } else {
      text = `${backlink}\n\n` + text;
      injectedLength = `${backlink}\n\n`.length;
    }
    if (cursorOffset >= 0) {
      if (!fm || cursorOffset > fm[0].length) {
        cursorOffset += injectedLength;
      }
    }
  }

  try {
    await vscode.workspace.fs.writeFile(targetUri, Buffer.from(text, 'utf8'));
    await updateTOCsUpToRoot(dailyDir, root.fsPath);
    await updateMasterTOC(root.fsPath);
    await updateTasksDashboard(root.fsPath);
  } catch (err) {
    vscode.window.showErrorMessage(`Notebook: could not create daily note (${String(err)}).`);
    return;
  }

  provider.refresh();

  const cfg = vscode.workspace.getConfiguration('markdownNotebook');
  const alwaysPreview = cfg.get<boolean>('alwaysShowPreview', false);
  if (alwaysPreview) {
    await vscode.commands.executeCommand('markdownNotebook.openPage', targetUri);
  } else {
    const doc = await vscode.workspace.openTextDocument(targetUri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    if (cursorOffset >= 0) {
      const pos = doc.positionAt(cursorOffset);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos));
    }
  }
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
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ───────────────────────── New from Template ─────────────────────────

function templatesDir(): string | undefined {
  const root = resolveRoot();
  if (!root) {
    return undefined;
  }
  const folder = vscode.workspace.getConfiguration('markdownNotebook').get<string>('templatesFolder', 'templates').trim() || 'templates';
  return path.isAbsolute(folder) ? folder : path.join(root.fsPath, folder);
}

async function newFromTemplate(node: NoteNode | undefined, provider: NotebookProvider): Promise<void> {
  const targetDir = node?.kind === 'section' ? node.fsPath : resolveRoot()?.fsPath;
  if (!targetDir) {
    vscode.window.showErrorMessage('Notebook: open a folder first.');
    return;
  }
  const tdir = templatesDir();
  if (!tdir) {
    return;
  }

  let templates: string[] = [];
  try {
    templates = (await fsp.readdir(tdir)).filter((f) => f.toLowerCase().endsWith('.md'));
  } catch {
    /* folder missing */
  }
  if (templates.length === 0) {
    const make = await vscode.window.showInformationMessage(
      'No templates found. Create a couple of starter templates?',
      'Create starters',
      'Cancel',
    );
    if (make === 'Create starters') {
      await createStarterTemplates(tdir);
      vscode.window.showInformationMessage(`Added starter templates in ${path.basename(tdir)}/. Run the command again to use one.`);
    }
    return;
  }

  const picked = await vscode.window.showQuickPick(
    templates.map((t) => ({ label: `$(symbol-snippet) ${t.replace(/\.md$/i, '')}`, file: t })),
    { placeHolder: 'Choose a template' },
  );
  if (!picked) {
    return;
  }

  const today = localDateKey();
  const title = await vscode.window.showInputBox({
    prompt: 'Title for the new note',
    value: /daily|journal/i.test(picked.file) ? today : '',
    placeHolder: 'e.g. Weekly sync',
  });
  if (title === undefined) {
    return;
  }
  const templateBaseName = picked.file.replace(/\.md$/i, '');
  const finalTitle = title.trim() || `${templateBaseName} ${today}`;

  let raw: string;
  try {
    raw = await fsp.readFile(path.join(tdir, picked.file), 'utf8');
  } catch (err) {
    vscode.window.showErrorMessage(`Notebook: could not read template (${String(err)}).`);
    return;
  }

  let { text, cursorOffset } = applyTemplate(raw, finalTitle);
  const parentDirName = path.basename(targetDir);
  const backlink = `[← ${parentDirName} TOC](.toc.md)`;
  
  // Inject backlink after frontmatter
  const fm = text.match(/^(---\r?\n[\s\S]*?\r?\n---)(?=[ \t]*(?:\r?\n|$))/);
  let injectedLength = 0;
  if (fm) {
    const fmEndIndex = fm[0].length;
    text = text.slice(0, fmEndIndex) + `\n\n${backlink}\n` + text.slice(fmEndIndex);
    injectedLength = `\n\n${backlink}\n`.length;
  } else {
    text = `${backlink}\n\n` + text;
    injectedLength = `${backlink}\n\n`.length;
  }
  if (cursorOffset >= 0) {
    if (!fm || cursorOffset > fm[0].length) {
      cursorOffset += injectedLength;
    }
  }

  const fileName = await uniqueMd(targetDir, slug(finalTitle) || slug(picked.label) || 'untitled');
  const target = vscode.Uri.file(path.join(targetDir, fileName));
  try {
    await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
  } catch (err) {
    vscode.window.showErrorMessage(`Notebook: could not create note (${String(err)}).`);
    return;
  }
  provider.refresh();

  const cfg = vscode.workspace.getConfiguration('markdownNotebook');
  const alwaysPreview = cfg.get<boolean>('alwaysShowPreview', false);
  if (alwaysPreview) {
    await vscode.commands.executeCommand('markdownNotebook.openPage', target);
  } else {
    const doc = await vscode.workspace.openTextDocument(target);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    if (cursorOffset >= 0) {
      const pos = doc.positionAt(cursorOffset);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos));
    }
  }
}

/** Substitute {{placeholders}} and locate an optional {{cursor}} marker. */
function applyTemplate(raw: string, title: string): { text: string; cursorOffset: number } {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const values: Record<string, string> = {
    title,
    slug: slug(title),
    author: vscode.workspace.getConfiguration('markdownNotebook').get<string>('author', '').trim(),
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    datetime: now.toISOString(),
    year: String(now.getFullYear()),
    month: pad(now.getMonth() + 1),
    day: pad(now.getDate()),
    weekday: now.toLocaleDateString('en-US', { weekday: 'long' }),
  };
  let text = raw.replace(/\{\{(\w+)\}\}/g, (m, key: string) =>
    key === 'cursor' ? m : key in values ? values[key] : m,
  );
  let cursorOffset = text.indexOf('{{cursor}}');
  if (cursorOffset >= 0) {
    text = text.slice(0, cursorOffset) + text.slice(cursorOffset + '{{cursor}}'.length);
  }
  return { text, cursorOffset };
}

async function createStarterTemplates(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  const daily = `---\ntitle: {{title}}\ncreated: {{date}}\ntags: [daily]\n---\n\n# {{weekday}}, {{date}}\n\n## Focus\n{{cursor}}\n\n## Notes\n\n## Tasks\n- [ ] \n`;
  const meeting = `---\ntitle: {{title}}\ncreated: {{date}}\ntags: [meeting]\n---\n\n# {{title}}\n\n- **When:** {{date}} {{time}}\n- **Attendees:** {{cursor}}\n\n## Agenda\n\n## Decisions\n\n## Action items\n- [ ] \n`;
  await fsp.writeFile(path.join(dir, 'daily.md'), daily, 'utf8');
  await fsp.writeFile(path.join(dir, 'meeting.md'), meeting, 'utf8');
}

// ───────────────────────── Manual ordering ─────────────────────────

async function movePage(node: NoteNode | undefined, delta: number, provider: NotebookProvider): Promise<void> {
  if (!node || node.kind !== 'page') {
    return;
  }
  const dir = path.dirname(node.fsPath);
  const base = path.basename(node.fsPath);
  let nodes = await displayOrderNodes(dir);
  // At the notebook root the dashboard shows pinned notes in a separate,
  // always-sorted group, so swap within the list the user actually sees
  // (moving a pinned root note is a no-op — its group ignores manual order).
  const root = resolveRoot();
  if (root && path.normalize(dir) === path.normalize(root.fsPath)) {
    nodes = nodes.filter((p) => p.contextValue !== 'pinnedPage');
  }
  const order = nodes.map((p) => path.basename(p.fsPath));
  const idx = order.indexOf(base);
  const target = idx + delta;
  if (idx < 0 || target < 0 || target >= order.length) {
    return;
  }
  [order[idx], order[target]] = [order[target], order[idx]];
  await writeOrderFile(dir, order);
  provider.refresh();
}

async function reorderBefore(
  dir: string,
  movedBase: string,
  beforeBase: string | undefined,
  provider: NotebookProvider,
): Promise<void> {
  let order = await displayOrder(dir);
  order = order.filter((n) => n !== movedBase);
  const pos = beforeBase ? order.indexOf(beforeBase) : -1;
  if (pos < 0) {
    order.push(movedBase);
  } else {
    order.splice(pos, 0, movedBase);
  }
  await writeOrderFile(dir, order);
  provider.refresh();
}

// ───────────────────────── Link-preserving rename ─────────────────────────

async function renamePage(node: NoteNode | undefined, provider: NotebookProvider): Promise<void> {
  if (!node || node.kind !== 'page') {
    return;
  }
  const oldUri = node.resourceUri!;
  const oldPath = node.fsPath;
  const dir = path.dirname(oldPath);
  const oldBase = path.basename(oldPath, '.md');

  let oldDoc: vscode.TextDocument;
  try {
    oldDoc = await vscode.workspace.openTextDocument(oldUri);
  } catch (err) {
    vscode.window.showErrorMessage(`Notebook: could not open note (${String(err)}).`);
    return;
  }
  const oldText = oldDoc.getText();
  const oldTitle = parseTitle(oldText);

  const input = await vscode.window.showInputBox({
    prompt: 'Rename note (updates the title and all [[wiki-links]])',
    value: typeof node.label === 'string' ? node.label : oldBase,
  });
  if (input === undefined) {
    return;
  }
  const newTitle = input.trim();
  if (!newTitle) {
    return;
  }

  const newSlug = slug(newTitle) || oldBase;
  const renaming = newSlug.toLowerCase() !== oldBase.toLowerCase();
  let newPath = oldPath;
  let finalBase = oldBase;
  if (renaming) {
    const fname = await uniqueMd(dir, newSlug);
    finalBase = path.basename(fname, '.md');
    newPath = path.join(dir, fname);
  }

  // Work out which links may safely be rewritten: folder-qualified links must
  // point at this note's folder, and bare [[name]] links are only safe when no
  // other note in the notebook shares the same file name.
  const root = resolveRoot();
  let files: string[] = [];
  let linkOpts: WikiLinkRenameOpts | undefined;
  if (renaming && root) {
    const cfg = vscode.workspace.getConfiguration('markdownNotebook');
    const ignore = new Set(
      (cfg.get<string[]>('ignoreFolders', DEFAULT_IGNORE) ?? DEFAULT_IGNORE).map((s) => s.toLowerCase()),
    );
    files = await listMarkdown(root.fsPath, ignore);
    const oldBaseLc = oldBase.toLowerCase();
    const duplicates = files.filter(
      (f) =>
        path.basename(f).toLowerCase() === `${oldBaseLc}.md` &&
        path.normalize(f) !== path.normalize(oldPath),
    );
    linkOpts = {
      relDir: path.relative(root.fsPath, dir).replace(/\\/g, '/'),
      bareNameUnique: duplicates.length === 0,
    };
  }

  // 1) The note's own content: frontmatter title, leading H1, and any self-links.
  const newOwn = updateOwnContent(oldText, oldTitle, newTitle, oldBase, finalBase, renaming, linkOpts);
  if (newOwn !== oldText) {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(oldUri, fullRangeOf(oldDoc), newOwn);
    await vscode.workspace.applyEdit(edit);
    await oldDoc.save();
  }

  if (!renaming) {
    provider.refresh();
    return;
  }

  // 2) Update [[wiki-links]] in every other note (left as reviewable unsaved edits).
  let updatedFiles = 0;
  if (root) {
    const edit = new vscode.WorkspaceEdit();
    for (const f of files) {
      if (path.normalize(f) === path.normalize(oldPath)) {
        continue; // handled above
      }
      let doc: vscode.TextDocument;
      try {
        doc = await vscode.workspace.openTextDocument(vscode.Uri.file(f));
      } catch {
        continue;
      }
      const text = doc.getText();
      const rewritten = rewriteWikiLinks(text, oldBase, finalBase, linkOpts);
      if (rewritten !== text) {
        edit.replace(doc.uri, fullRangeOf(doc), rewritten);
        updatedFiles++;
      }
    }
    if (edit.size > 0) {
      await vscode.workspace.applyEdit(edit);
    }
  }

  // 3) Move the file itself, and drop its old name from any order sidecar.
  try {
    await vscode.workspace.fs.rename(oldUri, vscode.Uri.file(newPath), { overwrite: false });
  } catch (err) {
    vscode.window.showErrorMessage(`Notebook: rename failed (${String(err)}).`);
    return;
  }
  const oldOrderName = path.basename(oldPath).toLowerCase();
  const ord = await readOrderFile(dir);
  if (ord.some((n) => n.toLowerCase() === oldOrderName)) {
    await writeOrderFile(
      dir,
      ord.map((n) => (n.toLowerCase() === oldOrderName ? path.basename(newPath) : n)),
    );
  }

  provider.refresh();
  await vscode.commands.executeCommand('markdownNotebook.openPage', vscode.Uri.file(newPath));
  if (updatedFiles > 0) {
    vscode.window.showInformationMessage(
      `Renamed note and updated links in ${updatedFiles} file${updatedFiles === 1 ? '' : 's'} (unsaved — review and save).`,
    );
  }
}

async function renameSection(node: NoteNode | undefined, provider: NotebookProvider): Promise<void> {
  if (!node || node.kind !== 'section') {
    return;
  }
  const oldPath = node.fsPath;
  const oldDirName = path.basename(oldPath);
  const parentDir = path.dirname(oldPath);

  const input = await vscode.window.showInputBox({
    prompt: 'Rename section folder (updates section references and wiki-links)',
    value: oldDirName,
  });
  if (input === undefined) {
    return;
  }
  const newDirName = input.trim();
  if (!newDirName || newDirName === oldDirName) {
    return;
  }

  const nameError = invalidFolderNameReason(newDirName);
  if (nameError) {
    vscode.window.showErrorMessage(`Notebook: ${nameError}`);
    return;
  }

  const newPath = path.join(parentDir, newDirName);
  
  // Verify target directory doesn't already exist
  try {
    const stat = await fsp.stat(newPath);
    if (stat) {
      vscode.window.showErrorMessage(`Notebook: a file or folder named "${newDirName}" already exists.`);
      return;
    }
  } catch {
    // OK, path doesn't exist
  }

  const root = resolveRoot();
  let updatedFiles = 0;

  // 1) Rename the folder first, so the link edits below are applied to the
  // notes at their final locations. (Doing it the other way around leaves
  // unsaved edits on documents whose files are then moved out from under
  // them — saving those would resurrect the old folder with stale copies.)
  try {
    await vscode.workspace.fs.rename(vscode.Uri.file(oldPath), vscode.Uri.file(newPath), { overwrite: false });
  } catch (err) {
    vscode.window.showErrorMessage(`Notebook: rename failed (${String(err)}).`);
    return;
  }

  // 2) Rewrite folder-qualified wiki-links across the notebook (left as
  // reviewable unsaved edits).
  if (root) {
    const oldRelPath = path.relative(root.fsPath, oldPath);
    const newRelPath = path.relative(root.fsPath, newPath);

    const cfg = vscode.workspace.getConfiguration('markdownNotebook');
    const ignore = new Set(
      (cfg.get<string[]>('ignoreFolders', DEFAULT_IGNORE) ?? DEFAULT_IGNORE).map((s) => s.toLowerCase()),
    );
    const files = await listMarkdown(root.fsPath, ignore);
    const edit = new vscode.WorkspaceEdit();

    for (const f of files) {
      let doc: vscode.TextDocument;
      try {
        doc = await vscode.workspace.openTextDocument(vscode.Uri.file(f));
      } catch {
        continue;
      }
      const text = doc.getText();
      const rewritten = rewriteWikiLinkDirectories(text, oldRelPath, newRelPath);
      if (rewritten !== text) {
        edit.replace(doc.uri, fullRangeOf(doc), rewritten);
        updatedFiles++;
      }
    }

    if (edit.size > 0) {
      await vscode.workspace.applyEdit(edit);
    }
  }

  // 3) Update parent folder manual ordering sidecar
  const oldDirNameLc = oldDirName.toLowerCase();
  const ord = await readOrderFile(parentDir);
  if (ord.some((n) => n.toLowerCase() === oldDirNameLc)) {
    await writeOrderFile(
      parentDir,
      ord.map((n) => (n.toLowerCase() === oldDirNameLc ? newDirName : n)),
    );
  }

  // 4) Regenerate TOCs and Dashboard
  if (root) {
    try {
      await updateTOCsUpToRoot(parentDir, root.fsPath);
      await updateTOCsUpToRoot(newPath, root.fsPath);
      await updateMasterTOC(root.fsPath);
      await updateTasksDashboard(root.fsPath);
    } catch (err) {
      console.error('Failed to update indexes after rename:', err);
    }
  }

  provider.refresh();

  if (updatedFiles > 0) {
    vscode.window.showInformationMessage(
      `Renamed section folder and updated links in ${updatedFiles} file${updatedFiles === 1 ? '' : 's'} (unsaved — review and save).`,
    );
  } else {
    vscode.window.showInformationMessage(`Renamed section folder to "${newDirName}".`);
  }
}

function rewriteWikiLinkDirectories(text: string, oldRelPath: string, newRelPath: string): string {
  const oldPathSlash = oldRelPath.replace(/\\/g, '/') + '/';
  const newPathSlash = newRelPath.replace(/\\/g, '/') + '/';
  const oldPathSlashLower = oldPathSlash.toLowerCase();

  return text.replace(/\[\[([^\[\]]+?)\]\]/g, (full, inner: string) => {
    const pipe = inner.indexOf('|');
    const target = pipe >= 0 ? inner.slice(0, pipe) : inner;
    const alias = pipe >= 0 ? inner.slice(pipe) : '';
    const subMatch = target.match(/[#^].*$/);
    const sub = subMatch ? subMatch[0] : '';
    const namePath = sub ? target.slice(0, target.length - sub.length) : target;

    const namePathSlash = namePath.replace(/\\/g, '/');
    if (namePathSlash.toLowerCase().startsWith(oldPathSlashLower)) {
      const remaining = namePathSlash.slice(oldPathSlash.length);
      const rebuilt = newPathSlash + remaining;
      return `[[${rebuilt}${sub}${alias}]]`;
    }
    return full;
  });
}


interface WikiLinkRenameOpts {
  /** The renamed note's folder relative to the notebook root ('' = root), slash-separated. */
  relDir?: string;
  /** False when another note shares the same file name, making bare [[links]] ambiguous. */
  bareNameUnique?: boolean;
}

/** Rewrite [[old]] / [[old|alias]] / [[old#heading]] / [[dir/old]] targets to the new base name. */
function rewriteWikiLinks(text: string, oldBase: string, newBase: string, opts?: WikiLinkRenameOpts): string {
  const oldLc = oldBase.toLowerCase();
  const relDirLc =
    opts?.relDir !== undefined
      ? opts.relDir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      : undefined;
  return text.replace(/\[\[([^\[\]]+?)\]\]/g, (full, inner: string) => {
    const pipe = inner.indexOf('|');
    const target = pipe >= 0 ? inner.slice(0, pipe) : inner;
    const alias = pipe >= 0 ? inner.slice(pipe) : ''; // includes leading '|'
    const subMatch = target.match(/[#^].*$/);
    const sub = subMatch ? subMatch[0] : '';
    const namePath = sub ? target.slice(0, target.length - sub.length) : target;
    const slashIdx = namePath.lastIndexOf('/');
    const dirPart = slashIdx >= 0 ? namePath.slice(0, slashIdx + 1) : '';
    let name = slashIdx >= 0 ? namePath.slice(slashIdx + 1) : namePath;
    const hasMd = /\.md$/i.test(name);
    const bare = hasMd ? name.slice(0, -3) : name;
    if (bare.trim().toLowerCase() !== oldLc) {
      return full;
    }
    if (dirPart) {
      // Folder-qualified link: only rewrite when it points at the renamed
      // note's folder, not some other note that happens to share its name.
      if (relDirLc !== undefined) {
        const linkDirLc = dirPart.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        if (linkDirLc !== relDirLc) {
          return full;
        }
      }
    } else if (opts?.bareNameUnique === false) {
      // Another note has the same name; a bare link is ambiguous, leave it.
      return full;
    }
    const rebuilt = newBase + (hasMd ? '.md' : '');
    return `[[${dirPart}${rebuilt}${sub}${alias}]]`;
  });
}

function updateOwnContent(
  text: string,
  oldTitle: string | undefined,
  newTitle: string,
  oldBase: string,
  newBase: string,
  renaming: boolean,
  linkOpts?: WikiLinkRenameOpts,
): string {
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
      txt.trim() === oldTitle.trim() ? `${h}${newTitle}${tail}` : m,
    );
  }

  if (renaming) {
    out = rewriteWikiLinks(out, oldBase, newBase, linkOpts);
  }
  return out;
}

function parseTitle(text: string): string | undefined {
  const fm = text.match(FRONTMATTER_RE);
  if (fm) {
    const m = fm[1].match(/^title:\s*(.*)$/m);
    if (m) {
      return stripQuotes(m[1].trim());
    }
  }
  const body = fm ? text.slice(fm[0].length) : text;
  const h1 = body.match(/^#\s+(.+?)\s*$/m);
  return h1 ? h1[1].trim() : undefined;
}

function yamlValue(s: string): string {
  // Quote anything YAML could misread: flow/comment/quote characters anywhere,
  // indicator characters at the start, surrounding whitespace, or emptiness.
  return /[:#\[\]{}",'`]|^[\s\-*&?>|%@!]|\s$|^$/.test(s) ? JSON.stringify(s) : s;
}

function fullRangeOf(doc: vscode.TextDocument): vscode.Range {
  return new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
}

async function listMarkdown(dir: string, ignore: Set<string>, depth = 0): Promise<string[]> {
  if (depth > 8) {
    return [];
  }
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) {
      continue;
    }
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!ignore.has(e.name.toLowerCase())) {
        out.push(...(await listMarkdown(full, ignore, depth + 1)));
      }
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

// ───────────────────────── Drag & drop ─────────────────────────

class NotebookDnD implements vscode.TreeDragAndDropController<NoteNode> {
  readonly dragMimeTypes = [DND_MIME];
  readonly dropMimeTypes = [DND_MIME, 'text/uri-list'];

  constructor(private readonly provider: NotebookProvider) {}

  handleDrag(source: readonly NoteNode[], dataTransfer: vscode.DataTransfer): void {
    // The dashboard node is the master .toc.md — moving it makes no sense.
    const movable = source.filter((n) => n.contextValue !== 'masterTOC');
    if (movable.length === 0) {
      return;
    }
    dataTransfer.set(DND_MIME, new vscode.DataTransferItem(movable.map((n) => n.fsPath)));
  }

  async handleDrop(target: NoteNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const item = dataTransfer.get(DND_MIME);
    if (!item) {
      const uriList = dataTransfer.get('text/uri-list');
      if (uriList) {
        // Drops from outside the tree (OS Explorer, editor tabs) only expose
        // the uri-list via asString(); .value is not a string there.
        const uriStrings = await uriList.asString();
        const uris = uriStrings
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0 && !s.startsWith('#'))
          .map((s) => vscode.Uri.parse(s));
        
        let destDir: string | undefined;
        if (!target) {
          destDir = resolveRoot()?.fsPath;
        } else if (target.kind === 'section') {
          destDir = target.fsPath;
        } else {
          destDir = path.dirname(target.fsPath);
        }
        if (destDir && uris.length > 0) {
          vscode.commands.executeCommand('markdownNotebook.importDroppedFiles', uris, vscode.Uri.file(destDir));
        }
      }
      return;
    }
    const paths = item.value as string[];

    let destDir: string | undefined;
    let beforeBase: string | undefined;
    if (!target) {
      destDir = resolveRoot()?.fsPath;
    } else if (target.kind === 'section') {
      destDir = target.fsPath;
    } else {
      destDir = path.dirname(target.fsPath);
      beforeBase = path.basename(target.fsPath);
    }
    if (!destDir) {
      return;
    }

    for (const src of paths) {
      if (path.normalize(src) === path.normalize(destDir)) {
        continue; // can't drop a folder into itself
      }
      const relToSrc = path.relative(path.normalize(src), path.normalize(destDir));
      if (relToSrc && !relToSrc.startsWith('..') && !path.isAbsolute(relToSrc)) {
        vscode.window.showWarningMessage('Notebook: cannot move a section into its own subfolder.');
        continue;
      }
      const srcDir = path.dirname(src);
      if (path.normalize(srcDir) === path.normalize(destDir)) {
        if (beforeBase && src.toLowerCase().endsWith('.md')) {
          await reorderBefore(destDir, path.basename(src), beforeBase, this.provider);
        }
      } else {
        await moveInto(src, destDir);
        await updateTOCsUpToRoot(srcDir, resolveRoot()!.fsPath);
        await updateTOCsUpToRoot(destDir, resolveRoot()!.fsPath);
        await updateMasterTOC(resolveRoot()!.fsPath);
        await updateTasksDashboard(resolveRoot()!.fsPath);
      }
    }
    this.provider.refresh();
  }
}

/** Move a page or section into another folder. Wiki-links survive because the name is unchanged. */
async function moveInto(srcPath: string, destDir: string): Promise<void> {
  const base = path.basename(srcPath);
  const dest = path.join(destDir, base);
  if (await exists(dest)) {
    vscode.window.showErrorMessage(`Notebook: "${base}" already exists in the destination — move skipped.`);
    return;
  }
  try {
    await vscode.workspace.fs.rename(vscode.Uri.file(srcPath), vscode.Uri.file(dest), { overwrite: false });
  } catch (err) {
    vscode.window.showErrorMessage(`Notebook: move failed (${String(err)}).`);
    return;
  }
  const srcDir = path.dirname(srcPath);
  const baseLc = base.toLowerCase();
  const ord = await readOrderFile(srcDir);
  if (ord.some((n) => n.toLowerCase() === baseLc)) {
    await writeOrderFile(srcDir, ord.filter((n) => n.toLowerCase() !== baseLc));
  }
}

export function updateTOC(dirPath: string): Promise<void> {
  return withIndexLock(() => updateTOCImpl(dirPath));
}

async function updateTOCImpl(dirPath: string): Promise<void> {
  try {
    const stat = await fsp.stat(dirPath);
    if (!stat.isDirectory()) { return; }
  } catch {
    return;
  }

  const cfg = vscode.workspace.getConfiguration('markdownNotebook');
  const ignore = new Set(
    (cfg.get<string[]>('ignoreFolders', DEFAULT_IGNORE) ?? DEFAULT_IGNORE).map((s) => s.toLowerCase()),
  );

  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  const pages: string[] = [];
  const subDirs: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md') && entry.name !== '.toc.md') {
      pages.push(entry.name);
    } else if (entry.isDirectory()) {
      if (ignore.has(entry.name.toLowerCase())) {
        continue;
      }
      subDirs.push(entry.name);
    }
  }

  subDirs.sort((a, b) => a.localeCompare(b));

  // Scan tasks under this folder (recursively) first, so we can calculate total tasks and completion rate recursively
  const files = await listMarkdown(dirPath, ignore);
  const sectionTasks: { notePath: string; noteTitle: string; text: string; line: number; completed: boolean }[] = [];
  const dailyRegexes = getDailyRegexes(cfg);

  for (const file of files) {
    const baseName = path.basename(file).toLowerCase();
    if (baseName === '.toc.md' || baseName === '.tasks.md') {
      continue;
    }
    let fileContent = '';
    try {
      fileContent = await fsp.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const meta = await readMeta(file);
    const title = computeDisplayTitle(path.basename(file), meta, dailyRegexes);

    const lines = fileContent.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];
      const matchOpen = lineText.match(/^[ \t]*[-*]\s+\[ \](.*)$/);
      const matchClosed = lineText.match(/^[ \t]*[-*]\s+\[[xX]\](.*)$/);

      if (matchOpen || matchClosed) {
        const completed = !!matchClosed;
        const textStr = (matchOpen ? matchOpen[1] : matchClosed![1]).trim();
        if (!textStr) { continue; }
        
        const relativeFilePath = path.relative(dirPath, file);
        const encodedPath = relativeFilePath.split(path.sep).map(encodeURIComponent).join('/');

        sectionTasks.push({
          notePath: file,
          noteTitle: title,
          text: textStr,
          line: i + 1,
          completed
        });
      }
    }
  }

  const totalOpen = sectionTasks.filter(t => !t.completed).length;
  const totalCompleted = sectionTasks.filter(t => t.completed).length;
  const totalTasks = totalOpen + totalCompleted;
  const completionRate = totalTasks > 0 ? Math.round((totalCompleted / totalTasks) * 100) : 0;

  // Calculate pages list directly in this folder
  let totalPages = 0;
  const pageItems: { name: string; title: string }[] = [];

  for (const page of pages) {
    totalPages++;
    let title = prettyName(page);
    try {
      const meta = await readMeta(path.join(dirPath, page));
      title = computeDisplayTitle(page, meta, dailyRegexes);
    } catch {
      /* ignore */
    }
    pageItems.push({ name: page, title });
  }

  // Sort pageItems based on their display title
  pageItems.sort((a, b) => collator.compare(a.title, b.title));

  const dirName = path.basename(dirPath);
  const prettyDir = prettyName(dirName);
  let content = `# Table of Contents: ${prettyDir}\n\n`;
  content += `Welcome to the Table of Contents for the **${prettyDir}** section.\n\n`;

  // Prepend visual dashboard Stats Strip
  content += `<div class="toc-stats-strip">\n`;
  content += `  <div class="toc-stat-card">\n`;
  content += `    <span class="toc-stat-val">${totalPages}</span>\n`;
  content += `    <span class="toc-stat-lbl">Total Pages</span>\n`;
  content += `  </div>\n`;
  content += `  <div class="toc-stat-card">\n`;
  content += `    <span class="toc-stat-val">${totalTasks}</span>\n`;
  content += `    <span class="toc-stat-lbl">Total Tasks</span>\n`;
  content += `  </div>\n`;
  content += `  <div class="toc-stat-card">\n`;
  content += `    <span class="toc-stat-val">${completionRate}%</span>\n`;
  content += `    <span class="toc-stat-lbl">Task Completion</span>\n`;
  content += `  </div>\n`;
  content += `</div>\n\n`;

  // Render sub-directories
  if (subDirs.length > 0) {
    content += `## Subsections\n\n`;
    for (const subDir of subDirs) {
      const prettySub = prettyName(subDir);
      content += `- [${prettySub}](./${encodeURIComponent(subDir)}/.toc.md)\n`;
    }
    content += `\n`;
  }

  content += `## Pages\n\n`;

  if (pageItems.length === 0) {
    content += `*No notes in this section yet. Create a new page to get started!*\n`;
  } else {
    for (const item of pageItems) {
      content += `- [${item.title}](./${encodeURIComponent(item.name)})\n`;
    }
  }

  // We already scanned sectionTasks at the top of the function

  const openSectionTasks = sectionTasks.filter(t => !t.completed);
  const closedSectionTasks = sectionTasks.filter(t => t.completed);

  if (sectionTasks.length > 0) {
    content += `\n<div class="tasks-dashboard-view">\n\n`;
    content += `## Tasks in this Section\n\n`;
    
    content += `### Open Tasks\n\n`;
    if (openSectionTasks.length === 0) {
      content += `*No active open tasks in this section.*\n\n`;
    } else {
      for (const t of openSectionTasks) {
        const relativeFilePath = path.relative(dirPath, t.notePath);
        const encodedPath = relativeFilePath.split(path.sep).map(encodeURIComponent).join('/');
        content += `- [ ] [<span class="task-text">${t.text}</span> <em class="task-note-badge">${t.noteTitle}</em>](./${encodedPath}#L${t.line})\n`;
      }
      content += `\n`;
    }

    content += `### Completed Tasks\n\n`;
    if (closedSectionTasks.length === 0) {
      content += `*No completed tasks in this section.*\n\n`;
    } else {
      for (const t of closedSectionTasks) {
        const relativeFilePath = path.relative(dirPath, t.notePath);
        const encodedPath = relativeFilePath.split(path.sep).map(encodeURIComponent).join('/');
        content += `- [x] [<span class="task-text">~~${t.text}~~</span> <em class="task-note-badge">${t.noteTitle}</em>](./${encodedPath}#L${t.line})\n`;
      }
      content += `\n`;
    }
    content += `</div>\n`;
  }

  const tocPath = path.join(dirPath, '.toc.md');
  await fsp.writeFile(tocPath, content, 'utf8');
}

async function updateBacklink(filePath: string, parentDirName: string): Promise<void> {
  let content = '';
  try {
    content = await fsp.readFile(filePath, 'utf8');
  } catch {
    return;
  }

  const backlinkRegex = /\[←\s*.*?\s*(Dashboard|TOC)\]\(\.(dashboard|toc)\.md\)/i;
  const newLink = `[← ${parentDirName} TOC](.toc.md)`;

  if (backlinkRegex.test(content)) {
    const updatedContent = content.replace(backlinkRegex, newLink);
    if (updatedContent !== content) {
      await fsp.writeFile(filePath, updatedContent, 'utf8');
    }
  } else {
    let updatedContent = '';
    const fm = content.match(/^(---\r?\n[\s\S]*?\r?\n---)(?=[ \t]*(?:\r?\n|$))/);
    if (fm) {
      const fmEndIndex = fm[0].length;
      updatedContent = content.slice(0, fmEndIndex) + `\n\n${newLink}\n` + content.slice(fmEndIndex);
    } else {
      updatedContent = `${newLink}\n\n` + content;
    }
    await fsp.writeFile(filePath, updatedContent, 'utf8');
  }
}

// ───────────────────────── Workspace Auto-Migration Wizard ─────────────────────────

async function scanForTOCNeeded(dirPath: string, ignore: Set<string>, depth = 0): Promise<boolean> {
  if (depth > 6) { return false; }

  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true });
  } catch {
    return false;
  }

  let hasMdNotes = false;
  let hasTOC = false;
  const subDirs: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      if (entry.name === '.toc.md') {
        hasTOC = true;
      }
      continue;
    }
    if (entry.isDirectory()) {
      if (ignore.has(entry.name.toLowerCase())) {
        continue;
      }
      subDirs.push(path.join(dirPath, entry.name));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      hasMdNotes = true;
    }
  }

  if (hasMdNotes && !hasTOC) {
    return true;
  }

  for (const subDir of subDirs) {
    if (await scanForTOCNeeded(subDir, ignore, depth + 1)) {
      return true;
    }
  }

  return false;
}

async function buildTOCConnections(dirPath: string, ignore: Set<string>, depth = 0): Promise<void> {
  if (depth > 6) { return; }

  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  const pages: string[] = [];
  const subDirs: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    if (entry.isDirectory()) {
      if (ignore.has(entry.name.toLowerCase())) {
        continue;
      }
      subDirs.push(path.join(dirPath, entry.name));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      pages.push(entry.name);
    }
  }

  if (pages.length > 0) {
    await updateTOC(dirPath);
    const parentDirName = path.basename(dirPath);
    for (const page of pages) {
      await updateBacklink(path.join(dirPath, page), parentDirName);
    }
  }

  for (const subDir of subDirs) {
    await buildTOCConnections(subDir, ignore, depth + 1);
  }
}

export async function checkAndPromptMigration(context: vscode.ExtensionContext): Promise<void> {
  const root = resolveRoot();
  if (!root) {
    return;
  }

  const prompted = context.workspaceState.get<boolean>('markdownNotebook.promptedMigration', false);
  if (prompted) {
    return;
  }

  const cfg = vscode.workspace.getConfiguration('markdownNotebook');
  const ignore = new Set(
    (cfg.get<string[]>('ignoreFolders', DEFAULT_IGNORE) ?? DEFAULT_IGNORE).map((s) => s.toLowerCase()),
  );

  const needsMigration = await scanForTOCNeeded(root.fsPath, ignore);
  if (!needsMigration) {
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    'Would you like to automatically generate a Table of Contents (.toc.md) and back-links for all folders in this notebook?',
    'Generate TOCs & Back-links',
    'Not Now',
    "Don't Ask Again",
  );

  if (choice === 'Generate TOCs & Back-links') {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Wiring up Notebook TOCs and Backlinks',
        cancellable: false,
      },
      async (progress) => {
        await buildTOCConnections(root.fsPath, ignore);
      },
    );
    await context.workspaceState.update('markdownNotebook.promptedMigration', true);
    vscode.commands.executeCommand('markdownNotebook.refresh');
    vscode.window.showInformationMessage('Successfully generated TOCs and backlinks for the notebook!');
  } else if (choice === "Don't Ask Again") {
    await context.workspaceState.update('markdownNotebook.promptedMigration', true);
  }
}

export function updateMasterTOC(rootDir: string): Promise<void> {
  return withIndexLock(() => updateMasterTOCImpl(rootDir));
}

async function updateMasterTOCImpl(rootDir: string): Promise<void> {
  try {
    const stat = await fsp.stat(rootDir);
    if (!stat.isDirectory()) { return; }
  } catch {
    return;
  }

  const cfg = vscode.workspace.getConfiguration('markdownNotebook');
  const ignore = new Set(
    (cfg.get<string[]>('ignoreFolders', DEFAULT_IGNORE) ?? DEFAULT_IGNORE).map((s) => s.toLowerCase()),
  );

  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(rootDir, { withFileTypes: true });
  } catch {
    return;
  }

  // Find all sections (folders) and root pages
  const sections: { name: string; fullPath: string; pages: string[] }[] = [];
  const rootPages: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (ignore.has(entry.name.toLowerCase())) {
        continue;
      }
      // Scan pages inside this subfolder
      let subEntries: fs.Dirent[] = [];
      try {
        subEntries = await fsp.readdir(fullPath, { withFileTypes: true });
      } catch {
        continue;
      }
      const pages: string[] = [];
      for (const se of subEntries) {
        if (se.isFile() && se.name.toLowerCase().endsWith('.md') && !se.name.startsWith('.') && se.name !== '.toc.md') {
          pages.push(se.name);
        }
      }
      pages.sort((a, b) => collator.compare(prettyName(a), prettyName(b)));
      sections.push({ name: entry.name, fullPath, pages });
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md') && entry.name !== '.toc.md') {
      rootPages.push(entry.name);
    }
  }

  sections.sort((a, b) => a.name.localeCompare(b.name));

  // Scan tasks under this root folder (recursively) first, so we can calculate total tasks and completion rate recursively
  const files = await listMarkdown(rootDir, ignore);
  const notebookTasks: { notePath: string; noteTitle: string; text: string; line: number; completed: boolean }[] = [];
  const dailyRegexes = getDailyRegexes(cfg);

  for (const file of files) {
    const baseName = path.basename(file).toLowerCase();
    if (baseName === '.toc.md' || baseName === '.tasks.md') {
      continue;
    }
    let fileContent = '';
    try {
      fileContent = await fsp.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const meta = await readMeta(file);
    const title = computeDisplayTitle(path.basename(file), meta, dailyRegexes);

    const lines = fileContent.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];
      const matchOpen = lineText.match(/^[ \t]*[-*]\s+\[ \](.*)$/);
      const matchClosed = lineText.match(/^[ \t]*[-*]\s+\[[xX]\](.*)$/);

      if (matchOpen || matchClosed) {
        const completed = !!matchClosed;
        const textStr = (matchOpen ? matchOpen[1] : matchClosed![1]).trim();
        if (!textStr) { continue; }
        
        const relativeFilePath = path.relative(rootDir, file);
        const encodedPath = relativeFilePath.split(path.sep).map(encodeURIComponent).join('/');

        notebookTasks.push({
          notePath: file,
          noteTitle: title,
          text: textStr,
          line: i + 1,
          completed
        });
      }
    }
  }

  const globalTotalOpen = notebookTasks.filter(t => !t.completed).length;
  const globalTotalCompleted = notebookTasks.filter(t => t.completed).length;
  const globalTotalTasks = globalTotalOpen + globalTotalCompleted;
  const globalCompletionRate = globalTotalTasks > 0 ? Math.round((globalTotalCompleted / globalTotalTasks) * 100) : 0;

  // Process sections to count pages
  let globalTotalPages = 0;
  for (const sec of sections) {
    for (const page of sec.pages) {
      globalTotalPages++;
    }
  }

  // Process root pages and compute normalized display titles
  const rootPageItems: { name: string; title: string }[] = [];

  for (const page of rootPages) {
    globalTotalPages++;
    const full = path.join(rootDir, page);
    let title = prettyName(page);
    try {
      const meta = await readMeta(full);
      title = computeDisplayTitle(page, meta, dailyRegexes);
    } catch { /* ignore */ }
    rootPageItems.push({ name: page, title });
  }

  // Sort rootPageItems based on their display title
  rootPageItems.sort((a, b) => collator.compare(a.title, b.title));

  let content = `# Table of Contents: Notebook Dashboard\n\n`;
  content += `Welcome to the Master Dashboard for your Markdown Notebook.\n\n`;

  // SaaS Stats Strip
  content += `<div class="toc-stats-strip">\n`;
  content += `  <div class="toc-stat-card">\n`;
  content += `    <span class="toc-stat-val">${globalTotalPages}</span>\n`;
  content += `    <span class="toc-stat-lbl">Global Pages</span>\n`;
  content += `  </div>\n`;
  content += `  <div class="toc-stat-card">\n`;
  content += `    <span class="toc-stat-val">${globalTotalTasks}</span>\n`;
  content += `    <span class="toc-stat-lbl">Global Tasks</span>\n`;
  content += `  </div>\n`;
  content += `  <div class="toc-stat-card">\n`;
  content += `    <span class="toc-stat-val">${globalCompletionRate}%</span>\n`;
  content += `    <span class="toc-stat-lbl">Global Completion</span>\n`;
  content += `  </div>\n`;
  content += `</div>\n\n`;

  content += `## Notebook Sections\n\n`;

  if (sections.length === 0) {
    content += `*No sections in this notebook yet.*\n\n`;
  } else {
    for (const sec of sections) {
      const prettySec = prettyName(sec.name);
      content += `- [${prettySec}](./${encodeURIComponent(sec.name)}/.toc.md)\n`;
    }
    content += `\n`;
  }

  // Render Root Pages
  if (rootPageItems.length > 0) {
    content += `## Notebook Root Notes\n\n`;
    for (const item of rootPageItems) {
      content += `- [${item.title}](./${encodeURIComponent(item.name)})\n`;
    }
    content += `\n`;
  }

  // We already scanned notebookTasks at the top of the function

  const openNotebookTasks = notebookTasks.filter(t => !t.completed);
  const closedNotebookTasks = notebookTasks.filter(t => t.completed);

  if (notebookTasks.length > 0) {
    content += `\n<div class="tasks-dashboard-view">\n\n`;
    content += `## Tasks in this Notebook\n\n`;
    
    content += `### Open Tasks\n\n`;
    if (openNotebookTasks.length === 0) {
      content += `*No active open tasks in this notebook.*\n\n`;
    } else {
      for (const t of openNotebookTasks) {
        const relativeFilePath = path.relative(rootDir, t.notePath);
        const encodedPath = relativeFilePath.split(path.sep).map(encodeURIComponent).join('/');
        content += `- [ ] [<span class="task-text">${t.text}</span> <em class="task-note-badge">${t.noteTitle}</em>](./${encodedPath}#L${t.line})\n`;
      }
      content += `\n`;
    }

    content += `### Completed Tasks\n\n`;
    if (closedNotebookTasks.length === 0) {
      content += `*No completed tasks in this notebook.*\n\n`;
    } else {
      for (const t of closedNotebookTasks) {
        const relativeFilePath = path.relative(rootDir, t.notePath);
        const encodedPath = relativeFilePath.split(path.sep).map(encodeURIComponent).join('/');
        content += `- [x] [<span class="task-text">~~${t.text}~~</span> <em class="task-note-badge">${t.noteTitle}</em>](./${encodedPath}#L${t.line})\n`;
      }
      content += `\n`;
    }
    content += `</div>\n`;
  }

  const masterTocPath = path.join(rootDir, '.toc.md');
  await fsp.writeFile(masterTocPath, content, 'utf8');
}


export function updateTasksDashboard(rootDir: string): Promise<void> {
  return withIndexLock(() => updateTasksDashboardImpl(rootDir));
}

async function updateTasksDashboardImpl(rootDir: string): Promise<void> {
  try {
    const stat = await fsp.stat(rootDir);
    if (!stat.isDirectory()) { return; }
  } catch {
    return;
  }

  const cfg = vscode.workspace.getConfiguration('markdownNotebook');
  const ignore = new Set(
    (cfg.get<string[]>('ignoreFolders', DEFAULT_IGNORE) ?? DEFAULT_IGNORE).map((s) => s.toLowerCase()),
  );
  const dailyRegexes = getDailyRegexes(cfg);

  const files = await listMarkdown(rootDir, ignore);
  const taskMap = new Map<string, { notePath: string; noteTitle: string; text: string; line: number; completed: boolean }[]>();

  let totalOpen = 0;
  let totalCompleted = 0;

  for (const file of files) {
    const baseName = path.basename(file).toLowerCase();
    if (baseName === '.toc.md' || baseName === '.tasks.md') {
      continue;
    }

    let content = '';
    try {
      content = await fsp.readFile(file, 'utf8');
    } catch {
      continue;
    }

    const meta = await readMeta(file);
    const title = computeDisplayTitle(path.basename(file), meta, dailyRegexes);

    const lines = content.split(/\r?\n/);
    const relativeDir = path.relative(rootDir, path.dirname(file)) || 'General Notes';

    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];
      const matchOpen = lineText.match(/^[ \t]*[-*]\s+\[ \](.*)$/);
      const matchClosed = lineText.match(/^[ \t]*[-*]\s+\[[xX]\](.*)$/);

      if (matchOpen || matchClosed) {
        const completed = !!matchClosed;
        const textStr = (matchOpen ? matchOpen[1] : matchClosed![1]).trim();
        if (!textStr) { continue; } // skip empty checklists

        if (completed) {
          totalCompleted++;
        } else {
          totalOpen++;
        }

        if (!taskMap.has(relativeDir)) {
          taskMap.set(relativeDir, []);
        }
        taskMap.get(relativeDir)!.push({
          notePath: file,
          noteTitle: title,
          text: textStr,
          line: i + 1,
          completed
        });
      }
    }
  }

  const totalTasks = totalOpen + totalCompleted;
  const completionRate = totalTasks > 0 ? Math.round((totalCompleted / totalTasks) * 100) : 0;

  let content = `<div class="tasks-dashboard-view">\n\n`;
  content += `# Tasks Dashboard\n\n`;
  content += `Welcome to the Central Tasks Dashboard for your Markdown Notebook.\n\n`;

  // Stats Strip
  content += `<div class="toc-stats-strip">\n`;
  content += `  <div class="toc-stat-card">\n`;
  content += `    <span class="toc-stat-val">${totalOpen}</span>\n`;
  content += `    <span class="toc-stat-lbl">Open Tasks</span>\n`;
  content += `  </div>\n`;
  content += `  <div class="toc-stat-card">\n`;
  content += `    <span class="toc-stat-val">${totalCompleted}</span>\n`;
  content += `    <span class="toc-stat-lbl">Completed Tasks</span>\n`;
  content += `  </div>\n`;
  content += `  <div class="toc-stat-card">\n`;
  content += `    <span class="toc-stat-val">${completionRate}%</span>\n`;
  content += `    <span class="toc-stat-lbl">Task Completion</span>\n`;
  content += `  </div>\n`;
  content += `</div>\n\n`;

  const sortedDirs = Array.from(taskMap.keys()).sort((a, b) => {
    if (a === 'General Notes') { return 1; }
    if (b === 'General Notes') { return -1; }
    return a.localeCompare(b);
  });

  if (sortedDirs.length === 0) {
    content += `*No tasks found in the notebook notes yet. Add checkboxes like \`- [ ]\` inside any markdown document to list them here!*\n`;
  } else {
    // Open Tasks first
    content += `## Open Tasks\n\n`;
    let openCount = 0;
    for (const dir of sortedDirs) {
      const openTasksInDir = taskMap.get(dir)!.filter(t => !t.completed);
      if (openTasksInDir.length === 0) { continue; }
      openCount += openTasksInDir.length;

      const prettyDirName = dir === 'General Notes' ? 'General Notes' : prettyName(dir);
      content += `### ${prettyDirName}\n\n`;
      for (const t of openTasksInDir) {
        const relativeFilePath = path.relative(rootDir, t.notePath);
        const encodedPath = relativeFilePath.split(path.sep).map(encodeURIComponent).join('/');
        content += `- [ ] [<span class="task-text">${t.text}</span> <em class="task-note-badge">${t.noteTitle}</em>](./${encodedPath}#L${t.line})\n`;
      }
      content += `\n`;
    }
    if (openCount === 0) {
      content += `*No active open tasks. Hurrah!*\n\n`;
    }

    // Completed Tasks
    content += `## Completed Tasks\n\n`;
    let closedCount = 0;
    for (const dir of sortedDirs) {
      const closedTasksInDir = taskMap.get(dir)!.filter(t => t.completed);
      if (closedTasksInDir.length === 0) { continue; }
      closedCount += closedTasksInDir.length;

      const prettyDirName = dir === 'General Notes' ? 'General Notes' : prettyName(dir);
      content += `### ${prettyDirName}\n\n`;
      for (const t of closedTasksInDir) {
        const relativeFilePath = path.relative(rootDir, t.notePath);
        const encodedPath = relativeFilePath.split(path.sep).map(encodeURIComponent).join('/');
        content += `- [x] [<span class="task-text">~~${t.text}~~</span> <em class="task-note-badge">${t.noteTitle}</em>](./${encodedPath}#L${t.line})\n`;
      }
      content += `\n`;
    }
    if (closedCount === 0) {
      content += `*No completed tasks yet.*\n\n`;
    }
  }

  content += `\n</div>\n`;

  const tasksFilePath = path.join(rootDir, '.tasks.md');
  await fsp.writeFile(tasksFilePath, content, 'utf8');
}

async function deleteNode(node: NoteNode | undefined, provider: NotebookProvider): Promise<void> {
  if (!node) {
    return;
  }
  const uri = node.resourceUri;
  if (!uri) {
    return;
  }

  const isDir = node.kind === 'section';
  const label = typeof node.label === 'string' ? node.label : path.basename(uri.fsPath);
  
  const confirm = await vscode.window.showWarningMessage(
    isDir
      ? `Are you sure you want to delete section "${label}" and all of its contents?`
      : `Are you sure you want to delete note "${label}"?`,
    { modal: true },
    'Delete'
  );

  if (confirm !== 'Delete') {
    return;
  }

  try {
    await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
    
    // Update parent TOC and global dashboards
    const parentDir = path.dirname(uri.fsPath);
    const root = resolveRoot();
    if (root) {
      await updateTOCsUpToRoot(parentDir, root.fsPath);
      await updateMasterTOC(root.fsPath);
      await updateTasksDashboard(root.fsPath);
    }
    
    provider.refresh();
    vscode.window.showInformationMessage(`Successfully deleted "${label}".`);
  } catch (err) {
    vscode.window.showErrorMessage(`Notebook: could not delete "${label}" (${String(err)}).`);
  }
}

