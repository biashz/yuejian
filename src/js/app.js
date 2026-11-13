/**
 * 阅笺 · 应用主逻辑
 * 书架（Rust 持久化）→ 打开文档 → PDF（pdf.js）/ Markdown（comrak）阅读
 */
import { invoke, isTauri, currentWindow } from "./api.js";
import { PdfReader, ZOOM_MAX, ZOOM_MIN } from "./reader-pdf.js";
import { renderMarkdown, setupScrollSpy, scrollToHeading } from "./reader-md.js";
import { t, getLanguage, setLanguage, applyDom, formatMonthDay } from "./i18n.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const THEME_ORDER = ["paper", "night", "sepia"];
const KIND_LABEL = { pdf: "PDF", markdown: "MARKDOWN" };
const KIND_CLASS = { pdf: "pdf", markdown: "md" };
/* 主题名与文档类型名随语言切换，用函数取值避免缓存旧语言文案 */
const themeLabel = (theme) => t(`status.theme.${theme}`);
const kindLabel = (kind) => KIND_LABEL[kind] || t("library.document");
const TINTS = ["clay", "indigo", "olive", "sand", "plum"];
const SIZE_STEPS = [15, 17, 19, 21];
/* 缩放档位：按钮、Ctrl+滚轮与快捷键都按档位步进，与常见阅读器一致 */
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
/* 菜单里展示的常用比例：点击即可切换，不必反复点加减 */
const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const DEFAULT_SETTINGS = {
  theme: "paper", fontSize: 17, lineHeight: 1.9, measure: 720,
  showCtx: true, zen: false, linkSync: true, language: "zh",
};

const state = {
  books: [],
  settings: { ...DEFAULT_SETTINGS },
  view: "library",
  filter: "all",
  query: "",
  ctxTab: "toc",
  ctxOpen: true,
  currentId: null,
  current: null,
  doc: null,
  pdfPage: 1,
  pdfZoom: 1,
  pdfTotal: 0,
  pdfOutline: null,
  findQuery: "",
  paletteIndex: 0,
};

/* 模块级句柄，避免反复创建 */
/* 双栏阅读：每个分栏各自持有 DOM、PDF reader 与阅读位置 */
const panes = [];
let activePaneIndex = 0;
let splitMode = false;
let linkSync = true;
let saveTimer = 0;
let findTimer = 0;
let findToken = 0;
let thumbObserver = null;
let zoomMenuOpen = false;

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

function tintOf(id) {
  let hash = 0;
  for (const ch of String(id)) hash = (hash * 31 + ch.charCodeAt(0)) % 997;
  return TINTS[hash % TINTS.length];
}

function percentOf(book) {
  return Math.round(clamp(book?.progress?.ratio || 0, 0, 1) * 100);
}

