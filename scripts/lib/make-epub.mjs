/**
 * 现场生成 EPUB：避免往仓库里塞二进制 fixture。
 *
 * 两个脚本都要用同一本样本——
 * - `scripts/smoke-reader.mjs`：直接读到内存，HTTP 交给 Chrome；
 * - `scripts/e2e-ebook.mjs`：必须落盘，再由 Tauri 的 `import_files` 走一遍
 *   `asset://` + ACL 的真实链路。
 *
 * 抽成公共模块是为了让两者**共用一个字节源**：样本结构一变，两边同时变，
 * 不会出现「冒烟通过但真机打不开」这种最难查的偏差。
 *
 * ZIP 是手写的（约 60 行），不引第三方依赖：EPUB 规范只要求
 * `mimetype` 是第一个条目且**不压缩**（store），其余条目 deflate 即可。
 */

import { deflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 手写 ZIP：mimetype 必须第一个条目且不压缩，其余 deflate */
function zipStored(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data, store } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    const body = store ? raw : deflateRawSync(raw);
    const method = store ? 0 : 8;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}

/**
 * 三章 EPUB3。
 *
 * 每章塞够正文，保证 1440×900 下不止一页——只有一页的话「翻页」和「记位置」
 * 都测不出来（`relocate` 只会触发一次，CFI 不会变）。
 *
 * @param {object} [options]
 * @param {boolean} [options.script=false]
 *   第一章里是否放一段 `<script>`。冒烟测试要它来证明清洗生效
 *   （失效则 `window.parent.__pwned` 会被置位）；真机 E2E 不需要这枚"炸弹"，
 *   因为真机上 CSP 才是第一道防线，留着反而让失败原因变得含混。
 * @param {string} [options.title="冒烟样本"] OPF 里的书名，用于验证回填
 * @param {string} [options.creator="测试"] OPF 里的作者
 * @returns {Buffer} 完整的 .epub 字节
 */
export function buildEpub({ script = false, title = "冒烟样本", creator = "测试" } = {}) {
  const para = (marker) => `<p>${marker}　` + "这是一段用来撑满页面的正文，重复出现以便分页。".repeat(6) + "</p>";
  const chapter = (heading, marker, extra = "", tail = "") => `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${heading}</title></head>
<body><h1>${heading}</h1>${extra}${para(marker).repeat(12)}${tail}</body></html>`;

  const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:smoke-0001</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:creator>${creator}</dc:creator>
    <dc:language>zh-CN</dc:language>
    <meta property="dcterms:modified">2026-11-18T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch3" href="ch3.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="ch1"/><itemref idref="ch2"/><itemref idref="ch3"/></spine>
</package>`;

  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目录</title></head><body>
<nav epub:type="toc" id="toc"><h1>目录</h1><ol>
  <li><a href="ch1.xhtml">第一章 起点</a></li>
  <li><a href="ch2.xhtml">第二章 展开</a></li>
  <li><a href="ch3.xhtml">第三章 收束</a></li>
</ol></nav></body></html>`;

  const payload = script ? "<script>window.parent.__pwned = 1;</script>" : "";

  // 第一章带一个脚注：正文里的注号指向章末的 aside，用来验「点注号弹小窗」。
  // aside 用 epub:type 与 id 双重标注——真实电子书里两者各有用例
  const note = `<p>正文末尾有一个注号<a href="#fn1" epub:type="noteref">1</a>。</p>`;
  const noteBody = `<aside id="fn1" epub:type="footnote"><p>这是一条脚注：青苔生于石阶背阴处，雨后可采。</p></aside>`;

  return zipStored([
    { name: "mimetype", data: "application/epub+zip", store: true },
    { name: "META-INF/container.xml", data: container },
    { name: "OEBPS/content.opf", data: opf },
    { name: "OEBPS/nav.xhtml", data: nav },
    { name: "OEBPS/ch1.xhtml", data: chapter("第一章 起点", "①", payload, note + noteBody) },
    // 第二章放一个全书只出现一次的词，搜索断言才有确定答案
    { name: "OEBPS/ch2.xhtml", data: chapter("第二章 展开", "②", "", "<p>檐下听雨，石阶生苔。</p>") },
    { name: "OEBPS/ch3.xhtml", data: chapter("第三章 收束", "③") },
  ]);
}
