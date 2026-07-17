// Integration test for the persistent scan cache: loads the REAL compiled
// main process (out/main.js) with a stubbed electron module and drives the
// get-notebook-tree / search-notes IPC handlers against a temp notebook.
//
// Usage: node tmp-scan-cache-test.cjs cold|warm <workdir>
//   cold: fresh userData -> expects every note read during the tree scan
//   warm: same userData  -> expects ~0 note reads during the tree scan
//         (meta from cache), search still finds content afterwards
const Module = require('module');
const path = require('path');
const fs = require('fs');

const MODE = process.argv[2];
const WORK = process.argv[3];
const NB = path.join(WORK, 'notebook');
const UD = path.join(WORK, 'userdata');
const NOTES = 300;

if (MODE === 'cold') {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(path.join(NB, 'Projects'), { recursive: true });
  fs.mkdirSync(UD, { recursive: true });
  for (let i = 0; i < NOTES; i++) {
    const dir = i % 3 === 0 ? path.join(NB, 'Projects') : NB;
    fs.writeFileSync(path.join(dir, `note-${i}.md`),
      `---\ntitle: Note ${i}\ntags: [t${i % 7}]\n---\n# Note ${i}\n\nBody with the special zebra-needle-${i} word.\n- [ ] task ${i}\n`);
  }
}

// --- electron stub ---------------------------------------------------------
const ipcHandlers = {};
const appHandlers = {};
const electronStub = {
  app: {
    getPath: () => UD,
    setPath: () => {},
    getVersion: () => '0.0.0-test',
    requestSingleInstanceLock: () => true,
    on: (ev, fn) => { appHandlers[ev] = fn; },
    whenReady: () => new Promise(() => {}), // never: no windows in this test
    quit: () => {},
    isPackaged: false,
  },
  ipcMain: { handle: (name, fn) => { ipcHandlers[name] = fn; }, on: () => {} },
  BrowserWindow: class {},
  dialog: {}, shell: {}, globalShortcut: { register: () => true, unregister: () => {}, unregisterAll: () => {} },
  Menu: { buildFromTemplate: () => ({ popup: () => {} }), setApplicationMenu: () => {} },
  MenuItemConstructorOptions: {},
  nativeTheme: { shouldUseDarkColors: true, on: () => {} },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return origLoad.apply(this, arguments);
};

// --- count .md reads through fs.promises.readFile --------------------------
let mdReads = 0;
const origReadFile = fs.promises.readFile;
fs.promises.readFile = function (p, ...rest) {
  if (typeof p === 'string' && p.endsWith('.md') && p.startsWith(NB)) mdReads++;
  return origReadFile.call(this, p, ...rest);
};

(async () => {
  // settle mtimes past the 2s freshness window so the cache path is eligible
  const newest = Date.now() - fs.statSync(path.join(NB, 'note-1.md')).mtimeMs;
  if (newest < 2200) await new Promise(r => setTimeout(r, 2200 - newest));

  require(path.join(__dirname, '..', '..', 'out', 'main.js'));
  if (!ipcHandlers['get-notebook-tree']) throw new Error('handlers not registered');

  const t0 = Date.now();
  mdReads = 0;
  const tree = await ipcHandlers['get-notebook-tree'](null, NB, null);
  const treeMs = Date.now() - t0;
  const treeReads = mdReads;

  const pageCount = (function count(n) {
    return n.pages.length + n.sections.reduce((a, s) => a + count(s), 0);
  })(tree);
  const sampleTitleOk = JSON.stringify(tree).includes('"Note 42"');
  const tasksOk = JSON.stringify(tree).includes('task 42');

  // Search must work either way (warm start awaits the background build)
  const results = await ipcHandlers['search-notes'](null, 'zebra-needle-42');
  const searchOk = Array.isArray(results) && results.length === 1 && results[0].title === 'Note 42';
  const backgroundReads = mdReads - treeReads;

  // Persist the cache like a real quit would
  if (appHandlers['before-quit']) appHandlers['before-quit']();
  const cacheFile = path.join(UD, 'scan-meta-cache-v1.json');
  const cacheEntries = fs.existsSync(cacheFile) ? Object.keys(JSON.parse(fs.readFileSync(cacheFile, 'utf8'))).length : 0;

  console.log(JSON.stringify({ mode: MODE, treeMs, treeReads, backgroundReads, pageCount, sampleTitleOk, tasksOk, searchOk, cacheEntries }));

  let fail = false;
  if (pageCount !== NOTES || !sampleTitleOk || !tasksOk || !searchOk) fail = true;
  if (MODE === 'cold' && treeReads < NOTES) fail = true;                 // cold must read everything
  if (MODE === 'warm' && treeReads > 5) fail = true;                     // warm tree scan must be ~read-free
  if (MODE === 'warm' && backgroundReads < NOTES - 5) fail = true;       // docs rebuilt in background
  if (cacheEntries !== NOTES) fail = true;
  console.log(fail ? `${MODE.toUpperCase()} FAILED` : `${MODE.toUpperCase()} OK`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
