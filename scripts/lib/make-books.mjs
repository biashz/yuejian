/**
 * 其余电子书格式的样本：FB2 与 CBZ（漫画）。
 *
 * 和 `make-epub.mjs` 一样现场生成、不往仓库里塞二进制。两种格式的「最小可读」
 * 恰好都很小：
 *
 * - **FB2** 就是一份 XML，书的元数据与章节结构全在标签里；
 * - **CBZ** 就是「改了扩展名的 zip，里面装图片」，漫画书解析器只认图片条目。
 *
 * ZIP 部分复用 `make-epub.mjs` 的 `zipStored`：EPUB 要求 `mimetype` 排第一且不压缩，
 * CBZ 没有这个要求，但同一份实现两个都能用。
 */
import { deflateSync } from "node:zlib";
import { zipStored, crc32 } from "./make-epub.mjs";

/**
 * 现画一张纯色 PNG。
 *
 * 不塞 base64 常量也不用 2×2 的占位图：固定版面渲染器按页面的**固有尺寸**排版，
 * 图有多大页就有多大——2×2 的图会得到 2 像素宽的一页，测出来的「渲染成功」
 * 与真实漫画的一点关系都没有。所以按真实页面比例画，只是压成纯色省字节。
 *
 * @param {number} width
 * @param {number} height
 * @param {[number, number, number]} rgb
 * @returns {Buffer}
 */
function makePng(width, height, rgb) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // 位深
  ihdr[9] = 2;   // 真彩色 RGB
  // 10..12 分别是压缩 / 过滤 / 隔行方式，全 0

  // 每行前面一个过滤器字节（0 = 不过滤），后面是 RGB 三元组
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * FB2（FictionBook 2）：两节正文，第一节里放一句全书唯一的词，供搜索断言用。
 *
 * `section` 直接挂在 `body` 下是 FB2 的常规写法，库会为每个 `section` 生成一章，
 * 标题取 `title` 元素的文字。
 *
 * @param {{ title?: string, creator?: string }} [options]
 * @returns {Buffer}
 */
