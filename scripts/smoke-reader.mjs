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
  throw new Error(`等待超时：${label}`);
}

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
      }
    };

    await send(ws, "Page.enable");
    await send(ws, "Runtime.enable");
    await send(ws, "Page.addScriptToEvaluateOnNewDocument", { source: stubSource() });
    await send(ws, "Page.navigate", { url: `${origin}/` });
    await waitFor(ws, "document.querySelectorAll('#bookList .book-row').length >= 2", "书架渲染");
    check("启动完成，书架渲染 2 本书", true);

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

    /* --- 翻页与缩放：覆盖 onPageChange / onZoom --- */
    await evaluate(ws, `document.querySelector('[data-act="next"]')?.click()`);
    await sleep(400);
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
