/**
 * 打开文档：调用 Rust 取回文档、按类型分派给 PDF 或 Markdown 渲染，
 * 并把阅读器的分页 / 缩放 / 就绪回调折算成该栏与全局状态。
 */
import { invoke } from "../api.js";
import { PdfReader } from "../reader-pdf.js";
import { renderMarkdown, setupScrollSpy } from "../reader-md.js";
import { renderText, defaultTextView, applyTextView, scheduleHighlight } from "../reader-text.js";
import { isWindowed, mountWindowed } from "../reader-bigtext.js";
import { $, clamp, escapeHtml } from "../core/dom.js";
import { t } from "../i18n.js";
import { state } from "../core/session.js";
import { kindLabel } from "../core/constants.js";
import { toast } from "../core/feedback.js";
import { formatBytes } from "../core/format.js";
import { panes, activePaneIndex, splitMode, activePane, activatePane, closePaneDoc, updatePaneHeads, syncToActivePane, maybeSync, scrollPaneToRatio } from "./panes.js";
import { renderToolbar, updateToolbarPage } from "./toolbar.js";
import { renderCtx, markTocActive, markThumbActive, setCtxTabActive, setCtxOpen } from "./ctx.js";
import { openEbook } from "./ebook-open.js";
import { setView, updateStatus } from "../view.js";
import { flushPaneProgress, flushProgress, scheduleSave } from "./progress.js";
import { visibleBooks, renderBookList, renderGrid } from "../shelf.js";

/* ---------------- 打开文档 ---------------- */
/**
 * 打开一份文档到指定栏。
 *
 * `options.encoding` 只在「信息」面板里手动换编码时传：空串表示改回自动检测，
 * 其余是编码标签。传了就一定会重新解析（正是要重解），并写回书架。
 */
async function openBook(id, pane = activePane(), { encoding } = {}) {
  const book = state.books.find((item) => item.id === id);
  if (!book || !pane) return;

  // 同栏已打开同一份文档：不重新解析，直接切回阅读视图。换编码时例外
  if (encoding === undefined && pane.book?.id === id && pane.doc) {
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
  // 每次打开都从「适合宽度」开始，不恢复上次的缩放比例
  pane.zoom = 1;
  pane.ratio = clamp(book.progress.ratio || 0, 0, 1);
  pane.total = book.pages || 0;
  pane.loadToken += 1;
  const token = pane.loadToken;

  pane.pdfStack.style.display = book.kind === "pdf" ? "flex" : "none";
  pane.mdDoc.style.display = book.kind === "pdf" || book.kind === "ebook" ? "none" : "block";
  // 电子书的排版由 foliate 接管：唯一能滚动的是它自己的分页器，
  // 外层 scroll-area 一旦还能滚，翻页时就会连带把整块内容推出视口
  pane.root.classList.toggle("is-ebook", book.kind === "ebook");

  if (wasActive) {
    setCtxTabActive("toc");
    activatePane(pane.index, true);
    setView("reading");
  }
  updatePaneHeads();

  let doc;
  try {
    doc = await invoke("open_book", { id, encoding });
  } catch (error) {
    if (token !== pane.loadToken) return;
    toast(String(error));
    closePaneDoc(pane);
    if (!panes.some((item) => item.book)) setView("library");
    if (wasActive) activatePane(pane.index, true);
    return;
  }
  if (token !== pane.loadToken) return;  // 已被同栏更新的打开请求取代
  // 书架的唯一真相在 Rust 侧，「信息」面板要靠这份前端副本标出当前选的是哪一项
  if (encoding !== undefined) book.encoding = encoding;
  pane.doc = doc;
  if (wasActive) state.doc = doc;

  if (doc.kind === "pdf") await openPdf(doc, pane);
  else if (doc.kind === "ebook") await openEbook(doc, pane);
  else if (doc.kind === "text") openText(doc, pane);
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
  if (book.kind === "pdf") {
    sub.textContent = t("reader.docSubPdf", { pages: state.pdfTotal || book.pages || "…", size: formatBytes(book.size) });
    return;
  }
  if (book.kind === "text") {
    const doc = activePane()?.doc;
    // 大文件统计不了字符数（要整篇解码），只报行数
    sub.textContent = doc?.windowed
      ? t("reader.docSubTextBig", { lines: doc.lines ?? 0, size: formatBytes(book.size) })
      : t("reader.docSubText", {
        lines: doc?.lines ?? 0,
        chars: doc?.chars ?? book.words ?? 0,
        size: formatBytes(book.size),
      });
    return;
  }
  if (book.kind === "ebook") {
    const pane = activePane();
    const format = kindLabel("ebook", book);
    const count = pane?.ebook?.chapters || pane?.ebookToc?.length || book.pages || 0;
    // 固定版面（漫画）数的是页不是章：一张图一页，叫它「章」只会让人以为目录没读对。
    // 目录为空的书（没有 NAV 的 MOBI）不写「0 章」——那不是信息，只是噪音
    const size = formatBytes(book.size);
    if (!count) sub.textContent = t("reader.docSubEbookPlain", { format, size });
    else if (pane?.ebook?.fixed) sub.textContent = t("reader.docSubComic", { format, pages: count, size });
    else sub.textContent = t("reader.docSubEbook", { format, chapters: count, size });
    return;
  }
  sub.textContent = t("reader.docSubMd", { words: book.words || 0, size: formatBytes(book.size) });
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
    // 不传 zoom：由阅读器按可视区计算出「适合宽度」的比例
    await reader.open(doc.path, { startPage: pane.page, size: doc.size || 0 });
  } catch (error) {
    pane.pdfStack.innerHTML = `<div class="pdf-error">${t("reader.pdfErrorTitle")}<br><small>${escapeHtml(error?.message || error)}</small></div>`;
    toast(t("reader.pdfErrorToast"));
  }
}

