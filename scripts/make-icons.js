// Renders the app icon to PNG with no image dependencies: a gradient tile
// with a white four-point "spark". Run: node scripts/make-icons.js
import fs from 'node:fs';
import zlib from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function render(size, { maskable = false, badge = false } = {}) {
  const rows = [];
  const pad = maskable ? 0 : size * 0.06;
  const radius = maskable ? 0 : size * 0.22;
  const c = size / 2;
  const spark = size * (maskable ? 0.26 : 0.32);
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      // Rounded-square mask (anti-aliased by 2x2 supersampling).
      let cover = 0;
      let white = 0;
      for (const [sx, sy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const px = x + sx;
        const py = y + sy;
        const dx = Math.max(pad + radius - px, 0, px - (size - pad - radius));
        const dy = Math.max(pad + radius - py, 0, py - (size - pad - radius));
        if (dx * dx + dy * dy <= radius * radius || (radius === 0 && px >= pad && py >= pad && px <= size - pad && py <= size - pad)) cover++;
        // Four-point star: |x|^0.5 + |y|^0.5 <= r^0.5
        const ax = Math.abs(px - c) / spark;
        const ay = Math.abs(py - c * 1.0) / spark;
        if (Math.sqrt(ax) + Math.sqrt(ay) <= 1) white++;
      }
      const t = (x + y) / (2 * size);
      const r = Math.round(99 + (236 - 99) * t);
      const g = Math.round(102 + (72 - 102) * t);
      const b = Math.round(241 + (153 - 241) * t);
      const w = white / 4;
      const i = 1 + x * 4;
      row[i] = Math.round(r * (1 - w) + 255 * w);
      row[i + 1] = Math.round(g * (1 - w) + 255 * w);
      row[i + 2] = Math.round(b * (1 - w) + 255 * w);
      row[i + 3] = Math.round((badge ? w : cover / 4) * 255);
      if (badge) row.fill(255, i, i + 3);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync('public/icons', { recursive: true });
fs.writeFileSync('public/icons/icon-192.png', render(192));
fs.writeFileSync('public/icons/icon-512.png', render(512));
fs.writeFileSync('public/icons/maskable-512.png', render(512, { maskable: true }));
fs.writeFileSync('public/icons/apple-touch-icon.png', render(180, { maskable: true }));
fs.writeFileSync('public/icons/badge-96.png', render(96, { badge: true }));
console.log('icons written to public/icons');
