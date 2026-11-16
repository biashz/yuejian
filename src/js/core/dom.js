/**
 * DOM 查询与文本处理的最小工具集。
 */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/* ---------------- 小工具 ---------------- */
const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/* PDF 文本层里是否已有选中的文字：有选区才放行原生右键菜单，复制才有意义 */
function isSelectionInTextLayer() {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || !selection.toString().trim()) return false;
  const anchor = selection.anchorNode;
  const element = anchor instanceof Element ? anchor : anchor?.parentElement;
  return Boolean(element?.closest(".textLayer"));
}

export { $, $$, escapeHtml, clamp, isSelectionInTextLayer };
