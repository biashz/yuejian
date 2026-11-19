/**
 * 侧栏外壳：开合、页签切换、按文档类型显示哪几个页签，以及把渲染派发给四个页。
 *
 * 四个页各自一个文件（`ctx-toc` / `ctx-thumbs` / `ctx-marks` / `ctx-notes` /
 * `ctx-find` / `ctx-info`）。挤在一起时这个文件一度到 500 行，而它们之间除了
 * 「都往 #ctxBody 里画」之外没有共享状态——拆开之后每个都读得动。
 *
 * 对外导出保持原样：调用方（open / panes / view / 键盘绑定）不必知道内部怎么分的。
 */
import { $, $$ } from "../core/dom.js";
import { state } from "../core/session.js";
import { renderToc, markTocActive } from "./ctx-toc.js";
import { renderThumbs, markThumbActive } from "./ctx-thumbs.js";
import { renderMarks } from "./ctx-marks.js";
import { renderNotes } from "./ctx-notes.js";
import { renderFind, runFind } from "./ctx-find.js";
import { renderInfo } from "./ctx-info.js";

/* 每种文档能用的侧栏视图：PDF 有缩略图，文本类没有大纲但有文件信息，
   电子书的目录来自书本身的 NAV/NCX（不是扫描标题），另有书签与划线两页 */
const TABS_BY_KIND = {
  pdf: ["toc", "thumbs", "find"],
  text: ["info", "find"],
  ebook: ["toc", "marks", "notes", "find", "info"],
};

function setCtxOpen(open) {
  state.ctxOpen = open;
  $("#ctxPanel").classList.toggle("is-hidden", !open);
  $("#ctxBtn").classList.toggle("is-on", open);
  const button = $('[data-act="ctx"]');
  if (button) button.classList.toggle("is-on", open);
}

function setCtxTabActive(tab) {
  state.ctxTab = tab;
  $$("#ctxTabs .ctx-tab").forEach((item) => item.classList.toggle("is-on", item.dataset.ctx === tab));
}

function switchCtxTab(tab) {
  setCtxTabActive(tab);
  renderCtx();
}

/**
 * 按文档类型显示/隐藏侧栏标签。
 * 文本类没有 PDF 大纲，也没有缩略图，硬留着两个空 tab 只会让人多点两次。
 */
function syncCtxTabs(book) {
  const allowed = TABS_BY_KIND[book.kind] || ["toc", "thumbs", "find"];
  if (!allowed.includes(state.ctxTab)) state.ctxTab = allowed[0];
  $$("#ctxTabs .ctx-tab").forEach((tab) => {
    tab.hidden = !allowed.includes(tab.dataset.ctx);
    tab.classList.toggle("is-on", tab.dataset.ctx === state.ctxTab);
  });
}

function renderCtx() {
  const book = state.current;
  if (!book) return;
  syncCtxTabs(book);
  if (state.ctxTab === "info") return renderInfo();
  if (state.ctxTab === "toc") return renderToc();
  if (state.ctxTab === "marks") return renderMarks();
  if (state.ctxTab === "notes") return renderNotes();
  if (state.ctxTab === "thumbs") return renderThumbs();
  return renderFind();
}

export { setCtxOpen, setCtxTabActive, switchCtxTab, renderCtx, renderToc, renderMarks, markTocActive, renderThumbs, markThumbActive, renderFind, runFind };