function formatRelative(ms) {
  if (!ms) return t("time.notOpened");
  const diff = Date.now() - ms;
  if (diff < 60_000) return t("time.justNow");
  if (diff < 3_600_000) return t("time.minutesAgo", { count: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t("time.hoursAgo", { count: Math.floor(diff / 3_600_000) });
  if (diff < 7 * 86_400_000) return t("time.daysAgo", { count: Math.floor(diff / 86_400_000) });
  const date = new Date(ms);
  return formatMonthDay(date.getMonth(), date.getDate());
}

function formatBytes(size) {
  if (!size) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/* ---------------- 书架渲染 ---------------- */
function visibleBooks() {
  const query = state.query.toLowerCase();
  return state.books
    .filter((book) => {
      if (state.filter === "star" && !book.favorite) return false;
      if ((state.filter === "pdf" || state.filter === "markdown") && book.kind !== state.filter) return false;
      if (query && !`${book.title} ${book.author}`.toLowerCase().includes(query)) return false;
      return true;
    })
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

function bookProgressText(book) {
  if (book.kind === "pdf") {
    const pages = book.pages ? t("reader.pagesCount", { count: book.pages }) : "";
    return pages ? `${pages} · ${formatBytes(book.size)}` : formatBytes(book.size);
  }
  const words = book.words ? t("reader.wordsCount", { count: book.words }) : "Markdown";
  return `${words} · ${formatBytes(book.size)}`;
}

function renderBookList(books) {
  const list = $("#bookList");
  $("#libCount").textContent = state.books.length;
  if (!books.length) {
    const emptyText = state.books.length
      ? `${t("library.noMatch")}<br>${t("library.tryAnother")}`
      : `${t("library.emptyList")}<br>${t("library.emptyListHint")}`;
    list.innerHTML = `<div class="ctx-empty">${emptyText}</div>`;
    return;
  }
  list.innerHTML = books.map((book) => `
    <div class="book-row ${book.id === state.currentId ? "is-current" : ""}" data-book="${book.id}" role="button" tabindex="0">
      <div class="mini-cover tint-${tintOf(book.id)}"><span>${escapeHtml(book.title.slice(0, 1))}</span></div>
      <div class="book-row-main">
        <div class="book-row-title">${escapeHtml(book.title)}</div>
        <div class="book-row-meta">
          <i class="type-dot ${KIND_CLASS[book.kind] || "md"}"></i>${kindLabel(book.kind)} · ${formatRelative(book.lastOpenedAt)}
        </div>
        <div class="progress-line"><i style="width:${percentOf(book)}%"></i></div>
      </div>
      <button class="remove-btn" data-remove="${book.id}" title="${t("library.remove")}">
        <svg class="ic"><use href="#i-trash"/></svg>
      </button>
    </div>`).join("");
}

function renderGrid(books) {
  const grid = $("#bookGrid");
  if (!books.length) {
    grid.innerHTML = state.books.length ? `<div class="ctx-empty">${t("library.noMatch")}</div>` : "";
    return;
  }
  grid.innerHTML = books.map((book, index) => `
    <div class="book-card" data-book="${book.id}" tabindex="0" style="animation-delay:${140 + index * 40}ms">
      <div class="cover tint-${tintOf(book.id)}">
        <div class="cover-inner">
          <span class="cover-kind">${kindLabel(book.kind)}</span>
          <span class="cover-title">${escapeHtml(book.title)}</span>
          <span class="cover-rule"></span>
          <span class="cover-author">${escapeHtml(bookProgressText(book))}</span>
        </div>
        <span class="cover-badge ${book.favorite ? "is-on" : ""}" data-star="${book.id}" title="${book.favorite ? t("library.unfavorite") : t("library.favorite")}">
          <svg class="ic"><use href="#i-star"/></svg>
        </span>
      </div>
      <div class="card-meta">
        <div class="card-title">${escapeHtml(book.title)}</div>
        <div class="card-sub">${kindLabel(book.kind)} · ${formatRelative(book.lastOpenedAt)}</div>
        <div class="card-foot">
          <span class="progress-line"><i style="width:${percentOf(book)}%"></i></span>
          <span class="card-pct">${percentOf(book)}%</span>
        </div>
      </div>
    </div>`).join("");
}

function renderResume() {
  const card = $("#resumeCard");
  const candidate =
    state.books.filter((book) => book.progress.ratio > 0.001 && book.progress.ratio < 0.999)
      .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0] ||
    state.books.slice().sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0];

  if (!candidate) {
    card.hidden = true;
    card.innerHTML = "";
    return;
  }

  card.hidden = false;
  const percent = percentOf(candidate);
  const page = candidate.progress.page || Math.max(1, Math.round(candidate.progress.ratio * (candidate.pages || 1)));
  card.dataset.book = candidate.id;
  card.innerHTML = `
    <div class="resume-cover tint-${tintOf(candidate.id)}">
      <div class="cover-inner">
        <span class="cover-kind">${kindLabel(candidate.kind)}</span>
        <span class="cover-title">${escapeHtml(candidate.title)}</span>
        <span class="cover-rule"></span>
        <span class="cover-author">${escapeHtml(bookProgressText(candidate))}</span>
      </div>
    </div>
    <div class="resume-info">
      <h3>${escapeHtml(candidate.title)}</h3>
      <p>${kindLabel(candidate.kind)} · ${escapeHtml(bookProgressText(candidate))}</p>
      <div class="resume-meta">
        <span>${candidate.kind === "pdf" ? t("reader.pageN", { page: `<b>${page}</b>` }) : t("reader.lastPosition")}</span>
        <span>${t("reader.openedAt", { time: `<b>${formatRelative(candidate.lastOpenedAt)}</b>` })}</span>
      </div>
      <span class="resume-go" data-book="${candidate.id}">${t("reader.continue")}
        <svg class="ic" style="width:13px;height:13px"><use href="#i-chevron-right"/></svg>
      </span>
    </div>
    <div class="resume-progress">
      <div class="bar"><i style="width:${percent}%"></i></div>
      <div class="label"><span>${t("reader.readingProgress")}</span><span>${percent}%</span></div>
    </div>`;
}

function renderStats() {
  $("#statBooks").textContent = state.books.length;
  $("#statReading").textContent = state.books.filter((book) => book.progress.ratio > 0.001 && book.progress.ratio < 0.999).length;
  $("#statPages").textContent = state.books.reduce((sum, book) => sum + (book.pages || 0), 0);
}

function renderLibrary() {
  const books = visibleBooks();
  renderBookList(books);
  renderGrid(books);
  renderResume();
  renderStats();

  const empty = state.books.length === 0;
  $("#emptyLibrary").hidden = !empty;
  $("#gridHead").hidden = empty;
  $("#bookGrid").hidden = empty;
}

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

/* ---------------- 双栏阅读 ---------------- */
/** 当前活动栏：工具栏、目录、状态栏都以它为准 */
function activePane() {
  return panes[activePaneIndex] || null;
}

function activeReader() {
  return activePane()?.reader || null;
}

/** 两栏是否打开同一份文档（联动只在同文档时生效） */
function canLinkPanes() {
  return Boolean(splitMode && panes[0]?.book && panes[1]?.book && panes[0].book.id === panes[1].book.id);
}

/** 把活动栏的阅读状态回写到全局 state，复用原有工具栏/状态栏逻辑 */
function mirrorPane(pane) {
  state.currentId = pane.book?.id || null;
  state.current = pane.book || null;
  state.doc = pane.doc || null;
  state.pdfPage = pane.page;
  state.pdfZoom = pane.zoom;
  state.pdfTotal = pane.total;
  state.pdfOutline = pane.outline;
  state.findQuery = pane.query;
}

function initPanes() {
  $$("[data-pane-root]").forEach((root) => {
    const index = Number(root.dataset.paneRoot);
    const pane = {
      index,
      root,
      head: $(".pane-head", root),
      headTitle: $(".pane-title", root),
      headPos: $(".pane-pos", root),
      scrollArea: $(".scroll-area", root),
      pdfStack: $(".pdf-stack", root),
      mdDoc: $(".md-doc", root),
      reader: null,
      doc: null,
      book: null,
      page: 1,
      zoom: 1,
      total: 0,
      ratio: 0,
      outline: null,
      query: "",
      hits: [],
      headingEls: [],
      spyCleanup: () => {},
      loadToken: 0,
    };

    // 点击或滚轮即激活该栏，避免“看着右栏却在操作左栏”
    root.addEventListener("pointerdown", () => activatePane(index));
    root.addEventListener("wheel", () => activatePane(index), { passive: true });
    // Ctrl + 滚轮缩放：与常见阅读器一致，同时拦住 WebView 默认的整页缩放。
    // 触控板会连续发出大量小 delta，累计到阈值才步进一档，避免一次手势跳好几档
    let zoomWheelAccum = 0;
    let zoomWheelTimer = 0;
    root.addEventListener("wheel", (event) => {
      if (!event.ctrlKey || pane.doc?.kind !== "pdf") return;
      event.preventDefault();
      if (pane.index !== activePaneIndex) activatePane(index);
      zoomWheelAccum += event.deltaY;
      clearTimeout(zoomWheelTimer);
      zoomWheelTimer = setTimeout(() => {
        zoomWheelAccum = 0;
      }, 220);
      if (Math.abs(zoomWheelAccum) < 40) return;
      zoomByStep(zoomWheelAccum < 0 ? 1 : -1);
      zoomWheelAccum = 0;
    }, { passive: false });
    $(".pane-open", root)?.addEventListener("click", (event) => {
      event.stopPropagation();
      activatePane(index);
      openPalette();
    });

    // Markdown 滚动：记录本栏位置，活动栏同时更新全局进度与联动
    let ticking = 0;
    pane.scrollArea.addEventListener("scroll", () => {
      if (ticking) return;
      ticking = requestAnimationFrame(() => {
        ticking = 0;
        const area = pane.scrollArea;
        const max = Math.max(1, area.scrollHeight - area.clientHeight);
        const ratio = clamp(area.scrollTop / max, 0, 1);
        pane.ratio = ratio;
        updatePaneHeads();
        if (pane.index !== activePaneIndex) return;
        if (pane.doc?.kind !== "markdown" || !pane.book) return;
        pane.book.progress = { ratio, page: 0, zoom: 1 };
        updateStatus();
        scheduleSave();
        maybeSync(pane, { page: 0, ratio });
      });
    }, { passive: true });

    panes[index] = pane;
  });
}

/** 同文档联动：把活动栏的位置同步给另一栏（PDF 精确到页内相对位置） */
function maybeSync(source, { page, ratio, pageOffset }) {
  if (!splitMode || !linkSync || source.index !== activePaneIndex) return;
  if (!canLinkPanes()) return;
  const target = panes[1 - source.index];
  if (!target?.book) return;
  if (source.book.kind === "pdf") {
    // 只同步页码会因两栏页内滚动量不同而错位，这里按页码 + 页内比例对齐
    if (!target.reader?.sheets?.length) return;
    target.reader.goPosition(page, pageOffset || 0);
    return;
  }
  if (Math.abs((target.ratio || 0) - ratio) < 0.002) return;
  scrollPaneToRatio(target, ratio);
}

/** 把另一栏对齐到活动栏当前位置：开启联动、分栏后新栏加载完成时调用 */
function syncToActivePane() {
  const source = activePane();
  if (!source?.book) return;
  const pos = source.reader?.currentPosition?.();
  maybeSync(source, { page: pos?.page ?? source.page, ratio: source.ratio, pageOffset: pos?.fraction ?? 0 });
}

function scrollPaneToRatio(pane, ratio) {
  const area = pane.scrollArea;
  const max = Math.max(0, area.scrollHeight - area.clientHeight);
  // 容器默认平滑滚动，联动时必须直接落位，否则每次同步都会重新开一段动画导致两栏追不上
  const previous = area.style.scrollBehavior;
  area.style.scrollBehavior = "auto";
  area.scrollTop = Math.round(clamp(ratio, 0, 1) * max);
  area.style.scrollBehavior = previous;
  pane.ratio = ratio;
}

/** 切换活动栏：把全局阅读状态切到新栏后刷新工具栏/目录/状态栏 */
function activatePane(index, force = false) {
  if (!panes[index]) return;
  if (index === activePaneIndex && !force) return;
  activePaneIndex = index;
  panes.forEach((pane) => pane.root.classList.toggle("is-active", pane.index === index));
  const pane = panes[index];
  // 用户接管这一栏后，放弃还没走完的联动落位校正
  pane.reader?.clearAnchor?.();
  mirrorPane(pane);

  $("#docTitle").textContent = pane.book?.title || t("reader.untitled");
  $("#starBtn").classList.toggle("is-on", Boolean(pane.book?.favorite));
  $("#ctxTabs").style.display = pane.book ? "flex" : "none";
  $("#ctxTabs [data-ctx='thumbs']").hidden = pane.book?.kind !== "pdf";
  $("#presentBtn").hidden = pane.book?.kind !== "pdf";
  // Markdown 栏没有缩略图，切回目录
  if (state.ctxTab === "thumbs" && pane.book?.kind !== "pdf") setCtxTabActive("toc");
  if (!pane.book) $("#ctxBody").innerHTML = "";

  updateDocSub();
  renderToolbar();
  renderCtx();
  updateStatus();
  updatePaneHeads();
}

function updatePaneHeads() {
  panes.forEach((pane) => {
    pane.head.hidden = !splitMode;
    pane.head.classList.toggle("is-active", pane.index === activePaneIndex);
    const book = pane.book;
    pane.headTitle.textContent = book?.title || t("reader.untitled");
    pane.headPos.textContent = book
      ? (book.kind === "pdf" ? t("reader.pageOf", { page: pane.page, total: pane.total || book.pages || "…" }) : `${Math.round((pane.ratio || 0) * 100)}%`)
      : "";
  });
}

/** 清空某个分栏；reader 实例保留，下次 open 时会自行重置 */
function closePaneDoc(pane) {
  pane.spyCleanup();
  pane.spyCleanup = () => {};
  pane.reader?.destroy();
  pane.doc = null;
  pane.book = null;
  pane.outline = null;
  pane.query = "";
  pane.hits = [];
  pane.headingEls = [];
  pane.page = 1;
  pane.zoom = 1;
  pane.total = 0;
  pane.ratio = 0;
  pane.loadToken += 1;
  pane.pdfStack.innerHTML = "";
  pane.mdDoc.innerHTML = "";
  pane.pdfStack.style.display = "none";
  pane.mdDoc.style.display = "none";
  pane.scrollArea.scrollTop = 0;
  if (pane.index === activePaneIndex) mirrorPane(pane);
  updatePaneHeads();
}

/** 拆分 / 合并双栏。拆分时右栏默认打开当前正在读的同一份文档 */
function setSplit(enabled) {
  if (enabled === splitMode || !panes[1]) return;
  splitMode = enabled;
  panes[1].root.hidden = !enabled;
  $("#readerPanes").classList.toggle("is-split", enabled);

  if (enabled) {
    if (panes[0].book) openBook(panes[0].book.id, panes[1]);
  } else {
    flushPaneProgress(panes[1]);
    // 左栏为空而只有右栏有文档时，把文档接回左栏，避免合并后什么都看不到
    const orphanId = panes[0].book ? null : panes[1].book?.id;
    closePaneDoc(panes[1]);
    if (activePaneIndex === 1) activatePane(0, true);
    if (orphanId) openBook(orphanId, panes[0]);
  }

  renderToolbar();
  updatePaneHeads();
  // 栏宽变化后重新计算 PDF 的适配宽度
  requestAnimationFrame(() => panes.forEach((pane) => pane.reader?.handleResize()));
}

function setLink(enabled) {
  linkSync = enabled;
  state.settings.linkSync = enabled;
  persistSettings();
  renderToolbar();
  // 开启联动时立刻把另一栏对齐到当前阅读位置，避免两栏停在各自位置等下一次滚动
  if (enabled && canLinkPanes()) syncToActivePane();
  toast(enabled ? t("toast.linkOn") : t("toast.linkOff"));
}

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

/* ---------------- 工具栏 ---------------- */
/** 缩放比例气泡菜单：常用比例 + 适合宽度 / 适合页面 */
function zoomMenuHtml() {
  return `<div class="zoom-menu" role="menu" aria-label="${t("reader.zoomMenu")}" hidden>
    <p class="zoom-menu-head">${t("reader.zoomMenu")}</p>
    ${ZOOM_PRESETS.map((value) => `
      <button class="zoom-item" role="menuitemradio" aria-checked="false" data-zoom="${value}">
        <span>${Math.round(value * 100)}%</span>
        <svg class="ic zoom-check"><use href="#i-check"/></svg>
      </button>`).join("")}
    <span class="zoom-menu-sep"></span>
    <button class="zoom-item" role="menuitemradio" aria-checked="false" data-fit-width>
      <svg class="ic zoom-fit"><use href="#i-fit-width"/></svg>
      <span>${t("reader.fitWidth")}</span>
      <svg class="ic zoom-check"><use href="#i-check"/></svg>
    </button>
    <button class="zoom-item" role="menuitemradio" aria-checked="false" data-fit-zoom>
      <svg class="ic zoom-fit"><use href="#i-maximize"/></svg>
      <span>${t("reader.fitPage")}</span>
      <svg class="ic zoom-check"><use href="#i-check"/></svg>
    </button>
  </div>`;
}

function renderToolbar() {
  const book = state.current;
  const bar = $("#readToolbar");
  // 工具栏整体重建，缩放菜单随之关闭
  zoomMenuOpen = false;
  if (!book) {
    bar.innerHTML = "";
    return;
  }

  // 双栏开关对所有文档生效；联动开关只在两栏同文档时出现
  const paneTools = `
      <span class="tool-sep"></span>
      <div class="tool-group">
        <button class="tool-btn ${splitMode ? "is-on" : ""}" data-act="split" title="${t("reader.split")}">
          <svg class="ic"><use href="#i-columns"/></svg>
        </button>
        ${canLinkPanes() ? `<button class="tool-btn ${linkSync ? "is-on" : ""}" data-act="link" title="${t("reader.link")}">
          <svg class="ic"><use href="#i-link"/></svg>
        </button>` : ""}
      </div>`;

  if (book.kind === "pdf") {
    const total = state.pdfTotal || book.pages || 0;
    bar.innerHTML = `
      <div class="tool-group">
        <button class="tool-btn" data-act="prev" title="${t("reader.prev")}"><svg class="ic"><use href="#i-chevron-left"/></svg></button>
        <input class="page-input" id="pageInput" type="number" min="1" max="${total || 1}" value="${state.pdfPage}" aria-label="${t("reader.pageInput")}" />
        <span class="page-total">/ ${total || "…"}</span>
        <button class="tool-btn" data-act="next" title="${t("reader.next")}"><svg class="ic"><use href="#i-chevron-right"/></svg></button>
      </div>
      <span class="tool-sep"></span>
      <div class="tool-group">
        <button class="tool-btn" data-act="zoom-out" title="${t("reader.zoomOut")}"><svg class="ic"><use href="#i-minus"/></svg></button>
        <span class="zoom-anchor">
          <button class="tool-btn zoom-label" data-act="zoom-menu" aria-haspopup="menu" aria-expanded="false" title="${t("reader.zoomMenu")}">${Math.round(state.pdfZoom * 100)}%</button>
          ${zoomMenuHtml()}
        </span>
        <button class="tool-btn" data-act="zoom-in" title="${t("reader.zoomIn")}"><svg class="ic"><use href="#i-plus"/></svg></button>
        <button class="tool-btn" data-act="present" title="${t("reader.present")}"><svg class="ic"><use href="#i-present"/></svg></button>
      </div>
      <span class="tool-sep"></span>
      <div class="tool-group">
        <button class="tool-btn ${state.ctxOpen ? "is-on" : ""}" data-act="ctx" title="${t("reader.ctx")}"><svg class="ic"><use href="#i-list"/></svg></button>
      </div>${paneTools}`;
  } else {
    const settings = state.settings;
    bar.innerHTML = `
      <div class="tool-group">
        <button class="tool-btn" data-act="font-down" title="${t("reader.fontDown")}">A−</button>
        <span class="page-total" style="min-width:34px;text-align:center">${settings.fontSize}px</span>
        <button class="tool-btn" data-act="font-up" title="${t("reader.fontUp")}">A+</button>
      </div>
      <span class="tool-sep"></span>
      <div class="tool-group">
        <button class="tool-btn" data-act="lh" title="${t("reader.lineHeightTip")}">${t("reader.lineHeightBtn", { value: settings.lineHeight })}</button>
        <button class="tool-btn" data-act="measure" title="${t("reader.measureTip")}">${t("reader.measureBtn", { value: settings.measure })}</button>
      </div>
      <span class="tool-sep"></span>
      <div class="tool-group">
        <button class="tool-btn ${state.ctxOpen ? "is-on" : ""}" data-act="ctx" title="${t("reader.ctx")}"><svg class="ic"><use href="#i-list"/></svg></button>
      </div>${paneTools}`;
  }
  updateToolbarPage();
}

function updateToolbarPage() {
  const input = $("#pageInput");
  if (input) input.value = state.pdfPage;
  const label = $('[data-act="zoom-menu"]');
  if (label) label.textContent = `${Math.round(state.pdfZoom * 100)}%`;
  const prev = $('[data-act="prev"]');
  const next = $('[data-act="next"]');
  if (prev) prev.disabled = state.pdfPage <= 1;
  if (next) next.disabled = state.pdfTotal > 0 && state.pdfPage >= state.pdfTotal;
  // 到缩放上下限时禁用对应按钮，避免点了没反应
  const zoomOut = $('[data-act="zoom-out"]');
  const zoomIn = $('[data-act="zoom-in"]');
  if (zoomOut) zoomOut.disabled = state.pdfZoom <= ZOOM_MIN + 0.005;
  if (zoomIn) zoomIn.disabled = state.pdfZoom >= ZOOM_MAX - 0.005;
  syncZoomMenu();
}

/** 展开 / 收起缩放比例菜单 */
function setZoomMenu(open) {
  const menu = $(".zoom-menu");
  const label = $('[data-act="zoom-menu"]');
  if (!menu || !label) return;
  zoomMenuOpen = open;
  menu.hidden = !open;
  label.setAttribute("aria-expanded", String(open));
  label.classList.toggle("is-on", open);
  if (open) syncZoomMenu();
}

/** 当前比例与适配模式在菜单里打勾 */
function syncZoomMenu() {
  const menu = $(".zoom-menu");
  if (!menu) return;
  const fitMode = activeReader()?.fitMode || null;
  $$("[data-zoom]", menu).forEach((item) => {
    const matched = !fitMode && Math.abs(Number(item.dataset.zoom) - state.pdfZoom) < 0.005;
    item.setAttribute("aria-checked", String(matched));
  });
  $("[data-fit-width]", menu)?.setAttribute("aria-checked", String(fitMode === "width"));
  $("[data-fit-zoom]", menu)?.setAttribute("aria-checked", String(fitMode === "page"));
}

function goPage(page, smooth = true) {
  const reader = activeReader();
  if (!reader) return;
  reader.goPage(page, smooth);
}

function setZoom(zoom) {
  const reader = activeReader();
  if (!reader) return;
  // 不传页码：以当前阅读位置为锚点，缩放后视线保持在同一处
  reader.setZoom(zoom);
  applyReaderZoom(reader);
}

/** 按档位步进缩放：方向 1 放大、-1 缩小；到头则停在边界 */
function zoomByStep(direction) {
  if (state.current?.kind !== "pdf" || !activeReader()) return;
  const current = state.pdfZoom;
  const epsilon = 0.005;
  const target = direction > 0
    ? ZOOM_STEPS.find((step) => step > current + epsilon)
    : [...ZOOM_STEPS].reverse().find((step) => step < current - epsilon);
  if (target == null) return;
  setZoom(target);
}

/** 适合页面（菜单项）：整页完整显示 */
function fitPdfPage() {
  const reader = activeReader();
  if (!reader) return;
  reader.fitPage();
  applyReaderZoom(reader);
  toast(t("reader.fitToast"));
}

/** 适合宽度（菜单项）：页宽撑满显示区域 */
function fitPdfWidth() {
  const reader = activeReader();
  if (!reader) return;
  reader.fitWidth();
  applyReaderZoom(reader);
  toast(t("reader.fitWidthToast"));
}

/** 把阅读器当前缩放回写到全局状态与工具栏 */
function applyReaderZoom(reader) {
  state.pdfZoom = reader.zoom;
  const pane = activePane();
  if (pane) pane.zoom = reader.zoom;
  updateToolbarPage();
  updateStatus();
}

/* ---------------- 目录 / 缩略图 / 搜索 ---------------- */
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

function renderCtx() {
  const book = state.current;
  if (!book) return;
  if (state.ctxTab === "toc") return renderToc();
  if (state.ctxTab === "thumbs") return renderThumbs();
  return renderFind();
}

async function renderToc() {
  const body = $("#ctxBody");
  const pane = activePane();
  const book = pane?.book;
  if (!book) return;

  if (book.kind === "pdf") {
    if (!pane.outline) {
      // PDF 尚未解析完成时先占位，等 onReady 再取大纲
      if (!pane.reader?.pdf) {
        body.innerHTML = `<div class="ctx-empty">${t("reader.tocLoading")}</div>`;
        return;
      }
      let outline = [];
      try {
        outline = await pane.reader.outline() || [];
      } catch (_) {
        outline = [];
      }
      if (state.ctxTab !== "toc" || activePane() !== pane || pane.book?.id !== book.id) return;
      pane.outline = outline;
      state.pdfOutline = outline;
    }
    if (!pane.outline.length) {
      body.innerHTML = `<div class="ctx-empty">${t("reader.tocPdfEmpty")}</div>`;
      return;
    }
    body.innerHTML = pane.outline.map((item) => `
      <button class="toc-item ${item.page === pane.page ? "is-active" : ""}"
        data-level="${item.level}" data-goto="${item.page}" data-kind="pdf">
        ${escapeHtml(item.text)}<span class="toc-page">${item.page}</span>
      </button>`).join("");
    return;
  }

  const toc = pane.doc?.toc || [];
  if (!toc.length) {
    body.innerHTML = `<div class="ctx-empty">${t("reader.tocMdEmpty")}</div>`;
    return;
  }
  body.innerHTML = toc.map((item) => `
    <button class="toc-item" data-level="${item.level}" data-goto="${escapeHtml(item.id)}" data-kind="md">
      ${escapeHtml(item.text)}
    </button>`).join("");
  markTocActive();
}

function markTocActive(id) {
  const items = $$("#ctxBody .toc-item");
  if (!items.length) return;
  if (typeof id === "string" && id) {
    items.forEach((item) => item.classList.toggle("is-active", item.dataset.goto === id));
    return;
  }
  const pane = activePane();
  if (!pane?.outline?.length) return;
  // PDF：取最后一个页码不超过当前页的条目
  let activeIndex = 0;
  pane.outline.forEach((item, index) => {
    if (item.page <= pane.page) activeIndex = index;
  });
  items.forEach((item, index) => item.classList.toggle("is-active", index === activeIndex));
}

function renderThumbs() {
  const body = $("#ctxBody");
  const pane = activePane();
  const total = pane?.total || pane?.book?.pages || 0;
  if (!total) {
    body.innerHTML = `<div class="ctx-empty">${t("reader.thumbsLoading")}</div>`;
    return;
  }
  body.innerHTML = Array.from({ length: total }, (_, index) => `
    <button class="thumb-item ${index + 1 === pane.page ? "is-active" : ""}" data-goto="${index + 1}" data-kind="pdf">
      <div class="thumb-page"><canvas data-thumb="${index + 1}"></canvas></div>
      <span class="thumb-no">${t("reader.pageN", { page: index + 1 })}</span>
    </button>`).join("");

  thumbObserver?.disconnect();
  thumbObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const canvas = entry.target;
      thumbObserver.unobserve(canvas);
      if (canvas.dataset.done) continue;
      canvas.dataset.done = "1";
      pane.reader?.renderThumb(Number(canvas.dataset.thumb), canvas).catch(() => {});
    }
  }, { root: body, rootMargin: "200px" });
  $$("canvas[data-thumb]", body).forEach((canvas) => thumbObserver.observe(canvas));

  body.querySelector(".thumb-item.is-active")?.scrollIntoView({ block: "nearest" });
}

