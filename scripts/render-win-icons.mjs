// Generates the Windows icon set for the Rust/Tauri shell from build/icon.png:
//   src-tauri/icons/icon.ico          (16/32/48/64/128/256, PNG-compressed)
//   src-tauri/icons/32x32.png
//   src-tauri/icons/128x128.png
//   src-tauri/icons/128x128@2x.png
//   src-tauri/icons/icon.png          (256x256, used for the tray)
//
// Deliberately dependency-free: it decodes the source PNG with node's own
// zlib, box-filters it down, and re-encodes. `npm install` is not needed, so
// the icons can be regenerated on any machine with node.
// Run: node scripts/render-win-icons.mjs

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'build', 'icon.png');
const OUT_DIR = path.join(ROOT, 'src-tauri', 'icons');

// --- PNG decode (8-bit RGB/RGBA, non-interlaced — what render-icon.mjs emits)

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0, height = 0, channels = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      const colorType = data[9];
      if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`);
      if (data[12] !== 0) throw new Error('interlaced PNGs are not supported');
      channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
      if (!channels) throw new Error(`unsupported color type ${colorType}`);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += len + 12;
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    // Undo the per-scanline filter (PNG spec §9.2)
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      switch (filter) {
        case 1: line[i] = (line[i] + a) & 0xff; break;
        case 2: line[i] = (line[i] + b) & 0xff; break;
        case 3: line[i] = (line[i] + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          line[i] = (line[i] + pred) & 0xff;
          break;
        }
      }
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      out[d] = line[s];
      out[d + 1] = line[s + 1];
      out[d + 2] = line[s + 2];
      out[d + 3] = channels === 4 ? line[s + 3] : 255;
    }
    prev = line;
  }
  return { width, height, data: out };
}

// --- Box-filter downscale, premultiplying alpha so transparent edge pixels
// don't bleed their (undefined) color into the average.

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
          r += img.data[i] * alpha;
          g += img.data[i + 1] * alpha;
          b += img.data[i + 2] * alpha;
          a += img.data[i + 3];
          n++;
        }
      }
      const d = (y * size + x) * 4;
      const avgA = a / n;
      const un = avgA > 0 ? 255 / avgA : 0;
      out[d] = Math.min(255, Math.round((r / n) * un));
      out[d + 1] = Math.min(255, Math.round((g / n) * un));
      out[d + 2] = Math.min(255, Math.round((b / n) * un));
      out[d + 3] = Math.round(avgA);
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

const source = decodePng(fs.readFileSync(SRC));
fs.mkdirSync(OUT_DIR, { recursive: true });

const icoSizes = [16, 32, 48, 64, 128, 256];
const ico = encodeIco(icoSizes.map(size => ({ size, png: encodePng(resize(source, size)) })));
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);

for (const [name, size] of [['32x32.png', 32], ['128x128.png', 128], ['128x128@2x.png', 256], ['icon.png', 256]]) {
  fs.writeFileSync(path.join(OUT_DIR, name), encodePng(resize(source, size)));
}

console.log(`Wrote ${OUT_DIR}: icon.ico (${icoSizes.join('/')}) + 4 PNGs`);
