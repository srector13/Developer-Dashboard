// Re-copies the vendored UI font files from the @fontsource packages into ui/.
// Run after upgrading @fontsource/inter or @fontsource/outfit:
//   npm run fonts:sync && npm run ui:sync
//
// The fonts land in ui/ rather than in an app, because every app in the suite
// uses the same two families; `sync-ui.mjs` is what gets them from there into
// each renderer.
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST = path.join(ROOT, 'ui', 'fonts');
fs.mkdirSync(DEST, { recursive: true });

let copied = 0;
for (const family of ['inter', 'outfit']) {
  for (const weight of [300, 400, 500, 600, 700]) {
    const name = `${family}-latin-${weight}-normal.woff2`;
    const src = path.join(ROOT, 'node_modules', '@fontsource', family, 'files', name);
    fs.copyFileSync(src, path.join(DEST, name));
    copied++;
  }
}
console.log(`Copied ${copied} font files to ${DEST}`);
