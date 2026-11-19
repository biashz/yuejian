#!/usr/bin/env node
/**
 * 阅读器冒烟验证（real-browser smoke test）
 *
 * 为什么需要它：`npm run check` 只能查出「调用了但没导入」这类静态问题，
 * 抓不到运行时才暴露的缺陷（回调里抛错导致流程半途终止、状态没刷到 DOM 等）。
 * 这里用真实 Chrome 跑真实模块图，把「打开文档 → 翻页 → 缩放 → 快捷键」走一遍，
 * 任何未捕获异常或状态没落地都算失败。
 *
 * 不依赖 Tauri：注入 `__TAURI__` 桩，命令返回值一律做深拷贝，模拟 IPC 的
 * 结构化克隆边界（否则前端拿到共享引用，会掩盖真实的时序问题）。
 * PDF 由脚本现场生成，不需要任何二进制 fixture。
 *
 * 用法：npm run smoke        指定浏览器：CHROME_PATH=/path/to/chrome npm run smoke
 * 退出码：0 全通过 / 1 有断言失败 / 2 环境不可用（无 Chrome 或 Node < 21）
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, dirname, resolve } from "node:path";
import { tmpdir, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { buildEpub } from "./lib/make-epub.mjs";
import { buildFb2, buildCbz, buildMobi } from "./lib/make-books.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
const WORK = join(tmpdir(), "yuejian-smoke");

/* ---------------- 环境 ---------------- */

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = {
    win32: [
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
      "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    ],
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ],
    linux: ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"],
  }[platform()] || [];
  return candidates.find((path) => path && existsSync(path));
}

if (typeof WebSocket === "undefined") {
  console.log("Node 版本过低（需要 21+ 才有内置 WebSocket），跳过冒烟验证");
  process.exit(2);
}

const CHROME = findChrome();
if (!CHROME) {
  console.log("未找到 Chrome/Edge，跳过冒烟验证（可用 CHROME_PATH 指定）");
  process.exit(2);
}

/* ---------------- 现场生成 PDF ---------------- */

/** 手工拼一个 3 页的最小合法 PDF：避免往仓库里塞二进制 fixture */
function buildPdf(labels) {
  const objects = [];
  const kids = labels.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  const fontRef = `${3 + labels.length * 2} 0 R`;
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${labels.length} >>`);
  labels.forEach((label, i) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontRef} >> >> /Contents ${4 + i * 2} 0 R >>`);
    const body = `BT /F1 36 Tf 72 700 Td (${label}) Tj ET`;
    objects.push(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
  });
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const startxref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".woff2": "font/woff2", ".wasm": "application/wasm",
  ".pdf": "application/pdf", ".md": "text/markdown; charset=utf-8",
  ".epub": "application/epub+zip",
};

/* ---------------- 桥接桩 ---------------- */

const MD_HTML = '<h1 id="h1">第一章</h1>' + "<p>正文段落。</p>".repeat(120)
  + '<h2 id="h2">第二节</h2>' + "<p>更多正文。</p>".repeat(120);

/** 日志样本：行数固定，断言才好比对；含一条超长行（横向滚动）与一处空行 */
const TEXT_LOG = [
  "2026-11-17 09:41:02.318 INFO  [shelf] store loaded books=126 categories=6 elapsed=12ms",
  "2026-11-17 09:41:02.402 INFO  [store] state.json 校验通过，未发现损坏字段",
  "2026-11-17 09:41:02.551 INFO  [win] window restored size=1440x900 scale=1.25 theme=paper",
  "2026-11-17 09:41:03.115 INFO  [shelf] cover tint resolved clay/indigo/olive for 126 books",
  "",
  "2026-11-17 09:41:04.887 WARN  [pdf] page cache miss doc=营造法式 页数=842 耗时=186ms",
  "2026-11-17 09:41:05.418 INFO  [pdf] render page=268 viewport=1440x742 dpr=1.25 ms=144",
  "2026-11-17 09:41:31.664 ERROR [download] curl exit=35 msg=SSL connect error url=https://github.com/biashz/yuejian/releases/download/v0.1.25/YueJian.Reader_0.1.25_x64-setup.exe proxy=127.0.0.1:7890 retry=1/3 elapsed=28441ms",
  "2026-11-17 09:41:52.480 INFO  [download] done size=4542464 duration=22.8s",
  "2026-11-17 09:42:10.884 INFO  [reader] open doc=项脊轩志.txt kind=text encoding=UTF-8 lines=24",
  "2026-11-17 09:42:10.903 INFO  [text] decode ok bom=false detector=none confidence=1.00",
  "2026-11-17 09:43:02.336 INFO  [idle] flush progress queue=0 pending=3",
].join("\n");

/** 代码样本：8 行，含关键字 / 注释 / 字符串，用来验证高亮确实生效 */
const RUST_CODE = [
  "use std::fs;",
  "use std::path::Path;",
  "",
  "/// 读取状态文件",
  "pub fn load(path: &Path) -> Result<String, std::io::Error> {",
  "    let raw = fs::read_to_string(path)?;",
  "    Ok(raw)",
  "}",
].join("\n");

/** 超过 HIGHLIGHT_MAX_CHARS（200KB）的代码：应当放弃高亮，只给等宽纯文本 */
const BIG_CODE = RUST_CODE.repeat(Math.ceil((220 * 1024) / RUST_CODE.length));

/**
 * 大文件样本的行数：20 万行，按 20px 行高就是 400 万像素的画布。
 * 正文不预置——由窗口命令按行号现生成，否则冒烟脚本自己就要先造 20MB 字符串。
 */
const HUGE_LINES = 200000;

/**
 * CSV 样本：5 列。
 * 第 2 行第 5 列含半角逗号且在引号内——被拆成两列就是解析错了。
 * 最后一行只有 4 列——渲染时要补到 5 列，不能错位。
 * 中间塞满 120 行，是为了让表格真的能纵向滚动：只有几行时「表头粘住」根本测不出来。
 */
const CSV_ROWS = [
  "日期,书名,作者,进度,备注",
  '2026-11-16,项脊轩志,归有光,100%,"短，但读完很久"',
  '2026-11-17,营造法式,李诫,32%,"图版多,页边窄"',
];
for (let i = 0; i < 120; i += 1) {
  CSV_ROWS.push(`2026-10-${String((i % 28) + 1).padStart(2, "0")},书目 ${i},作者 ${i},${i % 100}%,备注 ${i}`);
}
CSV_ROWS.push("2026-11-18,长物志,文震亨,8%");
const CSV_SAMPLE = CSV_ROWS.join("\n");

/** TSV 样本：制表符分隔，用来验证分隔符是从内容判出来的而不是按扩展名 */
const TSV_SAMPLE = ["id\t名称\t状态", "1\t书架\t完成", "2\t阅读\t进行中"].join("\n");

function stubSource() {
  return `(() => {
  // 收集所有未捕获异常：模块里漏 import 的调用会在这里冒出来
  window.__errors = [];
  window.__calls = [];
  // open_book 的 encoding 参数单独记：要区分「没传（沿用书架）」与「传了空串（改回自动）」
  window.__encCalls = [];
  addEventListener("error", (e) => window.__errors.push("error: " + (e.message || e.error)));
  addEventListener("unhandledrejection", (e) => window.__errors.push("rejection: " + (e.reason?.message || e.reason)));

  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const now = Date.now();
  const HUGE_LINES = ${HUGE_LINES};
  const hugeLine = (n) =>
    "2026-11-17 12:00:00.000 INFO worker-3 tick " + n + " lorem ipsum dolor sit amet consectetur adipiscing elit sed do";
  const BOOKS = [
    { id: "b-md", path: "C:/fixtures/demo.md", title: "示例 Markdown", author: "本地", kind: "markdown",
      size: 12800, pages: 0, words: 3200, addedAt: now - 9000, lastOpenedAt: now - 5000, favorite: false,
      categoryId: "", encoding: "", progress: { ratio: 0.35, page: 1, zoom: 1 } },
    { id: "b-pdf", path: "/fixtures/sample.pdf", title: "示例 PDF", author: "本地", kind: "pdf",
      size: 4000, pages: 3, words: 0, addedAt: now - 8000, lastOpenedAt: now - 4000, favorite: true,
      categoryId: "", encoding: "", progress: { ratio: 0, page: 2, zoom: 1 } },
    { id: "b-txt", path: "C:/fixtures/run.log", title: "运行日志", author: "本地", kind: "text",
      size: 9200, pages: 0, words: 680, addedAt: now - 7000, lastOpenedAt: now - 3000, favorite: false,
      categoryId: "", encoding: "", progress: { ratio: 0, page: 1, zoom: 1 } },
    { id: "b-code", path: "C:/fixtures/text.rs", title: "text.rs", author: "本地", kind: "text",
      size: 240, pages: 0, words: 40, addedAt: now - 6000, lastOpenedAt: now - 2000, favorite: false,
      categoryId: "", encoding: "", progress: { ratio: 0, page: 1, zoom: 1 } },
    { id: "b-big", path: "C:/fixtures/big.rs", title: "big.rs", author: "本地", kind: "text",
      size: 235000, pages: 0, words: 0, addedAt: now - 5000, lastOpenedAt: now - 1000, favorite: false,
      categoryId: "", encoding: "", progress: { ratio: 0, page: 1, zoom: 1 } },
    { id: "b-csv", path: "C:/fixtures/reading-log.csv", title: "reading-log.csv", author: "本地", kind: "text",
      size: 180, pages: 0, words: 0, addedAt: now - 4000, lastOpenedAt: now - 900, favorite: false,
      categoryId: "", encoding: "", progress: { ratio: 0, page: 1, zoom: 1 } },
    { id: "b-tsv", path: "C:/fixtures/reading-log.tsv", title: "reading-log.tsv", author: "本地", kind: "text",
      size: 90, pages: 0, words: 0, addedAt: now - 3000, lastOpenedAt: now - 800, favorite: false,
      categoryId: "", encoding: "", progress: { ratio: 0, page: 1, zoom: 1 } },
    // 电子书：路径指向测试服务器上的 /fixtures/sample.epub（现场生成，不进仓库）
    { id: "b-epub", path: "/fixtures/sample.epub", title: "冒烟样本", author: "本地", kind: "ebook",
      size: 4096, pages: 0, words: 0, addedAt: now - 2800, lastOpenedAt: now - 750, favorite: false,
      categoryId: "", encoding: "", bookmarks: [], progress: { ratio: 0, page: 0, zoom: 1, cfi: "" } },
    // 其余电子书格式：FB2（单文件 XML）、CBZ（图片漫画）、带 DRM 的 EPUB
    { id: "b-fb2", path: "/fixtures/sample.fb2", title: "sample.fb2", author: "本地", kind: "ebook",
      size: 5200, pages: 0, words: 0, addedAt: now - 2750, lastOpenedAt: now - 740, favorite: false,
      categoryId: "", encoding: "", bookmarks: [], progress: { ratio: 0, page: 0, zoom: 1, cfi: "" } },
    { id: "b-mobi", path: "/fixtures/sample.mobi", title: "sample.mobi", author: "本地", kind: "ebook",
      size: 9500, pages: 0, words: 0, addedAt: now - 2745, lastOpenedAt: now - 735, favorite: false,
      categoryId: "", encoding: "", bookmarks: [], progress: { ratio: 0, page: 0, zoom: 1, cfi: "" } },
    { id: "b-cbz", path: "/fixtures/sample.cbz", title: "sample.cbz", author: "本地", kind: "ebook",
      size: 900, pages: 0, words: 0, addedAt: now - 2740, lastOpenedAt: now - 730, favorite: false,
      categoryId: "", encoding: "", bookmarks: [], progress: { ratio: 0, page: 0, zoom: 1, cfi: "" } },
    // 坏文件与大文件：验证两种「打不开」的错误态
    { id: "b-broken", path: "/fixtures/broken.epub", title: "broken.epub", author: "本地", kind: "ebook",
      size: 2048, pages: 0, words: 0, addedAt: now - 2720, lastOpenedAt: now - 715, favorite: false,
      categoryId: "", encoding: "", bookmarks: [], progress: { ratio: 0, page: 0, zoom: 1, cfi: "" } },
    { id: "b-notzip", path: "/fixtures/notzip.epub", title: "notzip.epub", author: "本地", kind: "ebook",
      size: 900, pages: 0, words: 0, addedAt: now - 2715, lastOpenedAt: now - 712, favorite: false,
      categoryId: "", encoding: "", bookmarks: [], progress: { ratio: 0, page: 0, zoom: 1, cfi: "" } },
    { id: "b-bigebook", path: "/fixtures/big.epub", title: "big.epub", author: "本地", kind: "ebook",
      size: 629145600, pages: 0, words: 0, addedAt: now - 2710, lastOpenedAt: now - 710, favorite: false,
      categoryId: "", encoding: "", bookmarks: [], progress: { ratio: 0, page: 0, zoom: 1, cfi: "" } },
    { id: "b-drm", path: "/fixtures/drm.epub", title: "加密样本", author: "本地", kind: "ebook",
      size: 3600, pages: 0, words: 0, addedAt: now - 2730, lastOpenedAt: now - 720, favorite: false,
      categoryId: "", encoding: "", bookmarks: [], progress: { ratio: 0, page: 0, zoom: 1, cfi: "" } },
    // 大文件：正文由 read_text_window 按窗口现生成，不预置全文——
    // 20 万行 × 约 100 字节 ≈ 20MB，正好越过 8MB 的整篇上限
    { id: "b-huge", path: "C:/fixtures/huge.log", title: "huge.log", author: "本地", kind: "text",
      size: 20500000, pages: 0, words: 0, addedAt: now - 2500, lastOpenedAt: now - 700, favorite: false,
      categoryId: "", encoding: "", progress: { ratio: 0, page: 1, zoom: 1 } },
  ];
  const CATEGORIES = [{ id: "c-1", name: "论文", color: "clay", createdAt: 1 }];

  // 与 Rust 侧 Settings::default 一致：新装的机器读出来就是这一份，
  // 版式面板因此第一眼落在「舒适中文」预设上
  const SETTINGS = { theme: "paper", fontSize: 17, lineHeight: 1.9, measure: 720, showCtx: true,
    zen: false, split: false, linkSync: true, language: "zh", autoCheckUpdate: false, ebookSpread: true,
    ebookFontSize: 19, ebookLineHeight: 1.85, ebookMargin: 56,
    ebookFamily: "serif", ebookAlign: "justify", ebookOverride: false,
    ebookLetterSpacing: 0.25, ebookIndent: 2, ebookParaSpacing: 0,
    ebookMeasure: 660, ebookGap: 8, ebookHyphenate: false, ebookPunctuate: true,
    ebookOverrideColor: null };
  const HTML = ${JSON.stringify(MD_HTML)};

  window.__TAURI__ = {
    core: {
      invoke(command, args) {
        window.__calls.push(command);
        if (command === "get_settings") return Promise.resolve(clone(SETTINGS));
        // 偏好落盘：记下最后一次提交的整份设置，用来验证「改了会存」
        if (command === "save_settings") {
          window.__saved = args.settings;
          return Promise.resolve(null);
        }
        if (command === "get_library") return Promise.resolve(clone(BOOKS));
        if (command === "get_categories") return Promise.resolve(clone(CATEGORIES));
        // 拖拽 / 批量归类：记下最后一次的参数，并把书挪到目标分类
        if (command === "assign_category") {
          window.__assigned = { ids: args.ids, categoryId: args.categoryId };
          const moved = new Set(args.ids);
          return Promise.resolve(clone(BOOKS.map((book) =>
            (moved.has(book.id) ? { ...book, categoryId: args.categoryId } : book))));
        }
        if (command === "app_version") return Promise.resolve("0.0.0-smoke");
        // 摘录导出：不弹真对话框，把默认文件名与正文留下来给断言看
        if (command === "save_text_file") {
          window.__exported = { name: args.defaultName, content: args.content };
          return Promise.resolve("/tmp/" + args.defaultName);
        }
        if (command === "open_book") {
          window.__encCalls.push(args.encoding === undefined ? null : args.encoding);
          if (args.id === "b-pdf") return Promise.resolve(clone({ kind: "pdf", path: "/fixtures/sample.pdf", pages: 3, size: 4000 }));
          if (args.id === "b-epub") return Promise.resolve(clone({
            kind: "ebook", path: "/fixtures/sample.epub", size: 4096,
          }));
          const fixtures = { "b-fb2": "sample.fb2", "b-cbz": "sample.cbz", "b-mobi": "sample.mobi", "b-drm": "drm.epub" };
          if (fixtures[args.id]) return Promise.resolve(clone({
            kind: "ebook", path: "/fixtures/" + fixtures[args.id], size: 5000,
          }));
          // 坏文件：内容根本不是 zip；大文件：只报体积，前端在读取前就该拦下
          if (args.id === "b-broken") return Promise.resolve(clone({
            kind: "ebook", path: "/fixtures/broken.epub", size: 2048,
          }));
          if (args.id === "b-notzip") return Promise.resolve(clone({
            kind: "ebook", path: "/fixtures/notzip.epub", size: 900,
          }));
          if (args.id === "b-bigebook") return Promise.resolve(clone({
            kind: "ebook", path: "/fixtures/big.epub", size: 629145600,
          }));
          if (args.id === "b-txt") return Promise.resolve(clone({
            kind: "text", text: ${JSON.stringify(TEXT_LOG)},
            // 手动指定编码时回填对应名字，用来验证「选什么就按什么解」
            encoding: !args.encoding ? "UTF-8" : args.encoding === "gb18030" ? "GB18030" : args.encoding,
            lines: ${TEXT_LOG.split("\n").length}, chars: ${TEXT_LOG.replace(/\s/g, "").length},
            eol: "LF", lang: "", mode: "code", truncated: false,
          }));
          if (args.id === "b-code") return Promise.resolve(clone({
            kind: "text", text: ${JSON.stringify(RUST_CODE)}, encoding: "UTF-8",
            lines: ${RUST_CODE.split("\n").length}, chars: ${RUST_CODE.replace(/\s/g, "").length},
            eol: "LF", lang: "rust", mode: "code", truncated: false,
          }));
          if (args.id === "b-big") return Promise.resolve(clone({
            kind: "text", text: ${JSON.stringify(BIG_CODE)}, encoding: "UTF-8",
            lines: ${BIG_CODE.split("\n").length}, chars: ${BIG_CODE.replace(/\s/g, "").length},
            eol: "LF", lang: "rust", mode: "code", truncated: false,
          }));
          if (args.id === "b-csv") return Promise.resolve(clone({
            kind: "text", text: ${JSON.stringify(CSV_SAMPLE)}, encoding: "UTF-8",
            lines: ${CSV_SAMPLE.split("\n").length}, chars: ${CSV_SAMPLE.replace(/\s/g, "").length},
            eol: "LF", lang: "", mode: "table", truncated: false,
          }));
          if (args.id === "b-tsv") return Promise.resolve(clone({
            kind: "text", text: ${JSON.stringify(TSV_SAMPLE)}, encoding: "UTF-8",
            lines: ${TSV_SAMPLE.split("\n").length}, chars: ${TSV_SAMPLE.replace(/\s/g, "").length},
            eol: "LF", lang: "", mode: "table", truncated: false,
          }));
          if (args.id === "b-huge") return Promise.resolve(clone({
            // 大文件：不带正文，只给元信息，正文由 read_text_window 按窗口取
            kind: "text", text: "", encoding: "UTF-8", lines: HUGE_LINES, chars: 0,
            eol: "LF", lang: "", mode: "code", truncated: false, windowed: true, clipped: false,
          }));
          return Promise.resolve(clone({
            kind: "markdown", html: HTML, dir: "C:/fixtures", words: 3200,
            toc: [{ level: 1, text: "第一章", id: "h1" }, { level: 2, text: "第二节", id: "h2" }],
          }));
        }
        if (command === "read_text_window") {
          // 记录起点而不是只记命令名：断言要能看出「取了几次、从哪取」
          window.__calls.push("read_text_window:" + args.start);
          let out = "";
          const end = Math.min(args.start + args.count, HUGE_LINES);
          for (let n = args.start; n < end; n += 1) out += hugeLine(n + 1) + "\\n";
          // Tauri 的 ipc::Response 到前端就是 ArrayBuffer，这里照实返回
          return Promise.resolve(new TextEncoder().encode(out).buffer);
        }
        if (command === "set_bookmark") {
          // 桩要模仿真实语义：幂等、返回整本书（前端据此回填书签列表）
          const book = BOOKS.find((item) => item.id === args.id);
          if (!book) return Promise.reject("书架中找不到这本书");
          book.bookmarks = book.bookmarks || [];
          if (args.on) {
            if (!book.bookmarks.some((mark) => mark.cfi === args.cfi)) {
              book.bookmarks.push({ cfi: args.cfi, label: args.label, createdAt: Date.now() });
            }
          } else {
            book.bookmarks = book.bookmarks.filter((mark) => mark.cfi !== args.cfi);
          }
          return Promise.resolve(clone(book));
        }
        if (command === "set_highlight") {
          window.__calls.push("set_highlight:" + (args.on ? "on" : "off") + ":" + args.color);
          // 与 set_bookmark 同一套语义；差别是同一条再来一次是「改色」而不是「加一条」
          const book = BOOKS.find((item) => item.id === args.id);
          if (!book) return Promise.reject("书架中找不到这本书");
          book.highlights = book.highlights || [];
          const existing = book.highlights.find((mark) => mark.cfi === args.cfi);
          if (args.on) {
            if (existing) {
              existing.color = args.color;
              if (args.text) existing.text = args.text;
              if (args.label) existing.label = args.label;
            } else {
              book.highlights.push({ cfi: args.cfi, text: args.text, color: args.color,
                label: args.label, createdAt: Date.now() });
            }
          } else {
            book.highlights = book.highlights.filter((mark) => mark.cfi !== args.cfi);
          }
          return Promise.resolve(clone(book));
        }
        if (command === "search_text") {
          window.__calls.push("search_text");
          // zebra 只在超大日志里出现：其余文本文件返回空，用来验证跨书检索
          // 不会因为「每本书都命中同样几行」而分不清来源
          const isHuge = String(args.path || "").endsWith("huge.log");
          if (args.query !== "zebra" || !isHuge) {
            // 跨书检索：任何文本 / Markdown 都能搜到「共鸣」，两行命中用来验证
            // 「一本书列几条」与「片段带 <mark>」
            if (args.query === "共鸣") {
              return Promise.resolve(clone([
                { line: 12, text: "第一部分讲的是共鸣，用来验证跨书检索能落到片段上。" },
                { line: 88, text: "第二处共鸣：一本书最多列五条，多的不收。" },
              ]));
            }
            return Promise.resolve([]);
          }
          // 命中行必须真的含关键词，否则侧栏里的 <mark> 标记根本出不来
          return Promise.resolve(clone([
            { line: 1201, text: hugeLine(1201).replace("lorem", "zebra") },
            { line: 190000, text: hugeLine(190000).replace("lorem", "zebra") },
          ]));
        }
        // 检索索引：内存里存一份，够验证「读到了就复用、没读到就重建」
        if (command === "read_search_index") {
          window.__calls.push("read_search_index:" + args.id);
          return Promise.resolve(clone(window.__searchIndex?.[args.id] || null));
        }
        if (command === "write_search_index") {
          window.__calls.push("write_search_index:" + args.id);
          window.__searchIndex = window.__searchIndex || {};
          window.__searchIndex[args.id] = args.index;
          return Promise.resolve(null);
        }
        return Promise.resolve(null);
      },
    },
  };
})();`;
}