function markThumbActive() {
  const pane = activePane();
  $$("#ctxBody .thumb-item").forEach((item) => {
    item.classList.toggle("is-active", Number(item.dataset.goto) === pane?.page);
  });
}

function renderFind() {
  const body = $("#ctxBody");
  const pane = activePane();
  const query = pane?.query || "";
  body.innerHTML = `
    <div class="find-box">
      <input id="findInput" type="text" placeholder="${t("reader.findPlaceholder")}" value="${escapeHtml(query)}" />
    </div>
    <div class="find-summary" id="findSummary">${t("reader.findHint")}</div>
    <div id="findHits"></div>`;

  const input = $("#findInput");
  input.addEventListener("input", () => {
    const current = activePane();
    if (!current) return;
    current.query = input.value.trim();
    state.findQuery = current.query;
    clearTimeout(findTimer);
    findTimer = setTimeout(runFind, 320);
  });
  if (query) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    runFind();
  }
}

async function runFind() {
  const pane = activePane();
  const query = pane?.query || "";
  const summary = $("#findSummary");
  const hitsWrap = $("#findHits");
  if (!summary || !hitsWrap) return;
  if (!query) {
    summary.textContent = t("reader.findHint");
    hitsWrap.innerHTML = "";
    return;
  }

  const token = ++findToken;
  const book = pane?.book;
  summary.textContent = book?.kind === "pdf" ? t("reader.findFullText") : t("reader.findSearching");

  const mark = (text) => {
    const safe = escapeHtml(text);
    const pattern = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    return safe.replace(pattern, "<mark>$1</mark>");
  };

  let hits = [];
  if (book?.kind === "pdf") {
    hits = await pane.reader?.search(query) || [];
    if (token !== findToken || activePane() !== pane) return;
    summary.textContent = hits.length
      ? `${t("reader.findMatches", { count: hits.length })}${hits.length >= 60 ? t("reader.findMatchesTrunc") : ""}`
      : t("reader.findNone");
    hitsWrap.innerHTML = hits.map((hit, index) => `
      <button class="find-hit" data-hit="${index}" data-page="${hit.page}" data-kind="pdf">
        <span class="hit-page">${t("reader.pageN", { page: hit.page })}</span>${mark(hit.text)}
      </button>`).join("");
    pane.hits = [];
    return;
  }

  const nodes = $$("h1, h2, h3, p, li, td, blockquote", pane.mdDoc);
  pane.hits = nodes.filter((node) => node.textContent.includes(query)).slice(0, 40);
  summary.textContent = pane.hits.length ? t("reader.findMatches", { count: pane.hits.length }) : t("reader.findNone");
  hitsWrap.innerHTML = pane.hits.map((node, index) => {
    const text = node.textContent.trim();
    const at = text.indexOf(query);
    const snippet = text.length > 70 ? `${text.slice(Math.max(0, at - 24), at + 46)}…` : text;
    const label = /^H[123]$/.test(node.tagName) ? t("reader.findHeading", { level: node.tagName.slice(1) }) : t("reader.findBody");
    return `<button class="find-hit" data-hit="${index}" data-kind="md">
      <span class="hit-page">${label}</span>${mark(snippet)}
    </button>`;
  }).join("");
}

