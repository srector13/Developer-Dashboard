// Generates every raster the Windows build needs:
//
//   src-tauri/icons/icon.ico     16/20/24/32/40/48/64/128/256 — taskbar, Explorer, alt-tab
//   src-tauri/icons/icon.png     256 — the window icon
//   src-tauri/icons/tray.png      32 — the tray icon (embedded via include_image!)
//   src-tauri/icons/32x32.png    \
//   src-tauri/icons/128x128.png   } sizes tauri.conf.json's bundle.icon lists
//   src-tauri/icons/128x128@2x.png/
//   renderer/app-icon.png        256 — the dashboard header mark
//
// The PNG/ICO encoding and the linear-light downscale are ported from Markdown
// Notebook's scripts/render-win-icons.mjs. The one deliberate difference: that
// script rasterised build/icon-windows.svg through Playwright's Chromium, which
// makes `npm run icons` need a 150MB browser download. The Dev Hub mark is three
// circles and three spokes, so it is drawn analytically here instead — same
// geometry as build/icon.svg, no dependencies, runs in CI unchanged.
//
// Run: node scripts/render-win-icons.mjs

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'src-tauri', 'icons');
const RENDERER_DIR = path.join(ROOT, 'renderer');

// --- The mark, at a 1024 canvas. Mirrors build/icon.svg exactly.

const SIZE = 1024;
const SPOKE = '#58a6ff';
const NODE = '#39c5cf';
const HUB = '#58a6ff';
const CENTER = [512, 512];
const SATELLITES = [[512, 212], [772, 662], [252, 662]];
const SPOKE_WIDTH = 46;
const NODE_RADIUS = 90;
const HUB_RADIUS = 130;

function rgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** Signed distance to a circle: negative inside. */
function sdCircle(px, py, [cx, cy], r) {
  return Math.hypot(px - cx, py - cy) - r;
}

/** Signed distance to a round-capped segment — a stroked line with linecap="round". */
function sdSegment(px, py, [ax, ay], [bx, by], halfWidth) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) - halfWidth;
}

/** Coverage from a signed distance, antialiased across one pixel. */
function coverage(distance) {
  return Math.max(0, Math.min(1, 0.5 - distance));
}

/** Source-over compositing of a solid colour at `alpha`, in straight (un-premultiplied)
    RGBA — which is what PNG stores and what the resizer below expects. Compositing in
    premultiplied space and forgetting to divide back out is what makes antialiased edges
    read as a dark halo. */
function over(dst, offset, [r, g, b], alpha) {
  if (alpha <= 0) return;
  const dstA = dst[offset + 3] / 255;
  const outA = alpha + dstA * (1 - alpha);
  if (outA <= 0) return;
  const blend = (src, dstC) => (src * alpha + dstC * dstA * (1 - alpha)) / outA;
  dst[offset] = Math.round(blend(r, dst[offset]));
  dst[offset + 1] = Math.round(blend(g, dst[offset + 1]));
  dst[offset + 2] = Math.round(blend(b, dst[offset + 2]));
  dst[offset + 3] = Math.round(outA * 255);
}

function renderMark() {
  const data = Buffer.alloc(SIZE * SIZE * 4);
  const spokeColor = rgb(SPOKE), nodeColor = rgb(NODE), hubColor = rgb(HUB);

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const px = x + 0.5, py = y + 0.5;
      const offset = (y * SIZE + x) * 4;

      // Painter's order, same as the SVG: spokes, then satellites, then hub.
      let spoke = 1e9;
      for (const end of SATELLITES) {
        spoke = Math.min(spoke, sdSegment(px, py, CENTER, end, SPOKE_WIDTH / 2));
      }
      over(data, offset, spokeColor, coverage(spoke));

      let node = 1e9;
      for (const c of SATELLITES) node = Math.min(node, sdCircle(px, py, c, NODE_RADIUS));
      over(data, offset, nodeColor, coverage(node));

      over(data, offset, hubColor, coverage(sdCircle(px, py, CENTER, HUB_RADIUS)));
    }
  }

  return { width: SIZE, height: SIZE, data };
}

