/**
 * 阅读进度：滚动节流后整库写回，去重同一本书被两栏同时打开的情况。
 */
import { invoke } from "../api.js";
import { clamp } from "../core/dom.js";
import { panes } from "./panes.js";


/* 本模块自有的可变句柄，不对外暴露 */
let saveTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushProgress, 900);
}

function flushProgress() {
  clearTimeout(saveTimer);
  const seen = new Set();
  for (const pane of panes) {
    if (!pane.book || seen.has(pane.book.id)) continue;
    seen.add(pane.book.id);
    flushPaneProgress(pane);
  }
}

function flushPaneProgress(pane) {
  const book = pane?.book;
  if (!book) return;
  invoke("save_progress", {
    id: book.id,
    ratio: clamp(book.progress.ratio || 0, 0, 1),
    page: book.progress.page || 0,
    zoom: book.progress.zoom || 1,
    pages: book.pages || 0,
    // 电子书才有；PDF / Markdown 传空串，Rust 侧存成空表示「这本书没有 CFI」
    cfi: book.progress.cfi || "",
  }).catch(() => {});
}

export { scheduleSave, flushProgress, flushPaneProgress };
