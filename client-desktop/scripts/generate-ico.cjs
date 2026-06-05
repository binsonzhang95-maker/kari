const fs = require('fs');
const path = require('path');

const [outPath, iconsetDir] = process.argv.slice(2);
if (!outPath || !iconsetDir) {
  console.error('Usage: node scripts/generate-ico.cjs <output.ico> <iconset-dir>');
  process.exit(64);
}

const entries = [
  { size: 16, file: 'icon_16x16.png' },
  { size: 32, file: 'icon_32x32.png' },
  { size: 64, file: 'icon_32x32@2x.png' },
  { size: 128, file: 'icon_128x128.png' },
  { size: 256, file: 'icon_128x128@2x.png' }
].map((entry) => ({
  ...entry,
  data: fs.readFileSync(path.join(iconsetDir, entry.file))
}));

const headerSize = 6 + entries.length * 16;
let offset = headerSize;
const header = Buffer.alloc(headerSize);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(entries.length, 4);

entries.forEach((entry, index) => {
  const base = 6 + index * 16;
  header.writeUInt8(entry.size === 256 ? 0 : entry.size, base);
  header.writeUInt8(entry.size === 256 ? 0 : entry.size, base + 1);
  header.writeUInt8(0, base + 2);
  header.writeUInt8(0, base + 3);
  header.writeUInt16LE(1, base + 4);
  header.writeUInt16LE(32, base + 6);
  header.writeUInt32LE(entry.data.length, base + 8);
  header.writeUInt32LE(offset, base + 12);
  offset += entry.data.length;
});

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, Buffer.concat([header, ...entries.map((entry) => entry.data)]));
