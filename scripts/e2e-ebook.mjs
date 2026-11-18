/**
 * 真机端到端：启动已构建的 release 程序，在真实 WebView2 里打开一本 EPUB。
 *
 * 冒烟测试（scripts/smoke-reader.mjs）跑在 Chrome + HTTP 上，有四件只有 Tauri 才有的
 * 东西它验不到：
 *
 * 1. **CSP 与 Tauri 注入脚本的配合**：Tauri 要给自己的初始化脚本加 nonce 并改写策略，
 *    策略写死的后果是白屏——页面连 `__TAURI__` 都没有，冒烟里看不出来；
 * 2. **asset 协议**（`http://asset.localhost`）：电子书正文是从这里 fetch 回来的；
 * 3. **ACL 权限**：命令调不通时表现为被拒绝的 Promise，不跑真机永远不知道；
 * 4. 数据目录落在可执行文件旁边（这里是 `target/release/data`，随用随丢，不动用户数据）。
 *
 * 用法：`npm run build` 之后 `node scripts/e2e-ebook.mjs [exe] [epub]`
 * 默认用 `src-tauri/target/release/yuejian.exe`；不指定 epub 时现场生成一本三章的样本
 * （与冒烟测试同一字节源，见 scripts/lib/make-epub.mjs）。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildEpub } from "./lib/make-epub.mjs";

const EXE = process.argv[2] || "src-tauri/target/release/yuejian.exe";
const PORT = 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 样本必须落盘、且必须是**绝对路径**：真机上的 cwd 是 data 目录（可执行文件旁边），
 * 相对路径会指向 `target/release/data/...` 而找不到文件。
 */
function resolveSample() {
  const given = process.argv[3];
  if (given) {
    if (!existsSync(given)) {
      console.log(`指定的样本不存在：${given}`);
      process.exit(2);
    }
    return resolve(given);
  }
  const dir = join(tmpdir(), "yuejian-e2e");
  const file = join(dir, "sample.epub");
  mkdirSync(dir, { recursive: true });
  // 不带 <script>：真机上 CSP 是第一道防线，混入两重原因会让失败定位变难
  writeFileSync(file, buildEpub({ title: "真机样本", creator: "e2e" }));
  return file;
}

const EPUB = resolveSample();
console.log(`样本：${EPUB}`);

if (!existsSync(EXE)) {
  console.log(`未找到 ${EXE}，先跑 npm run build`);
  process.exit(2);
}

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
  if (reply.exceptionDetails) {
    throw new Error(`求值失败：${reply.exceptionDetails.exception?.description || reply.exceptionDetails.text}`);
  }
  return reply.result?.value;
}
async function waitFor(ws, expression, label, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await evaluate(ws, expression)) return true;
    } catch (_) { /* 页面还在切换 */ }
    await sleep(200);
  }
  throw new Error(`等待超时：${label}`);
}
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

/**
 * 章节正文在 blob iframe 里，`Page.Frame` 的字段是 `id`（不是 frameId），
 * `createIsolatedWorld` 才用 `frameId`。返回隔离世界的执行上下文 id。
 */
async function blobWorld(ws) {
  const tree = await send(ws, "Page.getFrameTree");
  const frames = [];
  const walk = (node) => { frames.push(node.frame); (node.childFrames || []).forEach(walk); };
  walk(tree.frameTree);
  const frame = frames.find((item) => (item.url || "").startsWith("blob:"));
  if (!frame) return null;
  const world = await send(ws, "Page.createIsolatedWorld", { frameId: frame.id, worldName: "e2e" });
  return world.executionContextId;
}

const app = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: "ignore",
});

