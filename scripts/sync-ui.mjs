// Copies ui/ into each app's renderer.
//
// Tauri serves one directory as the whole frontend root, and nothing above it
// is addressable at runtime — so a shared stylesheet cannot simply be imported
// from a sibling folder the way it would be in a bundler. The copies are
// committed rather than generated at build time, so a fresh clone builds with
// cargo alone and no npm step.
//
// Committed copies drift, which is the whole problem this was meant to solve,
// so `--check` re-runs the copy in memory and fails if what is on disk differs.
// CI runs that on every push.
//
// Run: node scripts/sync-ui.mjs
//      node scripts/sync-ui.mjs --check

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'ui');
const APPS = ['dev-hub', 'log-viewer', 'markdown-notebook'];

/** Every file under `dir`, as paths relative to it. */
function walk(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const relative = path.join(prefix, entry.name);
    return entry.isDirectory()
      ? walk(path.join(dir, entry.name), relative)
      : [relative];
  });
}

const files = walk(SOURCE);
const check = process.argv.includes('--check');
const drifted = [];
let written = 0;

for (const app of APPS) {
  const target = path.join(ROOT, 'apps', app, 'renderer', 'vendor', 'suite');

  for (const file of files) {
    const from = path.join(SOURCE, file);
    const to = path.join(target, file);
    const expected = fs.readFileSync(from);

    if (check) {
      // A missing copy counts as drift, not as a crash — the report should
      // name every file that is wrong, not stop at the first one.
      const actual = fs.existsSync(to) ? fs.readFileSync(to) : null;
      if (actual === null || !actual.equals(expected)) {
        drifted.push(path.relative(ROOT, to));
      }
      continue;
    }

    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, expected);
    written++;
  }

  // A file deleted from ui/ must disappear from the copies too, or it lingers
  // forever and the next person assumes it is still in use.
  if (fs.existsSync(target)) {
    for (const stale of walk(target).filter(file => !files.includes(file))) {
      const at = path.join(target, stale);
      if (check) drifted.push(`${path.relative(ROOT, at)} (no longer in ui/)`);
      else fs.rmSync(at);
    }
  }
}

if (check) {
  if (drifted.length) {
    console.error('The vendored copies of ui/ are out of date:\n');
    for (const file of drifted) console.error(`  ${file}`);
    console.error('\nRun `npm run ui:sync` and commit the result.');
    process.exit(1);
  }
  console.log(`ui/ is in sync across ${APPS.length} apps (${files.length} files each)`);
} else {
  console.log(`Copied ${files.length} files into ${APPS.length} apps (${written} writes)`);
}