/* ---------------- 演示模式（全屏单页放映，仅 PDF） ---------------- */
let presenting = false;
let presentPage = 1;
/// 每次翻页自增，用于丢弃过期的渲染结果
let presentRun = 0;
/// 串行队列：同一块离屏画布不能被两次 render 同时写入
let presentChain = Promise.resolve();
let presentBuffer = null;
let presentHintTimer = 0;
/// 首帧/尺寸变化的防抖：全屏过渡会连续触发 resize，等尺寸稳定后只画一次
let presentPaintTimer = 0;
/// 已画好的「页码 + 尺寸」，用于跳过重复渲染
let presentPaintedKey = "";
/// 全屏请求尚未落地：这段时间不重新渲染，避免和全屏动画抢帧
let presentEntering = false;
/// 滚轮翻页：先累积触控板的小增量，再用冷却避免一次滑动连翻多页
let presentWheelDelta = 0;
let presentWheelTimer = 0;
let presentWheelLock = 0;

function canPresent() {
  const pane = activePane();
  return Boolean(pane?.book && pane.book.kind === "pdf" && pane.reader?.pdf);
}

function enterPresent() {
  if (presenting) return;
  if (!canPresent()) {
    toast(t("reader.presentPdfOnly"));
    return;
  }
  presenting = true;
  presentPage = state.pdfPage || 1;
  presentPaintedKey = "";

  // 放映期间挂起背后阅读器的尺寸自适应与页渲染：全屏会改变窗口尺寸，
  // 若阅读器跟着重排重绘，会和首帧渲染抢主线程，切换时就会卡
  panes.forEach((pane) => pane.reader?.suspend());

  // 放映层先不显示：等首帧画好再和画布一起出现，中途不会露出纯黑底
  const canvas = $("#presentCanvas");
  canvas.style.visibility = "hidden";
  $("#presentStage").classList.remove("is-leaving");

  // 全屏请求必须紧跟用户手势，所以先发出去；过渡期间不做整页渲染，
  // 等尺寸稳定后再补一次（与首帧尺寸一致时会被去重，不会重复画）
  presentEntering = true;
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    presentEntering = false;
    // 全屏动画刚结束时主线程仍忙，稍等一拍再做整页渲染，切换更顺
    schedulePresentPaint(80);
  };
  const request = document.documentElement.requestFullscreen?.();
  if (request?.then) request.then(settle, settle);
  else settle();
  // 兜底：个别环境 fullscreen 的 promise 不落地，超时后照常放映
  setTimeout(settle, 600);

  // 先用屏幕上已经画好的那一页顶上：进入瞬间就有画面，
  // 整页高清渲染留到全屏动画结束之后，不和过渡抢主线程
  if (!showPresentSnapshot()) presentPaint();
}

