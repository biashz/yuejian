/**
 * 大文本的窗口渲染（虚拟滚动）。
 *
 * 为什么不能用「两个 `<pre>` 装全文」那套：那套的节点数是常数，但**内容**不是。
 * 100MB 的日志解码出来就是 100MB 的字符串，浏览器要为一个 `<pre>` 排一百万个
 * 行框，滚动时每帧都要重算，内存与帧率都撑不住。
 *
 * 这里的做法：
 *   - 画布（`.tx-canvas`）高度 = 总行数 × 行高，只负责把滚动条撑到位；
 *   - 窗口（`.tx-window`）用绝对定位放在「当前已加载的那一段」的行高位置上，
 *     里面仍然是两个 `<pre>`（行号 + 正文），只装一两千行；
 *   - 滚动时只重算窗口位置，越出已加载范围才去后端取下一段。
 *
 * 行高必须与 CSS 里的像素值一致（见 `LINE_HEIGHT` 与 styles.css 的
 * `.is-windowed` 规则）：画布高度、窗口位置、滚动换算全由它推导，
 * 差 0.25px 就会在十几万行处累积成整行错位。
 *
 * 环境上限：浏览器对元素高度有上限（WebView2 / WKWebView / WebKitGTK 都在
 * 3355 万像素附近）。总行数由 Rust 侧先按 150 万行截过（见 text.rs 的
 * `MAX_WINDOWED_LINES`），这里不再做压缩滚动——压缩画布会让窗口内容比它的
 * 位置高，滚动位置与看到的内容对不上，比截断更糟。
 */
import { clamp, escapeHtml } from "./core/dom.js";
import { invoke } from "./api.js";

/** 每行固定高度（px）。改这里必须同步 styles.css 里 `.is-windowed` 的 line-height */
export const LINE_HEIGHT = 20;

/** 一次取多少行。约 30 屏，滚动一整屏不需要重新取 */
const WINDOW_LINES = 1200;

/** 内存里最多留几个窗口 */
const CACHE_LIMIT = 3;

/** 可视区上下各多渲染几行，快速滚动时不至于露白 */
const OVERSCAN = 30;

/** 这份文档是否需要窗口渲染 */
export function isWindowed(doc) {
  return Boolean(doc?.windowed);
}

function visibleLines(pane) {
  const height = pane?.scrollArea?.clientHeight || 600;
  return Math.max(1, Math.ceil(height / LINE_HEIGHT));
}

/** 编码标签来自 Rust，理论上是 WHATWG 名字；认不出时按 UTF-8 兜底 */
function makeDecoder(encoding) {
  try {
    return new TextDecoder(encoding || "utf-8");
  } catch {
    return new TextDecoder("utf-8");
  }
}

/**
 * 把一段窗口字节解成行。
 * 窗口按行边界切，所以每段都以换行结束（末段可能没有）；解出来末尾的空串要去掉，
 * 否则行号会比正文多一行。
 */
function decodeWindow(win, bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const text = win.decoder.decode(view);
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  return trimmed === "" ? [] : trimmed.split("\n");
}

function gutterText(from, count) {
  const out = new Array(count);
  for (let i = 0; i < count; i += 1) out[i] = from + i;
  return out.join("\n");
}

/** 画出某一段。窗口位置跟着它走，否则内容与滚动条对不上 */
function paint(win, start, lines) {
  win.start = start;
  win.count = lines.length;
  const top = start * LINE_HEIGHT;
  if (win.top !== top) {
    win.windowEl.style.top = `${top}px`;
    win.top = top;
  }
  win.gutter.textContent = gutterText(start + 1, lines.length);
  win.body.innerHTML = escapeHtml(lines.join("\n"));
}

function trimCache(win) {
  while (win.cache.size > CACHE_LIMIT) {
    // 淘汰最早放进去的那个：滚动是顺序的，最早的最不可能马上回来
    const oldest = win.cache.keys().next().value;
    if (oldest === win.start) break;
    win.cache.delete(oldest);
  }
}

