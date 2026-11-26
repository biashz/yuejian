/**
 * 排序按钮与菜单的事件：开合、选轴、翻向、Esc / 外点关闭、菜单内键盘。
 * 选轴 / 翻向都落盘（排序是偏好），渲染走 renderLibrary 统一刷新。
 */
import { $ } from "../core/dom.js";
import { state } from "../core/session.js";
import { sortAxis } from "../sort.js";
import { renderLibrary } from "../shelf.js";
import { persistSettings } from "../preferences.js";

const menu = () => $("#sortMenu");

function setSortMenu(open) {
  menu().hidden = !open;
  $("#sortBtn").setAttribute("aria-expanded", String(open));
  if (open) menu().querySelector(".sort-item")?.focus();
}

export function bindSortEvents() {
  $("#sortBtn").addEventListener("click", () => setSortMenu(menu().hidden));

  menu().addEventListener("click", (event) => {
    /* 翻向时菜单会重建，点击目标随即脱离 DOM；不截断冒泡的话，
       document 的外点检测拿着已摘除的 target 找不到 .list-tools，会误关菜单 */
    event.stopPropagation();
    const item = event.target.closest(".sort-item");
    if (!item) return;
    const key = item.dataset.sort;
    if (key === state.settings.sort) {
      state.settings.sortDesc = !state.settings.sortDesc;
    } else {
      state.settings.sort = key;
      state.settings.sortDesc = sortAxis(key).desc;
      setSortMenu(false);
    }
    persistSettings();
    renderLibrary();
    if (!menu().hidden) menu().querySelector(`[data-sort="${key}"]`)?.focus();
  });

  menu().addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [...menu().querySelectorAll(".sort-item")];
    const at = items.indexOf(document.activeElement);
    const next = event.key === "ArrowDown" ? Math.min(items.length - 1, at + 1) : Math.max(0, at - 1);
    items[next]?.focus();
  });

  document.addEventListener("click", (event) => {
    if (!menu().hidden && !event.target.closest(".list-tools")) setSortMenu(false);
  });

  // 捕获阶段先于全局快捷键与「Esc 清选中」：菜单开着时 Esc 只关菜单。
  // 模态弹层（命令面板 / 设置 / 确认 / 分类编辑）在更上层，让它们的 Esc 先结算
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || menu().hidden) return;
    if (!$("#paletteOverlay").hidden || !$("#settingsOverlay").hidden
      || !$("#confirmOverlay").hidden || !$("#catOverlay").hidden) return;
    event.preventDefault();
    event.stopPropagation();
    setSortMenu(false);
    $("#sortBtn").focus();
  }, true);
}