let ws;
try {
  let target = null;
  for (let i = 0; i < 120 && !target; i += 1) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((item) => item.type === "page");
    } catch (_) { /* 还没起来 */ }
  }
  if (!target) throw new Error("WebView2 调试端口未就绪");

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const pageErrors = [];
  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    if (data.id && pending.has(data.id)) {
      const waiter = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) waiter.reject(new Error(JSON.stringify(data.error)));
      else waiter.resolve(data.result);
    } else if (data.method === "Runtime.exceptionThrown") {
      pageErrors.push(JSON.stringify(data.params.exceptionDetails).slice(0, 500));
    } else if (data.method === "Runtime.consoleAPICalled" && data.params.type === "error") {
      pageErrors.push(data.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    }
  };
  await send(ws, "Runtime.enable");
  await send(ws, "Page.enable");

  await waitFor(ws, "document.querySelectorAll('#bookList .book-row').length >= 0 && window.__TAURI__", "前端启动");
  const boot = await evaluate(ws, `({
    tauri: typeof window.__TAURI__,
    invoke: typeof window.__TAURI__?.core?.invoke,
    asset: window.__TAURI__.core.convertFileSrc("C:/tmp/x.epub"),
    books: document.querySelectorAll("#bookList .book-row").length,
    status: document.querySelector("#statusLeft")?.textContent || "",
  })`);
  check("Tauri 注入的脚本没被 CSP 拦掉（__TAURI__ 可用）",
    boot.tauri === "object" && boot.invoke === "function", `${boot.tauri} / ${boot.invoke}`);
  check("asset 协议 URL 已生成", /asset\.localhost|asset:/.test(boot.asset), boot.asset);

  // 导入样本 → 重载 → 打开。
  // 注意 `import_files` 返回的是**整库**（Rust 里 `Ok(data.books.clone())`），不是本次导入的
  // 那几本；而 `target/release/data` 会跨轮次保留，里面可能还躺着上次导入的书。
  // 按 kind 取第一个会在这种机器上悄悄打开旧书——所以必须按路径精确认领。
  const books = await evaluate(ws, `window.__TAURI__.core.invoke("import_files", { paths: [${JSON.stringify(EPUB)}] })`);
  const norm = (value) => String(value || "").replace(/^\\\\\?\\/, "").replace(/\\/g, "/").toLowerCase();
  const mine = (books || []).find((book) => book.kind === "ebook" && norm(book.path) === norm(EPUB));
  const imported = mine?.id || "";
  check("EPUB 被识别为 ebook 并入架", Boolean(imported), imported || `未命中 ${EPUB}`);
  await evaluate(ws, "location.reload()");
  await sleep(1200);
  await waitFor(ws, "document.querySelectorAll('#bookList .book-row').length > 0", "重载后的书架");
  await evaluate(ws, `document.querySelector('[data-book="${imported}"]').click()`);
  await waitFor(ws, "Boolean(document.querySelector('[data-pane-root=\\\"0\\\"] .ebook-stack foliate-view'))", "电子书挂载");
  await waitFor(ws, `(async () => {
    const mod = await import("/js/reader/panes.js");
    return (mod.activePane()?.ebook?.location?.cfi || "").length > 0;
  })()`.replace(/"/g, '"'), "首屏定位");

  const state = await evaluate(ws, `(async () => {
    const mod = await import("/js/reader/panes.js");
    const pane = mod.activePane();
    return {
      chapters: pane?.ebook?.chapters || 0,
      toc: (pane?.ebookToc || []).map((i) => i.label),
      cfi: pane?.ebook?.location?.cfi || "",
      title: pane?.book?.title || "",
      status: document.querySelector("#statusRight").textContent,
    };
  })()`);
  check("真机里打开 EPUB：目录与 CFI 都到位",
    state.chapters === 3 && state.cfi.startsWith("epubcfi("), `${state.chapters} 章 · ${state.cfi}`);
  check("书名回填自 OPF 元数据", state.title === "真机样本", state.title || "(空)");
  check("目录来自书内 NAV", state.toc.join("/") === "第一章 起点/第二章 展开/第三章 收束", state.toc.join("/"));

  // 章节正文在 blob iframe 里，从 CDP 帧树进去读。
  // 第一屏往往是封面（只有图、没有字），所以先跳到第一个正文章节再读
  await evaluate(ws, `(async () => {
    const mod = await import("/js/reader/panes.js");
    const pane = mod.activePane();
    const items = pane?.ebookToc || [];
    const target = items.find((i) => !/cover|封面/i.test(i.label)) || items[1] || items[0];
    if (target) await pane.ebook.goTo(target.href);
    return items.slice(0, 4).map((i) => i.label);
  })()`);
  await sleep(1200);
  const tree = await send(ws, "Page.getFrameTree");
  const frames = [];
  const walk = (node) => { frames.push(node.frame); (node.childFrames || []).forEach(walk); };
  walk(tree.frameTree);
  const frame = frames.find((item) => (item.url || "").startsWith("blob:"));
  let body = null;
  if (frame) {
    const world = await send(ws, "Page.createIsolatedWorld", { frameId: frame.id, worldName: "e2e" });
    body = await evaluate(ws, `({ length: document.body.innerText.length, scripts: document.querySelectorAll("script").length,
      html: document.documentElement.outerHTML.length, title: document.title,
      head: document.head?.innerHTML.slice(0, 200) || "" })`, world.executionContextId);
    // 只在出问题时才把帧树和正文吐出来，正常跑一行都不刷
    if (!body || body.length <= 50) {
      console.log("[debug] frame url:", frame.url, "| frames:", frames.map((f) => f.url.slice(0, 40)).join(" , "));
      console.log("[debug] body:", JSON.stringify(body).slice(0, 400));
    }
  }
  check("章节正文在真机 WebView2 里渲染出来", Boolean(body && body.length > 50), body ? `${body.length} 字` : "没有 iframe");
  check("书内脚本被清掉", Boolean(body && body.scripts === 0), body ? `${body.scripts} 个` : "无 iframe");

  // 翻页一次
  const before = state.cfi;
  for (const type of ["keyDown", "keyUp"]) {
    await send(ws, "Input.dispatchKeyEvent", {
      type, key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39,
    });
  }
  await sleep(800);
  const after = await evaluate(ws, `(async () => {
    const mod = await import("/js/reader/panes.js");
    return mod.activePane()?.ebook?.location?.cfi || "";
  })()`);
  check("键盘翻页在真机上生效", after !== before, `${before} → ${after}`);

  /* ---- P2：书签 / 搜索 / 脚注，走的是真 Rust 命令与真 WebView ---- */

  // `target/release/data` 会留着上一轮的书签（这是有意的，不主动清用户数据）。
  // 不清干净的话，第二遍跑点「加书签」其实是「取消书签」，断言只会在这里失败、
  // 而且看起来像是写入坏了。经真后端清一遍，断言才是「从 0 到 1」。
  const cleared = await evaluate(ws, `(async () => {
    const mod = await import("/js/reader/panes.js");
    const pane = mod.activePane();
    const marks = [...(pane?.book?.bookmarks || [])];
    for (const mark of marks) {
      const updated = await window.__TAURI__.core.invoke("set_bookmark",
        { id: pane.book.id, cfi: mark.cfi, label: "", on: false });
      Object.assign(pane.book, updated);
    }
    return marks.length;
  })()`);

  const marked = await evaluate(ws, `(async () => {
    document.querySelector('[data-act="ebook-mark"]').click();
    await new Promise((r) => setTimeout(r, 700));
    const mod = await import("/js/reader/panes.js");
    return {
      count: (mod.activePane()?.book?.bookmarks || []).length,
      on: Boolean(document.querySelector('[data-act="ebook-mark"]')?.classList.contains("is-on")),
    };
  })()`);
  check("书签经真后端写入并点亮按钮", marked.count === 1 && marked.on,
    `清掉旧书签 ${cleared} 条后新增 ${marked.count} 条，按钮 ${marked.on}`);

  const persisted = await evaluate(ws, `(async () => {
    const books = await window.__TAURI__.core.invoke("get_library");
    const mine = (books || []).find((book) => book.id === ${JSON.stringify(imported)});
    return mine ? (mine.bookmarks || []).length : -1;
  })()`);
  check("书签已落盘（重读书架仍在）", persisted === 1, `${persisted} 条`);

  const found = await evaluate(ws, `(async () => {
    document.querySelector('#ctxTabs [data-ctx="find"]').click();
    const input = document.querySelector("#findInput");
    input.value = "石阶生苔";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const started = Date.now();
    while (Date.now() - started < 20000) {
      await new Promise((r) => setTimeout(r, 250));
      if (document.querySelector("#findHits .find-hit")) break;
    }
    return {
      hits: document.querySelectorAll("#findHits .find-hit").length,
      group: document.querySelector(".find-group-head")?.textContent || "",
    };
  })()`);
  check("真机全书搜索命中并分组", found.hits >= 1, `${found.hits} 条 · ${found.group}`);

  // 脚注只在第一章，先跳回去；点注号应弹小窗而不是整页跳走
  await evaluate(ws, `(async () => {
    const mod = await import("/js/reader/panes.js");
    await mod.activePane()?.ebook?.goTo("OEBPS/ch1.xhtml");
  })()`);
  await sleep(1400);
  const noteWorld = await blobWorld(ws);
  const noteCfi = await evaluate(ws, `(async () => {
    const mod = await import("/js/reader/panes.js");
    return mod.activePane()?.ebook?.location?.cfi || "";
  })()`);
  const clicked = noteWorld ? await evaluate(ws, `(() => {
    const link = document.querySelector('a[href="#fn1"]');
    if (!link) return false;
    link.click();
    return true;
  })()`, noteWorld) : false;
  await sleep(1200);
  const note = await evaluate(ws, `(async () => {
    const card = document.querySelector(".ebook-note");
    const mod = await import("/js/reader/panes.js");
    return {
      open: Boolean(card && !card.hidden),
      text: card?.querySelector(".ebook-note-text")?.textContent || "",
      cfi: mod.activePane()?.ebook?.location?.cfi || "",
    };
  })()`);
  check("真机点脚注弹出小窗且不跳页",
    Boolean(clicked) && note.open && /青苔生于石阶/.test(note.text) && note.cfi === noteCfi,
    note.open ? `注文「${note.text.slice(0, 14)}…」` : "未弹出");
  check("真机全程无未捕获异常", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
} catch (error) {
  console.error("E2E 中断：", error.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch (_) { /* ignore */ }
  try { app.kill(); } catch (_) { /* ignore */ }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} 项通过`);
  if (failed) process.exitCode = 1;
}