/* ---------------- CDP ---------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 1;
const pending = new Map();

function send(ws, method, params = {}) {
  const id = seq++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(ws, expression, contextId) {
  const reply = await send(ws, "Runtime.evaluate", {
    expression, awaitPromise: true, returnByValue: true,
    ...(contextId ? { contextId } : {}),
  });
  if (reply.exceptionDetails) throw new Error(`求值失败：${reply.exceptionDetails.text}`);
  return reply.result?.value;
}

/** 用真实鼠标事件走一遍拖拽：按下 → 分几步移动 → 松开（Chromium 会据此合成 pointer 事件） */
async function dragPointer(ws, from, to, onMidway) {
  const point = (type, x, y, extra) => send(ws, "Input.dispatchMouseEvent",
    { type, x, y, ...extra });
  await point("mouseMoved", from.x, from.y, { button: "none", buttons: 0 });
  await point("mousePressed", from.x, from.y, { button: "left", buttons: 1, clickCount: 1 });
  await sleep(30);
  for (let i = 1; i <= 6; i += 1) {
    const x = Math.round(from.x + ((to.x - from.x) * i) / 6);
    const y = Math.round(from.y + ((to.y - from.y) * i) / 6);
    await point("mouseMoved", x, y, { button: "left", buttons: 1 });
    await sleep(25);
  }
  if (onMidway) await onMidway();
  await point("mouseReleased", to.x, to.y, { button: "left", buttons: 0, clickCount: 1 });
  await sleep(140);
}

/**
 * 电子书的章节渲染在 blob: iframe 里，而 `foliate-view` 的 shadow root 是 closed 的
 * ——从页面里既拿不到 renderer，也进不去 iframe。这里从 CDP 的 frame 树上找到那个
 * iframe，给它开一个隔离世界再读 DOM：只用于验证「正文真的渲染出来了」。
 */
async function blobFrameContext(ws) {
  const tree = await send(ws, "Page.getFrameTree");
  const frames = [];
  const walk = (node) => {
    frames.push(node.frame);
    for (const child of node.childFrames || []) walk(child);
  };
  walk(tree.frameTree);
  // Page.Frame 的字段叫 id（不是 frameId），createIsolatedWorld 才用 frameId
  const frame = frames.find((item) => (item.url || "").startsWith("blob:"));
  if (!frame) return null;
  const world = await send(ws, "Page.createIsolatedWorld", {
    frameId: frame.id,
    worldName: "smoke-ebook",
  });
  return world.executionContextId;
}

/**
 * 数当前挂着几个 blob 章节 iframe。换章会新建一个，旧的必须被回收——
 * 不回收的话读一晚上，进程里就攒着整本书清洗过的 DOM。
 */
async function blobFrameCount(ws) {
  const tree = await send(ws, "Page.getFrameTree");
  let count = 0;
  const walk = (node) => {
    if ((node.frame?.url || "").startsWith("blob:")) count += 1;
    (node.childFrames || []).forEach(walk);
  };
  walk(tree.frameTree);
  return count;
}

async function waitFor(ws, expression, label, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evaluate(ws, expression)) return true;
    await sleep(80);
  }
  // 超时多半是某个模块在启动阶段就抛了异常、界面根本没建起来，
  // 把页面里的未捕获异常一起打出来，否则只能看到一句「等待超时」
  const state = await evaluate(ws, `JSON.stringify({
    errors: window.__errors || null,
    books: document.querySelectorAll("#bookList .book-row").length,
    list: (document.querySelector("#bookList")?.innerHTML || "").slice(0, 260),
    bodyLength: document.body.innerHTML.length,
    calls: window.__calls || null,
  })`).catch(() => "无法读取页面状态");
  const consoleTail = pageErrors.slice(-3).join(" || ");
  throw new Error(`等待超时：${label} | ${state}${consoleTail ? ` | console: ${consoleTail}` : ""}`);
}

const pageErrors = [];
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/**
 * 断言能证明「高亮生效了」，但证明不了「看起来是对的」——颜色、对齐、主题
 * 对比度都得看。给 SHOT_DIR 时把这些关键时刻截下来，默认不产生任何文件。
 */
const SHOT_DIR = process.env.SMOKE_SHOT || "";
async function shot(ws, name) {
  if (!SHOT_DIR) return;
  await mkdir(SHOT_DIR, { recursive: true });
  const reply = await send(ws, "Page.captureScreenshot", { format: "png" });
  // send() 解析出的是 CDP 的 result 本体（外层 {id,result} 已被剥掉），
  // 所以 base64 直接挂在 reply.data 上
  if (!reply?.data) return;
  await writeFile(join(SHOT_DIR, `${name}.png`), Buffer.from(reply.data, "base64"));
}

/* ---------------- 主流程 ---------------- */