/** 进入演示时复用阅读器已渲染的页面做首帧：不必等整页重绘，切换没有空窗 */
function showPresentSnapshot() {
  if (!$("#presentStage").hidden) return false;
  const reader = activeReader();
  const source = reader?.pageSnapshot(presentPage);
  if (!source) return false;
  const sourceWidth = source.width;
  const sourceHeight = source.height;
  if (!sourceWidth || !sourceHeight) return false;

  const viewWidth = window.innerWidth;
  const viewHeight = window.innerHeight;
  // 等比放进放映区（留 12px 边），与高清渲染使用同一套尺寸口径
  const scale = Math.min((viewWidth - 24) / sourceWidth, (viewHeight - 24) / sourceHeight);
  const cssWidth = Math.max(1, Math.floor(sourceWidth * scale));
  const cssHeight = Math.max(1, Math.floor(sourceHeight * scale));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const canvas = $("#presentCanvas");
  canvas.width = Math.floor(cssWidth * dpr);
  canvas.height = Math.floor(cssHeight * dpr);
  // 显示尺寸交给 CSS 按视口约束，不写死像素：切换/替换位图都不会跳尺寸
  canvas.style.width = "";
  canvas.style.height = "";
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  canvas.style.visibility = "visible";
  showPresentStage();
  $("#presentPage").textContent = `${presentPage} / ${reader.numPages || state.pdfTotal || 0}`;
  return true;
}

/** 首帧就绪后再放出放映层：避免「先黑屏、再出现页面」的闪烁 */
function showPresentStage() {
  const stage = $("#presentStage");
  if (!stage.hidden) return;
  stage.hidden = false;
  const hint = $("#presentHint");
  hint.classList.remove("is-hidden");
  clearTimeout(presentHintTimer);
  presentHintTimer = setTimeout(() => hint.classList.add("is-hidden"), 2800);
}

/** 排一次放映页渲染；延迟期间有新的调用（如 resize）会重新计时 */
function schedulePresentPaint(delay = 120) {
  clearTimeout(presentPaintTimer);
  presentPaintTimer = setTimeout(() => {
    presentPaintTimer = 0;
    presentPaint();
  }, delay);
}

function exitPresent() {
  if (!presenting) return;
  presenting = false;
  presentEntering = false;
  presentRun += 1;
  clearTimeout(presentPaintTimer);
  presentPaintTimer = 0;
  clearTimeout(presentWheelTimer);
  presentWheelTimer = 0;
  presentWheelDelta = 0;
  presentPaintedKey = "";
  activeReader()?.cancelPaintFit();

  // 退出时先不收起放映层：全屏收回的动画期间屏幕上保持放映页，
  // 等系统真正退出全屏后再淡出、恢复阅读视图，中间不会闪出底下的阅读页
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    document.removeEventListener("fullscreenchange", release);
    const stage = $("#presentStage");
    const restore = () => {
      stage.hidden = true;
      stage.classList.remove("is-leaving");
      panes.forEach((pane) => pane.reader?.resume());
      const reader = activeReader();
      // 回到放映时停留的页，阅读位置与演示保持一致
      reader?.goPage(presentPage, false);
      // 全屏期间尺寸被挂起，退出后补一次适配（rAF 等布局稳定）
      requestAnimationFrame(() => reader?.handleResize());
    };
    // 放映层从未显示过（首帧还没画完就退出）：直接恢复
    if (stage.hidden) {
      restore();
      return;
    }
    // 150ms 淡出，与进入时的淡入对称，切换不会「啪」地硬切
    stage.classList.add("is-leaving");
    setTimeout(restore, 150);
  };

  // 先复位状态再退出全屏，避免 fullscreenchange 再次进来
  if (document.fullscreenElement) {
    document.addEventListener("fullscreenchange", release);
    document.exitFullscreen?.().catch(release);
    // 兜底：个别环境不派发 fullscreenchange，避免阅读器一直处于挂起状态
    setTimeout(release, 600);
  } else {
    release();
  }
}

function presentStep(delta) {
  if (!presenting) return;
  const total = activeReader()?.numPages || state.pdfTotal || 0;
  if (!total) return;
  const next = clamp(presentPage + delta, 1, total);
  if (next === presentPage) return;
  presentPage = next;
  state.pdfPage = next;
  presentPaint();
}

/** 滚轮翻页：向下下一页、向上上一页；触控板的小增量先累积，再用冷却避免连翻多页 */
function handlePresentWheel(event) {
  if (!presenting) return;
  event.preventDefault();
  const now = performance.now();
  if (now < presentWheelLock) return;
  presentWheelDelta += event.deltaY;
  clearTimeout(presentWheelTimer);
  presentWheelTimer = setTimeout(() => {
    presentWheelDelta = 0;
  }, 160);
  if (Math.abs(presentWheelDelta) < 40) return;
  const direction = presentWheelDelta > 0 ? 1 : -1;
  presentWheelDelta = 0;
  presentWheelLock = now + 400;
  presentStep(direction);
}

function presentPaint() {
  const reader = activeReader();
  if (!presenting || !reader) return;
  const pageNo = presentPage;
  // 尺寸统一取当前可视区：全屏后 innerWidth 就是屏幕尺寸，
  // 不必用 screen 预估，也避免刚进入时页面被放大出可视区
  const box = { width: window.innerWidth - 24, height: window.innerHeight - 24 };
  const key = `${pageNo}:${box.width}x${box.height}`;
  // 同一页、同一尺寸已经画好：重复的 resize 事件不必再渲染
  if (key === presentPaintedKey) {
    showPresentStage();
    return;
  }

  const run = ++presentRun;
  // 旧页还在渲染时先取消，翻页/全屏切换不用排队等它画完
  reader.cancelPaintFit();

  presentChain = presentChain.then(async () => {
    // 队列里已有更新的翻页请求，这一帧直接跳过
    if (!presenting || run !== presentRun) return;
    presentBuffer ??= document.createElement("canvas");
    // 传一个失效判断：getPage 等待期间若又翻页，就不必再启动这一页的渲染
    const painted = await reader.paintFit(pageNo, presentBuffer, box, () => !presenting || run !== presentRun);
    if (!presenting || run !== presentRun) return;
    // 渲染失败也要把放映层放出来，否则看起来像点击没反应
    if (!painted) {
      showPresentStage();
      return;
    }

    // 离屏画好后一次性贴到可见画布，翻页不会闪白
    const canvas = $("#presentCanvas");
    canvas.width = presentBuffer.width;
    canvas.height = presentBuffer.height;
    // 清掉内联尺寸，继续由 CSS 按视口约束显示，避免替换时尺寸跳变
    canvas.style.width = "";
    canvas.style.height = "";
    canvas.getContext("2d").drawImage(presentBuffer, 0, 0);
    canvas.style.visibility = "visible";
    // 首帧与放映层同一帧出现，不会先露黑底
    showPresentStage();
    presentPaintedKey = key;
    $("#presentPage").textContent = `${pageNo} / ${reader.numPages || state.pdfTotal || 0}`;
  }).catch(() => {
    // 单帧失败不能污染队列，否则后续翻页都会停在 rejected 状态
  });
}

/* ---------------- 主题与排版 ---------------- */
function applySettings() {
  const settings = state.settings;
  document.documentElement.style.setProperty("--read-size", `${settings.fontSize}px`);
  document.documentElement.style.setProperty("--read-lh", String(settings.lineHeight));
  document.documentElement.style.setProperty("--measure", `${settings.measure}px`);
  document.body.classList.toggle("zen", Boolean(settings.zen));
}

function setTheme(theme, silent = false) {
  state.settings.theme = theme;
  document.documentElement.dataset.theme = theme;
  $("#themeBtn use").setAttribute("href", theme === "night" ? "#i-moon" : "#i-sun");
  $("#statusMid").textContent = themeLabel(theme);
  $$(".theme-swatch").forEach((item) => item.classList.toggle("is-on", item.dataset.themeValue === theme));
  persistSettings();
  if (!silent) toast(t("theme.switched", { theme: themeLabel(theme) }));
}

function cycleTheme() {
  const next = THEME_ORDER[(THEME_ORDER.indexOf(state.settings.theme) + 1) % THEME_ORDER.length];
  setTheme(next);
}

function toggleZen() {
  state.settings.zen = !state.settings.zen;
  applySettings();
  syncSettingsUI();
  persistSettings();
  toast(state.settings.zen ? t("zen.on") : t("zen.off"));
}

/* ---------------- 持久化 ---------------- */
let settingsTimer = 0;
function persistSettings() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    invoke("save_settings", { settings: state.settings }).catch(() => {});
  }, 200);
}

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
  }).catch(() => {});
}

