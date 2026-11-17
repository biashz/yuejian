/**
 * 文本类文档（txt / log / csv / 代码配置）的渲染、视图状态与语法高亮。
 *
 * 两种视图：
 *   plain —— 宋体正文，空行分段，限宽居中；
 *   code  —— 等宽 + 行号，长行横向滚动。
 *
 * 刻意不「一行一个 div」：一份 5MB 日志有十几万行，那是十几万个 DOM 节点，
 * 光排版就能卡住几秒。这里用两个 <pre>（行号栏 + 正文）——节点数是常数，
 * 行高一致时天然对齐，十几万行也是毫秒级。真正的窗口化（虚拟滚动）留给
 * 「大文件」那一期，到那时才需要按可视区切片。
 *
 * 行号栏在 code 视图里**总是**渲染出来，靠 `show-gutter` 类控制显隐。这样
 * 切行号、切软换行都只是加删类名：不重建 DOM、不丢高亮、不把滚动位置弹回
 * 文首。原先每次切换都整篇重绘，在大文件上是肉眼可见的卡顿。
 */
import { escapeHtml } from "./core/dom.js";
import { t } from "./i18n.js";
import { buildTable } from "./reader-csv.js";

/**
 * 超过这个字符数就不做语法高亮，只显示等宽纯文本。
 *
 * 实测（本机，hljs 11.11.1 common bundle，Rust 代码）：
 * 50KB→57ms、200KB→133ms、500KB→265ms、1MB→492ms、2MB→1010ms，
 * 且高亮后的 HTML 约为原文的 3.6 倍（500KB 源码 → 1.79MB HTML）。
 * 200KB 处约 130ms 高亮 + 700KB HTML 解析，是「能感觉到但可接受」的上限；
 * 再往上就变成打开文件时明显一顿。
 */
export const HIGHLIGHT_MAX_CHARS = 200 * 1024;

/**
 * 首次打开某份文本时的视图状态。
 * 代码与日志默认等宽（要行号和横向滚动），表格类默认表格，其余默认正文。
 */
export function defaultTextView(doc) {
  const mode = doc.mode === "code" ? "code" : doc.mode === "table" ? "table" : "plain";
  return {
    mode,
    // 行号只属于等宽视图：表格自带行号列，正文不需要行号
    gutter: mode === "code",
    // 软换行只属于正文；等宽靠横向滚动，表格靠单元格自身换行
    wrap: mode === "plain",
  };
}

/** 归一化换行：CRLF / CR 一律按 LF 处理，行号与分段才不会错位 */
function normalize(text) {
  return text.replace(/\r\n?/g, "\n");
}