function openMarkdown(doc, pane) {
  const area = pane.scrollArea;
  area.scrollTop = 0;
  // 从文本类文档切过来时，要清掉 text-plain / text-code 这些排版类
  pane.mdDoc.className = "md-doc";
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

/* ---------------- 文本类文档 ---------------- */
function openText(doc, pane) {
  const area = pane.scrollArea;
  area.scrollTop = 0;
  // 同一份文档在本次会话内切回来时保留用户的视图选择；换一份文档则回到默认视图
  if (!pane.textView || pane.textView.bookId !== pane.book?.id) {
    pane.textView = { ...defaultTextView(doc), bookId: pane.book?.id };
  }
  pane.headingEls = [];

  if (isWindowed(doc)) {
    // 大文件只有等宽一途：窗口渲染靠固定行高换算滚动位置，软换行会改变行高、
    // 正文视图连行都不存在。行号常显——几十万行里没有行号就没法定位
    pane.textView.mode = "code";
    pane.textView.gutter = true;
    pane.textView.wrap = false;
    pane.table = null;
    mountWindowed(pane, doc);
    if (doc.clipped) toast(t("reader.textClipped"));
  } else {
    // 表格视图的摘要（行列数、分隔符）留给工具栏与信息面板用
    pane.table = renderText(doc, pane.mdDoc, pane.textView).table;
    // 高亮异步补上：先把等宽纯文本给出去，别让打开动作等 hljs 算完
    scheduleHighlight(pane, doc, pane.mdDoc);
  }

  if (doc.truncated) toast(t("reader.textTruncated"));
  if (pane.index === activePaneIndex) {
    renderToolbar();
    renderCtx();
    updateDocSub();
  }

  requestAnimationFrame(() => scrollPaneToRatio(pane, pane.book?.progress.ratio || 0));
}

/**
 * 视图开关变更后刷新。
 *
 * 只有「正文 ↔ 等宽」需要重建 DOM（两者结构完全不同），此时保留滚动比例。
 * 行号与软换行只影响类名，走 applyTextView——不重建、不丢高亮、不挪滚动条。
 */
function refreshTextView(pane = activePane(), { rerender = true } = {}) {
  if (!pane?.doc || pane.doc.kind !== "text" || !pane.textView) return;
  // 大文件锁死在等宽：工具栏上的视图开关都已禁用，这里再兜一层，
  // 免得别的路径（比如恢复进度）误触把窗口渲染换掉
  if (isWindowed(pane.doc)) return;
  const area = pane.scrollArea;
  const span = area.scrollHeight - area.clientHeight;
  const ratio = span > 0 ? area.scrollTop / span : 0;

  if (rerender) {
    pane.table = renderText(pane.doc, pane.mdDoc, pane.textView).table;
    scheduleHighlight(pane, pane.doc, pane.mdDoc);
  } else {
    applyTextView(pane.mdDoc, pane.textView);
  }
  if (pane.index === activePaneIndex) renderToolbar();
  if (rerender) requestAnimationFrame(() => scrollPaneToRatio(pane, ratio));
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

export { openBook, updateDocSub, openPdf, openMarkdown, openText, refreshTextView, ensurePdfReader, handleZoomChange, handlePageChange, handlePdfReady };