// --- Downscale
//
// Averaging sRGB bytes directly is the classic cause of "fuzzy, slightly
// muddy" icons: sRGB is a gamma curve, so the mean of two encoded values is
// darker than the mean of the light they represent. Everything below averages
// in LINEAR light and converts back at the end, which keeps thin bright
// strokes on a transparent background crisp instead of grey and washed out.
// Alpha is premultiplied so transparent pixels can't bleed their colour in.

const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(v) {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

function resize(img, size) {
  const out = Buffer.alloc(size * size * 4);
  const scale = img.width / size;
  for (let y = 0; y < size; y++) {
    const y0 = Math.floor(y * scale), y1 = Math.max(y0 + 1, Math.floor((y + 1) * scale));
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * scale), x1 = Math.max(x0 + 1, Math.floor((x + 1) * scale));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * img.width + sx) * 4;
          const alpha = img.data[i + 3] / 255;
          r += SRGB_TO_LINEAR[img.data[i]] * alpha;
          g += SRGB_TO_LINEAR[img.data[i + 1]] * alpha;
          b += SRGB_TO_LINEAR[img.data[i + 2]] * alpha;
          a += alpha;
          n++;
        }
      }
      const d = (y * size + x) * 4;
      const avgA = a / n;
      // Un-premultiply before the curve, or the colour comes back too dark
      const un = avgA > 0 ? 1 / avgA : 0;
      out[d] = linearToSrgb((r / n) * un);
      out[d + 1] = linearToSrgb((g / n) * un);
      out[d + 2] = linearToSrgb((b / n) * un);
      out[d + 3] = Math.round(avgA * 255);
    }
  }
  return { width: size, height: size, data: out };
}

// --- PNG encode (RGBA, filter 0)

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePng(img) {
  const stride = img.width * 4;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    raw[y * (stride + 1)] = 0;
    img.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- ICO container. Every entry is a PNG payload, which Windows Vista+
// (and therefore every WebView2-capable machine) reads natively.

function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach((e, i) => {
    const at = i * 16;
    dir[at] = e.size >= 256 ? 0 : e.size;      // 0 means 256
    dir[at + 1] = e.size >= 256 ? 0 : e.size;
    dir[at + 2] = 0;                            // palette size
    dir[at + 3] = 0;                            // reserved
    dir.writeUInt16LE(1, at + 4);               // color planes
    dir.writeUInt16LE(32, at + 6);              // bits per pixel
    dir.writeUInt32LE(e.png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += e.png.length;
  });

  return Buffer.concat([header, dir, ...entries.map(e => e.png)]);
}

// --- main

// Windows asks for far more sizes than the four a bundler usually emits: 16
// and 20 for list views, 24 for the small taskbar, 32/40/48 for the normal
// taskbar and alt-tab, 64+ for large tiles. Leaving gaps is what makes an icon
// look blurry — Windows rescales whatever it finds nearest.
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

const source = renderMark();
fs.mkdirSync(OUT_DIR, { recursive: true });

fs.writeFileSync(
  path.join(OUT_DIR, 'icon.ico'),
  encodeIco(ICO_SIZES.map(size => ({ size, png: encodePng(resize(source, size)) }))),
);

for (const [name, size] of [['32x32.png', 32], ['128x128.png', 128], ['128x128@2x.png', 256], ['icon.png', 256]]) {
  fs.writeFileSync(path.join(OUT_DIR, name), encodePng(resize(source, size)));
}

// The tray gets its own 32px raster rather than reusing icon.png. The
// notification area draws at 16px (24 or 32 on a scaled display), and handing
// Windows a 256px source to shrink is a second, avoidable source of blur.
fs.writeFileSync(path.join(OUT_DIR, 'tray.png'), encodePng(resize(source, 32)));

// The dashboard header mark lives in renderer/, because that directory is the
// whole frontend root at runtime; anything above it is not addressable.
fs.writeFileSync(path.join(RENDERER_DIR, 'app-icon.png'), encodePng(resize(source, 256)));

console.log(`Wrote ${OUT_DIR}: icon.ico (${ICO_SIZES.join('/')}) + 5 PNGs`);
console.log(`Wrote ${path.join(RENDERER_DIR, 'app-icon.png')}`);
