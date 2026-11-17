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

function stubSource() {
  return `(() => {
  // 收集所有未捕获异常：模块里漏 import 的调用会在这里冒出来
  window.__errors = [];
  window.__calls = [];
  addEventListener("error", (e) => window.__errors.push("error: " + (e.message || e.error)));
  addEventListener("unhandledrejection", (e) => window.__errors.push("rejection: " + (e.reason?.message || e.reason)));

  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const now = Date.now();
  const BOOKS = [
    { id: "b-md", path: "C:/fixtures/demo.md", title: "示例 Markdown", author: "本地", kind: "markdown",
      size: 12800, pages: 0, words: 3200, addedAt: now - 9000, lastOpenedAt: now - 5000, favorite: false,
      categoryId: "", progress: { ratio: 0.35, page: 1, zoom: 1 } },
    { id: "b-pdf", path: "/fixtures/sample.pdf", title: "示例 PDF", author: "本地", kind: "pdf",
      size: 4000, pages: 3, words: 0, addedAt: now - 8000, lastOpenedAt: now - 4000, favorite: true,
      categoryId: "", progress: { ratio: 0, page: 2, zoom: 1 } },
    { id: "b-txt", path: "C:/fixtures/run.log", title: "运行日志", author: "本地", kind: "text",
      size: 9200, pages: 0, words: 680, addedAt: now - 7000, lastOpenedAt: now - 3000, favorite: false,
      categoryId: "", progress: { ratio: 0, page: 1, zoom: 1 } },
  ];
  const SETTINGS = { theme: "paper", fontSize: 17, lineHeight: 1.9, measure: 720, showCtx: true,
    zen: false, split: false, linkSync: true, language: "zh", autoCheckUpdate: false };
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
          if (args.id === "b-pdf") return Promise.resolve(clone({ kind: "pdf", path: "/fixtures/sample.pdf", pages: 3, size: 4000 }));
          if (args.id === "b-txt") return Promise.resolve(clone({
            kind: "text", text: ${JSON.stringify(TEXT_LOG)}, encoding: "UTF-8",
            lines: ${TEXT_LOG.split("\n").length}, chars: ${TEXT_LOG.replace(/\s/g, "").length},
            eol: "LF", lang: "", mode: "code", truncated: false,
          }));
          return Promise.resolve(clone({
            kind: "markdown", html: HTML, dir: "C:/fixtures", words: 3200,
            toc: [{ level: 1, text: "第一章", id: "h1" }, { level: 2, text: "第二节", id: "h2" }],
          }));
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

async function evaluate(ws, expression) {
  const reply = await send(ws, "Runtime.evaluate", {
    expression, awaitPromise: true, returnByValue: true,
  });
  if (reply.exceptionDetails) throw new Error(`求值失败：${reply.exceptionDetails.text}`);
  return reply.result?.value;
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

/* ---------------- 主流程 ---------------- */

async function main() {
  await mkdir(WORK, { recursive: true });
  await writeFile(join(WORK, "sample.pdf"), buildPdf(["第一页", "第二页", "第三页"]));
  await writeFile(join(WORK, "demo.md"), "# 第一章\n\n正文\n");

  // 端口交给系统分配：并行跑多个实例不会撞车
  const server = createServer(async (req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    const file = url.startsWith("/fixtures/")
      ? join(WORK, url.slice("/fixtures/".length))
      : join(ROOT, url === "/" ? "index.html" : url.slice(1));
    try {
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
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
    await waitFor(ws, "document.querySelectorAll('#bookList .book-row').length >= 3", "书架渲染");
    check("启动完成，书架渲染 3 本书", true);

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
      gutterGone: !document.querySelector('${pane} .tx-gutter'),
      wrapped: document.querySelector('${pane} .text-code')?.classList.contains('is-wrap'),
    }))()`);
    check("打开软换行自动关掉行号（避免错位）",
      wrapInfo.wrap && !wrapInfo.gutterOn && wrapInfo.gutterGone && wrapInfo.gutterDisabled && wrapInfo.wrapped,
      `软换行=${wrapInfo.wrap} 行号=${wrapInfo.gutterOn} 行号栏已移除=${wrapInfo.gutterGone}`);

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
