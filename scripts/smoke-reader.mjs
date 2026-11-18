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
    // 大文件：正文由 read_text_window 按窗口现生成，不预置全文——
    // 20 万行 × 约 100 字节 ≈ 20MB，正好越过 8MB 的整篇上限
    { id: "b-huge", path: "C:/fixtures/huge.log", title: "huge.log", author: "本地", kind: "text",
      size: 20500000, pages: 0, words: 0, addedAt: now - 2500, lastOpenedAt: now - 700, favorite: false,
      categoryId: "", encoding: "", progress: { ratio: 0, page: 1, zoom: 1 } },
  ];
  const SETTINGS = { theme: "paper", fontSize: 17, lineHeight: 1.9, measure: 720, showCtx: true,
    zen: false, split: false, linkSync: true, language: "zh", autoCheckUpdate: false, ebookSpread: true };
  const HTML = ${JSON.stringify(MD_HTML)};

  window.__TAURI__ = {
    core: {
      invoke(command, args) {
        window.__calls.push(command);
        if (command === "get_settings") return Promise.resolve(clone(SETTINGS));
        if (command === "get_library") return Promise.resolve(clone(BOOKS));
        if (command === "get_categories") return Promise.resolve([]);
        if (command === "app_version") return Promise.resolve("0.0.0-smoke");
        if (command === "open_book") {
          window.__encCalls.push(args.encoding === undefined ? null : args.encoding);
          if (args.id === "b-pdf") return Promise.resolve(clone({ kind: "pdf", path: "/fixtures/sample.pdf", pages: 3, size: 4000 }));
          if (args.id === "b-epub") return Promise.resolve(clone({
            kind: "ebook", path: "/fixtures/sample.epub", size: 4096,
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
        if (command === "search_text") {
          window.__calls.push("search_text");
          if (args.query !== "zebra") return Promise.resolve([]);
          // 命中行必须真的含关键词，否则侧栏里的 <mark> 标记根本出不来
          return Promise.resolve(clone([
            { line: 1201, text: hugeLine(1201).replace("lorem", "zebra") },
            { line: 190000, text: hugeLine(190000).replace("lorem", "zebra") },
          ]));
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
    const errors = () => evaluate(ws, "window.__errors.slice()");

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
