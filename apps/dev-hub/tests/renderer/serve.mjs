// A throwaway static server for renderer/.
//
// The pages carry a real CSP with `script-src 'self'`, and `'self'` does not
// resolve usefully for a file:// origin — loading them off disk would either
// block the scripts or test a policy the app never runs under. Serving them
// over http on a loopback port keeps the specs honest about the CSP.
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

export async function serve(root) {
  const server = http.createServer((req, res) => {
    const relative = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    const file = path.join(root, relative || 'index.html');
    // Never serve outside the renderer directory, even in a test harness.
    if (!file.startsWith(path.resolve(root))) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, body) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Shared PASS/FAIL reporter, so both specs print the same shape. */
export function reporter() {
  let passed = 0, failed = 0;
  return {
    check(name, condition, extra = '') {
      const ok = !!condition;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
      ok ? passed++ : failed++;
    },
    finish(label) {
      console.log(`\n${label}: ${passed} passed, ${failed} failed`);
      return failed;
    },
  };
}
