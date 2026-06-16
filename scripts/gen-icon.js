'use strict';

// Generates assets/icon.png — a 512x512 "liquid bubble" app icon, drawn pixel
// by pixel (no native deps) so the portable build always has a real icon.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 512;

function lerp(a, b, t) { return a + (b - a) * t; }
function mix(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

const PURPLE = [124, 77, 255];
const PINK = [255, 61, 176];
const CYAN = [0, 229, 255];
const DEEP = [12, 8, 30];

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
let p = 0;
const cx = SIZE / 2;
const cy = SIZE / 2;
const R = SIZE * 0.42;

for (let y = 0; y < SIZE; y++) {
  raw[p++] = 0; // filter byte per scanline
  for (let x = 0; x < SIZE; x++) {
    const dx = x - cx;
    const dy = y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Background deep field
    let color = DEEP.slice();
    let alpha = 255;

    if (dist <= R) {
      // Diagonal vivid gradient inside the bubble
      const t = (x + y) / (SIZE * 2);
      color = t < 0.5 ? mix(PURPLE, PINK, t * 2) : mix(PINK, CYAN, (t - 0.5) * 2);
      // Glossy highlight (upper-left)
      const hx = cx - R * 0.35;
      const hy = cy - R * 0.35;
      const hd = Math.sqrt((x - hx) ** 2 + (y - hy) ** 2);
      const hl = Math.max(0, 1 - hd / (R * 0.7));
      color = mix(color, [255, 255, 255], hl * 0.55);
      // Soft edge
      const edge = Math.min(1, (R - dist) / 14);
      alpha = Math.round(255 * edge);
    } else {
      alpha = 0; // transparent outside the bubble
    }

    raw[p++] = Math.round(color[0]);
    raw[p++] = Math.round(color[1]);
    raw[p++] = Math.round(color[2]);
    raw[p++] = alpha;
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const CRC_TABLE = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // color type RGBA
const idat = zlib.deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0))
]);

const out = path.join(__dirname, '..', 'assets', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes');