/* ---------------- 状态栏 ---------------- */
function updateStatus() {
  const book = state.current;
  if (state.view === "reading" && book) {
    $("#statusLeft").textContent = book.title;
    $("#statusRight").textContent = book.kind === "pdf"
      ? t("status.page", { page: state.pdfPage, total: state.pdfTotal || book.pages || "…", zoom: Math.round(state.pdfZoom * 100) })
      : t("status.markdown", { words: book.words || 0, size: state.settings.fontSize, lh: state.settings.lineHeight });
  } else {
    $("#statusLeft").textContent = t("status.ready");
    $("#statusRight").textContent = t("status.documents", { count: state.books.length });
  }
  $("#statusMid").textContent = themeLabel(state.settings.theme);
}

/* ---------------- Toast ---------------- */
let toastTimer = null;
// 复用同一个提示元素：连续触发时只重置计时，避免旧提示丢失计时器而永久停留
function toast(message) {
  const wrap = $("#toastWrap");
  let el = wrap.firstElementChild;
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    el.innerHTML = '<svg class="ic"><use href="#i-check"/></svg><span></span>';
    wrap.appendChild(el);
  }
  el.querySelector("span").textContent = message;
  el.classList.remove("is-out");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.add("is-out");
    toastTimer = setTimeout(() => el.remove(), 220);
  }, 2200);
}

/* ---------------- 导入文档 ---------------- */
async function importDocuments(paths) {
  let list = paths;
  if (!list?.length) {
    try {
      list = await invoke("pick_files");
    } catch (error) {
      toast(String(error));
      return 0;
    }
  }
  if (!list?.length) return 0;

  try {
    state.books = await invoke("import_files", { paths: list });
  } catch (error) {
    toast(String(error));
    return 0;
  }
  renderLibrary();
  updateStatus();

  const normalized = list.map((path) => path.replace(/\//g, "\\").toLowerCase());
  const imported = state.books.find((book) => normalized.includes(book.path.toLowerCase()));
  toast(t("toast.imported", { count: list.length }));
  if (list.length === 1 && imported) openBook(imported.id);
  return list.length;
}

/* ---------------- 确认弹框 ---------------- */
let confirmSettle = null;

/**
 * 纸感「注销单」确认框，替代系统弹框。
 * 返回 Promise<boolean>：点「移出」为 true，取消 / ESC / 点遮罩为 false。
 */
function askConfirm({ title, book, note, okText }) {
  const overlay = $("#confirmOverlay");
  const card = $("#confirmCard");
  const lastFocus = document.activeElement;
  $("#confirmTitle").textContent = title;
  // 书名放进内层 span，由 CSS 单独做两行截断（外层 padding 不参与裁切）
  $("#confirmBook").innerHTML = "<span></span>";
  $("#confirmBook span").textContent = book;
  $("#confirmNote").textContent = note;
  $("#confirmOk").textContent = okText;
  overlay.hidden = false;
  // 焦点落在单据本体而非按钮上：避免默认聚焦「取消」造成的强调边框，Tab 再进入按钮
  card.focus();

  return new Promise((resolve) => {
    // 结算只做一次：双击按钮、ESC 与遮罩点击不会重复触发
    const settle = (result) => {
      if (!confirmSettle) return;
      confirmSettle = null;
      overlay.hidden = true;
      overlay.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKeydown, true);
      lastFocus?.focus?.();
      resolve(result);
    };
    const onClick = (event) => {
      if (event.target.closest("#confirmOk")) settle(true);
      else if (event.target === overlay || event.target.closest("#confirmCancel")) settle(false);
    };
    // 捕获阶段截下 ESC：否则会继续冒泡触发全局「退出阅读」快捷键
    const onKeydown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      settle(false);
    };
    confirmSettle = settle;
    overlay.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeydown, true);
  });
}

async function removeBook(id) {
  const book = state.books.find((item) => item.id === id);
  if (!book) return;
  const confirmed = await askConfirm({
    title: t("confirm.title"),
    book: book.title,
    note: t("confirm.note"),
    okText: t("confirm.ok"),
  });
  if (!confirmed) return;
  try {
    state.books = await invoke("remove_book", { id });
  } catch (error) {
    toast(String(error));
    return;
  }
  // 任何一栏打开了这份文档都要一起关闭
  let closedActive = false;
  panes.forEach((pane) => {
    if (pane.book?.id !== id) return;
    if (pane.index === activePaneIndex) closedActive = true;
    closePaneDoc(pane);
  });
  if (!panes.some((pane) => pane.book)) setView("library");
  else if (closedActive) {
    // 活动栏被清空时切到还有文档的那一栏
    const fallback = panes.find((pane) => pane.book) || activePane();
    activatePane(fallback.index, true);
  }
  renderLibrary();
  updateStatus();
  toast(t("confirm.removed", { title: book.title }));
}

async function toggleFavorite(id) {
  try {
    const updated = await invoke("toggle_favorite", { id });
    const index = state.books.findIndex((book) => book.id === id);
    if (index >= 0) state.books[index] = updated;
    // 分栏里保存的是书籍对象引用，替换后要同步，否则收藏状态会丢
    panes.forEach((pane) => {
      if (pane.book?.id === id) pane.book = updated;
    });
    if (state.currentId === id) {
      state.current = updated;
      $("#starBtn").classList.toggle("is-on", updated.favorite);
    }
    renderLibrary();
    toast(updated.favorite ? t("toast.favorited", { title: updated.title }) : t("toast.unfavorited", { title: updated.title }));
  } catch (error) {
    toast(String(error));
  }
}

/* ---------------- 命令面板 ---------------- */
function openPalette() {
  $("#paletteOverlay").hidden = false;
  state.paletteIndex = 0;
  const input = $("#paletteInput");
  input.value = "";
  renderPalette("");
  setTimeout(() => input.focus(), 30);
}

function closePalette() {
  $("#paletteOverlay").hidden = true;
}

function paletteItems(query) {
  const keyword = query.trim().toLowerCase();
  const books = state.books
    .filter((book) => !keyword || `${book.title} ${book.author}`.toLowerCase().includes(keyword))
    .slice(0, 6)
    .map((book) => ({
      group: t("palette.documents"),
      icon: book.kind === "pdf" ? "file-text" : "book-open",
      title: book.title,
      sub: `${kindLabel(book.kind)} · ${formatRelative(book.lastOpenedAt)}`,
      run: `open:${book.id}`,
    }));

  const actions = [
    { title: t("palette.import"), sub: t("palette.importSub"), icon: "folder-plus", run: "import" },
    { title: t("palette.theme"), sub: t("palette.themeSub"), icon: "sun", run: "theme" },
    { title: t("palette.zen"), sub: t("palette.zenSub"), icon: "maximize", run: "zen" },
    { title: splitMode ? t("palette.merge") : t("palette.split"), sub: t("palette.splitSub"), icon: "columns", run: "split" },
    { title: t("palette.present"), sub: t("palette.presentSub"), icon: "present", run: "present" },
    { title: t("palette.settings"), sub: t("palette.settingsSub"), icon: "settings", run: "settings" },
    { title: t("palette.back"), sub: t("palette.backSub"), icon: "library", run: "back" },
  ].filter((action) => !keyword || `${action.title} ${action.sub}`.toLowerCase().includes(keyword))
    .map((action) => ({ ...action, group: t("palette.actions") }));

  return [...books, ...actions];
}

function renderPalette(query) {
  const items = paletteItems(query);
  const list = $("#paletteList");
  if (!items.length) {
    list.innerHTML = `<div class="ctx-empty">${t("palette.empty")}</div>`;
    return;
  }
  state.paletteIndex = clamp(state.paletteIndex, 0, items.length - 1);

  let html = "";
  let lastGroup = "";
  items.forEach((item, index) => {
    if (item.group !== lastGroup) {
      html += `<div class="palette-group">${item.group}</div>`;
      lastGroup = item.group;
    }
    html += `<button class="palette-item ${index === state.paletteIndex ? "is-active" : ""}" data-pi="${index}">
      <svg class="ic"><use href="#i-${item.icon}"/></svg>
      <span class="pi-main">
        <span class="pi-title">${escapeHtml(item.title)}</span>
        <span class="pi-sub">${escapeHtml(item.sub)}</span>
      </span>
      <svg class="ic" style="width:13px;height:13px;color:var(--ink-3)"><use href="#i-corner-down-right"/></svg>
    </button>`;
  });
  list.innerHTML = html;
  list.dataset.items = JSON.stringify(items.map((item) => item.run));
  list.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
}

function runPalette(run) {
  closePalette();
  if (!run) return;
  if (run.startsWith("open:")) return openBook(run.slice(5));
  if (run === "import") return importDocuments();
  if (run === "theme") return cycleTheme();
  if (run === "zen") return toggleZen();
  if (run === "split") return setSplit(!splitMode);
  if (run === "present") return enterPresent();
  if (run === "settings") return openSettings();
  if (run === "back") return setView("library");
}

/* ---------------- 设置面板 ---------------- */
function openSettings() {
  syncSettingsUI();
  $("#settingsOverlay").hidden = false;
}

function closeSettings() {
  $("#settingsOverlay").hidden = true;
}