/** 取一段窗口；回来时用户可能已经滚走，所以取完统一走 sync 而不是直接画 */
async function loadWindow(pane, win, start) {
  const token = (win.token += 1);
  win.loading = true;
  try {
    const bytes = await invoke("read_text_window", {
      path: pane.book?.path || "",
      start,
      count: WINDOW_LINES,
    });
    if (pane.win !== win || win.token !== token) return;
    win.cache.set(start, decodeWindow(win, bytes));
    trimCache(win);
    sync(pane, win);
  } catch (error) {
    if (pane.win === win && win.token === token) {
      win.body.textContent = String(error);
      win.body.classList.add("tx-error");
    }
  } finally {
    if (win.token === token) win.loading = false;
  }
}

/** 当前可视区需要的那一段是否已经在窗口里；不在就取 */
function ensureWindow(pane, win, first) {
  const visible = visibleLines(pane);
  const from = Math.max(0, first - OVERSCAN);
  const to = Math.min(win.total, first + visible + OVERSCAN);
  if (win.start >= 0 && from >= win.start && to <= win.start + win.count) return;

  // 起点优先按整块对齐（滚回来能命中缓存），但**必须**保证窗口罩得住可视区：
  // 跳到某块末尾附近的行时，对齐后的起点会让窗口停在可视区之前，屏幕上就是一片空白。
  const aligned = Math.floor(from / WINDOW_LINES) * WINDOW_LINES;
  const start = Math.min(Math.max(aligned, to - WINDOW_LINES), from);
  const cached = win.cache.get(start);
  if (cached) {
    paint(win, start, cached);
    return;
  }
  loadWindow(pane, win, start);
}

function sync(pane, win) {
  const first = clamp(
    Math.round((pane.scrollArea?.scrollTop || 0) / LINE_HEIGHT),
    0,
    Math.max(0, win.total - visibleLines(pane)),
  );
  win.first = first;
  ensureWindow(pane, win, first);
}

/**
 * 挂上窗口渲染。容器沿用 `.md-doc`，类名切到 `text-code`，
 * 行号与软换行的开关在大文件里不可用（见 toolbar.js 的说明）。
 */
export function mountWindowed(pane, doc) {
  // 换文档时先把上一份的监听摘掉，否则旧窗口会继续响应滚动
  unmountWindowed(pane);

  const total = Math.max(doc.lines || 1, 1);
  pane.mdDoc.className = "md-doc is-text text-code show-gutter is-windowed";
  pane.mdDoc.innerHTML =
    `<div class="tx-canvas" style="height:${total * LINE_HEIGHT}px">` +
    `<div class="tx-window">` +
    `<pre class="tx-gutter" aria-hidden="true"></pre>` +
    `<pre class="tx-lines"></pre>` +
    `</div></div>`;

  const win = {
    total,
    first: -1,
    start: -1,
    count: 0,
    top: -1,
    cache: new Map(),
    token: 0,
    loading: false,
    raf: 0,
    decoder: makeDecoder(doc.encoding),
    windowEl: pane.mdDoc.querySelector(".tx-window"),
    gutter: pane.mdDoc.querySelector(".tx-gutter"),
    body: pane.mdDoc.querySelector(".tx-lines"),
    onScroll: null,
  };

  // 滚动事件每帧只处理一次：不节流的话一次滚轮能触发几十次取窗口
  win.onScroll = () => {
    if (win.raf) return;
    win.raf = requestAnimationFrame(() => {
      win.raf = 0;
      sync(pane, win);
    });
  };
  pane.scrollArea.addEventListener("scroll", win.onScroll, { passive: true });
  pane.win = win;
  sync(pane, win);
}

/** 摘掉监听、作废在途请求。切视图 / 换文档 / 关文档时都要调 */
export function unmountWindowed(pane) {
  const win = pane?.win;
  if (!win) return;
  if (win.raf) cancelAnimationFrame(win.raf);
  pane.scrollArea?.removeEventListener("scroll", win.onScroll);
  win.token += 1;
  pane.win = null;
}

/**
 * 滚到某一行（1 基），搜索命中跳转用。
 * 临时关掉平滑滚动：跨越几十万行的平滑动画既慢又没必要。
 */
export function scrollToLine(pane, line) {
  const win = pane?.win;
  if (!win) return;
  const area = pane.scrollArea;
  const target = clamp(line - 1, 0, Math.max(0, win.total - 1)) * LINE_HEIGHT;
  const previous = area.style.scrollBehavior;
  area.style.scrollBehavior = "auto";
  area.scrollTop = target;
  area.style.scrollBehavior = previous;
  sync(pane, win);
}
