/** 生成应用图标源文件（1024×1024 PNG），再交给 `tauri icon` 切分多尺寸。 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const SIZE = 1024;
const pixels = Buffer.alloc(SIZE * SIZE * 4);
const PAPER = [243, 237, 225];
const INK = [36, 31, 26];
const ACCENT = [178, 58, 43];

const insideRounded = (x, y, r) => {
  const cx = Math.min(Math.max(x, r), SIZE - r);
  const cy = Math.min(Math.max(y, r), SIZE - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

const put = (x, y, [r, g, b], alpha = 255) => {
  const i = (y * SIZE + x) * 4;
  pixels[i] = r;
  pixels[i + 1] = g;
  pixels[i + 2] = b;
  pixels[i + 3] = alpha;
};

// 纸色圆角底
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const alpha = insideRounded(x, y, 196) ? 255 : 0;
    put(x, y, PAPER, alpha);
  }
}

const rect = (x0, y0, w, h, color) => {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (x >= 0 && y >= 0 && x < SIZE && y < SIZE) put(x, y, color);
    }
  }
};

// 书脊
rect(150, 188, 58, 648, ACCENT);
// 三行文字，长度递减，像一页排好的纸
rect(280, 320, 520, 54, INK);
rect(280, 470, 420, 54, INK);
rect(280, 620, 300, 54, INK);
// 右下角一枚朱砂点
for (let y = -46; y <= 46; y++) {
  for (let x = -46; x <= 46; x++) {
    if (x * x + y * y <= 46 * 46) put(720 + x, 760 + y, ACCENT);
  }
}

// ---- 最小 PNG 编码 ----
const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, body) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, body])));
  return Buffer.concat([len, typeBuf, body, crc]);
};

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const outDir = path.join(process.cwd(), "src-tauri");
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "app-icon.png"), png);
console.log("icon source →", path.join(outDir, "app-icon.png"));