function syncSettingsUI() {
  const settings = state.settings;
  $$("#fontSizeSeg button").forEach((button) => button.classList.toggle("is-on", Number(button.dataset.size) === settings.fontSize));
  $$("#lineHeightSeg button").forEach((button) => button.classList.toggle("is-on", Number(button.dataset.lh) === settings.lineHeight));
  $$("#measureSeg button").forEach((button) => button.classList.toggle("is-on", Number(button.dataset.measure) === settings.measure));
  $$("#langSeg button").forEach((button) => button.classList.toggle("is-on", button.dataset.lang === getLanguage()));
  $("#switchCtx").classList.toggle("is-on", settings.showCtx);
  $("#switchCtx").setAttribute("aria-checked", String(settings.showCtx));
  $("#switchZen").classList.toggle("is-on", settings.zen);
  $("#switchZen").setAttribute("aria-checked", String(settings.zen));
  $$(".theme-swatch").forEach((item) => item.classList.toggle("is-on", item.dataset.themeValue === settings.theme));
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
  $("#docTitle").textContent = state.current?.title || t("reader.untitled");
  $("#tbTitle").textContent = state.view === "reading"
    ? ($("#docTitle").textContent || t("nav.reading"))
    : t("nav.shelf");
  // 命令面板打开时按新语言重建列表
  if (!$("#paletteOverlay").hidden) renderPalette($("#paletteInput").value);
  persistSettings();
}

