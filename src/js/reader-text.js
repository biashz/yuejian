/**
 * 文本类文档（txt / log / csv / 代码配置）的渲染与视图状态。
 *
 * 两种视图：
 *   plain —— 宋体正文，空行分段，限宽居中；
 *   code  —— 等宽 + 行号，长行横向滚动。
 *
 * 刻意不「一行一个 div」：一份 5MB 日志有十几万行，那是十几万个 DOM 节点，
 * 光排版就能卡住几秒。这里用两个 <pre>（行号栏 + 正文）——节点数是常数，
 * 行高一致时天然对齐，十几万行也是毫秒级。真正的窗口化（虚拟滚动）留给
 * 「大文件」那一期，到那时才需要按可视区切片。
 */
import { escapeHtml } from "./core/dom.js";
import { t } from "./i18n.js";

/**
 * 首次打开某份文本时的视图状态。
 * 代码与日志默认等宽（要行号和横向滚动），其余默认正文（要宋体阅读感）。
 */
export function defaultTextView(doc) {
  const code = doc.mode === "code";
  return { mode: code ? "code" : "plain", gutter: code, wrap: !code };
}

/** 归一化换行：CRLF / CR 一律按 LF 处理，行号与分段才不会错位 */
function normalize(text) {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * 渲染到容器（复用 .md-doc 这个 <article>，通过类名切换排版）。
 * @returns {number} 渲染出的行数（正文视图按段落折算），用于状态栏
 */
export function renderText(doc, container, view) {
  const text = normalize(doc.text || "");
  const mode = view.mode === "code" ? "code" : "plain";
  container.className = `md-doc is-text text-${mode}${view.wrap ? " is-wrap" : ""}`;

  if (!text.trim()) {
    container.innerHTML = `<p class="tx-empty">${t("reader.textEmpty")}</p>`;
    return 0;
  }

  if (mode === "plain") {
    // 空行分段：正文是给人读的，段间距比保留原始换行更重要
    const paras = text.split(/\n[ \t]*\n/).filter((para) => para.trim() !== "");
    container.innerHTML = paras
      .map((para) => `<p class="tx-para">${escapeHtml(para)}</p>`)
      .join("");
    return paras.length;
  }

  const lines = text.replace(/\n+$/, "").split("\n");
  const gutter = view.gutter
    ? `<pre class="tx-gutter" aria-hidden="true">${lines.map((_, i) => i + 1).join("\n")}</pre>`
    : "";
  container.innerHTML =
    `<div class="tx-code${view.gutter ? " has-gutter" : ""}">` +
    gutter +
    `<pre class="tx-lines">${escapeHtml(lines.join("\n"))}</pre>` +
    `</div>`;
  return lines.length;
}
