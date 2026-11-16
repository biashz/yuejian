/**
 * 打开文档：调用 Rust 取回文档、按类型分派给 PDF 或 Markdown 渲染，
 * 并把阅读器的分页 / 缩放 / 就绪回调折算成该栏与全局状态。
 */
import { invoke } from "../api.js";
import { PdfReader } from "../reader-pdf.js";
import { renderMarkdown, setupScrollSpy } from "../reader-md.js";
import { $, clamp, escapeHtml } from "../core/dom.js";
import { t } from "../i18n.js";
import { state } from "../core/session.js";
import { toast } from "../core/feedback.js";
import { formatBytes } from "../core/format.js";
import { panes, activePaneIndex, splitMode, activePane, activatePane, closePaneDoc, updatePaneHeads, syncToActivePane, maybeSync, scrollPaneToRatio } from "./panes.js";
import { renderToolbar, updateToolbarPage } from "./toolbar.js";
import { renderCtx, markTocActive, markThumbActive, setCtxTabActive, setCtxOpen } from "./ctx.js";
import { setView, updateStatus } from "../view.js";
import { flushPaneProgress, flushProgress, scheduleSave } from "./progress.js";
import { visibleBooks, renderBookList, renderGrid } from "../shelf.js";

/* ---------------- 打开文档 ---------------- */
async function openBook(id, pane = activePane()) {
  const book = state.books.find((item) => item.id === id);
  if (!book || !pane) return;

  // 同栏已打开同一份文档：不重新解析，直接切回阅读视图
  if (pane.book?.id === id && pane.doc) {
    if (pane.index === activePaneIndex) {
      activatePane(pane.index, true);
      setView("reading");
    }
    return;
  }

  const wasActive = pane.index === activePaneIndex;

  // 替换文档只影响本栏：另一栏保持原文档不变，两栏内容是否相同由用户各自选择
  flushPaneProgress(pane);
  closePaneDoc(pane);

  pane.book = book;
  pane.page = clamp(book.progress.page || 1, 1, Math.max(1, book.pages || 1));
  // 每次打开都从「适合页面」开始，不恢复上次的缩放比例
  pane.zoom = 1;
  pane.ratio = clamp(book.progress.ratio || 0, 0, 1);
  pane.total = book.pages || 0;
  pane.loadToken += 1;
  const token = pane.loadToken;

  pane.pdfStack.style.display = book.kind === "pdf" ? "flex" : "none";
  pane.mdDoc.style.display = book.kind === "pdf" ? "none" : "block";

  if (wasActive) {
    setCtxTabActive("toc");
    activatePane(pane.index, true);
    setView("reading");
  }
  updatePaneHeads();

  let doc;
  try {
    doc = await invoke("open_book", { id });
  } catch (error) {
    if (token !== pane.loadToken) return;
    toast(String(error));
    closePaneDoc(pane);
    if (!panes.some((item) => item.book)) setView("library");
    if (wasActive) activatePane(pane.index, true);
    return;
  }
  if (token !== pane.loadToken) return;  // 已被同栏更新的打开请求取代
  pane.doc = doc;
  if (wasActive) state.doc = doc;

  if (doc.kind === "pdf") await openPdf(doc, pane);
  else openMarkdown(doc, pane);

  renderBookList(visibleBooks());
  renderGrid(visibleBooks());
  updatePaneHeads();
  if (wasActive) {
    setCtxOpen(state.settings.showCtx);
    activatePane(pane.index, true);
  }
  // 本栏文档变化后刷新工具栏：两栏是否同文档决定联动按钮的显示
  renderToolbar();
  updateStatus();
  // 分栏中新栏刚加载完：两栏同文档时立即对齐到活动栏位置，避免联动起点错位
  if (splitMode && pane.index !== activePaneIndex) syncToActivePane();
}

function updateDocSub() {
  const book = state.current;
  const sub = $("#docSub");
  if (!book) {
    sub.textContent = "";
    return;
  }
  sub.textContent = book.kind === "pdf"
    ? t("reader.docSubPdf", { pages: state.pdfTotal || book.pages || "…", size: formatBytes(book.size) })
    : t("reader.docSubMd", { words: book.words || 0, size: formatBytes(book.size) });
}

async function openPdf(doc, pane) {
  pane.total = doc.pages || pane.total || pane.book?.pages || 0;
  if (pane.index === activePaneIndex) state.pdfTotal = pane.total;
  const reader = ensurePdfReader(pane);
  if (pane.index === activePaneIndex) {
    renderToolbar();
    renderCtx();
    updateDocSub();
  }

  try {
    // 不传 zoom：由阅读器按可视区计算出「适合页面」的比例
    await reader.open(doc.path, { startPage: pane.page, size: doc.size || 0 });
  } catch (error) {
    pane.pdfStack.innerHTML = `<div class="pdf-error">${t("reader.pdfErrorTitle")}<br><small>${escapeHtml(error?.message || error)}</small></div>`;
    toast(t("reader.pdfErrorToast"));
  }
}

function openMarkdown(doc, pane) {
  const area = pane.scrollArea;
  area.scrollTop = 0;
  pane.headingEls = renderMarkdown(doc, pane.mdDoc);
  pane.spyCleanup = setupScrollSpy(area, pane.headingEls, (id) => {
    if (pane.index === activePaneIndex) markTocActive(id);
  });
  if (pane.index === activePaneIndex) {
    renderToolbar();
    renderCtx();
  }

  requestAnimationFrame(() => scrollPaneToRatio(pane, pane.book?.progress.ratio || 0));
}

/* ---------------- PDF 阅读器 ---------------- */
function ensurePdfReader(pane) {
  if (pane.reader) return pane.reader;
  pane.reader = new PdfReader({
    stack: pane.pdfStack,
    scrollArea: pane.scrollArea,
    onPageChange: (info) => handlePageChange(pane, info),
    onReady: ({ pages }) => handlePdfReady(pane, pages),
    onZoom: (zoom) => handleZoomChange(pane, zoom),
  });
  return pane.reader;
}

/** 缩放变化（含窗口适配重算）：同步到该栏与工具栏 */
function handleZoomChange(pane, zoom) {
  pane.zoom = zoom;
  if (pane.index !== activePaneIndex) return;
  state.pdfZoom = zoom;
  updateToolbarPage();
}

function handlePageChange(pane, { page, zoom, ratio, total, pageOffset }) {
  pane.page = page;
  pane.zoom = zoom;
  pane.ratio = ratio;
  if (total) pane.total = total;
  if (pane.book) {
    pane.book.progress = { ratio, page, zoom };
    if (total) pane.book.pages = total;
  }
  updatePaneHeads();
  if (pane.index !== activePaneIndex) return;

  state.pdfPage = page;
  state.pdfZoom = zoom;
  if (total) state.pdfTotal = total;
  updateToolbarPage();
  markThumbActive();
  markTocActive();
  updateDocSub();
  updateStatus();
  scheduleSave();
  maybeSync(pane, { page, ratio, pageOffset });
}

function handlePdfReady(pane, pages) {
  pane.total = pages;
  if (pane.book) pane.book.pages = pages;
  if (pane.index !== activePaneIndex) {
    updatePaneHeads();
    return;
  }
  state.pdfTotal = pages;
  updateToolbarPage();
  updateDocSub();
  updateStatus();
  renderToolbar();
  renderCtx();
  flushProgress();
}

export { openBook, updateDocSub, openPdf, openMarkdown, ensurePdfReader, handleZoomChange, handlePageChange, handlePdfReady };