/** 视图对应的类名；mode 之外的两个开关都只影响类名 */
function viewClass(view) {
  const mode = view.mode === "code" ? "code" : view.mode === "table" ? "table" : "plain";
  return [
    "md-doc",
    "is-text",
    `text-${mode}`,
    mode === "code" && view.wrap ? "is-wrap" : "",
    mode === "code" && view.gutter ? "show-gutter" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * 只更新视图开关，不重建 DOM。
 * 行号、软换行都走这里——重绘会丢掉已经算好的高亮，还得把滚动位置救回来。
 */
export function applyTextView(container, view) {
  container.className = viewClass(view);
}

/** 行号栏：一份 10 万行的文件也只是拼接一个字符串，不产生节点爆炸 */
function gutterText(count) {
  const out = new Array(count);
  for (let i = 0; i < count; i += 1) out[i] = i + 1;
  return out.join("\n");
}

/**
 * 渲染到容器（复用 .md-doc 这个 <article>，通过类名切换排版）。
 * @returns {{blocks: number, table: object|null}} blocks 用于状态栏；
 *   table 是表格视图的摘要（行列数、分隔符），工具栏与信息面板要用
 */
export function renderText(doc, container, view) {
  const text = normalize(doc.text || "");
  const mode = view.mode === "code" ? "code" : view.mode === "table" ? "table" : "plain";
  container.className = viewClass({ ...view, mode });

  if (!text.trim()) {
    container.innerHTML = `<p class="tx-empty">${t("reader.textEmpty")}</p>`;
    return { blocks: 0, table: null };
  }

  if (mode === "plain") {
    // 空行分段：正文是给人读的，段间距比保留原始换行更重要
    const paras = text.split(/\n[ \t]*\n/).filter((para) => para.trim() !== "");
    container.innerHTML = paras
      .map((para) => `<p class="tx-para">${escapeHtml(para)}</p>`)
      .join("");
    return { blocks: paras.length, table: null };
  }

  if (mode === "table") {
    const summary = buildTable(text);
    container.innerHTML = summary.html;
    return { blocks: summary.rows, table: summary };
  }

  const body = text.replace(/\n+$/, "");
  const lineCount = body.split("\n").length;
  container.innerHTML =
    `<div class="tx-code">` +
    `<pre class="tx-gutter" aria-hidden="true">${gutterText(lineCount)}</pre>` +
    `<pre class="tx-lines">${escapeHtml(body)}</pre>` +
    `</div>`;
  return { blocks: lineCount, table: null };
}

/* ---------------- 语法高亮 ---------------- */

/** 最近一次高亮结果。切视图、切行号会反复取同一份文本，没必要重算 */
let cache = { key: "", html: "" };

/** hljs 是否可用、该语言是否认识；任一不满足都退回纯等宽 */
function highlighterFor(lang) {
  const hljs = window.hljs;
  if (!hljs || !lang) return null;
  try {
    return hljs.getLanguage(lang) ? hljs : null;
  } catch {
    return null;
  }
}

/** 这份文档的尺寸与语言是否允许高亮 */
export function canHighlight(doc) {
  return Boolean(doc?.lang) && (doc.text || "").length <= HIGHLIGHT_MAX_CHARS;
}

/**
 * 最终会不会真的高亮：还要 hljs 认识这个语言别名。
 * 信息面板必须用这个而不是 canHighlight——否则语言认不出时面板显示「开」，
 * 屏幕上却是黑白，用户会以为高亮坏了。
 */
export function willHighlight(doc) {
  return canHighlight(doc) && Boolean(highlighterFor(doc.lang));
}

/**
 * 异步高亮：先出等宽纯文本，再在空闲时算好颜色换上去。
 *
 * 打开文件的瞬间不该被高亮拖住——200KB 的代码要 130ms，同步做就是可见的
 * 白屏一顿。`token` 用来作废过期任务：用户在算完之前切了视图、换了文档，
 * 结果就直接丢掉。
 */
export function scheduleHighlight(pane, doc, container) {
  const token = (pane.textHighlightToken = (pane.textHighlightToken || 0) + 1);
  if (!canHighlight(doc) || !highlighterFor(doc.lang)) return;

  const run = () => {
    if (pane.textHighlightToken !== token || pane.doc !== doc) return;
    if (pane.textView?.mode !== "code") return;
    const body = container.querySelector(".tx-lines");
    if (!body) return;

    const text = normalize(doc.text || "").replace(/\n+$/, "");
    // 键里带上首尾片段：只按长度做键，两份等长的文件会互相顶掉缓存
    const key = `${doc.lang}:${text.length}:${text.slice(0, 32)}:${text.slice(-32)}`;
    let html = cache.key === key ? cache.html : "";
    if (!html) {
      const hljs = highlighterFor(doc.lang);
      if (!hljs) return;
      try {
        html = hljs.highlight(text, { language: doc.lang, ignoreIllegals: true }).value;
        cache = { key, html };
      } catch {
        return; /* 高亮失败就保持纯文本，不影响阅读 */
      }
    }
    // 算的过程中可能又切了视图或换了文档
    if (pane.textHighlightToken !== token) return;
    body.innerHTML = html;
    body.classList.add("hljs");
  };

  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(run, { timeout: 400 });
  } else {
    setTimeout(run, 0);
  }
}
