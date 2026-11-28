// Draws the app icons: a white "L" on the accent colour. Run from apps/web when the mark changes.
import { writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";

const ACCENT = [0x2d, 0x6b, 0xe4];
const WHITE = [0xff, 0xff, 0xff];

const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
};

function png(size) {
  const row = size * 3 + 1;
  const pixels = Buffer.alloc(row * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // The letter stays inside the middle 80%, so a masked icon never cuts it.
      const u = x / size;
      const v = y / size;
      const stem = u >= 0.34 && u < 0.46 && v >= 0.26 && v < 0.74;
      const foot = u >= 0.34 && u < 0.68 && v >= 0.62 && v < 0.74;
      pixels.set(stem || foot ? WHITE : ACCENT, y * row + 1 + x * 3);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const [name, size] of [
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["icon-maskable-512.png", 512],
  ["apple-touch-icon.png", 180],
]) {
  writeFileSync(new URL(`../public/${name}`, import.meta.url), png(size));
}
