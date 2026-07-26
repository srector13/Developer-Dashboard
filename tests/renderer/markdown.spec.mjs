import * as fs from 'fs';
import vm from 'vm';
const R = new URL('../../renderer/', import.meta.url).pathname;
const ctx = { window: {}, console };
ctx.globalThis = ctx; ctx.self = ctx;
vm.createContext(ctx);
// markdown-it UMD needs module/exports absent to take the global branch
vm.runInContext(fs.readFileSync(`${R}/vendor/markdown-it.min.js`,'utf8'), ctx);
vm.runInContext(fs.readFileSync(`${R}/vendor/highlight.min.js`,'utf8'), ctx);
vm.runInContext(fs.readFileSync(`${R}/vendor/hljs-dart.min.js`,'utf8'), ctx);
vm.runInContext(fs.readFileSync(`${R}/vendor/hljs-scala.min.js`,'utf8'), ctx);
// markdown-it/hljs attach to `this`/globalThis, mirror onto window
vm.runInContext('window.markdownit = globalThis.markdownit; window.hljs = globalThis.hljs;', ctx);
vm.runInContext(fs.readFileSync(`${R}/markdown.js`,'utf8'), ctx);

const md = ctx.window.NotebookMarkdown;
const sample = `---
title: Test
tags: [a, b]
---

# Test

Some ==highlighted== text and a [[Wiki Page|label]] link.

- [ ] open task
- [x] done task

![shot|300](attachments/x.png "A caption")

\`\`\`mermaid
flowchart LR
A --> B
\`\`\`

\`\`\`dart
void main() { print('hi'); }
\`\`\`

\`\`\`js
const x = 1;
\`\`\`

[external](https://example.com)
`;
const out = md.render(sample, { resourceBase: 'C:\\notes\\section' });
const checks = {
  'frontmatter stripped': !out.includes('title: Test'),
  'h1 stripped': !/<h1>/.test(out),
  'mark rule': out.includes('<mark>highlighted</mark>'),
  'wiki link': out.includes('class="wiki-link" data-page="Wiki Page.md"') && out.includes('>label<'),
  'task checkbox open': out.includes('class="task-checkbox" type="checkbox" style'),
  'task checkbox done': out.includes('type="checkbox" checked'),
  'task data-line': /data-line="\d+"/.test(out),
  'mermaid block': out.includes('class="mermaid-block-container"') && out.includes('flowchart LR'),
  'image width': out.includes('width: 300px'),
  'figcaption': out.includes('<figcaption>A caption</figcaption>'),
  'image asset url': out.includes('file://C:/notes/section/attachments/x.png'),
  'dart highlight': /language-dart|hljs/.test(out) && out.includes('hljs'),
  'js highlight': out.includes('hljs-keyword') || out.includes('hljs'),
  'external target': out.includes('target="_blank"'),
};
let fail = 0;
for (const [k,v] of Object.entries(checks)) { if(!v) fail++; console.log((v?'  ok  ':'  FAIL') + '  ' + k); }
console.log('\nresolvePath:', md.resolvePath('C:\\notes\\sec', '../att/x.png'));
console.log('resolvePath posix:', md.resolvePath('/home/u/n', './a/b.png'));
if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
console.log('\nall checks passed');