async function main() {
  await mkdir(WORK, { recursive: true });
  await writeFile(join(WORK, "sample.pdf"), buildPdf(["第一页", "第二页", "第三页"]));
  // script: true —— 第一章带一段 <script>，用来证明清洗生效（见 make-epub.mjs）
  await writeFile(join(WORK, "sample.epub"), buildEpub({ script: true }));
  await writeFile(join(WORK, "sample.fb2"), buildFb2());
  await writeFile(join(WORK, "sample.cbz"), buildCbz());
  // script: true —— MOBI 没有 EPUB 的资源钩子，正文里的脚本要靠 hardenBook 在读回后洗掉
  await writeFile(join(WORK, "sample.mobi"), buildMobi({ script: true }));
  // 正文加密的 EPUB：打开时应被拦下并说明是哪一种 DRM，而不是报「文件损坏」
  await writeFile(join(WORK, "drm.epub"), buildEpub({ title: "加密样本", encryption: "drm" }));
  // 真 EPUB 截掉后半段：zip 头还在、中央目录没了，属于「文件不完整」
  await writeFile(join(WORK, "broken.epub"), buildEpub({ title: "截断样本" }).subarray(0, 1200));
  // 另一种「打不开」：内容是纯文本，只是后缀改成了 .epub —— 连 zip 都不是
  await writeFile(join(WORK, "notzip.epub"), Buffer.from("这不是一个 zip，只是把后缀改成了 .epub"));
  // 大文件只需要存在：前端在 fetch 之前就按 size 拦下，不会真读
  await writeFile(join(WORK, "big.epub"), Buffer.from("placeholder"));
  await writeFile(join(WORK, "demo.md"), "# 第一章\n\n正文\n");

  // 端口交给系统分配：并行跑多个实例不会撞车
  // 把 tauri.conf.json 里的 CSP 原样作为响应头发给页面：
  // 真机上由 Tauri 注入这条策略，冒烟里若只在 HTTP 下跑，CSP 写错了永远测不出来
  const csp = await readFile(join(ROOT, "..", "src-tauri", "tauri.conf.json"), "utf8")
    .then((text) => JSON.parse(text)?.app?.security?.csp)
    .catch(() => null);

  const server = createServer(async (req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    const file = url.startsWith("/fixtures/")
      ? join(WORK, url.slice("/fixtures/".length))
      : join(ROOT, url === "/" ? "index.html" : url.slice(1));
    try {
      const body = await readFile(file);
      const headers = { "Content-Type": MIME[extname(file)] || "application/octet-stream" };
      if (csp && extname(file) === ".html") headers["Content-Security-Policy"] = csp;
      res.writeHead(200, headers);
      res.end(body);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const profile = join(WORK, `profile-${process.pid}-${Date.now()}`);
  const chrome = spawn(CHROME, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    "--window-size=1440,900", "--mute-audio", "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });

  const cleanup = () => {
    try { chrome.kill(); } catch { /* 进程可能已退出 */ }
    server.close();
  };

  try {
    // --remote-debugging-port=0 时端口写在 profile 目录的 DevToolsActivePort 首行
    let port = 0;
    for (let i = 0; i < 200 && !port; i += 1) {
      await sleep(100);
      try {
        port = Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]);
      } catch { /* 还没生成 */ }
    }
    if (!port) throw new Error("Chrome 未能启动调试端口");

    let target = null;
    for (let i = 0; i < 100 && !target; i += 1) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((item) => item.type === "page");
      } catch { /* 还没就绪 */ }
      if (!target) await sleep(100);
    }
    if (!target) throw new Error("找不到可用的页面目标");

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    const exceptions = [];
    ws.onmessage = (msg) => {
      const data = JSON.parse(msg.data);
      if (data.id && pending.has(data.id)) {
        const waiter = pending.get(data.id);
        pending.delete(data.id);
        if (data.error) waiter.reject(new Error(data.error.message));
        else waiter.resolve(data.result);
      } else if (data.method === "Runtime.exceptionThrown") {
        exceptions.push(data.params.exceptionDetails.exception?.description || data.params.exceptionDetails.text);
      } else if (data.method === "Runtime.consoleAPICalled" && data.params.type === "error") {
        // 模块加载失败、被 catch 住的异常都会走 console.error，超时时一并打出来
        pageErrors.push(data.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
      }
    };

    await send(ws, "Page.enable");
    await send(ws, "Runtime.enable");
    await send(ws, "Page.addScriptToEvaluateOnNewDocument", { source: stubSource() });
    await send(ws, "Page.navigate", { url: `${origin}/` });
    await waitFor(ws, "document.querySelectorAll('#bookList .book-row').length >= 8", "书架渲染");
    check("启动完成，书架渲染 8 本书", true);

    // 筛完一份不剩时，提示要落在「全部文档」空出来的那一片中间、且略偏上：
    // 铺满整行 + 垂直居中 + 底部多留白。挑一个当前确实没有文档的类型来筛
    const emptyLayout = await evaluate(ws, `(async () => {
      // 直接改 state 再重绘：这里只验空态摆法，不依赖筛选按钮的监听是否已绑上
      const { state } = await import("/js/core/session.js");
      const { renderLibrary } = await import("/js/shelf.js");
      const emptyKind = ["pdf", "markdown", "text", "ebook"]
        .find((kind) => !state.books.some((book) => book.kind === kind));
      if (emptyKind) state.filter = emptyKind;
      else state.query = "zzz-没有这本书";
      renderLibrary();
      const grid = document.querySelector("#bookGrid");
      const hint = grid.querySelector(".ctx-empty");
      const head = document.querySelector("#gridHead");
      const view = document.querySelector("#view-library");
      if (!hint) return { found: false, trigger: emptyKind || "query",
        books: state.books.length, cards: document.querySelectorAll("#bookGrid .book-card").length };
      const g = grid.getBoundingClientRect(), h = hint.getBoundingClientRect();
      const hr = head.getBoundingClientRect(), v = view.getBoundingClientRect();
      return { found: true, trigger: emptyKind || "query",
        cards: document.querySelectorAll("#bookGrid .book-card").length,
        dx: Math.round(h.left + h.width / 2 - (g.left + g.width / 2)),
        spans: h.width >= g.width - 4,
        // 提示中心在「抬头底 → 视图底」这段里的相对位置：0 贴顶、1 贴底、0.5 正中
        ratio: +(((h.top + h.height / 2) - hr.bottom) / (v.bottom - hr.bottom)).toFixed(2) };
    })()`);
    check("筛空时提示在「全部文档」里居中偏上",
      emptyLayout.found && emptyLayout.cards === 0 && emptyLayout.spans
        && Math.abs(emptyLayout.dx) <= 2 && emptyLayout.ratio > 0.25 && emptyLayout.ratio < 0.5,
      `触发 ${emptyLayout.trigger} · 卡片 ${emptyLayout.cards}，水平差 ${emptyLayout.dx}px，` +
      `铺满整行 ${emptyLayout.spans}，垂直落点 ${emptyLayout.ratio}（0.25–0.5 为偏上）`);
    await evaluate(ws, `(async () => {
      const { state } = await import("/js/core/session.js");
      const { renderLibrary } = await import("/js/shelf.js");
      state.filter = "all";
      state.query = "";
      renderLibrary();
    })()`);
    await sleep(180);

    /* --- 跨书检索：正文命中单独成区，不与书名筛选混排 --- */
    // 先收到 MARKDOWN 类型：范围里只剩 b-md，检索路径确定（走 search_text，不碰索引）
    await evaluate(ws, `document.querySelector('#filterRow [data-filter="markdown"]').click()`);
    await sleep(200);
    await evaluate(ws, `(() => {
      const input = document.querySelector("#libSearch");
      input.value = "共鸣";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    // 320ms 防抖 + 一轮异步检索，留足余量
    await sleep(1100);

    const libHitsSeen = await evaluate(ws, `(() => {
      const box = document.querySelector("#libHits");
      return {
        visible: Boolean(box && !box.hidden),
        state: box?.dataset.state || "",
        groups: box?.querySelectorAll(".hits-group").length || 0,
        rows: box?.querySelectorAll(".hits-row").length || 0,
        mark: box?.querySelector(".hits-text mark")?.textContent || "",
        bookTitle: box?.querySelector(".hits-book-title")?.textContent || "",
        where: (box?.querySelector(".hits-where")?.textContent || "").trim(),
        head: (box?.querySelector(".hits-head")?.textContent || "").replace(/\\s+/g, " ").trim(),
        searched: window.__calls.filter((c) => c === "search_text").length,
        indexed: window.__calls.filter((c) => c.startsWith("read_search_index")).length,
        // 命中区必须在书网格之后，而不是塞进书列表里
        afterGrid: Boolean(box && box.previousElementSibling?.id === "bookGrid"),
        // 书名一个都没匹配上时，书网格的空态不能再说「没有匹配的文档」
        gridHint: (document.querySelector("#bookGrid .ctx-empty")?.textContent || "").replace(/\\s+/g, " ").trim(),
      };
    })()`);
    check("正文命中单独成区：书名 + 行号 + 带 <mark> 的片段",
      libHitsSeen.visible && libHitsSeen.state === "done" && libHitsSeen.groups === 1 && libHitsSeen.rows === 2
        && libHitsSeen.mark === "共鸣" && libHitsSeen.bookTitle === "示例 Markdown"
        && /12/.test(libHitsSeen.where) && libHitsSeen.head.includes("全文命中") && libHitsSeen.afterGrid,
      `${libHitsSeen.groups} 组 / ${libHitsSeen.rows} 行 · ${libHitsSeen.bookTitle} · ${libHitsSeen.where} · 抬头「${libHitsSeen.head}」`);
    check("书名没匹配、正文有命中时，空态指向下方命中区",
      libHitsSeen.gridHint.includes("书名里没有匹配") && libHitsSeen.gridHint.includes("正文命中见下方"),
      `空态「${libHitsSeen.gridHint}」`);
    check("文本类走 search_text，不读也不写检索索引",
      libHitsSeen.searched >= 1 && libHitsSeen.indexed === 0,
      `search_text ${libHitsSeen.searched} 次 · 读索引 ${libHitsSeen.indexed} 次`);

    // 点一条命中：打开这本书，并把关键词填进侧栏搜索框
    await evaluate(ws, `document.querySelector("#libHits .hits-row").click()`);
    await sleep(900);
    const libSearchJump = await evaluate(ws, `(async () => {
      const { state } = await import("/js/core/session.js");
      const { activePane } = await import("/js/reader/panes.js");
      return {
        view: state.view,
        current: state.currentId || "",
        query: activePane()?.query || "",
        inputValue: document.querySelector("#findInput")?.value || "",
        ctxOpen: !document.querySelector("#ctxPanel")?.classList.contains("is-hidden"),
      };
    })()`);
    check("点命中打开这本书，并把关键词填进侧栏搜索",
      libSearchJump.view === "reading" && libSearchJump.current === "b-md" && libSearchJump.query === "共鸣"
        && libSearchJump.inputValue === "共鸣" && libSearchJump.ctxOpen,
      `${libSearchJump.view} · ${libSearchJump.current} · 侧栏「${libSearchJump.inputValue}」`);

    // 清空关键词：命中区要整段收起，不留一个「没有命中」的空壳
    await evaluate(ws, `(async () => {
      const { setView } = await import("/js/view.js");
      setView("library");
      const input = document.querySelector("#libSearch");
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await sleep(420);
    const libHitsCleared = await evaluate(ws, `(() => {
      const box = document.querySelector("#libHits");
      return { hidden: box ? box.hidden : true, html: box ? box.innerHTML.length : 0 };
    })()`);
    check("清空关键词后命中区收起", libHitsCleared.hidden && libHitsCleared.html === 0,
      `隐藏 ${libHitsCleared.hidden} · 残留 ${libHitsCleared.html} 字符`);

    // 索引与片段的纯函数：这几处最容易在重构里悄悄错，单独钉住
    const indexPure = await evaluate(ws, `(async () => {
      const { joinItems, isFresh } = await import("/js/library-index.js");
      const { snippet, searchIndexed } = await import("/js/library-search.js");
      const source = "甲".repeat(60) + "关键词" + "乙".repeat(60);
      // 一个 PDF 单元（带页码）与一个电子书单元（带章节 href）：位置三件套要原样带出去
      const units = { units: [
        { label: "", page: 7, href: "", text: "第七页写了关键词" },
        { label: "第二章", page: 0, href: "OEBPS/ch2.xhtml", text: "这一节也有关键词" },
        { label: "", page: 9, href: "", text: "没有命中的一页" },
      ] };
      const found = searchIndexed(units, "关键词", { cancelled: false });
      return {
        joined: joinItems([
          { str: "Hello" }, { str: "world" }, { str: "你好" },
          { str: "世界", hasEOL: true }, { str: "next" },
        ]),
        cut: snippet(source, "关键词"),
        fresh: isFresh({ v: 1, size: 10, mtime: 5 }, { size: 10, mtime: 5 }),
        stale: isFresh({ v: 1, size: 10, mtime: 5 }, { size: 10, mtime: 6 }),
        // mtime 取不到（旧数据）时一律当过期，否则永远不重建
        zeroMtime: isFresh({ v: 1, size: 10, mtime: 0 }, { size: 10, mtime: 0 }),
        located: found.map((hit) => ({ page: hit.page, line: hit.line, href: hit.href })),
      };
    })()`);
    check("PDF 文本拼接补空格、片段带省略号、索引按体积与 mtime 判过期",
      indexPure.joined === "Hello world你好世界\nnext"
        && indexPure.cut.hit === "关键词"
        && indexPure.cut.pre.startsWith("…") && indexPure.cut.post.endsWith("…")
        && indexPure.fresh === true && indexPure.stale === false && indexPure.zeroMtime === false,
      `拼接「${indexPure.joined.replace("\n", "⏎")}」· fresh ${indexPure.fresh}/${indexPure.stale}/${indexPure.zeroMtime}`);
    check("命中带上定位三件套：PDF 页码、电子书章节 href、文本行号（此处为 0）",
      indexPure.located.length === 2
        && indexPure.located[0].page === 7 && indexPure.located[0].href === "" && indexPure.located[0].line === 0
        && indexPure.located[1].page === 0 && indexPure.located[1].href === "OEBPS/ch2.xhtml",
      indexPure.located.map((hit) => `${hit.page || "-"}/${hit.href || "-"}`).join(" , "));

    // 复原筛选，后面的用例还要看到全部书
    await evaluate(ws, `(async () => {
      const { state } = await import("/js/core/session.js");
      const { renderLibrary } = await import("/js/shelf.js");
      state.filter = "all";
      state.query = "";
      document.querySelector("#libSearch").value = "";
      document.querySelectorAll("#filterRow .chip")
        .forEach((chip) => chip.classList.toggle("is-on", chip.dataset.filter === "all"));
      renderLibrary();
    })()`);
    await sleep(200);

    /* --- 拖拽归类：HTML5 拖放在真机上时灵时不灵，改走指针事件（bind/book-drag.js） --- */
    const dragPoints = await evaluate(ws, `(() => {
      // 取第一条可见的行：按最近打开排序，别的行可能在滚动区外面
      const row = document.querySelector("#bookList .book-row");
      const cat = document.querySelector('.cat-row[data-cat="c-1"]');
      if (!row || !cat) return null;
      const a = row.getBoundingClientRect(), b = cat.getBoundingClientRect();
      return { book: row.dataset.book,
        from: { x: Math.round(a.left + a.width / 2), y: Math.round(a.top + a.height / 2) },
        to: { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) } };
    })()`);
    let midway = { ghost: "", drop: 0 };
    if (dragPoints) {
      await dragPointer(ws, dragPoints.from, dragPoints.to, async () => {
        midway = await evaluate(ws, `({
          ghost: document.querySelector(".book-ghost")?.textContent || "",
          drop: document.querySelectorAll(".cat-row.is-drop").length })`);
      });
    }
    const afterDrag = await evaluate(ws, `({ assigned: window.__assigned || null,
      ghostLeft: document.querySelectorAll(".book-ghost").length,
      dropLeft: document.querySelectorAll(".cat-row.is-drop").length,
      dragging: document.querySelectorAll(".is-dragging").length })`);
    check("把文档拖到分类行上就归类（指针事件版）",
      Boolean(dragPoints) && midway.ghost.length > 0 && midway.drop === 1
        && afterDrag.assigned?.ids?.length === 1
        && afterDrag.assigned.ids[0] === dragPoints?.book && afterDrag.assigned.categoryId === "c-1"
        && afterDrag.ghostLeft === 0 && afterDrag.dropLeft === 0 && afterDrag.dragging === 0,
      `拖「${midway.ghost}」，途中高亮 ${midway.drop} 行，归类 ${JSON.stringify(afterDrag.assigned)}；` +
      `收尾残留 ghost ${afterDrag.ghostLeft} / 高亮 ${afterDrag.dropLeft} / 拖动态 ${afterDrag.dragging}`);
    // 拖完那一次 click 会被吃掉，补一个空点击把标记用掉，免得影响后面的点击
    await evaluate(ws, `document.body.click()`);

    // CSP：既确认策略按 tauri.conf.json 下发，也确认它真的生效（内联脚本被拦）
    const sentCsp = await fetch(`${origin}/`).then((res) => res.headers.get("content-security-policy"));
    const inlineBlocked = await evaluate(ws, `(async () => {
      const frame = document.createElement("iframe");
      frame.srcdoc = "<" + "script>parent.__inlineRan = 1<" + "/script>";
      document.body.append(frame);
      await new Promise((r) => setTimeout(r, 300));
      const ran = window.__inlineRan === 1;
      frame.remove();
      return !ran;
    })()`);
    check("CSP 按 tauri.conf.json 下发", Boolean(csp) && sentCsp === csp, `${String(sentCsp || "").slice(0, 48)}…`);
    check("CSP 真的生效：内联脚本被拦下", inlineBlocked, inlineBlocked ? "未执行" : "内联脚本执行了");

    const pane = '[data-pane-root="0"]';
    // 引擎在「主动改视口」时必然会补一条 ResizeObserver 通知没送完的抱怨——那是浏览器
    // 自己的排版提示，不是应用抛的异常。只滤这一句，其余异常照旧一条都算失败
    const errors = () => evaluate(ws,
      `(window.__errors || []).filter((e) => !/ResizeObserver loop/.test(e))`);

    /* --- 打开 Markdown：覆盖 openMarkdown 末尾的进度恢复 --- */
    await evaluate(ws, `document.querySelector('#bookList .book-row[data-book="b-md"]').click()`);
    await waitFor(ws, `(document.querySelector('${pane} .md-doc')?.innerHTML.length || 0) > 100`, "Markdown 渲染");
    await sleep(600);
    const mdLength = await evaluate(ws, `document.querySelector('${pane} .md-doc').innerHTML.length`);
    const mdScroll = await evaluate(ws, `Math.round(document.querySelector('${pane} .scroll-area').scrollTop)`);
    let errs = await errors();
    check("Markdown 已渲染", mdLength > 100, `innerHTML ${mdLength} 字符`);
    check("打开 Markdown 无未捕获异常", errs.length === 0, errs.join(" | "));
    check("阅读进度已恢复（scrollPaneToRatio 生效）", mdScroll > 0, `scrollTop=${mdScroll}`);

    /* --- Ctrl+B：覆盖 keys.js 里的工具栏重绘 --- */
    const ctxOn = `document.querySelector('[data-act="ctx"]')?.classList.contains('is-on')`;
    const ctxBefore = await evaluate(ws, ctxOn);
    for (const type of ["keyDown", "keyUp"]) {
      await send(ws, "Input.dispatchKeyEvent", {
        type, modifiers: 2, key: "b", code: "KeyB",
        windowsVirtualKeyCode: 66, nativeVirtualKeyCode: 66,
      });
    }
    await sleep(400);
    const ctxAfter = await evaluate(ws, ctxOn);
    errs = await errors();
    check("Ctrl+B 无未捕获异常", errs.length === 0, errs.join(" | "));
    check("Ctrl+B 后工具栏已重绘", ctxBefore !== ctxAfter, `${ctxBefore} → ${ctxAfter}`);

    /* --- 打开 PDF：覆盖 onReady / 页码刷新 --- */
    await evaluate(ws, `document.querySelector('#bookList .book-row[data-book="b-pdf"]').click()`);
    await waitFor(ws, `(document.querySelectorAll('${pane} .pdf-stack .pdf-sheet').length || 0) >= 3`, "PDF 页渲染", 20000);
    await sleep(900);
    const pageStart = await evaluate(ws, "document.querySelector('#pageInput')?.value || ''");
    errs = await errors();
    check("PDF 三页已挂载到阅读栈", true);
    check("打开 PDF 无未捕获异常", errs.length === 0, errs.join(" | "));
    check("工具栏页码已渲染（updateToolbarPage 生效）", /^\d+$/.test(pageStart), `页码 "${pageStart}"`);

    /* --- 默认适配模式：适合宽度（菜单里对应的项打勾） --- */
    const fitInfo = await evaluate(ws, `(async () => {
      const mod = await import("/js/reader/panes.js");
      const reader = mod.activeReader();
      return {
        fitMode: reader?.fitMode || null,
        zoom: reader?.zoom || 0,
        menuChecked: document.querySelector('.zoom-menu [data-fit-width]')?.getAttribute("aria-checked"),
      };
    })()`);
    check("PDF 默认按适合宽度打开",
      fitInfo.fitMode === "width" && fitInfo.menuChecked === "true",
      `fitMode=${fitInfo.fitMode} 缩放=${Math.round(fitInfo.zoom * 100)}% 菜单打勾=${fitInfo.menuChecked}`);

    /* --- 翻页与缩放：覆盖 onPageChange / onZoom --- */
    await evaluate(ws, `document.querySelector('[data-act="next"]')?.click()`);
    // 适合宽度下页面更高、平滑滚动距离更长，等页码真正前进，别用固定 sleep 赌时间
    await waitFor(ws, `Number(document.querySelector('#pageInput')?.value || 0) > ${Number(pageStart)}`, "页码前进");
    const pageNext = await evaluate(ws, "document.querySelector('#pageInput')?.value || ''");
    await evaluate(ws, `document.querySelector('[data-act="zoom-in"]')?.click()`);
    await sleep(300);
    await evaluate(ws, `document.querySelector('[data-act="zoom-in"]')?.click()`);
    await sleep(800);
    const zoomLabel = await evaluate(ws, `document.querySelector('[data-act="zoom-menu"]')?.textContent?.trim() || ''`);
    errs = await errors();
    check("翻页成功", Number(pageNext) > Number(pageStart), `${pageStart} → ${pageNext}`);
    check("翻页与缩放无未捕获异常", errs.length === 0, errs.join(" | "));
    check("缩放比例已刷新", /%$/.test(zoomLabel), `比例 "${zoomLabel}"`);

    /* --- 文本类文档：等宽行号 / 视图切换 / 信息面板 --- */
    await evaluate(ws, `document.querySelector('#bookList .book-row[data-book="b-txt"]').click()`);
    await waitFor(ws, `!!document.querySelector('${pane} .tx-code')`, "文本等宽渲染");
    await sleep(300);

    const codeInfo = await evaluate(ws, `(() => {
      const root = document.querySelector('${pane} .md-doc');
      const gutter = root.querySelector('.tx-gutter');
      const lines = root.querySelectorAll('.tx-lines')[0];
      return {
        cls: root.className,
        gutterHead: gutter ? gutter.textContent.split("\\n").slice(0, 2).join(",") : "",
        gutterCount: gutter ? gutter.textContent.trim().split("\\n").length : 0,
        lineCount: lines ? lines.textContent.split("\\n").length : 0,
        nodes: root.querySelectorAll('*').length,
        sub: document.querySelector('#docSub')?.textContent || "",
      };
    })()`);
    errs = await errors();
    check("文本按等宽渲染", codeInfo.cls.includes("text-code"), `class="${codeInfo.cls}"`);
    check("行号与正文行数一致且从 1 开始",
      codeInfo.gutterHead === "1,2" && codeInfo.gutterCount === codeInfo.lineCount && codeInfo.lineCount === 12,
      `行号 ${codeInfo.gutterCount} 行 / 正文 ${codeInfo.lineCount} 行，前两行 "${codeInfo.gutterHead}"`);
    // 关键性能约束：不是「一行一个 div」，十几万行的日志也只有常数个节点
    check("等宽视图节点数为常数", codeInfo.nodes <= 4, `节点数 ${codeInfo.nodes}`);
    check("文档副标题显示行数与字数", /行/.test(codeInfo.sub) && /字/.test(codeInfo.sub), `"${codeInfo.sub}"`);

    const tbInfo = await evaluate(ws, `(() => ({
      plain: !!document.querySelector('[data-act="text-plain"]'),
      code: document.querySelector('[data-act="text-code"]')?.classList.contains('is-on'),
      gutter: document.querySelector('[data-act="text-gutter"]')?.classList.contains('is-on'),
      wrap: document.querySelector('[data-act="text-wrap"]')?.classList.contains('is-on'),
      stat: document.querySelector('.read-toolbar .page-total')?.textContent?.trim() || "",
    }))()`);
    check("文本工具栏：等宽视图 + 行号默认打开 + 行数统计",
      tbInfo.plain && tbInfo.code && tbInfo.gutter && !tbInfo.wrap && /行$/.test(tbInfo.stat),
      `等宽=${tbInfo.code} 行号=${tbInfo.gutter} 软换行=${tbInfo.wrap} 统计="${tbInfo.stat}"`);

    /* 切到正文视图：空行分段，段落数应为 4（样本里有 3 处空行） */
    await evaluate(ws, `document.querySelector('[data-act="text-plain"]').click()`);
    await sleep(200);
    const plainInfo = await evaluate(ws, `(() => {
      const root = document.querySelector('${pane} .md-doc');
      return { cls: root.className, paras: root.querySelectorAll('.tx-para').length,
        wrapDisabled: document.querySelector('[data-act="text-wrap"]')?.disabled };
    })()`);
    check("切到正文视图按空行分段",
      plainInfo.cls.includes("text-plain") && plainInfo.paras >= 2,
      `段落 ${plainInfo.paras}，软换行按钮禁用=${plainInfo.wrapDisabled}`);

    /* 回到等宽，打开软换行：行号应自动让位（两者互斥） */
    await evaluate(ws, `document.querySelector('[data-act="text-code"]').click()`);
    await sleep(150);
    await evaluate(ws, `document.querySelector('[data-act="text-wrap"]').click()`);
    await sleep(200);
    const wrapInfo = await evaluate(ws, `(() => ({
      wrap: document.querySelector('[data-act="text-wrap"]')?.classList.contains('is-on'),
      gutterOn: document.querySelector('[data-act="text-gutter"]')?.classList.contains('is-on'),
      gutterDisabled: document.querySelector('[data-act="text-gutter"]')?.disabled,
      // 行号栏现在常驻 DOM，靠 show-gutter 类显隐——检查它真的不可见，而不是被删掉
      gutterHidden: (() => {
        const el = document.querySelector('${pane} .tx-gutter');
        return !el || getComputedStyle(el).display === 'none';
      })(),
      showGutterClass: document.querySelector('${pane} .md-doc')?.classList.contains('show-gutter'),
      wrapped: document.querySelector('${pane} .text-code')?.classList.contains('is-wrap'),
    }))()`);
    check("打开软换行自动关掉行号（避免错位）",
      wrapInfo.wrap && !wrapInfo.gutterOn && wrapInfo.gutterHidden && !wrapInfo.showGutterClass
        && wrapInfo.gutterDisabled && wrapInfo.wrapped,
      `软换行=${wrapInfo.wrap} 行号=${wrapInfo.gutterOn} 行号栏已隐藏=${wrapInfo.gutterHidden}`);

    /* 侧栏：文本类只保留「信息 / 搜索」，信息里要能看到编码 */
    const infoPanel = await evaluate(ws, `(() => {
      const tabs = [...document.querySelectorAll('#ctxTabs .ctx-tab')].filter((t) => !t.hidden).map((t) => t.dataset.ctx);
      const rows = [...document.querySelectorAll('#ctxBody .info-row')].map((r) => r.textContent.trim());
      return { tabs, rows, body: document.querySelector('#ctxBody')?.textContent || "" };
    })()`);
    errs = await errors();
    check("文本类侧栏只保留「信息 / 搜索」", infoPanel.tabs.join(",") === "info,find", `tabs=${infoPanel.tabs.join(",")}`);
    check("信息面板列出编码与行数",
      infoPanel.body.includes("UTF-8") && infoPanel.body.includes("LF") && infoPanel.rows.length >= 5,
      `行数 ${infoPanel.rows.length}`);
    check("文本阅读无未捕获异常", errs.length === 0, errs.join(" | "));

    /* --- 编码手动切换：探测错了要能当场换一个重开，选择写回书架 --- */
    const encBefore = await evaluate(ws, `(() => {
      const btn = document.querySelector('#ctxBody [data-enc-toggle]');
      return {
        btnText: btn?.textContent?.trim() || "",
        menuHidden: document.querySelector('#ctxBody #encMenu')?.hidden,
        items: document.querySelectorAll('#ctxBody #encMenu .enc-item').length,
        onItem: document.querySelector('#ctxBody #encMenu .enc-item.is-on')?.dataset.enc,
      };
    })()`);
    errs = await errors();
    check("编码一行可点开、默认收起",
      !!encBefore.btnText && encBefore.menuHidden === true,
      `按钮 "${encBefore.btnText}"，菜单 ${encBefore.menuHidden ? "收起" : "已展开"}`);
    check("编码菜单列出常见编码并以「自动检测」为当前项",
      encBefore.items >= 6 && encBefore.onItem === "",
      `${encBefore.items} 项，当前 "${encBefore.onItem}"`);
    check("未手动指定时按钮标「自动」", encBefore.btnText.includes("自动"), `"${encBefore.btnText}"`);

    // 选 GB18030：应以该编码重开，按钮改标「手动」
    await evaluate(ws, `document.querySelector('#ctxBody [data-enc-toggle]').click()`);
    await sleep(120);
    await shot(ws, "text-encoding-menu");
    await evaluate(ws, `document.querySelector('#ctxBody #encMenu [data-enc="gb18030"]').click()`);
    await waitFor(ws, `document.querySelector('#ctxBody [data-enc-toggle]')?.textContent.includes("GB18030")`, "按 GB18030 重开");
    const encManual = await evaluate(ws, `(() => ({
      btnText: document.querySelector('#ctxBody [data-enc-toggle]')?.textContent?.trim() || "",
      onItem: document.querySelector('#ctxBody #encMenu .enc-item.is-on')?.dataset.enc,
      menuHidden: document.querySelector('#ctxBody #encMenu')?.hidden,
      encCalls: window.__encCalls.slice(),
      bodyText: document.querySelector('${pane} .tx-lines')?.textContent?.length || 0,
      cls: document.querySelector('${pane} .md-doc')?.className || "",
      rows: [...document.querySelectorAll('#ctxBody .info-row')].map((r) => r.textContent.trim()).join(" / "),
    }))()`);
    errs = await errors();
    check("选中项会以该编码重新打开",
      encManual.encCalls[encManual.encCalls.length - 1] === "gb18030",
      `调用记录 ${JSON.stringify(encManual.encCalls)}`);
    check("切换后按钮与菜单都标为手动、GB18030",
      encManual.btnText.includes("GB18030") && encManual.btnText.includes("手动")
        && encManual.onItem === "gb18030",
      `"${encManual.btnText}" / 当前项 "${encManual.onItem}"`);
    check("选完菜单自动收起", encManual.menuHidden === true);
    check("切换编码后正文仍在、视图选择不丢",
      encManual.bodyText > 100 && encManual.cls.includes("is-wrap"),
      `正文 ${encManual.bodyText} 字符，class="${encManual.cls}"`);

    // 改回自动检测：传空串，按钮回到「自动」
    await evaluate(ws, `document.querySelector('#ctxBody [data-enc-toggle]').click()`);
    await evaluate(ws, `document.querySelector('#ctxBody #encMenu [data-enc=""]').click()`);
    await waitFor(ws, `document.querySelector('#ctxBody [data-enc-toggle]')?.textContent.includes("自动")`, "改回自动检测");
    const encAuto = await evaluate(ws, `(() => ({
      btnText: document.querySelector('#ctxBody [data-enc-toggle]')?.textContent?.trim() || "",
      onItem: document.querySelector('#ctxBody #encMenu .enc-item.is-on')?.dataset.enc,
      encCalls: window.__encCalls.slice(),
    }))()`);
    errs = await errors();
    check("改回自动检测时传空串",
      encAuto.encCalls[encAuto.encCalls.length - 1] === "" && encAuto.onItem === "",
      `调用记录 ${JSON.stringify(encAuto.encCalls)}`);
    check("改回自动后按钮标「自动」", encAuto.btnText.includes("自动") && encAuto.btnText.includes("UTF-8"),
      `"${encAuto.btnText}"`);
    check("编码切换全程无未捕获异常", errs.length === 0, errs.join(" | "));

    /* --- 代码高亮：异步补上，且不能破坏行号对齐 --- */
    await evaluate(ws, `document.querySelector('#bookList .book-row[data-book="b-code"]').click()`);
    await waitFor(ws, `!!document.querySelector('${pane} .tx-lines.hljs')`, "语法高亮");
    const hlInfo = await evaluate(ws, `(() => {
      const root = document.querySelector('${pane} .md-doc');
      const body = root.querySelector('.tx-lines');
      const gutter = root.querySelector('.tx-gutter');
      return {
        highlighted: body.classList.contains('hljs'),
        keywords: body.querySelectorAll('.hljs-keyword').length,
        comments: body.querySelectorAll('.hljs-comment').length,
        plainText: body.querySelectorAll('.hljs-string').length,
        bodyLines: body.textContent.split("\\n").length,
        gutterLines: gutter ? gutter.textContent.trim().split("\\n").length : 0,
        gutterVisible: gutter ? getComputedStyle(gutter).display !== "none" : false,
        tabSize: getComputedStyle(body).tabSize,
        info: [...document.querySelectorAll('#ctxBody .info-row')].map((r) => r.textContent.trim()).join(" / "),
      };
    })()`);
    errs = await errors();
    check("代码文件按语言高亮", hlInfo.highlighted && hlInfo.keywords >= 4,
      `关键字 ${hlInfo.keywords} 个、注释 ${hlInfo.comments} 处、字符串 ${hlInfo.plainText} 处`);
    check("高亮不破坏行号对齐",
      hlInfo.gutterVisible && hlInfo.bodyLines === hlInfo.gutterLines && hlInfo.bodyLines === RUST_CODE.split("\n").length,
      `行号 ${hlInfo.gutterLines} / 正文 ${hlInfo.bodyLines}（样本 ${RUST_CODE.split("\n").length} 行）`);
    check("等宽视图制表符宽度为 4", hlInfo.tabSize === "4", `tab-size=${hlInfo.tabSize}`);
    check("信息面板标出高亮为「开」", hlInfo.info.includes("开"), hlInfo.info);
    // 状态栏曾经对文本类沿用 Markdown 那一行，显示成「MARKDOWN · N 字」
    const statusText = await evaluate(ws, `document.querySelector('#statusRight')?.textContent || ""`);
    check("状态栏按文本口径显示类型与行数",
      statusText.includes("RS") && statusText.includes("行") && !statusText.includes("MARKDOWN"),
      `"${statusText}"`);
    check("代码阅读无未捕获异常", errs.length === 0, errs.join(" | "));
    await shot(ws, "text-code-paper");
    // 夜读主题下的 token 配色单独看一眼：深底上颜色不对是最容易漏的
    await evaluate(ws, `document.documentElement.dataset.theme = "night"`);
    await sleep(200);
    await shot(ws, "text-code-night");
    await evaluate(ws, `document.documentElement.dataset.theme = "paper"`);

    /* --- 超过 200KB 的代码：放弃高亮但必须仍然可读，信息面板要说清原因 --- */
    await evaluate(ws, `document.querySelector('#bookList .book-row[data-book="b-big"]').click()`);
    await waitFor(ws, `!!document.querySelector('${pane} .tx-code')`, "大文件等宽渲染");
    await sleep(700); // 留足空闲回调的机会：确认它确实“没做”，而不是“还没做完”
    const bigInfo = await evaluate(ws, `(() => {
      const root = document.querySelector('${pane} .md-doc');
      const body = root.querySelector('.tx-lines');
      const gutter = root.querySelector('.tx-gutter');
      return {
        highlighted: body.classList.contains('hljs'),
        tokens: body.querySelectorAll('[class^="hljs-"]').length,
        bodyLines: body.textContent.split("\\n").length,
        gutterLines: gutter ? gutter.textContent.trim().split("\\n").length : 0,
        info: [...document.querySelectorAll('#ctxBody .info-row')].map((r) => r.textContent.trim()).join(" / "),
      };
    })()`);
    errs = await errors();
    check("超 200KB 的代码不启用高亮", !bigInfo.highlighted && bigInfo.tokens === 0,
      `highlights=${bigInfo.highlighted} token 节点 ${bigInfo.tokens}`);
    check("超限文件仍完整渲染且行号对齐",
      bigInfo.bodyLines === bigInfo.gutterLines && bigInfo.bodyLines === BIG_CODE.split("\n").length,
      `行号 ${bigInfo.gutterLines} / 正文 ${bigInfo.bodyLines}（样本 ${BIG_CODE.split("\n").length} 行）`);
    check("信息面板说明高亮被关闭", bigInfo.info.includes("200 KB"), bigInfo.info);
    check("大文件阅读无未捕获异常", errs.length === 0, errs.join(" | "));

    /* --- CSV：默认进表格视图，引号内的逗号不能被拆列 --- */
    await evaluate(ws, `document.querySelector('#bookList .book-row[data-book="b-csv"]').click()`);
    await waitFor(ws, `!!document.querySelector('${pane} .tx-table')`, "表格渲染");
    const csvInfo = await evaluate(ws, `(() => {
      const root = document.querySelector('${pane} .md-doc');
      const table = root.querySelector('.tx-table');
      const headCells = [...table.querySelectorAll('thead th')].map((c) => c.textContent);
      const bodyRows = [...table.querySelectorAll('tbody tr')];
      const lastRow = bodyRows[bodyRows.length - 1];
      const secondRow = bodyRows[1];
      const headTh = table.querySelector('thead th:not(.tx-rowno)');
      const rowNo = table.querySelector('tbody .tx-rowno');
      return {
        cls: root.className,
        headCells,
        bodyCount: bodyRows.length,
        lastRowCells: [...lastRow.children].map((c) => c.textContent),
        secondRowCells: [...secondRow.children].map((c) => c.textContent),
        stickyHead: getComputedStyle(headTh).position,
        stickyRowNo: getComputedStyle(rowNo).position,
        rowNoFirst: rowNo.textContent,
        hasTableBtn: !!document.querySelector('[data-act="text-table"]'),
        tableBtnOn: document.querySelector('[data-act="text-table"]')?.classList.contains('is-on'),
        gutterDisabled: document.querySelector('[data-act="text-gutter"]')?.disabled,
        stat: document.querySelector('.read-toolbar .page-total')?.textContent?.trim() || "",
        info: [...document.querySelectorAll('#ctxBody .info-row')].map((r) => r.textContent.trim()).join(" / "),
      };
    })()`);
    errs = await errors();
    check("CSV 默认按表格渲染", csvInfo.cls.includes("text-table") && csvInfo.tableBtnOn,
      `class="${csvInfo.cls}"`);
    check("表头 5 列且第 5 列是备注", csvInfo.headCells.join(",") === "#,日期,书名,作者,进度,备注",
      `表头 ${csvInfo.headCells.join("|")}`);
    check("引号内的逗号不拆列",
      csvInfo.secondRowCells.length === 6 && csvInfo.secondRowCells[5] === "图版多,页边窄",
      `第 2 行 ${csvInfo.secondRowCells.length} 格：${csvInfo.secondRowCells.slice(4).join(" | ")}`);
    check("残缺行补齐到表头列数", csvInfo.lastRowCells.length === 6,
      `末行 ${csvInfo.lastRowCells.length} 格：${csvInfo.lastRowCells.join(" | ")}`);
    check("表头与行号列都是 sticky",
      csvInfo.stickyHead === "sticky" && csvInfo.stickyRowNo === "sticky",
      `表头 ${csvInfo.stickyHead} / 行号 ${csvInfo.stickyRowNo}，首个行号 "${csvInfo.rowNoFirst}"`);
    check("表格统计为行 × 列", /行/.test(csvInfo.stat) && /列/.test(csvInfo.stat), `"${csvInfo.stat}"`);
    check("表格视图下架掉行号开关", csvInfo.gutterDisabled === true);
    check("信息面板标出分隔符为逗号", csvInfo.info.includes("逗号"), csvInfo.info);
    check("CSV 阅读无未捕获异常", errs.length === 0, errs.join(" | "));
    await shot(ws, "text-table-paper");

    /* 真滚一次：computed 是 sticky 不等于粘住了，得看它滚完还在不在顶上 */
    const stickyInfo = await evaluate(ws, `(() => {
      const table = document.querySelector('${pane} .tx-table');
      let scroller = table.parentElement;
      while (scroller && scroller.scrollHeight <= scroller.clientHeight + 4) scroller = scroller.parentElement;
      if (!scroller) return { ok: false, reason: "找不到滚动容器" };
      // .scroll-area 带 scroll-behavior: smooth，直接赋 scrollTop 会启动动画，
      // 同步读回来还是 0。测量前必须临时改成 auto
      scroller.style.scrollBehavior = "auto";
      // .md-doc 有 animation: rise 600ms both，进场时整块内容被 translateY 推下去，
      // 期间量到的「表头偏移」是动画的位移，不是 sticky 的偏差（上一轮 1px、这一轮
      // 10px 就是这么来的）。测量前把动画一律走到终点
      document.getAnimations().forEach((a) => { try { a.finish(); } catch {} });
      scroller.scrollTop = 600;
      const head = table.querySelector('thead th:not(.tx-rowno)');
      const rowNo = table.querySelector('thead .tx-rowno');
      const box = scroller.getBoundingClientRect();
      return {
        ok: true,
        scrolled: scroller.scrollTop,
        headOffset: Math.round(head.getBoundingClientRect().top - box.top),
        rowNoOffset: Math.round(rowNo.getBoundingClientRect().top - box.top),
        // 表头自己（th）粘住了，但表头行（thead）应该已经滚出去——
        // 这两个数一起看才能排除「整块没滚」造成的假通过
        theadOffset: Math.round(table.querySelector("thead").getBoundingClientRect().top - box.top),
      };
    })()`);
    check("滚动后表头仍贴在顶部（真的 sticky，不是只有声明）",
      stickyInfo.ok && stickyInfo.scrolled > 500 && stickyInfo.theadOffset < -500
        && Math.abs(stickyInfo.headOffset) <= 2 && Math.abs(stickyInfo.rowNoOffset) <= 2,
      stickyInfo.ok
        ? `表体滚出 ${-stickyInfo.theadOffset}px，表头与行号列偏移 ${stickyInfo.headOffset} / ${stickyInfo.rowNoOffset}px`
        : stickyInfo.reason);
    await shot(ws, "text-table-scrolled");

    /* 行号不能缺：截图里看着像少一行时，靠 DOM 说话，别靠眼睛 */
    const rowNos = await evaluate(ws, `(() => {
      const cells = [...document.querySelectorAll('${pane} .tx-table tbody th.tx-rowno')];
      const nums = cells.map((c) => c.textContent.trim());
      const bad = nums.findIndex((v, i) => v !== String(i + 1));
      const empty = nums.filter((v) => !v).length;
      return { count: nums.length, bad, empty, head: nums.slice(0, 3).join(",") };
    })()`);
    check("表格行号从 1 连续到末行、无空格子",
      rowNos.bad === -1 && rowNos.empty === 0 && rowNos.count === 123,
      `${rowNos.count} 个行号，首个 "${rowNos.head}"，空格子 ${rowNos.empty}，首个断点 ${rowNos.bad}`);
    // 横向滚动不测：本机视口 1440px 下 5 列撑不满，滚不动

    /* --- TSV：分隔符靠内容判断，不按扩展名写死 --- */
    await evaluate(ws, `document.querySelector('#bookList .book-row[data-book="b-tsv"]').click()`);
    await waitFor(ws, `!!document.querySelector('${pane} .tx-table')`, "TSV 表格渲染");
    const tsvInfo = await evaluate(ws, `(() => {
      const table = document.querySelector('${pane} .tx-table');
      return {
        headCells: [...table.querySelectorAll('thead th')].map((c) => c.textContent),
        text: table.querySelector('tbody tr').textContent,
        info: [...document.querySelectorAll('#ctxBody .info-row')].map((r) => r.textContent.trim()).join(" / "),
      };
    })()`);
    check("TSV 按制表符拆列", tsvInfo.headCells.join(",") === "#,id,名称,状态",
      `表头 ${tsvInfo.headCells.join("|")}`);
    check("信息面板标出分隔符为制表符", tsvInfo.info.includes("制表符"), tsvInfo.info);
    check("TSV 阅读无未捕获异常", (await errors()).length === 0);

    /* --- 表格按钮只对 CSV/TSV 出现：日志上不该有 --- */
    await evaluate(ws, `document.querySelector('#bookList .book-row[data-book="b-txt"]').click()`);
    await waitFor(ws, `!!document.querySelector('${pane} .tx-code')`, "回到日志");
    const logToolbar = await evaluate(ws, `(() => ({
      hasTableBtn: !!document.querySelector('[data-act="text-table"]'),
      gutterOn: document.querySelector('[data-act="text-gutter"]')?.classList.contains('is-on'),
    }))()`);
    check("非表格类文档不出现表格按钮",
      !logToolbar.hasTableBtn && logToolbar.gutterOn === true,
      `表格按钮=${logToolbar.hasTableBtn} 行号=${logToolbar.gutterOn}`);

    /* --- 大文件（>8MB）：行索引 + 窗口渲染，不能把整篇塞进 DOM --- */
    await evaluate(ws, `document.querySelector('#bookList .book-row[data-book="b-huge"]').click()`);
    await waitFor(ws, `!!document.querySelector('${pane} .tx-canvas')`, "大文件窗口渲染");
    await waitFor(ws, `(document.querySelector('${pane} .tx-lines')?.textContent.length || 0) > 0`, "首个窗口到位");

    const hugeInit = await evaluate(ws, `(() => {
      const root = document.querySelector('${pane} .md-doc');
      const canvas = root.querySelector('.tx-canvas');
      const win = root.querySelector('.tx-window');
      const body = root.querySelector('.tx-lines');
      const gutter = root.querySelector('.tx-gutter');
      const nums = gutter.textContent.split("\\n");
      return {
        cls: root.className,
        canvasH: Math.round(canvas.getBoundingClientRect().height),
        winTop: Math.round(win.getBoundingClientRect().top - canvas.getBoundingClientRect().top),
        bodyLines: body.textContent.split("\\n").length,
        gutterFirst: nums[0],
        textChars: body.textContent.length,
        stat: document.querySelector('.read-toolbar .page-total')?.textContent?.trim() || "",
        status: document.querySelector('#statusRight')?.textContent?.trim() || "",
        plainDisabled: document.querySelector('[data-act="text-plain"]')?.disabled,
        wrapDisabled: document.querySelector('[data-act="text-wrap"]')?.disabled,
        gutterDisabled: document.querySelector('[data-act="text-gutter"]')?.disabled,
        hasTableBtn: !!document.querySelector('[data-act="text-table"]'),
        rows: [...document.querySelectorAll('#ctxBody .info-row')].map((r) => r.textContent.trim()).join(" / "),
        note: document.querySelector('#ctxBody .info-note')?.textContent?.trim() || "",
        wmCalls: window.__calls.filter((c) => c.startsWith("read_text_window:")).length,
      };
    })()`);
    errs = await errors();
    check("大文件画布高度 = 行数 × 行高",
      hugeInit.canvasH === HUGE_LINES * 20, `${hugeInit.canvasH}px（${HUGE_LINES} 行 × 20px）`);
    check("首屏只渲染一个窗口，不铺全文",
      hugeInit.bodyLines > 0 && hugeInit.bodyLines <= 1200 && hugeInit.textChars < 200000
        && hugeInit.wmCalls === 1,
      `${hugeInit.bodyLines} 行 / ${hugeInit.textChars} 字符，取窗口 ${hugeInit.wmCalls} 次`);
    check("窗口贴在第 1 行，行号从 1 开始", hugeInit.winTop === 0 && hugeInit.gutterFirst === "1",
      `窗口顶 ${hugeInit.winTop}px，首个行号 "${hugeInit.gutterFirst}"`);
    check("大文件锁死等宽：正文/行号/软换行禁用，无表格按钮",
      hugeInit.plainDisabled === true && hugeInit.wrapDisabled === true
        && hugeInit.gutterDisabled === true && hugeInit.hasTableBtn === false,
      `正文=${hugeInit.plainDisabled} 行号=${hugeInit.gutterDisabled} 软换行=${hugeInit.wrapDisabled}`);
    check("工具栏报行数、状态栏标明是大文件",
      hugeInit.stat.includes(String(HUGE_LINES)) && hugeInit.status.includes("大文件"),
      `工具栏 "${hugeInit.stat}" / 状态栏 "${hugeInit.status}"`);
    check("信息面板说明按窗口加载，且不谎报字符数",
      hugeInit.note.includes("窗口") && !hugeInit.rows.includes("字符"), `${hugeInit.rows} | ${hugeInit.note}`);
    check("大文件阅读无未捕获异常", errs.length === 0, errs.join(" | "));
    await shot(ws, "text-huge-top");

    /* 拖到底部：末行必须真的出来，窗口下沿贴着画布底 */
    const hugeEnd = await evaluate(ws, `(async () => {
      const area = document.querySelector('${pane} .scroll-area');
      area.style.scrollBehavior = "auto";
      area.scrollTop = area.scrollHeight;
      await new Promise((r) => setTimeout(r, 600));
      const root = document.querySelector('${pane} .md-doc');
      const canvas = root.querySelector('.tx-canvas').getBoundingClientRect();
      const win = root.querySelector('.tx-window').getBoundingClientRect();
      const nums = root.querySelector('.tx-gutter').textContent.split("\\n").map(Number);
      return {
        scrollTop: Math.round(area.scrollTop),
        maxScroll: Math.round(area.scrollHeight - area.clientHeight),
        first: nums[0],
        last: nums[nums.length - 1],
        count: nums.length,
        gap: Math.round(canvas.bottom - win.bottom),
        calls: window.__calls.filter((c) => c.startsWith("read_text_window:")),
      };
    })()`);
    check("拖到底部能看到最后一行",
      hugeEnd.scrollTop === hugeEnd.maxScroll && hugeEnd.last === HUGE_LINES,
      `滚到 ${hugeEnd.scrollTop}/${hugeEnd.maxScroll}px，行号 ${hugeEnd.first}–${hugeEnd.last}（${hugeEnd.count} 行）`);
    // 窗口盒子的尾部有几十像素空白，只要它盖到画布底（gap <= 0）就不会露白
    check("末窗盖到画布底，底部不露白",
      hugeEnd.gap <= 0 && hugeEnd.gap > -40, `窗口比画布底多出 ${-hugeEnd.gap}px`);
    check("末窗按行对齐取到文件尾",
      hugeEnd.count > 0 && hugeEnd.count <= 1200 && hugeEnd.calls.length === 2,
      `取窗口 ${hugeEnd.calls.join(" → ")}`);
    await shot(ws, "text-huge-bottom");

    /* 滚回开头：窗口仍在缓存里就不该再发请求 */
    const hugeBack = await evaluate(ws, `(async () => {
      const area = document.querySelector('${pane} .scroll-area');
      area.scrollTop = 0;
      await new Promise((r) => setTimeout(r, 400));
      const root = document.querySelector('${pane} .md-doc');
      const nums = root.querySelector('.tx-gutter').textContent.split("\\n").map(Number);
      return {
        first: nums[0],
        calls: window.__calls.filter((c) => c.startsWith("read_text_window:")).length,
      };
    })()`);
    check("滚回开头命中缓存，不重复取窗口",
      hugeBack.first === 1 && hugeBack.calls === 2, `首个行号 ${hugeBack.first}，累计取窗口 ${hugeBack.calls} 次`);

    /* 搜索：窗口模式下 DOM 里只有一两千行，必须下沉到后端 */
    await evaluate(ws, `document.querySelector('.ctx-tab[data-ctx="find"]').click()`);
    await waitFor(ws, `!!document.querySelector('#findInput')`, "搜索面板打开");
    await evaluate(ws, `(() => {
      const input = document.querySelector('#findInput');
      input.value = "zebra";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await waitFor(ws, `document.querySelectorAll('#findHits .find-hit').length > 0`, "大文件搜索命中");
    const hugeFind = await evaluate(ws, `(() => {
      const hits = [...document.querySelectorAll('#findHits .find-hit')];
      return {
        count: hits.length,
        labels: hits.map((h) => h.querySelector('.hit-page')?.textContent?.trim() || ""),
        searched: window.__calls.filter((c) => c === "search_text").length,
        summary: document.querySelector('#findSummary')?.textContent?.trim() || "",
        marked: document.querySelectorAll('#findHits .find-hit mark').length,
      };
    })()`);
    check("大文件搜索走后端而不是遍历 DOM",
      hugeFind.searched >= 1 && hugeFind.count === 2, `命中 ${hugeFind.count} 处，search_text ${hugeFind.searched} 次`);
    check("命中项标出行号并高亮关键词",
      hugeFind.labels[0] === "第 1201 行" && hugeFind.marked >= 2,
      `"${hugeFind.labels.join(" / ")}"，<mark> ${hugeFind.marked} 处`);

    await evaluate(ws, `document.querySelectorAll('#findHits .find-hit')[0].click()`);
    const jumped = await evaluate(ws, `(async () => {
      await new Promise((r) => setTimeout(r, 600));
      const area = document.querySelector('${pane} .scroll-area');
      const nums = document.querySelector('${pane} .tx-gutter').textContent.split("\\n").map(Number);
      const firstVisible = Math.round(area.scrollTop / 20);
      return {
        scrollTop: Math.round(area.scrollTop),
        windowFirst: nums[0],
        // 可视区顶部那一行的行号：窗口首行号 + 相对偏移
        topLine: nums[firstVisible - (nums[0] - 1)],
      };
    })()`);
    check("点击命中跳到对应行",
      jumped.topLine === 1201 && jumped.scrollTop === (1201 - 1) * 20,
      `滚到 ${jumped.scrollTop}px，可视区首行 ${jumped.topLine}（窗口从 ${jumped.windowFirst} 行起）`);
    errs = await errors();
    check("大文件搜索无未捕获异常", errs.length === 0, errs.join(" | "));
    await shot(ws, "text-huge-search");

    /* --- 命中定位：从书架命中直接落到那一行，并在侧栏标出对应条目 ---
       放在大文件用例之后：这里要真的重开一次 b-huge，才能覆盖 openText 里
       那个「用 rAF 恢复进度」的时序——它晚于打开动作，会把过早设定的滚动位置冲掉 */
    await evaluate(ws, `document.querySelector('#bookList .book-row[data-book="b-txt"]').click()`);
    await sleep(600);
    await evaluate(ws, `(async () => {
      const { setView } = await import("/js/view.js");
      setView("library");
    })()`);
    await sleep(200);
    await evaluate(ws, `document.querySelector('#filterRow [data-filter="text"]').click()`);
    await sleep(200);
    await evaluate(ws, `(() => {
      const input = document.querySelector("#libSearch");
      input.value = "zebra";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await sleep(1200);
    const lineHit = await evaluate(ws, `(() => {
      const row = document.querySelector("#libHits .hits-row");
      return row ? {
        book: row.dataset.hitBook,
        line: Number(row.dataset.hitLine) || 0,
        page: Number(row.dataset.hitPage) || 0,
        href: row.dataset.hitHref || "",
        groups: document.querySelectorAll("#libHits .hits-group").length,
        rows: document.querySelectorAll("#libHits .hits-row").length,
      } : null;
    })()`);
    check("文本命中带上行号，且只有真正含关键词的那一本出结果",
      Boolean(lineHit) && lineHit.book === "b-huge" && lineHit.line === 1201
        && lineHit.page === 0 && lineHit.groups === 1 && lineHit.rows === 2,
      lineHit ? `${lineHit.groups} 本 / ${lineHit.rows} 行 · ${lineHit.book} · 第 ${lineHit.line} 行` : "没有命中");

    await evaluate(ws, `document.querySelector("#libHits .hits-row").click()`);
    await sleep(1500);
    const lineJump = await evaluate(ws, `(async () => {
      const { activePane } = await import("/js/reader/panes.js");
      const { LINE_HEIGHT } = await import("/js/reader-bigtext.js");
      const pane = activePane();
      const top = pane?.scrollArea?.scrollTop || 0;
      const rows = [...document.querySelectorAll("#ctxBody .find-hit")];
      const focused = rows.find((row) => row.classList.contains("is-focus"));
      return {
        book: pane?.book?.id || "",
        line: Math.round(top / LINE_HEIGHT) + 1,
        top,
        focus: Boolean(focused),
        focusLabel: (focused?.textContent || "").replace(/\\s+/g, " ").trim(),
      };
    })()`);
    check("点文本命中重开这本书并直接落到那一行，侧栏也标出对应条目",
      lineJump.book === "b-huge" && lineJump.top === 1200 * 20 && lineJump.focus
        && /1201/.test(lineJump.focusLabel),
      `${lineJump.book} · 滚到 ${lineJump.top}px（第 ${lineJump.line} 行）· 侧栏「${lineJump.focusLabel.slice(0, 16)}」`);

    // 复原：后续用例还要按书 id 从书架点书
    await evaluate(ws, `(async () => {
      const { state } = await import("/js/core/session.js");
      const { setView } = await import("/js/view.js");
      const { renderLibrary } = await import("/js/shelf.js");
      setView("library");
      state.filter = "all";
      state.query = "";
      document.querySelector("#libSearch").value = "";
      document.querySelectorAll("#filterRow .chip")
        .forEach((chip) => chip.classList.toggle("is-on", chip.dataset.filter === "all"));
      renderLibrary();
    })()`);
    await sleep(240);

    /* --- 电子书：打开、分页、目录、CFI 续读、书内脚本不执行 --- */
    await evaluate(ws, `document.querySelector('#bookList .book-row[data-book="b-epub"]').click()`);
    await waitFor(ws, `document.querySelector('${pane} .ebook-stack foliate-view') !== null`, "电子书挂载", 20000);
    await waitFor(ws, `(async () => {
      const mod = await import("/js/reader/panes.js");
      return (mod.activePane()?.ebook?.location?.cfi || "").length > 0;
    })()`, "电子书首屏定位", 20000);

    const ebook = await evaluate(ws, `(async () => {
      const mod = await import("/js/reader/panes.js");
      const current = mod.activePane();
      const view = document.querySelector('${pane} .ebook-stack foliate-view');
      const box = view?.getBoundingClientRect();
      return {
        height: Math.round(box?.height || 0),
        toc: (current?.ebookToc || []).map((item) => item.label),
        levels: (current?.ebookToc || []).map((item) => item.level),
        chapters: current?.ebook?.chapters || 0,
        cfi: current?.ebook?.location?.cfi || "",
        fraction: current?.ebook?.location?.fraction ?? -1,
        label: current?.ebook?.location?.label || "",
        status: document.querySelector("#statusRight").textContent,
        sub: document.querySelector("#docSub").textContent,
        toolbar: document.querySelector("#readToolbar").textContent.replace(/\\s+/g, " ").trim(),
        title: document.querySelector("#docTitle").textContent,
      };
    })()`);
    errs = await errors();
    check("EPUB 打开并占满分栏", ebook.height > 200, `view 高度 ${ebook.height}px`);
    check("目录取自书内 NAV，三章都在",
      ebook.toc.length === 3 && ebook.toc[0] === "第一章 起点" && ebook.chapters === 3,
      `${ebook.toc.join(" / ")}（章节计数 ${ebook.chapters}）`);
    check("状态栏报章节与百分比", /第一章 起点 · \d+%/.test(ebook.status), ebook.status);
    check("副标题与工具栏按电子书口径", /EPUB · 3 章/.test(ebook.sub) && /%/.test(ebook.toolbar),
      `${ebook.sub} | ${ebook.toolbar}`);
    check("书名回填自 OPF 元数据", ebook.title === "冒烟样本", ebook.title);

    // 正文确实渲染出来了：只能从 iframe 的隔离世界里读
    let frameCtx = await blobFrameContext(ws);
    const body = frameCtx ? await evaluate(ws,
      `({ text: document.body.innerText.replace(/\\s+/g, " ").trim().slice(0, 40),
          length: document.body.innerText.length,
          scripts: document.querySelectorAll("script").length })`, frameCtx) : null;
    check("章节正文已排版（iframe 内可见文字）",
      Boolean(body && body.length > 500), body ? `${body.length} 字，开头「${body.text}」` : "找不到章节 iframe");
    check("书内 <script> 已被清洗", Boolean(body && body.scripts === 0) && await evaluate(ws, "window.__pwned === undefined"),
      body ? `iframe 内 script 元素 ${body.scripts} 个` : "无 iframe");

    // 翻页：键盘 → relocate → 百分比增加
    for (const type of ["keyDown", "keyUp"]) {
      await send(ws, "Input.dispatchKeyEvent", {
        type, key: "ArrowRight", code: "ArrowRight",
        windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39,
      });
    }
    await sleep(700);
    const turned = await evaluate(ws, `(async () => {
      const mod = await import("/js/reader/panes.js");
      const current = mod.activePane();
      return {
        fraction: current?.ebook?.location?.fraction ?? -1,
        cfi: current?.ebook?.location?.cfi || "",
        ratio: current?.book?.progress?.ratio ?? -1,
        savedCfi: current?.book?.progress?.cfi || "",
      };
    })()`);
    check("键盘翻页改变了位置（CFI 与比例都前进）",
      turned.fraction > ebook.fraction && turned.cfi !== ebook.cfi,
      `${ebook.fraction.toFixed(4)} → ${turned.fraction.toFixed(4)}`);
    check("进度写回书架条目（ratio + cfi）",
      turned.ratio === turned.fraction && turned.savedCfi === turned.cfi,
      `ratio ${turned.ratio.toFixed(4)}，cfi ${turned.savedCfi}`);

    // 目录跳转
    const tocClick = await evaluate(ws, `(() => {
      const item = document.querySelector('#ctxBody .toc-item[data-goto$="ch3.xhtml"]');
      if (!item) return { found: false, html: (document.querySelector("#ctxBody")?.innerHTML || "").slice(0, 160),
        tab: (document.querySelector("#ctxTabs .is-on")?.textContent || ""),
        len: (document.querySelector("#ctxBody")?.children.length ?? -1),
        panel: document.querySelector("#ctxPanel")?.className || "" };
      item.click();
      return { found: true };
    })()`);
    await sleep(900);
    if (!tocClick.found) check("目录里能找到第三章", false, JSON.stringify(tocClick));
    const jumpedEbook = await evaluate(ws, `(async () => {
      const mod = await import("/js/reader/panes.js");
      const current = mod.activePane();
      return {
        label: current?.ebook?.location?.label || "",
        status: document.querySelector("#statusRight").textContent,
        active: document.querySelector('#ctxBody .toc-item.is-active')?.textContent.trim() || "",
      };
    })()`);
    check("点目录跳到第三章并高亮当前项",
      jumpedEbook.label === "第三章 收束" && /第三章/.test(jumpedEbook.active),
      `章节「${jumpedEbook.label}」，高亮「${jumpedEbook.active}」`);
    await shot(ws, "ebook-epub");

    /* --- P2：滑杆 / 单双页 / 点击与滚轮 / 书签 / 全书搜索 / 脚注 --- */
    const bar = await evaluate(ws, `(() => ({
      slider: Boolean(document.querySelector("#ebookSlider")),
      spread: Boolean(document.querySelector('[data-act="ebook-spread"]')),
      mark: Boolean(document.querySelector('[data-act="ebook-mark"]')),
    }))()`);
    check("工具栏给出进度滑杆、单双页与书签按钮",
      bar.slider && bar.spread && bar.mark, JSON.stringify(bar));

    // 回到第一章开头，后面的翻页手势才有确定的方向可走
    await evaluate(ws, `(async () => {
      const mod = await import("/js/reader/panes.js");
      await mod.activePane()?.ebook?.goTo("OEBPS/ch1.xhtml");
    })()`);
    await sleep(900);

    // 点击 / 滚轮都在章节 iframe 里派发：正是为了证明手势真的挂到了章节文档上
    frameCtx = await blobFrameContext(ws);
    const cfiOf = async () => evaluate(ws, `(async () => {
      const mod = await import("/js/reader/panes.js");
      return mod.activePane()?.ebook?.location?.cfi || "";
    })()`);

    const beforeClick = await cfiOf();
    await evaluate(ws, `(() => {
      document.body.dispatchEvent(new MouseEvent("click", {
        bubbles: true, clientX: window.innerWidth * 0.9, clientY: window.innerHeight / 2,
      }));
      return true;
    })()`, frameCtx);
    await sleep(800);
    const afterClick = await cfiOf();
    check("点击右半屏翻到下一页", afterClick !== beforeClick, `...${beforeClick.slice(-18)} → ...${afterClick.slice(-18)}`);

    await evaluate(ws, `(() => {
      document.body.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 120 }));
      return true;
    })()`, frameCtx);
    await sleep(900);
    const afterWheel = await cfiOf();
    check("滚轮下滑再翻一页", afterWheel !== afterClick, `...${afterClick.slice(-18)} → ...${afterWheel.slice(-18)}`);

    // 拖到 80%：滑杆只认 change（松手），拖动过程不跳
    const seek = await evaluate(ws, `(async () => {
      const slider = document.querySelector("#ebookSlider");
      slider.value = "800";
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      const during = document.querySelector(".ebook-pct")?.textContent;
      slider.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 1000));
      const mod = await import("/js/reader/panes.js");
      return {
        during,
        fraction: mod.activePane()?.ebook?.location?.fraction ?? -1,
        label: mod.activePane()?.ebook?.location?.label || "",
        pct: document.querySelector(".ebook-pct")?.textContent || "",
        value: document.querySelector("#ebookSlider")?.value || "",
        fill: document.querySelector("#ebookSlider")?.style.getPropertyValue("--_fill") || "",
      };
    })()`);
    check("拖动进度条跳到目标位置",
      seek.fraction > 0.65 && /^\d+%$/.test(seek.pct) && Math.abs(Number(seek.value) - seek.fraction * 1000) < 60,
      `拖到 ${seek.during} → 实际 ${(seek.fraction * 100).toFixed(0)}%（${seek.label}，工具栏 ${seek.pct}，滑杆 ${seek.value} / 填充 ${seek.fill}）`);

    const spread = await evaluate(ws, `(async () => {
      const mod = await import("/js/reader/panes.js");
      const columns = () => mod.activePane()?.ebook?.view?.renderer?.getAttribute("max-column-count");
      const before = columns();
      document.querySelector('[data-act="ebook-spread"]').click();
      await new Promise((r) => setTimeout(r, 600));
      const single = columns();
      document.querySelector('[data-act="ebook-spread"]').click();
      await new Promise((r) => setTimeout(r, 600));
      return { before, single, back: columns() };
    })()`);
    check("单页 / 双页切换改到分页器列数",
      spread.before === "2" && spread.single === "1" && spread.back === "2",
      `${spread.before} → ${spread.single} → ${spread.back}`);

    // 书签：加 → 侧栏列出 → 删
    const mark = await evaluate(ws, `(async () => {
      document.querySelector('[data-act="ebook-mark"]').click();
      await new Promise((r) => setTimeout(r, 500));
      const mod = await import("/js/reader/panes.js");
      const stateMod = await import("/js/core/session.js");
      const ctx = await import("/js/reader/ctx.js");
      document.querySelector('#ctxTabs [data-ctx="marks"]').click();
      ctx.renderCtx();
      const rows = document.querySelectorAll("#ctxBody .mark-row").length;
      const label = document.querySelector("#ctxBody .mark-main .hit-page")?.textContent || "";
      return {
        count: (mod.activePane()?.book?.bookmarks || []).length,
        on: Boolean(document.querySelector('[data-act="ebook-mark"]')?.classList.contains("is-on")),
        marked: stateMod.state.ebookMarked,
        rows, label,
      };
    })()`);
    check("加书签后按钮点亮、侧栏列出",
      mark.count === 1 && mark.on && mark.marked && mark.rows === 1,
      `${mark.count} 条，行数 ${mark.rows}，章节「${mark.label}」`);
    await shot(ws, "ebook-marks");

    const removed = await evaluate(ws, `(async () => {
      document.querySelector("#ctxBody .mark-del").click();
      await new Promise((r) => setTimeout(r, 500));
      const mod = await import("/js/reader/panes.js");
      return { count: (mod.activePane()?.book?.bookmarks || []).length,
        rows: document.querySelectorAll("#ctxBody .mark-row").length,
        empty: document.querySelector("#ctxBody .ctx-empty")?.textContent || "" };
    })()`);
    check("删书签后列表清空并给出空态",
      removed.count === 0 && removed.rows === 0 && removed.empty.length > 0,
      `${removed.count} 条，空态「${removed.empty.slice(0, 12)}」`);

    // 全书搜索：第二章那个只出现一次的词
    const find = await evaluate(ws, `(async () => {
      document.querySelector('#ctxTabs [data-ctx="find"]').click();
      const input = document.querySelector("#findInput");
      input.value = "石阶生苔";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const started = Date.now();
      while (Date.now() - started < 8000) {
        await new Promise((r) => setTimeout(r, 200));
        if (document.querySelector("#findHits .find-hit")) break;
      }
      return {
        summary: document.querySelector("#findSummary")?.textContent || "",
        groups: [...document.querySelectorAll("#ctxBody .find-group-head")].map((el) => el.textContent),
        hits: document.querySelectorAll("#findHits .find-hit").length,
        excerpt: document.querySelector("#findHits .find-hit")?.textContent || "",
      };
    })()`);
    check("全书搜索命中并标出所属章节",
      find.hits >= 1 && find.groups.includes("第二章 展开") && /石阶生苔/.test(find.excerpt),
      `${find.summary} · 分组 ${find.groups.join("/")} · 首条「${find.excerpt.slice(0, 20)}」`);

    const findJump = await evaluate(ws, `(async () => {
      document.querySelector("#findHits .find-hit").click();
      await new Promise((r) => setTimeout(r, 1000));
      const mod = await import("/js/reader/panes.js");
      return mod.activePane()?.ebook?.location?.label || "";
    })()`);
    check("点搜索结果跳到命中章节", findJump === "第二章 展开", findJump);

    // 脚注：点正文里的注号，弹小窗而不是整页跳走。注号只在第一章
    await evaluate(ws, `(async () => {
      const mod = await import("/js/reader/panes.js");
      await mod.activePane()?.ebook?.goTo("OEBPS/ch1.xhtml");
    })()`);
    await sleep(1000);
    frameCtx = await blobFrameContext(ws);
    const noteBefore = await cfiOf();
    const noteDiag = await evaluate(ws, `(async () => {
      const mod = await import("/js/reader/panes.js");
      const reader = mod.activePane()?.ebook;
      const href = "OEBPS/ch1.xhtml#fn1";
      let resolved = null;
      let error = "";
      try { resolved = reader?.book?.resolveHref?.(href); } catch (e) { error = String(e); }
      let tag = "";
      if (resolved) {
        const doc = await reader.sectionDoc(resolved.index);
        const el = doc ? resolved.anchor(doc) : null;
        tag = el ? String(el.tagName) : "no-el";
      }
      const note = await reader?.footnote?.(href);
      return { index: resolved?.index ?? null, tag, error, noteText: note?.text || "" };
    })()`);
    const noteClick = await evaluate(ws, `(() => {
      const link = document.querySelector('a[href="#fn1"]');
      if (!link) return { found: false, text: document.body.innerText.slice(0, 80) };
      link.click();
      return { found: true };
    })()`, frameCtx);
    await sleep(1200);
    const note = await evaluate(ws, `(() => {
      const card = document.querySelector(".ebook-note");
      const bar = document.querySelector("#readToolbar");
      const rect = card && !card.hidden ? card.getBoundingClientRect() : null;
      const barRect = bar?.getBoundingClientRect();
      // 卡片不能压住浮动工具栏：两者都是阅读区上的浮层，压上去等于把翻页按钮挡掉
      const overlapsBar = Boolean(rect && barRect && rect.bottom > barRect.top && rect.top < barRect.bottom);
      return {
        open: Boolean(card && !card.hidden),
        text: card?.querySelector(".ebook-note-text")?.textContent || "",
        label: card?.querySelector(".ebook-note-label")?.textContent || "",
        overlapsBar,
        inPane: Boolean(rect && rect.left >= 0 && rect.right <= window.innerWidth),
      };
    })()`);
    check("点脚注弹出小窗而不是跳页",
      noteClick.found && note.open && /青苔生于石阶/.test(note.text) && (await cfiOf()) === noteBefore,
      note.open ? `注文「${note.text.slice(0, 16)}…」（章节「${note.label}」）` : `未弹出：${JSON.stringify(noteClick)} 诊断 ${JSON.stringify(noteDiag)}`);
    check("脚注小窗不压工具栏、不越出窗口",
      note.open && !note.overlapsBar && note.inPane,
      `压工具栏 ${note.overlapsBar}，在窗口内 ${note.inPane}`);
    await shot(ws, "ebook-note");
    await evaluate(ws, `document.querySelector(".ebook-note-close")?.click()`);
    const noteClosed = await evaluate(ws, `document.querySelector(".ebook-note")?.hidden ?? true`);
    check("脚注小窗可以关掉", noteClosed === true, String(noteClosed));

    // 到此已经翻过好几章（目录跳转、搜索命中、脚注来回）——章节 iframe 该只剩当前这本
    const frames = await blobFrameCount(ws);
    check("换章后没有留下废弃的章节 iframe", frames <= 2, `${frames} 个 blob 帧`);

    // 续读：回书架再打开，位置要回到第三章
    const beforeReopen = await evaluate(ws, `(async () => {
      const mod = await import("/js/reader/panes.js");
      const current = mod.activePane();
      return { cfi: current?.book?.progress?.cfi || "", label: current?.ebook?.location?.label || "" };
    })()`);
    await evaluate(ws, `document.querySelector("#backBtn").click()`);
    await sleep(600);
    await evaluate(ws, `document.querySelector('#bookList .book-row[data-book="b-epub"]').click()`);
    await waitFor(ws, `(async () => {
      const mod = await import("/js/reader/panes.js");
      return (mod.activePane()?.ebook?.location?.cfi || "").length > 0;
    })()`, "电子书续读定位", 20000);
    await sleep(500);
    const reopened = await evaluate(ws, `(async () => {
      const mod = await import("/js/reader/panes.js");
      const current = mod.activePane();
      return { cfi: current?.ebook?.location?.cfi || "", label: current?.ebook?.location?.label || "" };
    })()`);
    check("关掉重开回到原位（CFI 续读）",
      reopened.cfi === beforeReopen.cfi || reopened.label === beforeReopen.label,
      `期望「${beforeReopen.label}」，实际「${reopened.label}」`);

    /* --- 版式面板：电子书的版式全在这一块调，与通用设置彻底分开 --- */
    frameCtx = await blobFrameContext(ws);
    // 书自带 style.css（serif / 16px 底色 #fff / 左对齐 / 行高 1.5），
    // 所以「设置胜出」这件事才有对象可比
    const typoOf = `(() => {
      const html = getComputedStyle(document.documentElement);
      const body = getComputedStyle(document.body);
      const p = document.querySelector("p");
      const ps = p ? getComputedStyle(p) : null;
      const css = [...document.head.querySelectorAll("style")].map((el) => el.textContent).join("\\n");
      return { htmlSize: parseFloat(html.fontSize), bodySize: parseFloat(body.fontSize),
        ratio: parseFloat(body.lineHeight) / parseFloat(body.fontSize),
        family: body.fontFamily, align: body.textAlign, pAlign: ps ? ps.textAlign : "",
        letter: body.letterSpacing, indent: ps ? ps.textIndent : "",
        color: body.color, bg: body.backgroundColor, css };
    })()`;
    const baseTypo = await evaluate(ws, typoOf, frameCtx);
    check("默认版式就是「舒适中文」预设（19px / 1.85 / 0.25 字距 / 首行缩进 2em）",
      Math.round(baseTypo.htmlSize) === 19 && Math.abs(baseTypo.ratio - 1.85) < 0.02
        && /SimSun|Songti/i.test(baseTypo.family) && baseTypo.pAlign === "justify"
        && Math.abs(parseFloat(baseTypo.letter) - 0.25) < 0.01
        && Math.abs(parseFloat(baseTypo.indent) - 38) < 1.5,
      `${baseTypo.bodySize}px / ${baseTypo.ratio.toFixed(2)} / 字距 ${baseTypo.letter} / 缩进 ${baseTypo.indent}`);

    // 通用设置里那组旧控件必须已经下线：两个入口同时存在，用户不知道改哪个才对
    const legacy = await evaluate(ws, `(async () => {
      (await import("/js/preferences.js")).openSettings();
      const ids = ["#ebookSizeSeg", "#ebookLhSeg", "#ebookMarginSeg", "#ebookFamilySeg", "#ebookAlignSeg", "#switchEbookOverride"];
      const alive = ids.filter((id) => document.querySelector(id));
      const group = [...document.querySelectorAll("#settingsOverlay .setting-group")]
        .find((el) => el.querySelector("h3")?.dataset.i18n === "settings.ebook");
      const note = group?.querySelector(".setting-note")?.dataset.i18n || "";
      const sheet = document.querySelector("#settingsOverlay .sheet");
      const body = sheet.querySelector(".sheet-body");
      const foot = sheet.querySelector(".sheet-foot");
      const sheetH = Math.round(sheet.getBoundingClientRect().height);
      return { alive, note, sheetH, winH: innerHeight,
        footInside: foot.getBoundingClientRect().bottom <= innerHeight + 1,
        scrolls: body.scrollHeight > body.clientHeight + 1 };
    })()`);
    check("通用设置里的旧电子书控件已下线，只留一行指路",
      legacy.alive.length === 0 && legacy.note === "settings.ebookMoved",
      `残留 ${legacy.alive.join(",") || "无"} · 指路 ${legacy.note || "缺失"}`);
    check("设置面板仍整屏收住（正文滚动、底栏可见）",
      legacy.footInside && legacy.scrolls && legacy.sheetH <= legacy.winH + 1,
      `面板 ${legacy.sheetH}px / 窗口 ${legacy.winH}px，底栏在窗口内 ${legacy.footInside}，正文可滚 ${legacy.scrolls}`);

    // 窗口压到 420 高再验一遍：面板必须整块收在窗口里，正文滚到底、底栏永远看得见。
    // 早先 `.sheet` 用 `height: 100%`，网格项目的百分比高度会退化成 auto，
    // 面板比窗口还高——正文没有可滚的余量，底栏直接掉到窗口外，谁也点不到「完成」
    await send(ws, "Emulation.setDeviceMetricsOverride",
      { width: 820, height: 420, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    const shortPanel = await evaluate(ws, `(() => {
      const sheet = document.querySelector("#settingsOverlay .sheet");
      const body = sheet.querySelector(".sheet-body");
      const foot = sheet.querySelector(".sheet-foot");
      const last = [...sheet.querySelectorAll(".setting-group")].pop();
      body.scrollTop = 0;
      const before = body.scrollTop;
      body.scrollTop = body.scrollHeight;
      return { winH: innerHeight,
        sheetBottom: Math.round(sheet.getBoundingClientRect().bottom),
        footBottom: Math.round(foot.getBoundingClientRect().bottom),
        scrolls: body.scrollHeight > body.clientHeight + 1,
        moved: body.scrollTop > before,
        lastInside: last.getBoundingClientRect().bottom <= body.getBoundingClientRect().bottom + 1 };
    })()`);
    check("窗口压到 420 高时设置面板仍收在窗口内，正文能滚到底",
      shortPanel.sheetBottom <= shortPanel.winH + 1 && shortPanel.footBottom <= shortPanel.winH + 1
        && shortPanel.scrolls && shortPanel.moved && shortPanel.lastInside,
      `面板底 ${shortPanel.sheetBottom} / 窗口 ${shortPanel.winH}，底栏底 ${shortPanel.footBottom}，` +
      `可滚 ${shortPanel.scrolls}，滚到底 ${shortPanel.moved}，末组可见 ${shortPanel.lastInside}`);
    await send(ws, "Emulation.clearDeviceMetricsOverride");
    await sleep(250);
    await evaluate(ws, `(async () => { (await import("/js/preferences.js")).closeSettings(); })()`);

    /* --- 打开版式面板：从工具栏的 Aa 进，且它要靠挤窄阅读区来腾位置 --- */
    const beforeOpen = await evaluate(ws, `Math.round(document.querySelector(".reader-panes").getBoundingClientRect().width)`);
    await evaluate(ws, `document.querySelector('[data-act="ebook-layout"]').click()`);
    await sleep(500);
    const opened = await evaluate(ws, `(() => {
      const panel = document.querySelector("#layoutPanel");
      const body = panel.querySelector(".lp-body");
      const foot = panel.querySelector(".lp-foot");
      const chip = panel.querySelector(".lp-chip.is-on");
      return { open: !panel.classList.contains("is-hidden"),
        width: Math.round(panel.getBoundingClientRect().width),
        panes: Math.round(document.querySelector(".reader-panes").getBoundingClientRect().width),
        preset: chip?.dataset.preset || "",
        custom: !panel.querySelector("#lpCustom").hidden,
        title: panel.querySelector("h2").textContent,
        scrolls: body.scrollHeight > body.clientHeight + 1,
        footInside: foot.getBoundingClientRect().bottom <= innerHeight + 1 };
    })()`);
    check("工具栏 Aa 打开版式面板，默认高亮「舒适中文」",
      opened.open && opened.title === "版式" && opened.preset === "comfort" && !opened.custom,
      `开 ${opened.open} · 标题 ${opened.title} · 预设 ${opened.preset || "无"} · 自定义 ${opened.custom}`);
    // 面板是挤窄阅读区，不是浮在上面：正文因此会真的重排，这才叫所见即所得
    check("面板参与布局（阅读区正好少了面板那 332px）",
      beforeOpen - opened.panes === opened.width && opened.width === 332,
      `开之前 ${beforeOpen}px，开之后 ${opened.panes}px，面板 ${opened.width}px`);
    check("面板正文自己滚、底栏留在屏内",
      opened.scrolls && opened.footInside,
      `可滚 ${opened.scrolls}，底栏在窗口内 ${opened.footInside}`);

    // 带副标题的行（版心宽度那行有「纸的最大宽度」）不能把自己的小字裁掉：
    // 行是 flex + min-height，最容易出现的塌陷就是第二行文字溢出行框
    const labelFit = await evaluate(ws, `(() => {
      const row = [...document.querySelectorAll("#layoutPanel .lp-row")].find((r) => r.querySelector("small"));
      const small = row.querySelector("small");
      const outer = row.getBoundingClientRect();
      const inner = small.getBoundingClientRect();
      return { gap: Math.round((outer.bottom - inner.bottom) * 10) / 10,
        height: Math.round(outer.height), text: small.textContent };
    })()`);
    check("带副标题的行不会把自己的小字裁掉",
      labelFit.gap >= 0 && labelFit.height >= 30,
      `「${labelFit.text}」距行底 ${labelFit.gap}px，行高 ${labelFit.height}px`);

    // 滑杆的填充与数值必须对得上：填充是按 (值-下限)/(上限-下限) 算的，
    // 算错就会出现「数值 0、滑块却贴在最左」这种自相矛盾的界面
    const sliderFill = await evaluate(ws, `(() => {
      const input = document.querySelector("#layoutPanel [data-range='letter']");
      return { value: input.value, fill: input.style.getPropertyValue("--_fill") };
    })()`);
    check("滑杆填充与数值一致（0 在 [-0.5, 2] 的五分之一处）",
      Number(sliderFill.value) === 0.25 && sliderFill.fill === "30%",
      `值 ${sliderFill.value} · 填充 ${sliderFill.fill || "未设置"}`);

    /* --- 窄窗口：面板退回抽屉 + 遮罩，不再挤占阅读区 --- */
    await send(ws, "Emulation.setDeviceMetricsOverride",
      { width: 900, height: 780, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    const narrow = await evaluate(ws, `(() => {
      const panel = document.querySelector("#layoutPanel");
      const scrim = document.querySelector("#layoutScrim");
      const style = getComputedStyle(panel);
      const scrimStyle = getComputedStyle(scrim);
      return { position: style.position, width: Math.round(panel.getBoundingClientRect().width),
        scrimOn: scrim.classList.contains("is-on"), scrimShown: scrimStyle.display !== "none",
        scrimOpacity: Number(scrimStyle.opacity),
        right: Math.round(innerWidth - panel.getBoundingClientRect().right) };
    })()`);
    check("窄窗口下面板浮成右侧抽屉并压一层遮罩",
      narrow.position === "absolute" && narrow.right <= 1 && narrow.width <= 332
        && narrow.scrimShown && narrow.scrimOn && narrow.scrimOpacity > 0.5,
      `${narrow.position} · 宽 ${narrow.width} · 贴右 ${narrow.right}px · 遮罩显示 ${narrow.scrimShown}/${narrow.scrimOpacity}`);
    // 点遮罩就收起来
    await evaluate(ws, `document.querySelector("#layoutScrim").click()`);
    await sleep(300);
    const closedByScrim = await evaluate(ws, `document.querySelector("#layoutPanel").classList.contains("is-hidden")`);
    check("点遮罩收起面板", closedByScrim === true, String(closedByScrim));
    await evaluate(ws, `document.querySelector('[data-act="ebook-layout"]').click()`);
    await send(ws, "Emulation.clearDeviceMetricsOverride");
    await sleep(400);

    /* --- 预设：整组回填 + 反推出「自定义」 --- */
    await evaluate(ws, `document.querySelector('#layoutPanel [data-preset="latin"]').click()`);
    await sleep(900);
    frameCtx = await blobFrameContext(ws);
    const latinTypo = await evaluate(ws, typoOf, frameCtx);
    const latinPanel = await evaluate(ws, `(() => {
      const panel = document.querySelector("#layoutPanel");
      const on = (sel) => panel.querySelector(sel + " .is-on")?.dataset[
        Object.keys(panel.querySelector(sel + " .is-on")?.dataset || {})[0]] || "";
      return { preset: panel.querySelector(".lp-chip.is-on")?.dataset.preset || "",
        custom: !panel.querySelector("#lpCustom").hidden,
        family: on("#lpFamily"), align: on("#lpAlign"), brk: on("#lpBreak"),
        size: panel.querySelector("[data-val='size']").textContent };
    })()`);
    check("点「西文衬线」整组回填（左对齐 + 连字符开 + 标点挤压关）",
      latinPanel.preset === "latin" && !latinPanel.custom && latinPanel.align === "left"
        && latinPanel.brk === "space" && latinPanel.size === "17" && latinTypo.pAlign === "left",
      `预设 ${latinPanel.preset} · 对齐 ${latinPanel.align} · 分段 ${latinPanel.brk} · 字号 ${latinPanel.size} · 书内 ${latinTypo.pAlign}`);

    await evaluate(ws, `document.querySelector('#layoutPanel [data-step="1"]').click()`);
    await sleep(300);
    const custom = await evaluate(ws, `(() => {
      const panel = document.querySelector("#layoutPanel");
      return { preset: panel.querySelector(".lp-chip.is-on")?.dataset.preset || "",
        custom: !panel.querySelector("#lpCustom").hidden,
        size: panel.querySelector("[data-val='size']").textContent };
    })()`);
    check("手改一项就变成「自定义」，不再挂着旧预设",
      custom.preset === "" && custom.custom && custom.size === "18",
      `预设 ${custom.preset || "无"} · 自定义可见 ${custom.custom} · 字号 ${custom.size}`);

    /* --- 缩进与段距互斥 --- */
    const breakModes = await evaluate(ws, `(() => {
      const panel = document.querySelector("#layoutPanel");
      const p = () => getComputedStyle(document.querySelector(".ebook-stack") || document.body);
      panel.querySelector('[data-break="indent"]').click();
      const indent = { wrapHidden: panel.querySelector("#lpParaWrap").hidden,
        val: panel.querySelector("[data-val='para']").textContent };
      panel.querySelector('[data-break="space"]').click();
      const space = { wrapHidden: panel.querySelector("#lpParaWrap").hidden,
        val: panel.querySelector("[data-val='para']").textContent };
      panel.querySelector('[data-break="none"]').click();
      const none = { wrapHidden: panel.querySelector("#lpParaWrap").hidden };
      return { indent, space, none };
    })()`);
    check("分段方式三选一，段距滑杆只在「段间距」下露出来",
      breakModes.indent.wrapHidden && !breakModes.space.wrapHidden
        && Number(breakModes.space.val) > 0 && breakModes.none.wrapHidden,
      `缩进 ${breakModes.indent.wrapHidden ? "藏" : "露"} · 段距 ${breakModes.space.wrapHidden ? "藏" : `露(${breakModes.space.val})`} · 无 ${breakModes.none.wrapHidden ? "藏" : "露"}`);

    /* --- 生效链路：CSS 走注入，页面参数走分页器属性 --- */
    await evaluate(ws, `document.querySelector('#layoutPanel [data-break="indent"]').click()`);
    await sleep(900);
    frameCtx = await blobFrameContext(ws);
    const applied = await evaluate(ws, typoOf, frameCtx);
    check("注入的样式表带上了字号与缩进（不是只改了面板上的数字）",
      applied.css.includes("font-size: 18px") && applied.css.includes("text-indent: 2em"),
      applied.css.includes("font-size: 18px") ? "含 font-size: 18px + text-indent: 2em" : `未见新规则：${applied.css.slice(0, 90)}`);

    const pageParams = await evaluate(ws, `(async () => {
      const mod = await import("/js/reader/panes.js");
      const renderer = mod.activePane()?.ebook?.view?.renderer;
      return { margin: renderer?.getAttribute("margin") || "",
        measure: renderer?.getAttribute("max-inline-size") || "",
        gap: renderer?.getAttribute("gap") || "" };
    })()`);
    check("页边距 / 版心宽度 / 列间距落到分页器属性",
      pageParams.margin === "48px" && pageParams.measure === "640px" && pageParams.gap === "8%",
      `margin ${pageParams.margin || "无"} · max-inline-size ${pageParams.measure || "无"} · gap ${pageParams.gap || "无"}`);

    /* --- 覆盖配色依赖覆盖排版 --- */
    /* --- 配色覆盖独立于排版覆盖，且默认开 --- */
    const beforeOverride = await evaluate(ws, `(async () => {
      const panel = document.querySelector("#layoutPanel");
      const color = panel.querySelector("[data-switch='overrideColor']");
      const typo = panel.querySelector("[data-switch='override']");
      const mod = await import("/js/reader/ebook-layout.js");
      const { state } = await import("/js/core/session.js");
      return { colorOn: color.classList.contains("is-on"), colorDisabled: color.disabled,
        typoOn: typo.classList.contains("is-on"),
        resolved: mod.readLayout(state.settings).overrideColor };
    })()`);
    check("配色覆盖默认开、不依赖排版覆盖（夜读下书里写死的深色字才读得清）",
      beforeOverride.colorOn && !beforeOverride.colorDisabled && !beforeOverride.typoOn
        && beforeOverride.resolved === true,
      `配色覆盖 ${beforeOverride.colorOn}/禁用 ${beforeOverride.colorDisabled} · 排版覆盖 ${beforeOverride.typoOn}`);

    // 关掉配色覆盖：字色回到书里自己的（#333），排版覆盖仍是关的
    await evaluate(ws, `document.querySelector("#layoutPanel [data-switch='overrideColor']").click()`);
    await sleep(1200);
    frameCtx = await blobFrameContext(ws);
    const ownColor = await evaluate(ws, typoOf, frameCtx);
    const appInk = await evaluate(ws, `getComputedStyle(document.body).color`);
    check("关掉配色覆盖后字色回到书里自己的",
      ownColor.color !== appInk,
      `字色 ${ownColor.color}（应用 ${appInk}）/ 底色 ${ownColor.bg}`);

    // 再打开：字色被压成主题色、底色交还给容器
    await evaluate(ws, `document.querySelector("#layoutPanel [data-switch='overrideColor']").click()`);
    await sleep(1200);
    frameCtx = await blobFrameContext(ws);
    const forced = await evaluate(ws, typoOf, frameCtx);
    check("打开配色覆盖把书内字色与底色交给主题",
      forced.color === appInk && forced.bg === "rgba(0, 0, 0, 0)",
      `字色 ${forced.color}（应用 ${appInk}）/ 底色 ${forced.bg}`);

    // 排版覆盖此时仍是关的：字色被接管、字体字号还是书里的
    const typoStillOff = await evaluate(ws, `(() => document.querySelector("#layoutPanel [data-switch='override']").classList.contains("is-on"))()`);
    check("配色覆盖与排版覆盖互不影响", typoStillOff === false, `排版覆盖 ${typoStillOff}`);

    await sleep(400);
    await shot(ws, "ebook-layout-panel");
    const saved = await evaluate(ws, `window.__saved || null`);
    check("版式写进偏好并落盘（新增字段一个不少）",
      Boolean(saved) && saved.ebookFontSize === 18 && saved.ebookFamily === "serif"
        && saved.ebookAlign === "left" && saved.ebookIndent === 2
        && saved.ebookLetterSpacing === 0 && saved.ebookMeasure === 640
        && saved.ebookGap === 8 && saved.ebookOverride === false && saved.ebookOverrideColor === true,
      saved ? `字号 ${saved.ebookFontSize} 字距 ${saved.ebookLetterSpacing} 缩进 ${saved.ebookIndent}`
        + ` 版心 ${saved.ebookMeasure} 列距 ${saved.ebookGap} 覆盖 ${saved.ebookOverride}/${saved.ebookOverrideColor}`
        : "未调用 save_settings");

    // 旧 state.json 里没有这些字段，容器级 serde(default) 靠前端这份默认值兜底：
    // 少一个键，升级后第一次打开电子书就会把 undefined 写进样式
    const defaults = await evaluate(ws, `(async () => {
      const mod = await import("/js/core/constants.js");
      const keys = ["ebookFontSize", "ebookLineHeight", "ebookMargin", "ebookFamily", "ebookAlign",
        "ebookOverride", "ebookLetterSpacing", "ebookIndent", "ebookParaSpacing", "ebookMeasure",
        "ebookGap", "ebookHyphenate", "ebookPunctuate", "ebookSpread", "ebookOverrideColor"];
      const missing = keys.filter((key) => mod.DEFAULT_SETTINGS[key] === undefined);
      return { missing, count: keys.length - missing.length, total: keys.length };
    })()`);
    check("默认设置补齐全部版式字段（旧配置升级不受影响）",
      defaults.missing.length === 0 && defaults.count === defaults.total,
      defaults.missing.length ? `缺 ${defaults.missing.join(",")}` : `${defaults.count}/${defaults.total}`);

    // 固定版面（CBZ）下面板要整体禁用并给出说明，值仍照存
    await evaluate(ws, `(async () => { (await import("/js/reader/ebook-layout-panel.js")).setLayoutPanel(false); })()`);

    /* --- P4：FB2 / CBZ（固定版面）/ 带 DRM 的 EPUB --- */
    // 设置面板前面留在打开状态，先关掉，否则遮罩挡住书架的点击
    await evaluate(ws, `(async () => { (await import("/js/preferences.js")).closeSettings(); })()`);

    const switchBook = async (id) => {
      await evaluate(ws, `document.querySelector("#backBtn").click()`);
      await sleep(400);
      await evaluate(ws, `document.querySelector('#bookList .book-row[data-book="${id}"]').click()`);
    };

    await switchBook("b-fb2");
    await waitFor(ws, `(async () => {
      const mod = await import("/js/reader/panes.js");
      return mod.activePane()?.ebook?.format === "fb2" && Boolean(mod.activePane()?.ebook?.location?.cfi);
    })()`, "FB2 打开", 20000);
    await sleep(600);
    const fb2 = await evaluate(ws, `(async () => {
      const mod = await import("/js/reader/panes.js");
      const pane = mod.activePane();
      return { format: pane?.ebook?.format || "", fixed: Boolean(pane?.ebook?.fixed),
        chapters: pane?.ebook?.chapters || 0, title: pane?.book?.title || "",
        toc: (pane?.ebookToc || []).map((item) => item.label),
        sub: document.querySelector("#docSub")?.textContent || "" };
    })()`);
    check("FB2 打开：目录两章、角标写 FB2、书名读自 XML",
      fb2.format === "fb2" && fb2.chapters === 2 && fb2.title === "冒烟 FB2"
        && fb2.toc[0] === "第一章 起点" && /^FB2 · 2 章/.test(fb2.sub),
      `${fb2.format} · ${fb2.chapters} 章 · 「${fb2.title}」· ${fb2.sub}`);

    frameCtx = await blobFrameContext(ws);
    const fb2Body = await evaluate(ws, `(() => ({
      text: document.body.innerText.replace(/\\s+/g, "").slice(0, 40),
      scripts: document.querySelectorAll("script").length,
    }))()`, frameCtx);
    check("FB2 正文渲染出来且不带脚本",
      /第一章起点/.test(fb2Body.text) && fb2Body.scripts === 0,
      `${fb2Body.text.slice(0, 16)}… · script ${fb2Body.scripts}`);

    // MOBI：正文来自文件本身，且第一章里塞了 <script>，靠 hardenBook 在读回后洗掉
    await switchBook("b-mobi");
    await waitFor(ws, `(async () => {
      const mod = await import("/js/reader/panes.js");
      return mod.activePane()?.ebook?.format === "mobi" && Boolean(mod.activePane()?.ebook?.location?.cfi);
    })()`, "MOBI 打开", 20000);
    await sleep(700);
    const mobi = await evaluate(ws, `(async () => {
      const mod = await import("/js/reader/panes.js");
      const pane = mod.activePane();
      return { format: pane?.ebook?.format || "", chapters: pane?.ebook?.chapters || 0,
        title: pane?.book?.title || "",
        toc: (pane?.ebookToc || []).map((item) => item.label),
        sub: document.querySelector("#docSub")?.textContent || "" };
    })()`);
    check("MOBI 打开：书名与目录都读自 PalmDB/MOBI 头",
      mobi.format === "mobi" && mobi.title === "冒烟 MOBI" && mobi.toc.length === 2
        && mobi.toc[0] === "第一章 起点" && /^MOBI · 2 章/.test(mobi.sub),
      `${mobi.format} · 「${mobi.title}」· ${mobi.toc.join("/")} · ${mobi.sub}`);

    // 首屏是目录页，先跳到第一章，正文与「脚本没执行」才有对象可验
    await evaluate(ws, `(async () => {
      const mod = await import("/js/reader/panes.js");
      const pane = mod.activePane();
      const first = (pane?.ebookToc || [])[0];
      if (first) await pane.ebook.goTo(first.href);
    })()`);
    await sleep(1200);
    frameCtx = await blobFrameContext(ws);
    const mobiBody = await evaluate(ws, `(() => ({
      // 那句唯一的正文在章末，取整段来看；截断只用在这条断言的说明文字上
      text: document.body.innerText.replace(/\\s+/g, ""),
      scripts: document.querySelectorAll("script").length,
    }))()`, frameCtx);
    const mobiPwned = await evaluate(ws, `window.__mobiPwned ?? null`);
    check("MOBI 正文渲染出来，书内脚本没被执行",
      mobiBody.text.includes("檐下听雨") && mobiBody.scripts === 0 && mobiPwned === null,
      `${mobiBody.text.slice(0, 20)}… script ${mobiBody.scripts} · __mobiPwned ${String(mobiPwned)}`);

    // CBZ：固定版面，页序按文件名里的数字走
    await switchBook("b-cbz");
    await waitFor(ws, `(async () => {
      const mod = await import("/js/reader/panes.js");
      return mod.activePane()?.ebook?.format === "cbz" && Boolean(mod.activePane()?.ebook?.location?.cfi);
    })()`, "CBZ 打开", 20000);
    await sleep(600);
    const cbz = await evaluate(ws, `(async () => {
      const mod = await import("/js/reader/panes.js");
      const pane = mod.activePane();
      const spread = document.querySelector('[data-act="ebook-spread"]');
      return { format: pane?.ebook?.format || "", fixed: Boolean(pane?.ebook?.fixed),
        pages: pane?.ebook?.chapters || 0, sub: document.querySelector("#docSub")?.textContent || "",
        spreadHidden: spread ? spread.hidden : null };
    })()`);
    check("CBZ 按固定版面打开，副标题数页而不是章",
      cbz.fixed && cbz.pages === 3 && /^CBZ · 3 页/.test(cbz.sub),
      `${cbz.format} · 固定 ${cbz.fixed} · ${cbz.pages} 页 · ${cbz.sub}`);
    check("固定版面下不显示单双页按钮", cbz.spreadHidden === true, String(cbz.spreadHidden));

    // 版式面板对固定版面无能为力：整块禁用 + 顶部说明，而不是让人白调半天
    await evaluate(ws, `document.querySelector('[data-act="ebook-layout"]').click()`);
    await sleep(500);
    const fixedPanel = await evaluate(ws, `(() => {
      const panel = document.querySelector("#layoutPanel");
      const notice = panel.querySelector("#lpNotice");
      const range = panel.querySelector("[data-range='measure']");
      const body = panel.querySelector(".lp-body");
      // 计算出的 opacity 是元素自己的，子元素不会继承成 0.42，所以量分组这一层
      const row = panel.querySelector(".lp-group");
      return { open: !panel.classList.contains("is-hidden"),
        disabled: panel.classList.contains("is-fixed"),
        noticeShown: !notice.hidden,
        rangeDisabled: range.disabled,
        sub: panel.querySelector("#lpSub").textContent,
        rowOpacity: Number(getComputedStyle(row).opacity),
        rowPe: getComputedStyle(row).pointerEvents };
    })()`);
    check("固定版面上版式面板整体禁用并给出说明",
      fixedPanel.open && fixedPanel.disabled && fixedPanel.noticeShown && fixedPanel.rangeDisabled
        && fixedPanel.rowPe === "none" && fixedPanel.rowOpacity < 0.5
        && /固定版面/.test(fixedPanel.sub),
      `禁用 ${fixedPanel.disabled} · 说明 ${fixedPanel.noticeShown} · 滑杆禁用 ${fixedPanel.rangeDisabled} `
        + `· 行不可点 ${fixedPanel.rowPe}/${fixedPanel.rowOpacity}`);

    // 漫画的目录条目原本是图片文件名，界面上应当是人读的页码
    const cbzToc = await evaluate(ws, `(async () => {
      const mod = await import("/js/reader/panes.js");
      return (mod.activePane()?.ebookToc || []).map((item) => item.label);
    })()`);
    check("漫画目录显示页码而不是图片文件名",
      cbzToc.length === 3 && cbzToc[0] === "第 1 页" && cbzToc[2] === "第 3 页",
      cbzToc.join(" / ") || "空");

    frameCtx = await blobFrameContext(ws);
    const cbzPage = await evaluate(ws, `(() => {
      const img = document.querySelector("img");
      const rect = img?.getBoundingClientRect();
      return { images: document.querySelectorAll("img").length,
        // 图片解码出 600×900，页面按固有尺寸排版，画在屏上的宽度应当接近阅读区宽度
        natural: img ? [img.naturalWidth, img.naturalHeight] : [0, 0],
        width: Math.round(rect?.width || 0), height: Math.round(rect?.height || 0) };
    })()`, frameCtx);
    await shot(ws, "ebook-cbz");
    check("漫画页在 iframe 里按整页画出图片",
      cbzPage.images === 1 && cbzPage.natural[0] === 600 && cbzPage.width > 200
        && cbzPage.height / cbzPage.width > 1.3,
      `${cbzPage.images} 张，源 ${cbzPage.natural.join("×")}，画在 ${cbzPage.width}×${cbzPage.height}`);

    /* ---- 划线批注与图片放大 ---- */

    await switchBook("b-epub");
    await waitFor(ws, `(async () => {
      const mod = await import("/js/reader/panes.js");
      return Boolean(mod.activePane()?.ebook?.location?.cfi);
    })()`, "回到 EPUB 划线", 20000);
    // 先落到第一章：那里有脚注与够长的正文，划得开
    await evaluate(ws, `(async () => {
      const mod = await import("/js/reader/panes.js");
      await mod.activePane()?.ebook?.goTo("OEBPS/ch1.xhtml");
    })()`);
    await sleep(1200);

    // 在章节 iframe 里造一个真选区再派发 mouseup：手势层就是这么收线的
    frameCtx = await blobFrameContext(ws);
    const hlText = await evaluate(ws, `(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node = null;
      while ((node = walker.nextNode())) {
        if (node.textContent.replace(/\\s/g, "").length >= 12) break;
      }
      if (!node) return "";
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, Math.min(12, node.textContent.length));
      const selection = document.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
      return range.toString();
    })()`, frameCtx);
    await sleep(320);
    const hlSwatch = await evaluate(ws, `(() => {
      const box = document.querySelector("#hlMenu");
      return { open: Boolean(box && !box.hidden),
        dots: box ? box.querySelectorAll("[data-hl-color]").length : 0,
        remove: Boolean(box && box.querySelector("[data-hl-remove]")) };
    })()`);
    await shot(ws, "ebook-hlmenu");
    check("选中正文弹出取色小窗（五个颜色，未划过的没有删除项）",
      Boolean(hlText) && hlSwatch.open && hlSwatch.dots === 5 && !hlSwatch.remove,
      `选中「${hlText}」· ${hlSwatch.dots} 个色点`);

    await evaluate(ws, `document.querySelector('#hlMenu [data-hl-color="indigo"]').click()`);
    await sleep(700);
    const hlDrawn = await evaluate(ws, `(async () => {
      const mod = await import("/js/reader/panes.js");
      const pane = mod.activePane();
      const first = (pane?.book?.highlights || [])[0] || {};
      const parts = pane?.ebook?.view?.renderer?.getContents?.() || [];
      const svg = parts.find((item) => item.overlayer)?.overlayer?.element;
      const group = svg?.querySelector("g");
      return { count: (pane?.book?.highlights || []).length, color: first.color || "",
        cfi: first.cfi || "", text: first.text || "",
        rects: group ? group.querySelectorAll("rect").length : 0,
        fill: group?.getAttribute("fill") || "",
        menu: Boolean(document.querySelector("#hlMenu") && !document.querySelector("#hlMenu").hidden) };
    })()`);
    await shot(ws, "ebook-highlight");
    check("选色之后划线落盘，并画在正文上（颜色与矩形都对）",
      hlDrawn.count === 1 && hlDrawn.color === "indigo" && hlDrawn.cfi.startsWith("epubcfi(")
        && hlDrawn.rects > 0 && hlDrawn.fill === "#6a7bb8" && !hlDrawn.menu,
      `${hlDrawn.count} 条 · ${hlDrawn.color} · ${hlDrawn.rects} 个矩形 · ${hlDrawn.fill}`);

    await evaluate(ws, `document.querySelector('#ctxTabs [data-ctx="notes"]').click()`);
    await sleep(400);
    const notePane = await evaluate(ws, `(() => ({
      rows: document.querySelectorAll("#ctxBody [data-note-hit]").length,
      dot: Boolean(document.querySelector("#ctxBody .note-dot")),
      label: (document.querySelector("#ctxBody .hit-page")?.textContent || "").trim(),
      text: (document.querySelector("#ctxBody .mark-main")?.textContent || "").trim().slice(0, 16),
    }))()`);
    check("侧栏「划线」页列出条目：颜色点 + 章节名 + 原文",
      notePane.rows === 1 && notePane.dot && /第一章/.test(notePane.label) && notePane.text.length > 0,
      `${notePane.rows} 行 · ${notePane.label} · 「${notePane.text}…」`);

    /* ---- 摘录导出 ---- */
    const tools = await evaluate(ws, `(() => ({
      buttons: document.querySelectorAll("#ctxBody .mark-tools .mark-tool").length,
      labels: [...document.querySelectorAll("#ctxBody .mark-tool")].map((b) => b.textContent.trim()),
      insideHead: Boolean(document.querySelector("#ctxBody .mark-count .mark-tools")),
    }))()`);
    check("划线页计数行右侧出现「复制 / 导出」",
      tools.buttons === 2 && tools.insideHead, tools.labels.join(" / ") || "没有按钮");

    await evaluate(ws, `document.querySelector("#ctxBody [data-export-marks]").click()`);
    await sleep(600);
    const exported = await evaluate(ws, `window.__exported || null`);
    const md = exported?.content || "";
    check("导出交出整份摘录：标题、计数、引用块与出处行",
      exported?.name === "冒烟样本-摘录.md"
        && /^# 冒烟样本$/m.test(md)
        && /1 条划线/.test(md)
        && /^## 划线$/m.test(md)
        && /^> /m.test(md)
        && /^—— .*第一章.*靛青$/m.test(md)
        // 这本书没有书签，就不该出现空的书签小节
        && !/^## 书签$/m.test(md),
      `${exported?.name || "未触发"} · ${md.split("\n").length} 行`);

    // 复制走同一份内容：这里替换掉 navigator.clipboard，避免无头环境里权限不可用
    await evaluate(ws, `(() => {
      window.__copied = null;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: (text) => { window.__copied = text; return Promise.resolve(); } },
      });
      document.querySelector("#ctxBody [data-copy-marks]").click();
    })()`);
    await sleep(400);
    const copied = await evaluate(ws, `window.__copied`);
    check("复制与导出是同一份内容", Boolean(copied) && copied === md,
      copied ? `${copied.split("\n").length} 行，与导出${copied === md ? "一致" : "不一致"}` : "没写进剪贴板");

    // 纯函数边界：多行原文的块级转义、无时间的书签、非法文件名、空摘录
    const pure = await evaluate(ws, `(async () => {
      const mod = await import("/js/reader/export-marks.js");
      const md = mod.buildMarksMarkdown({
        title: "边界样本", author: "某人",
        bookmarks: [{ cfi: "m1", label: "第三章", createdAt: 0 }],
        highlights: [{ cfi: "h1", text: "- 列表开头\\n# 标题开头\\n普通行", color: "amber", label: "" }],
      }, { now: new Date(2026, 10, 19, 14, 30) });
      return { md, name: mod.suggestFileName({ title: "A/B: C" }),
        none: mod.hasMarks({ highlights: [], bookmarks: [] }) };
    })()`);
    check("多行原文按引用块转义，书签缺时间不补空行，文件名滤掉非法字符",
      /^> \\- 列表开头$/m.test(pure.md)
        && /^> \\# 标题开头$/m.test(pure.md)
        && /^> 普通行$/m.test(pure.md)
        // 没有章节名的划线落到「正文」，不是空字符串
        && /^—— 正文 .*琥珀$/m.test(pure.md)
        && /^## 书签$/m.test(pure.md)
        && /^- 第三章$/m.test(pure.md)
        && /导出于 2026-11-19 14:30/.test(pure.md)
        && pure.name === "A B C-摘录.md"
        && pure.none === false,
      `${pure.name} · ${pure.md.split("\n").length} 行`);

    // 点列表里的条目：跳过去，并把那条的色板浮出来（带删除）
    await evaluate(ws, `document.querySelector("#ctxBody [data-note-hit]").click()`);
    await sleep(900);
    const hlAgain = await evaluate(ws, `(() => {
      const box = document.querySelector("#hlMenu");
      if (!box || box.hidden) return { open: false };
      return { open: true, remove: Boolean(box.querySelector("[data-hl-remove]")),
        on: box.querySelector(".hl-dot.is-on")?.dataset.hlColor || "" };
    })()`);
    check("点侧栏条目跳到那条划线并浮出它的色板",
      hlAgain.open && hlAgain.remove && hlAgain.on === "indigo",
      hlAgain.open ? `当前色 ${hlAgain.on}` : "没弹出来");

    await evaluate(ws, `document.querySelector("#hlMenu [data-hl-remove]").click()`);
    await sleep(700);
    const hlGone = await evaluate(ws, `(async () => {
      const mod = await import("/js/reader/panes.js");
      const pane = mod.activePane();
      const parts = pane?.ebook?.view?.renderer?.getContents?.() || [];
      const svg = parts.find((item) => item.overlayer)?.overlayer?.element;
      return { count: (pane?.book?.highlights || []).length,
        rects: svg ? svg.querySelectorAll("g rect").length : 0,
        rows: document.querySelectorAll("#ctxBody [data-note-hit]").length };
    })()`);
    check("删掉之后正文与侧栏一起清掉",
      hlGone.count === 0 && hlGone.rects === 0 && hlGone.rows === 0,
      `${hlGone.count} 条 · ${hlGone.rects} 个矩形 · ${hlGone.rows} 行`);

    // 摘录清空之后，两个页签都不该再摆出「导出 / 复制」——空列表上挂着必然失败的按钮最误导
    const notesTools = await evaluate(ws, `(() => {
      const count = document.querySelectorAll("#ctxBody .mark-tools").length;
      document.querySelector('#ctxTabs [data-ctx="marks"]').click();
      return count;
    })()`);
    await sleep(400);
    const marksTools = await evaluate(ws, `(async () => {
      const toolsRow = document.querySelectorAll("#ctxBody .mark-tools").length;
      document.querySelector('#ctxTabs [data-ctx="notes"]').click();
      return toolsRow;
    })()`);
    check("没有摘录时两个页签都不显示导出入口",
      notesTools === 0 && marksTools === 0, `划线页 ${notesTools} · 书签页 ${marksTools}`);

    /* ---- 图片放大 ---- */
    await switchBook("b-cbz");
    await waitFor(ws, `(async () => {
      const mod = await import("/js/reader/panes.js");
      return mod.activePane()?.ebook?.format === "cbz" && Boolean(mod.activePane()?.ebook?.location?.cfi);
    })()`, "CBZ 打开（图片放大）", 20000);
    await sleep(700);
    const cfiBefore = await evaluate(ws, `(async () => {
      const mod = await import("/js/reader/panes.js");
      return mod.activePane()?.ebook?.location?.cfi || "";
    })()`);
    frameCtx = await blobFrameContext(ws);
    await evaluate(ws, `document.querySelector("img").click()`, frameCtx);
    await sleep(500);
    const hlLight = await evaluate(ws, `(() => {
      const box = document.querySelector("#imgView");
      const img = box?.querySelector("img");
      return { open: Boolean(box && !box.hidden),
        src: (img?.getAttribute("src") || "").slice(0, 5), natural: img?.naturalWidth || 0,
        hint: (box?.querySelector(".img-view-hint")?.textContent || "") };
    })()`);
    await shot(ws, "ebook-image");
    check("点漫画页把图放大到整屏（不是把 iframe 再排一次版）",
      hlLight.open && hlLight.src === "blob:" && hlLight.natural === 600 && hlLight.hint.length > 0,
      `${hlLight.natural}px · ${hlLight.hint}`);
    const cfiAfter = await evaluate(ws, `(async () => {
      const mod = await import("/js/reader/panes.js");
      return mod.activePane()?.ebook?.location?.cfi || "";
    })()`);
    check("点图片不翻页", cfiAfter === cfiBefore, `${cfiBefore} → ${cfiAfter}`);

    await evaluate(ws, `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
    await sleep(250);
    const imgClosed = await evaluate(ws, `document.querySelector("#imgView")?.hidden ?? null`);
    check("Esc 关掉放大视图", imgClosed === true, String(imgClosed));

    // DRM：拦下并说清是哪一种方案
    await switchBook("b-drm");
    await sleep(1600);
    const drm = await evaluate(ws, `(async () => {
      const mod = await import("/js/reader/panes.js");
      const pane = mod.activePane();
      // 错误卡片就画在阅读区里（ebookOpen 的 catch 分支），没有挂上 foliate-view
      const card = document.querySelector(".ebook-stack .pdf-error");
      // 打不开的书没有页可翻：翻页/进度条/书签都不该占着位置
      const acts = [...document.querySelectorAll("#readToolbar [data-act]")].map((el) => el.dataset.act);
      return { message: card?.textContent || "", mounted: Boolean(pane?.ebook?.book),
        views: document.querySelectorAll(".ebook-stack foliate-view").length,
        acts, slider: Boolean(document.querySelector("#ebookSlider")),
        empty: (document.querySelector("#ctxBody .ctx-empty")?.textContent || "").replace(/\s+/g, " ") };
    })()`);
    await shot(ws, "ebook-drm");
    check("带 DRM 的 EPUB 被拦下并说明方案",
      /DRM/.test(drm.message) && /ADEPT/.test(drm.message) && !drm.mounted && drm.views === 0,
      drm.message.replace(/\s+/g, " ").slice(0, 60) || "没有提示");
    check("打不开的书不摆翻页与书签按钮",
      !drm.slider && !drm.acts.some((act) => /^ebook-(prev|next|mark|spread)$/.test(act))
        && drm.acts.includes("ctx"),
      `剩 ${drm.acts.join("/") || "空工具栏"}${drm.slider ? "，还有进度条" : ""}`);
    check("打不开的书侧栏也不说「用方向键翻页」",
      /没能打开/.test(drm.empty) && !/方向键/.test(drm.empty), drm.empty || "空态没出现");

    // 坏文件：扩展名对、内容不对，要说「损坏」而不是甩一段 zip.js 的英文
    await switchBook("b-broken");
    await sleep(1400);
    const broken = await evaluate(ws, `(() => ({
      message: (document.querySelector(".ebook-stack .pdf-error")?.textContent || "").replace(/\s+/g, " "),
      views: document.querySelectorAll(".ebook-stack foliate-view").length,
    }))()`);
    check("截断的 EPUB 说成「文件不完整」而不是解析器原话",
      /损坏|不完整/.test(broken.message) && broken.views === 0, broken.message.slice(0, 60) || "没有提示");

    // 改后缀的假书：连 zip 都不是，说法要落到「不是能读的格式」
    await switchBook("b-notzip");
    await sleep(1400);
    const notzip = await evaluate(ws, `(() => ({
      message: (document.querySelector(".ebook-stack .pdf-error")?.textContent || "").replace(/\s+/g, " "),
      views: document.querySelectorAll(".ebook-stack foliate-view").length,
    }))()`);
    check("改了后缀的假书说成「不是能读的格式」",
      /不是能读的 EPUB/.test(notzip.message) && notzip.views === 0, notzip.message.slice(0, 60) || "没有提示");

    // 大文件：读取之前就按体积拦下
    await switchBook("b-bigebook");
    await sleep(1200);
    const tooBig = await evaluate(ws, `(() => ({
      message: (document.querySelector(".ebook-stack .pdf-error")?.textContent || "").replace(/\s+/g, " "),
      views: document.querySelectorAll(".ebook-stack foliate-view").length,
    }))()`);
    check("超过体积上限的书在读取前就被拦下",
      /512(\.0)? MB/.test(tooBig.message) && tooBig.views === 0, tooBig.message.slice(0, 60) || "没有提示");

    errs = await errors();
    check("电子书阅读无未捕获异常", errs.length === 0, errs.join(" | "));

    /* --- 更新安装提示：非模态卡片，可稍后，点立即安装才走安装命令 --- */
    await evaluate(ws, `(async () => {
      const mod = await import("/js/update-ui.js");
      mod.updater.release = { version: "9.9.9", assetUrl: "https://example.com/x.exe", assetSize: 1,
        pageUrl: "https://example.com", publishedAt: new Date().toISOString() };
      mod.updater.installerPath = "C:/tmp/yuejian-setup.exe";
      mod.updater.phase = "ready";
      mod.showInstallPrompt();
    })()`);
    const prompt = await evaluate(ws, `(() => {
      const el = document.getElementById("installPrompt");
      return { hidden: el.hidden, title: document.getElementById("installPromptTitle").textContent,
        modal: el.getAttribute("aria-modal") };
    })()`);
    check("下载完成后弹出安装提示", prompt.hidden === false && prompt.title.includes("9.9.9"), `标题 "${prompt.title}"`);
    // 非模态：没有 aria-modal、没有遮罩层、不抢焦点，阅读可以继续
    const nonModal = await evaluate(ws, `(() => {
      const el = document.getElementById("installPrompt");
      return {
        nonModal: el.getAttribute("aria-modal") === null,
        noOverlay: document.getElementById("confirmOverlay").hidden === true,
        noFocus: document.activeElement.id !== "installPromptInstall",
      };
    })()`);
    check("安装提示不打断当前使用（非模态、不抢焦点、无遮罩）",
      nonModal.nonModal && nonModal.noOverlay && nonModal.noFocus,
      `非模态=${nonModal.nonModal} 无遮罩=${nonModal.noOverlay} 未抢焦点=${nonModal.noFocus}`);

    // 卡片确实被样式表接管了（不是靠 display:none 蒙过去的空壳），且贴在右下角
    const look = await evaluate(ws, `(() => {
      const el = document.getElementById("installPrompt");
      const css = getComputedStyle(el);
      return { position: css.position, display: css.display, width: Math.round(parseFloat(css.width)),
        right: css.right, bottom: css.bottom, bg: css.backgroundColor };
    })()`);
    check("安装提示已按右下角卡片样式渲染",
      look.position === "fixed" && look.display === "flex" && look.width > 240 && look.right === "20px",
      `${look.position}/${look.display} ${look.width}px right=${look.right} bottom=${look.bottom}`);

    await evaluate(ws, `document.getElementById("installPromptLater").click()`);
    const afterLater = await evaluate(ws, `document.getElementById("installPrompt").hidden`);
    check("点「稍后再说」收起提示", afterLater === true);

    await evaluate(ws, `(async () => {
      (await import("/js/update-ui.js")).showInstallPrompt();
    })()`);
    await evaluate(ws, `(async () => {
      document.getElementById("installPromptInstall").click();
    })()`);
    const afterInstall = await evaluate(ws, `(() => ({
      hidden: document.getElementById("installPrompt").hidden,
      called: window.__calls.includes("install_update"),
    }))()`);
    check("点「立即安装」收起提示并调用安装命令", afterInstall.hidden === true && afterInstall.called === true,
      `hidden=${afterInstall.hidden} install_update=${afterInstall.called}`);

    errs = await errors();
    check("更新提示交互无未捕获异常", errs.length === 0, errs.join(" | "));
    check("全程无 CDP 级未捕获异常", exceptions.length === 0, exceptions.join(" | "));

    ws.close();
  } finally {
    cleanup();
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  return failed.length ? 1 : 0;
}

/** 收尾：Windows 上 Chrome 退出后 user-data-dir 可能仍被占用，删不掉就算了 */
function finish(code) {
  rm(WORK, { recursive: true, force: true, maxRetries: 3 })
    .catch(() => {})
    .finally(() => process.exit(code));
}

main()
  .then(finish)
  .catch((error) => {
    console.error(`\n冒烟验证中断：${error.message}`);
    finish(1);
  });
