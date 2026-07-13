// Renders build/splash.bmp — the image the Windows PORTABLE launcher shows
// natively while it unpacks the app (the phase where no Electron window can
// exist yet). Drawn in the Playwright Chromium already required by the e2e
// tests, exported as raw canvas pixels, and encoded here as a 24-bit BMP
// (the only format the NSIS splash plugin accepts).
// Run: node scripts/render-splash.mjs   (CHROMIUM_PATH honored, as elsewhere)
import { createRequire } from 'module';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iconPath = path.join(ROOT, 'build', 'icon.png');
const bmpPath = path.join(ROOT, 'build', 'splash.bmp');

const W = 380, H = 260;

const launchOpts = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
const browser = await chromium.launch(launchOpts);
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

const iconDataUri = `data:image/png;base64,${fs.readFileSync(iconPath).toString('base64')}`;

const rgba = await page.evaluate(async ({ W, H, iconDataUri }) => {
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Dark backdrop matching the in-app splash
  ctx.fillStyle = '#14181e';
  ctx.fillRect(0, 0, W, H);

  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = iconDataUri; });
  const size = 110;
  ctx.drawImage(img, (W - size) / 2, 38, size, size);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#d6dde5';
  ctx.font = '600 19px "Segoe UI", system-ui, sans-serif';
  ctx.fillText('Markdown Notebook', W / 2, 186);
  ctx.fillStyle = '#8b949e';
  ctx.font = '13px "Segoe UI", system-ui, sans-serif';
  ctx.fillText('Starting…', W / 2, 212);

  return Array.from(ctx.getImageData(0, 0, W, H).data);
}, { W, H, iconDataUri });

await browser.close();

// Encode 24-bit bottom-up BMP: 14-byte file header + 40-byte BITMAPINFOHEADER
const rowSize = Math.ceil((W * 3) / 4) * 4;
const pixelBytes = rowSize * H;
const buf = Buffer.alloc(54 + pixelBytes);
buf.write('BM', 0);
buf.writeUInt32LE(54 + pixelBytes, 2);  // file size
buf.writeUInt32LE(54, 10);              // pixel data offset
buf.writeUInt32LE(40, 14);              // DIB header size
buf.writeInt32LE(W, 18);
buf.writeInt32LE(H, 22);
buf.writeUInt16LE(1, 26);               // planes
buf.writeUInt16LE(24, 28);              // bpp
buf.writeUInt32LE(pixelBytes, 34);
for (let y = 0; y < H; y++) {
  const srcRow = H - 1 - y; // BMP rows are bottom-up
  for (let x = 0; x < W; x++) {
    const s = (srcRow * W + x) * 4;
    const d = 54 + y * rowSize + x * 3;
    buf[d] = rgba[s + 2];     // B
    buf[d + 1] = rgba[s + 1]; // G
    buf[d + 2] = rgba[s];     // R
  }
}
fs.writeFileSync(bmpPath, buf);
console.log(`Wrote ${bmpPath} (${W}x${H}, ${buf.length} bytes)`);