export function buildFb2({ title = "冒烟 FB2", creator = "测试" } = {}) {
  const para = (marker) => `<p>${marker}　` + "这是一段用来撑满页面的正文，重复出现以便分页。".repeat(6) + "</p>";
  const section = (heading, marker, tail = "") =>
    `<section><title><p>${heading}</p></title>${para(marker).repeat(10)}${tail}</section>`;

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
  <description>
    <title-info>
      <genre>prose</genre>
      <author><first-name>${creator}</first-name><last-name>作者</last-name></author>
      <book-title>${title}</book-title>
      <lang>zh</lang>
    </title-info>
  </description>
  <body>
    ${section("第一章 起点", "①", "<p>檐下听雨，石阶生苔。</p>")}
    ${section("第二章 展开", "②")}
  </body>
</FictionBook>`;
  return Buffer.from(xml, "utf8");
}

/**
 * CBZ（漫画）：三张图一页一张。
 *
 * 文件名带序号，因为漫画书解析器按文件名排序决定页序（用的还是
 * `Intl.Collator` 的数字感知比较，`10` 会排在 `9` 后面）。
 *
 * @returns {Buffer}
 */
export function buildCbz() {
  return zipStored([
    { name: "page-1.png", data: makePng(600, 900, [178, 58, 43]) },
    { name: "page-2.png", data: makePng(600, 900, [74, 92, 122]) },
    { name: "page-3.png", data: makePng(600, 900, [95, 115, 80]) },
  ]);
}

export { makePng };

/**
 * 最小可读的 MOBI（Mobipocket 6）。
 *
 * 结构是三层套娃，全部按大端写：
 *
 * 1. **PalmDB 头**（78 字节）：`type`/`creator` 在 60/64 处写 `BOOKMOBI`——库就是
 *    靠这两处认 Kindle 格式的；76 处是记录数。
 * 2. **记录表**：每条 8 字节（偏移 4 + 属性 1 + 编号 3）。
 * 3. **记录 0**：PalmDOC 头（压缩方式、正文长度、记录数、加密标志）+ MOBI 头
 *    （`MOBI` 魔数、编码、书名偏移）+ 书名。之后是正文记录。
 *
 * 两个刻意的简化：压缩方式写 1（不压缩），所以正文记录就是 UTF-8 原文；
 * 不写 EXTH，书名走 MOBI 头里的 `titleOffset`。
 *
 * 目录要能点，`filepos` 就得是**字节**偏移。这里先用等长的占位号
 * （`0000000000`）排好版，量出真实偏移后再把占位号原地替换掉——
 * 长度不变，前面算出的偏移因此全部作废不了。
 *
 * @param {{ title?: string, script?: boolean }} [options]
 *   `script: true` 在第一章塞一段 `<script>`：MOBI 的正文来自文件本身，
 *   没有 EPUB 那条资源钩子，只能靠 `hardenBook` 在读回 blob 之后洗掉。
 * @returns {Buffer}
 */
export function buildMobi({ title = "冒烟 MOBI", script = false } = {}) {
  const para = (marker) => `<p>${marker}　` + "这是一段用来撑满页面的正文，重复出现以便分页。".repeat(6) + "</p>";
  const chapters = [
    { heading: "第一章 起点",
      body: para("①").repeat(10) + "<p>檐下听雨，石阶生苔。</p>"
        + (script ? "<script>window.parent.__mobiPwned = 1;</script>" : "") },
    { heading: "第二章 展开", body: para("②").repeat(10) },
  ];
  const slot = "0000000000";

  // 第一个正文块里放 guide 与目录：库读 `<reference type="toc">` 找到目录页，
  // 再把目录页里的 `<a filepos>` 收集成 TOC
  const head = `<html><head><title>${title}</title></head><body>
<guide><reference type="toc" title="目录" filepos="0"/></guide>
<h1>目录</h1>
${chapters.map((item) => `<p><a filepos="${slot}">${item.heading}</a></p>`).join("\n")}
<mbp:pagebreak/>`;
  const blocks = chapters.map((item, index) =>
    `<html><head><title>${item.heading}</title></head><body><h1>${item.heading}</h1>${item.body}</body></html>`
    + (index === chapters.length - 1 ? "" : "<mbp:pagebreak/>"));

  // 两遍：先用占位号量偏移，再把占位号换成真实偏移
  let text = Buffer.from(head + blocks.join(""), "utf8");
  const positions = chapters.map((item) => text.indexOf(Buffer.from(`<h1>${item.heading}</h1>`, "utf8")));
  let filled = head;
  for (const position of positions) {
    filled = filled.replace(slot, String(position).padStart(slot.length, "0"));
  }
  text = Buffer.from(filled + blocks.join(""), "utf8");

  const recordSize = 4096;
  const chunks = [];
  for (let offset = 0; offset < text.length; offset += recordSize) {
    chunks.push(text.subarray(offset, offset + recordSize));
  }

  const titleBytes = Buffer.from(title, "utf8");
  const header = Buffer.alloc(300);
  header.writeUInt16BE(1, 0);                 // 压缩方式：不压缩
  header.writeUInt32BE(text.length, 4);       // 正文总长
  header.writeUInt16BE(chunks.length, 8);     // 正文记录数
  header.writeUInt16BE(recordSize, 10);
  header.writeUInt16BE(0, 12);                // 加密方式：无
  header.write("MOBI", 16, "ascii");
  header.writeUInt32BE(264, 20);              // MOBI 头长度
  header.writeUInt32BE(2, 24);                // 类型：书
  header.writeUInt32BE(65001, 28);            // 编码：UTF-8
  header.writeUInt32BE(1, 32);                // 唯一标识
  header.writeUInt32BE(6, 36);                // 版本 6 = MOBI6
  header.writeUInt32BE(300, 84);              // 书名紧跟在头后面
  header.writeUInt32BE(titleBytes.length, 88);
  header.writeUInt8(0, 94);                   // 地区 / 语言
  header.writeUInt8(0, 95);
  header.writeUInt32BE(0xffffffff, 108);      // 无资源区
  header.writeUInt32BE(0, 112);
  header.writeUInt32BE(0, 116);
  header.writeUInt32BE(0, 128);               // 不跟 EXTH
  header.writeUInt32BE(0, 240);               // 无尾部附加字节
  header.writeUInt32BE(0xffffffff, 244);      // 不跟 INDX

  const records = [Buffer.concat([header, titleBytes]), ...chunks];
  const pdb = Buffer.alloc(78);
  pdb.write("smoke-mobi", 0, "ascii");
  pdb.write("BOOK", 60, "ascii");
  pdb.write("MOBI", 64, "ascii");
  pdb.writeUInt16BE(records.length, 76);

  const table = Buffer.alloc(records.length * 8);
  let cursor = 78 + table.length;
  records.forEach((record, index) => {
    table.writeUInt32BE(cursor, index * 8);
    table.writeUInt32BE(index, index * 8 + 4);   // 属性 + 编号，库只读偏移
    cursor += record.length;
  });

  return Buffer.concat([pdb, table, ...records]);
}
