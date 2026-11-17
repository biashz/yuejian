/**
 * 顶层视图编排：书架 / 阅读两个视图的切换、状态栏、窗口标题与界面语言切换。
 */
import { $, $$ } from "./core/dom.js";
import { t, getLanguage, setLanguage, applyDom } from "./i18n.js";
import { currentWindow } from "./api.js";
import { state } from "./core/session.js";
import { themeLabel, kindLabel } from "./core/constants.js";
import { renderLibrary } from "./shelf.js";
import { exitPresent } from "./reader/present.js";
import { flushProgress } from "./reader/progress.js";
import { updateDocSub } from "./reader/open.js";
import { updatePaneHeads, activePane } from "./reader/panes.js";
import { renderToolbar } from "./reader/toolbar.js";
import { renderCtx } from "./reader/ctx.js";
import { syncSettingsUI, persistSettings } from "./preferences.js";
import { renderUpdateUI } from "./update-ui.js";
import { renderPalette } from "./palette.js";

/* ---------------- 视图切换 ---------------- */
function setView(view) {
  state.view = view;
  document.body.dataset.view = view;
  const isReading = view === "reading";
  $("#view-library").classList.toggle("is-visible", !isReading);
  $("#view-reader").classList.toggle("is-visible", isReading);
  $$(".rail-btn").forEach((button) => {
    const nav = button.dataset.nav;
    button.classList.toggle("is-active", nav === (isReading ? "reading" : "library"));
  });
  $("#tbTitle").textContent = isReading ? ($("#docTitle").textContent || t("nav.reading")) : t("nav.shelf");
  if (!isReading) {
    exitPresent();
    flushProgress();
    renderLibrary();
  }
  updateStatus();
}

/* ---------------- 状态栏 ---------------- */

/**
 * 状态栏右侧按文档类型给不同口径。
 * 文本类不能沿用 Markdown 那一行（会显示成「MARKDOWN · N 字」），
 * 行数才是读日志与代码时真正关心的量。
 */
function statusRightText(book) {
  if (book.kind === "pdf") {
    return t("status.page", {
      page: state.pdfPage,
      total: state.pdfTotal || book.pages || "…",
      zoom: Math.round(state.pdfZoom * 100),
    });
  }
  if (book.kind === "text") {
    const doc = activePane()?.doc;
    // 大文件统计不了字符数，改报「大文件」，让用户知道为什么没有字数
    if (doc?.windowed) {
      return t("status.textBig", { kind: kindLabel("text", book), lines: doc.lines ?? 0 });
    }
    return t("status.text", {
      kind: kindLabel("text", book),
      lines: doc?.lines ?? 0,
      chars: doc?.chars ?? 0,
    });
  }
  return t("status.markdown", {
    words: book.words || 0,
    size: state.settings.fontSize,
    lh: state.settings.lineHeight,
  });
}

function updateStatus() {
  const book = state.current;
  if (state.view === "reading" && book) {
    $("#statusLeft").textContent = book.title;
    $("#statusRight").textContent = statusRightText(book);
  } else {
    $("#statusLeft").textContent = t("status.ready");
    $("#statusRight").textContent = t("status.documents", { count: state.books.length });
  }
  $("#statusMid").textContent = themeLabel(state.settings.theme);
}

/* ---------------- 语言切换 ---------------- */
/** 原生窗口标题跟随界面语言（任务栏 / Alt+Tab 上显示的名称） */
function syncWindowTitle() {
  currentWindow?.setTitle(t("app.title"));
}

/**
 * 切换界面语言：重填静态文案，并按新语言重绘所有动态区域，无需重启应用。
 * 只改变界面语言，不影响文档内容与阅读进度。
 */
function switchLanguage(language) {
  if (!language || language === getLanguage()) return;
  setLanguage(language);
  state.settings.language = getLanguage();
  applyDom();
  syncWindowTitle();

  syncSettingsUI();
  renderLibrary();
  renderToolbar();
  renderCtx();
  updateDocSub();
  updatePaneHeads();
  updateStatus();
  renderUpdateUI();
  $("#docTitle").textContent = state.current?.title || t("reader.untitled");
  $("#tbTitle").textContent = state.view === "reading"
    ? ($("#docTitle").textContent || t("nav.reading"))
    : t("nav.shelf");
  // 命令面板打开时按新语言重建列表
  if (!$("#paletteOverlay").hidden) renderPalette($("#paletteInput").value);
  persistSettings();
}

export { setView, updateStatus, syncWindowTitle, switchLanguage };
