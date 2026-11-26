/**
 * 排序工具条与菜单的渲染。只画 DOM，事件在 bind/sort.js。
 * 计数由调用方传入可见书数组，避免反向 import shelf.js 成环。
 */
import { $, escapeHtml } from "./core/dom.js";
import { t } from "./i18n.js";
import { state } from "./core/session.js";
import { SORT_AXES, sortAxis } from "./sort.js";

const dirGlyph = (desc) => (desc ? "↓" : "↑");

function renderSortMenu() {
  const menu = $("#sortMenu");
  // 菜单开着时重绘（翻向 / 撤销恢复等）会摘掉焦点节点，重绘后把焦点还回去
  const focusedKey = menu.contains(document.activeElement) ? document.activeElement.dataset.sort : null;
  menu.innerHTML = SORT_AXES.map((axis) => {
    const active = axis.key === state.settings.sort;
    const desc = active ? state.settings.sortDesc : axis.desc;
    return `
    <button class="sort-item ${active ? "is-active" : ""}" type="button" data-sort="${axis.key}"
      role="menuitemradio" aria-checked="${active}" tabindex="-1">
      <svg class="ic"><use href="#i-check"/></svg>
      <span>${escapeHtml(axis.label())}</span>
      <span class="dir">${dirGlyph(desc)}</span>
    </button>`;
  }).join("") + `<p class="sort-hint">${t("sort.hint")}</p>`;
  if (focusedKey) menu.querySelector(`[data-sort="${focusedKey}"]`)?.focus();
}

function renderSortTools(books) {
  const axis = sortAxis(state.settings.sort);
  const dir = t(state.settings.sortDesc ? "sort.desc" : "sort.asc");
  $("#sortBtnLabel").textContent = axis.label();
  $("#sortDir").textContent = dirGlyph(state.settings.sortDesc);
  $("#sortBtn").title = t("library.sortSub", { axis: axis.label(), dir });
  $("#shownCount").textContent = t("library.shownCount", { count: books.length });
  renderSortMenu();
}

export { renderSortTools, renderSortMenu };