/**
 * 阅读工具栏上的「文档操作」菜单：打印、导出为 HTML、另存原文件。
 *
 * 单独一个下拉而不是三个按钮：这三件事都是「偶尔用一次」，钉在工具栏上会挤掉
 * 每天都在用的翻页与缩放；而且哪个格式能用、哪个不能用需要一行说明，按钮放不下。
 */
import { t } from "../i18n.js";

/** 菜单展开状态。工具栏整块重建时由 `renderToolbar` 复位 */
let docMenuOpen = false;

/**
 * 菜单结构。
 *
 * `caps` 由 `docCapabilities()` 给出，这里只管「有什么就画什么」——不再自行判断
 * 格式，否则同一条规则会出现在两处，迟早对不上。
 */
function docMenuHtml(caps) {
  if (!caps) return "";
  const item = (act, label, hint) => `
    <button class="doc-item" role="menuitem" data-doc="${act}">
      <span class="doc-item-label">${label}</span>
      ${hint ? `<span class="doc-item-hint">${hint}</span>` : ""}
    </button>`;
  const items = [];
  if (caps.print) items.push(item("print", t("reader.print"), "Ctrl P"));
  if (caps.html) items.push(item("html", t("reader.exportHtml"), ".html"));
  // 另存副本对四种格式都成立，和上面的「生成一份新文档」不是一类，前面隔一条线
  if (items.length) items.push(`<span class="doc-sep"></span>`);
  if (caps.copy) items.push(item("copy", t("reader.saveCopy"), ""));
  const note = caps.note ? `<p class="doc-note">${t(caps.note)}</p>` : "";
  return `<div class="doc-menu" role="menu" aria-label="${t("reader.docMenu")}" hidden>
    <p class="doc-menu-head">${t("reader.docMenu")}</p>
    ${items.join("")}
    ${note}
  </div>`;
}

/** 展开 / 收起菜单 */
function setDocMenu(open) {
  const menu = document.querySelector(".doc-menu");
  if (!menu) return;
  docMenuOpen = open;
  menu.hidden = !open;
  const label = document.querySelector('[data-act="doc-menu"]');
  if (label) {
    label.setAttribute("aria-expanded", String(open));
    label.classList.toggle("is-on", open);
  }
}

export { docMenuOpen, docMenuHtml, setDocMenu };