/* ---------------- 事件绑定 ---------------- */
function bind() {
  // 文档打开 / 收藏 / 移除
  document.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-remove]");
    if (remove) {
      event.stopPropagation();
      removeBook(remove.dataset.remove);
      return;
    }
    const star = event.target.closest("[data-star]");
    if (star) {
      event.stopPropagation();
      toggleFavorite(star.dataset.star);
      return;
    }
    const anchor = event.target.closest(".md-doc a[href]");
    if (anchor) {
      const href = anchor.getAttribute("href") || "";
      if (/^https?:/i.test(href)) {
        event.preventDefault();
        toast(t("toast.linkCopied", { url: href }));
        navigator.clipboard?.writeText(href).catch(() => {});
        return;
      }
      if (href.startsWith("#")) {
        event.preventDefault();
        const paneRoot = event.target.closest("[data-pane-root]");
        const area = paneRoot ? $(".scroll-area", paneRoot) : null;
        if (area) scrollToHeading(area, href.slice(1));
        return;
      }
      if (/\.(md|markdown)$/i.test(href)) {
        event.preventDefault();
        toast(t("toast.crossDoc"));
        return;
      }
    }
    const bookEl = event.target.closest("[data-book]");
    if (bookEl) openBook(bookEl.dataset.book);
  });

  // 导航
  $$(".rail-btn").forEach((button) => button.addEventListener("click", () => {
    const nav = button.dataset.nav;
    if (nav === "library") setView("library");
    if (nav === "reading") {
      if (state.currentId) {
        setView("reading");
      } else if (panes.some((pane) => pane.book)) {
        // 活动栏为空但另一栏有文档时，直接切到有文档的那一栏
        const opened = panes.find((pane) => pane.book);
        activatePane(opened.index, true);
        setView("reading");
      } else if (state.books.length) {
        openBook(state.books.slice().sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0].id);
      } else {
        toast(t("toast.emptyShelf"));
      }
    }
    if (nav === "search") openPalette();
    if (nav === "settings") openSettings();
  }));

  // 书架搜索与过滤
  $("#libSearch").addEventListener("input", (event) => {
    state.query = event.target.value.trim();
    renderBookList(visibleBooks());
    renderGrid(visibleBooks());
  });
  $("#filterRow").addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    state.filter = chip.dataset.filter;
    $$("#filterRow .chip").forEach((item) => item.classList.toggle("is-on", item === chip));
    renderBookList(visibleBooks());
    renderGrid(visibleBooks());
  });

  // 导入
  ["#importBtn", "#importCta", "#emptyImport"].forEach((selector) => $(selector)?.addEventListener("click", () => importDocuments()));

  // 文档栏
  $("#backBtn").addEventListener("click", () => setView("library"));
  $("#starBtn").addEventListener("click", () => state.current && toggleFavorite(state.current.id));
  $("#zenBtn").addEventListener("click", toggleZen);
  $("#presentBtn").addEventListener("click", enterPresent);
  // 点击右半屏下一页、左半屏上一页，方便鼠标/投屏笔操作
  $("#presentStage").addEventListener("click", (event) => {
    // 底部是提示与页码区域，不当作翻页
    if (event.clientY > window.innerHeight - 60) return;
    presentStep(event.clientX < window.innerWidth / 2 ? -1 : 1);
  });
  // 滚轮/触控板翻页：向下下一页、向上上一页
  $("#presentStage").addEventListener("wheel", handlePresentWheel, { passive: false });
  window.addEventListener("resize", () => {
    // 全屏切换会连续触发 resize：防抖后只重画最后一次的尺寸；
    // 全屏过渡期间先不画，等 fullscreen 的 promise 落地后再排首帧
    if (presenting && !presentEntering) schedulePresentPaint();
  });
  document.addEventListener("fullscreenchange", () => {
    // 用户按系统快捷键退出全屏时，同步退出演示（presenting 已复位则不会递归）
    if (presenting && !document.fullscreenElement) exitPresent();
  });
  $("#ctxBtn").addEventListener("click", () => {
    setCtxOpen(!state.ctxOpen);
    renderToolbar();
  });

  // 目录标签
  $("#ctxTabs").addEventListener("click", (event) => {
    const tab = event.target.closest(".ctx-tab");
    if (tab && !tab.hidden) switchCtxTab(tab.dataset.ctx);
  });

  // 目录 / 缩略图 / 搜索结果跳转
  $("#ctxBody").addEventListener("click", (event) => {
    const goto = event.target.closest("[data-goto]");
    if (goto) {
      if (goto.dataset.kind === "pdf") goPage(Number(goto.dataset.goto));
      else if (activePane()) scrollToHeading(activePane().scrollArea, goto.dataset.goto);
      return;
    }
    const hit = event.target.closest("[data-hit]");
    if (hit) {
      if (hit.dataset.kind === "pdf") goPage(Number(hit.dataset.page));
      else {
        const pane = activePane();
        const node = pane?.hits[Number(hit.dataset.hit)];
        if (node && pane) {
          const area = pane.scrollArea;
          const offset = node.getBoundingClientRect().top - area.getBoundingClientRect().top;
          area.scrollTo({ top: area.scrollTop + offset - 80, behavior: "smooth" });
        }
      }
    }
  });

  // 阅读工具栏
  $("#readToolbar").addEventListener("click", (event) => {
    // 缩放菜单里的选项先于 [data-act] 处理（菜单项没有 data-act）
    const preset = event.target.closest("[data-zoom]");
    if (preset) {
      setZoom(Number(preset.dataset.zoom));
      setZoomMenu(false);
      return;
    }
    if (event.target.closest("[data-fit-width]")) {
      fitPdfWidth();
      setZoomMenu(false);
      return;
    }
    if (event.target.closest("[data-fit-zoom]")) {
      fitPdfPage();
      setZoomMenu(false);
      return;
    }
    const button = event.target.closest("[data-act]");
    if (!button) return;
    const act = button.dataset.act;
    const settings = state.settings;
    if (act === "prev") goPage(state.pdfPage - 1);
    if (act === "next") goPage(state.pdfPage + 1);
    if (act === "zoom-in") zoomByStep(1);
    if (act === "zoom-out") zoomByStep(-1);
    if (act === "zoom-menu") setZoomMenu(!zoomMenuOpen);
    if (act === "ctx") {
      setCtxOpen(!state.ctxOpen);
      renderToolbar();
    }
    if (act === "split") setSplit(!splitMode);
    if (act === "link") setLink(!linkSync);
    if (act === "present") enterPresent();
    if (act === "font-up" || act === "font-down") {
      const index = SIZE_STEPS.indexOf(settings.fontSize);
      const nextIndex = clamp((index < 0 ? 1 : index) + (act === "font-up" ? 1 : -1), 0, SIZE_STEPS.length - 1);
      settings.fontSize = SIZE_STEPS[nextIndex];
      applySettings();
      syncSettingsUI();
      renderToolbar();
      updateStatus();
      persistSettings();
    }
    if (act === "lh") {
      settings.lineHeight = settings.lineHeight === 1.7 ? 1.9 : settings.lineHeight === 1.9 ? 2.1 : 1.7;
      applySettings();
      syncSettingsUI();
      renderToolbar();
      updateStatus();
      persistSettings();
    }
    if (act === "measure") {
      settings.measure = settings.measure === 620 ? 720 : settings.measure === 720 ? 820 : 620;
      applySettings();
      syncSettingsUI();
      renderToolbar();
      persistSettings();
    }
  });

  $("#readToolbar").addEventListener("change", (event) => {
    if (event.target.id === "pageInput") goPage(Number(event.target.value) || 1);
  });

  // 点工具栏以外的地方收起缩放比例菜单
  document.addEventListener("click", (event) => {
    if (zoomMenuOpen && !event.target.closest(".zoom-anchor")) setZoomMenu(false);
  });

  // 命令面板
  $("#paletteBtn").addEventListener("click", openPalette);
  $("#paletteOverlay").addEventListener("click", (event) => {
    if (event.target.id === "paletteOverlay") closePalette();
  });
  $("#paletteInput").addEventListener("input", (event) => {
    state.paletteIndex = 0;
    renderPalette(event.target.value);
  });
  $("#paletteList").addEventListener("click", (event) => {
    const item = event.target.closest("[data-pi]");
    if (!item) return;
    const runs = JSON.parse($("#paletteList").dataset.items || "[]");
    runPalette(runs[Number(item.dataset.pi)]);
  });

  // 设置
  $("#themeBtn").addEventListener("click", cycleTheme);
  // 导航栏语言按钮：在中文 / English 之间直接切换
  $("#langBtn").addEventListener("click", () => {
    switchLanguage(getLanguage() === "zh" ? "en" : "zh");
  });
  $("#settingsOverlay").addEventListener("click", (event) => {
    if (event.target.id === "settingsOverlay") closeSettings();
  });
  $("#settingsClose").addEventListener("click", closeSettings);
  $("#settingsDone").addEventListener("click", closeSettings);
  $("#themeRow").addEventListener("click", (event) => {
    const swatch = event.target.closest("[data-theme-value]");
    if (swatch) {
      setTheme(swatch.dataset.themeValue);
      syncSettingsUI();
    }
  });
  $("#langSeg").addEventListener("click", (event) => {
    const button = event.target.closest("[data-lang]");
    if (button) switchLanguage(button.dataset.lang);
  });
  $("#fontSizeSeg").addEventListener("click", (event) => {
    const button = event.target.closest("[data-size]");
    if (!button) return;
    state.settings.fontSize = Number(button.dataset.size);
    applySettings();
    syncSettingsUI();
    renderToolbar();
    updateStatus();
    persistSettings();
  });
  $("#lineHeightSeg").addEventListener("click", (event) => {
    const button = event.target.closest("[data-lh]");
    if (!button) return;
    state.settings.lineHeight = Number(button.dataset.lh);
    applySettings();
    syncSettingsUI();
    renderToolbar();
    updateStatus();
    persistSettings();
  });
  $("#measureSeg").addEventListener("click", (event) => {
    const button = event.target.closest("[data-measure]");
    if (!button) return;
    state.settings.measure = Number(button.dataset.measure);
    applySettings();
    syncSettingsUI();
    renderToolbar();
    persistSettings();
  });
  $("#switchCtx").addEventListener("click", () => {
    state.settings.showCtx = !state.settings.showCtx;
    setCtxOpen(state.settings.showCtx);
    syncSettingsUI();
    persistSettings();
    toast(state.settings.showCtx ? t("settings.showCtxOn") : t("settings.showCtxOff"));
  });
  $("#switchZen").addEventListener("click", toggleZen);
  $("#resetBtn").addEventListener("click", () => {
    if (splitMode) setSplit(false);  // 默认设置是单栏，先合并再重置
    // 恢复默认不应把界面语言改回中文，保留当前语言
    state.settings = { ...DEFAULT_SETTINGS, language: getLanguage() };
    setTheme("paper", true);
    applySettings();
    syncSettingsUI();
    renderToolbar();
    updateStatus();
    persistSettings();
    toast(t("settings.resetDone"));
  });

  // 窗口按钮
  $("#winMin").addEventListener("click", () => currentWindow?.minimize());
  $("#winMax").addEventListener("click", () => currentWindow?.toggleMaximize());
  $("#winClose").addEventListener("click", () => currentWindow?.close());

  // 拖拽导入（Tauri 窗口级事件）
  if (currentWindow?.onDragDropEvent) {
    currentWindow.onDragDropEvent((event) => {
      const payload = event.payload || {};
      if (payload.type === "enter" || payload.type === "over") {
        document.body.classList.add("is-dragging");
        return;
      }
      document.body.classList.remove("is-dragging");
      if (payload.type !== "drop") return;
      const paths = (payload.paths || []).filter((path) => /\.(pdf|md|markdown|mdown)$/i.test(path));
      if (!paths.length) {
        toast(t("toast.onlySupported"));
        return;
      }
      importDocuments(paths);
    });
  }

  // 屏蔽 WebView2 默认右键菜单（刷新 / 另存为 / 检查等），保持桌面应用观感；
  // 输入框、可编辑区域以及 PDF 文本层中已选中的文字保留原生菜单，便于复制粘贴
  document.addEventListener("contextmenu", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement) {
      if (target.isContentEditable || target.closest("input, textarea")) return;
      if (target.closest(".textLayer") && isSelectionInTextLayer()) return;
    }
    event.preventDefault();
  });

  // 键盘
  document.addEventListener("keydown", (event) => {
    const paletteOpen = !$("#paletteOverlay").hidden;
    const settingsOpen = !$("#settingsOverlay").hidden;
    const modifier = event.ctrlKey || event.metaKey;

    // 演示模式：只认翻页与退出，屏蔽其它快捷键
    if (presenting) {
      event.preventDefault();
      if (event.key === "Escape" || event.key === "F5") exitPresent();
      else if (["ArrowRight", "ArrowDown", "PageDown", " ", "Spacebar", "Enter"].includes(event.key)) presentStep(1);
      else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(event.key)) presentStep(-1);
      else if (event.key === "Home") presentStep(1 - presentPage);
      else if (event.key === "End") presentStep((activeReader()?.numPages || 0) - presentPage);
      return;
    }

    if (modifier && event.key.toLowerCase() === "k") {
      event.preventDefault();
      paletteOpen ? closePalette() : openPalette();
      return;
    }
    if (modifier && event.key.toLowerCase() === "o") {
      event.preventDefault();
      importDocuments();
      return;
    }
    // F5 进入演示（避免 WebView 刷新整个界面）
    if (event.key === "F5") {
      event.preventDefault();
      enterPresent();
      return;
    }
    if (event.key === "Escape") {
      if (zoomMenuOpen) setZoomMenu(false);
      else if (paletteOpen) closePalette();
      else if (settingsOpen) closeSettings();
      else if (state.view === "reading") setView("library");
      return;
    }
    if (paletteOpen) {
      const items = paletteItems($("#paletteInput").value);
      if (event.key === "ArrowDown") {
        event.preventDefault();
        state.paletteIndex = Math.min(items.length - 1, state.paletteIndex + 1);
        renderPalette($("#paletteInput").value);
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        state.paletteIndex = Math.max(0, state.paletteIndex - 1);
        renderPalette($("#paletteInput").value);
      }
      if (event.key === "Enter" && items[state.paletteIndex]) {
        event.preventDefault();
        runPalette(items[state.paletteIndex].run);
      }
      return;
    }
    if (settingsOpen) return;
    if (state.view !== "reading") return;
    if (document.activeElement?.tagName === "INPUT") return;

    if (event.key === "ArrowRight" && state.current?.kind === "pdf") {
      event.preventDefault();
      goPage(state.pdfPage + 1);
    }
    if (event.key === "ArrowLeft" && state.current?.kind === "pdf") {
      event.preventDefault();
      goPage(state.pdfPage - 1);
    }
    // 缩放：Ctrl +/- 按档位步进，Ctrl+0 回到 100%；不带修饰键的 +/- 同样可用
    if (modifier && (event.key === "+" || event.key === "=" || event.key === "-")) {
      event.preventDefault();
      zoomByStep(event.key === "-" ? -1 : 1);
      return;
    }
    if (modifier && event.key === "0") {
      event.preventDefault();
      setZoom(1);
      return;
    }
    if ((event.key === "+" || event.key === "=") && state.current?.kind === "pdf") {
      event.preventDefault();
      zoomByStep(1);
    }
    if (event.key === "-" && state.current?.kind === "pdf") {
      event.preventDefault();
      zoomByStep(-1);
    }
    if (modifier && event.key.toLowerCase() === "b") {
      event.preventDefault();
      setCtxOpen(!state.ctxOpen);
      renderToolbar();
    }
    // Ctrl+\ 拆分 / 合并双栏
    if (modifier && event.key === "\\") {
      event.preventDefault();
      setSplit(!splitMode);
    }
    if (modifier && event.key.toLowerCase() === "d") {
      event.preventDefault();
      toggleZen();
    }
  });

  window.addEventListener("beforeunload", flushProgress);
}

/* ---------------- 启动 ---------------- */
async function boot() {
  $("#emptyLibrary").hidden = true;
  applySettings();
  initPanes();

  if (!isTauri) {
    setLanguage(state.settings.language);
    applyDom();
    applySplitState();
    renderLibrary();
    bind();
    setView("library");
    toast(t("toast.desktopOnly"));
    return;
  }

  try {
    const [settings, books] = await Promise.all([invoke("get_settings"), invoke("get_library")]);
    state.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    state.books = books || [];
  } catch (error) {
    toast(t("toast.loadFailed", { error }));
  }

  // 语言必须在其余渲染之前落地：后续动态文案都依赖当前语言
  setLanguage(state.settings.language);
  applyDom();
  syncWindowTitle();
  setTheme(state.settings.theme, true);
  applySettings();
  syncSettingsUI();
  applySplitState();
  bind();
  renderLibrary();
  setView("library");
}

/** 分栏是临时操作，启动时一律单栏；联动开关按上次选择恢复（不自动打开文档） */
function applySplitState() {
  splitMode = false;
  linkSync = state.settings.linkSync !== false;
  if (panes[1]) panes[1].root.hidden = true;
  $("#readerPanes").classList.remove("is-split");
  updatePaneHeads();
}

boot();
