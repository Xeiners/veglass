/**
 * Generates the application icons from code — no binary assets to keep in sync.
 *
 * Everything is rasterised by hand (2× supersampled for anti-aliasing) and
 * encoded as PNG with Node's built-in zlib, then wrapped into a PNG-backed ICO
 * for the Windows build.
 *
 *   node scripts/generate-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'icons');
const SUPERSAMPLE = 2;

/* ------------------------------ geometry ------------------------------ */

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Signed distance to a rounded rectangle covering the whole canvas. */
function roundedRectInside(x, y, size, radius) {
  const half = size / 2;
  const dx = Math.abs(x - half) - (half - radius);
  const dy = Math.abs(y - half) - (half - radius);
  if (dx <= 0 && dy <= 0) return true;
  const cx = Math.max(dx, 0);
  const cy = Math.max(dy, 0);
  return Math.hypot(cx, cy) <= radius;
}

function insideTriangle(px, py, a, b, c) {
  const sign = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
  const d1 = sign([px, py], a, b);
  const d2 = sign([px, py], b, c);
  const d3 = sign([px, py], c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function distanceToSegment(px, py, [ax, ay], [bx, by]) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len = vx * vx + vy * vy;
  const t = len === 0 ? 0 : clamp01((wx * vx + wy * vy) / len);
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

/* ------------------------------ raster ------------------------------ */

const VIOLET_LIGHT = [139, 92, 246];
const VIOLET_DEEP = [49, 46, 129];
const GLYPH = [255, 255, 255];

function renderIcon(size) {
  const s = size * SUPERSAMPLE;
  const radius = s * 0.225;
  const acc = new Float64Array(size * size * 4);

  const apex = [s * 0.755, s * 0.5];
  const top = [s * 0.345, s * 0.265];
  const bottom = [s * 0.345, s * 0.735];
  const cutA = [s * 0.16, s * 0.185];
  const cutB = [s * 0.84, s * 0.815];
  const cutWidth = s * 0.05;

  for (let y = 0; y < s; y += 1) {
    for (let x = 0; x < s; x += 1) {
      if (!roundedRectInside(x + 0.5, y + 0.5, s, radius)) continue;

      // Diagonal gradient across the tile.
      const t = clamp01((x + y) / (2 * s));
      let r = lerp(VIOLET_LIGHT[0], VIOLET_DEEP[0], t);
      let g = lerp(VIOLET_LIGHT[1], VIOLET_DEEP[1], t);
      let b = lerp(VIOLET_LIGHT[2], VIOLET_DEEP[2], t);

      // Top highlight, mirroring the CSS logo.
      const sheen = clamp01(1 - y / (s * 0.55)) * 0.22;
      r = lerp(r, 255, sheen);
      g = lerp(g, 255, sheen);
      b = lerp(b, 255, sheen);

      // Cut line, then the play triangle punched over it.
      if (distanceToSegment(x + 0.5, y + 0.5, cutA, cutB) <= cutWidth) {
        r = lerp(r, GLYPH[0], 0.26);
        g = lerp(g, GLYPH[1], 0.26);
        b = lerp(b, GLYPH[2], 0.26);
      }
      if (insideTriangle(x + 0.5, y + 0.5, top, bottom, apex)) {
        r = GLYPH[0];
        g = GLYPH[1];
        b = GLYPH[2];
      }

      const ox = Math.floor(x / SUPERSAMPLE);
      const oy = Math.floor(y / SUPERSAMPLE);
      const index = (oy * size + ox) * 4;
      acc[index] += r;
      acc[index + 1] += g;
      acc[index + 2] += b;
      acc[index + 3] += 255;
    }
  }

  const samples = SUPERSAMPLE * SUPERSAMPLE;
  const pixels = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    const alpha = acc[i * 4 + 3] / samples;
    const covered = acc[i * 4 + 3] / 255;
    // Premultiplied accumulation → straight alpha.
    pixels[i * 4] = covered === 0 ? 0 : Math.round(acc[i * 4] / covered);
    pixels[i * 4 + 1] = covered === 0 ? 0 : Math.round(acc[i * 4 + 1] / covered);
    pixels[i * 4 + 2] = covered === 0 ? 0 : Math.round(acc[i * 4 + 2] / covered);
    pixels[i * 4 + 3] = Math.round(alpha);
  }
  return pixels;
}

/* ------------------------------ PNG ------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(pixels, size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  // One filter byte (None) per scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** ICO container holding PNG-compressed entries (Vista+). */
function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;

  entries.forEach((entry, index) => {
    const base = index * 16;
    directory[base] = entry.size >= 256 ? 0 : entry.size;
    directory[base + 1] = entry.size >= 256 ? 0 : entry.size;
    directory[base + 2] = 0; // palette
    directory[base + 3] = 0; // reserved
    directory.writeUInt16LE(1, base + 4); // colour planes
    directory.writeUInt16LE(32, base + 6); // bits per pixel
    directory.writeUInt32LE(entry.png.length, base + 8);
    directory.writeUInt32LE(offset, base + 12);
    offset += entry.png.length;
  });

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.png)]);
}

/* ------------------------------ run ------------------------------ */

mkdirSync(OUT_DIR, { recursive: true });

const PNG_TARGETS = [
  ['32x32.png', 32],
  ['128x128.png', 128],
  ['128x128@2x.png', 256],
  ['icon.png', 512],
];

const cache = new Map();
const pngFor = (size) => {
  if (!cache.has(size)) cache.set(size, encodePng(renderIcon(size), size));
  return cache.get(size);
};

for (const [name, size] of PNG_TARGETS) {
  writeFileSync(join(OUT_DIR, name), pngFor(size));
  console.log(`icons/${name}  ${size}×${size}`);
}

const ico = encodeIco([16, 32, 48, 64, 128, 256].map((size) => ({ size, png: pngFor(size) })));
writeFileSync(join(OUT_DIR, 'icon.ico'), ico);
console.log(`icons/icon.ico  ${ico.length} bytes`);
