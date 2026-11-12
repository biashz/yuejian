/**
 * 阅笺 · 应用主逻辑
 * 书架（Rust 持久化）→ 打开文档 → PDF（pdf.js）/ Markdown（comrak）阅读
 */
import { invoke, isTauri, currentWindow } from "./api.js";
import { PdfReader } from "./reader-pdf.js";
import { renderMarkdown, setupScrollSpy, scrollToHeading } from "./reader-md.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const THEME_LABEL = { paper: "纸白主题", night: "夜读主题", sepia: "护眼主题" };
const THEME_ORDER = ["paper", "night", "sepia"];
const KIND_LABEL = { pdf: "PDF", markdown: "MARKDOWN" };
const KIND_CLASS = { pdf: "pdf", markdown: "md" };
const TINTS = ["clay", "indigo", "olive", "sand", "plum"];
const SIZE_STEPS = [15, 17, 19, 21];
const DEFAULT_SETTINGS = { theme: "paper", fontSize: 17, lineHeight: 1.9, measure: 720, showCtx: true, zen: false };

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
let pdfReader = null;
let saveTimer = 0;
let findTimer = 0;
let findToken = 0;
let spyCleanup = () => {};
let headingEls = [];
let mdHits = [];
let thumbObserver = null;
let scrollTick = 0;

/* ---------------- 小工具 ---------------- */
const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function tintOf(id) {
  let hash = 0;
  for (const ch of String(id)) hash = (hash * 31 + ch.charCodeAt(0)) % 997;
  return TINTS[hash % TINTS.length];
}

function percentOf(book) {
  return Math.round(clamp(book?.progress?.ratio || 0, 0, 1) * 100);
}

function formatRelative(ms) {
  if (!ms) return "未打开";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  const date = new Date(ms);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
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
    return book.pages ? `${book.pages} 页 · ${formatBytes(book.size)}` : formatBytes(book.size);
  }
  return `${book.words ? `${book.words} 字` : "Markdown"} · ${formatBytes(book.size)}`;
}

function renderBookList(books) {
  const list = $("#bookList");
  $("#libCount").textContent = state.books.length;
  if (!books.length) {
    list.innerHTML = `<div class="ctx-empty">${state.books.length ? "没有匹配的文档<br>换个关键词试试" : "书架还是空的<br>导入 PDF 或 Markdown"}</div>`;
    return;
  }
  list.innerHTML = books.map((book) => `
    <div class="book-row ${book.id === state.currentId ? "is-current" : ""}" data-book="${book.id}" role="button" tabindex="0">
      <div class="mini-cover tint-${tintOf(book.id)}"><span>${escapeHtml(book.title.slice(0, 1))}</span></div>
      <div class="book-row-main">
        <div class="book-row-title">${escapeHtml(book.title)}</div>
        <div class="book-row-meta">
          <i class="type-dot ${KIND_CLASS[book.kind] || "md"}"></i>${KIND_LABEL[book.kind] || "文档"} · ${formatRelative(book.lastOpenedAt)}
        </div>
        <div class="progress-line"><i style="width:${percentOf(book)}%"></i></div>
      </div>
      <button class="remove-btn" data-remove="${book.id}" title="从书架移除">
        <svg class="ic"><use href="#i-trash"/></svg>
      </button>
    </div>`).join("");
}

function renderGrid(books) {
  const grid = $("#bookGrid");
  if (!books.length) {
    grid.innerHTML = state.books.length ? `<div class="ctx-empty">没有匹配的文档</div>` : "";
    return;
  }
  grid.innerHTML = books.map((book, index) => `
    <div class="book-card" data-book="${book.id}" tabindex="0" style="animation-delay:${140 + index * 40}ms">
      <div class="cover tint-${tintOf(book.id)}">
        <div class="cover-inner">
          <span class="cover-kind">${KIND_LABEL[book.kind] || "文档"}</span>
          <span class="cover-title">${escapeHtml(book.title)}</span>
          <span class="cover-rule"></span>
          <span class="cover-author">${escapeHtml(bookProgressText(book))}</span>
        </div>
        <span class="cover-badge ${book.favorite ? "is-on" : ""}" data-star="${book.id}" title="收藏">
          <svg class="ic"><use href="#i-star"/></svg>
        </span>
      </div>
      <div class="card-meta">
        <div class="card-title">${escapeHtml(book.title)}</div>
        <div class="card-sub">${KIND_LABEL[book.kind] || "文档"} · ${formatRelative(book.lastOpenedAt)}</div>
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
        <span class="cover-kind">${KIND_LABEL[candidate.kind] || "文档"}</span>
        <span class="cover-title" style="font-size:17px">${escapeHtml(candidate.title)}</span>
        <span class="cover-rule"></span>
        <span class="cover-author">${escapeHtml(bookProgressText(candidate))}</span>
      </div>
    </div>
    <div class="resume-info">
      <h3>${escapeHtml(candidate.title)}</h3>
      <p>${KIND_LABEL[candidate.kind] || "文档"} · ${escapeHtml(bookProgressText(candidate))}</p>
      <div class="resume-meta">
        <span>${candidate.kind === "pdf" ? `第 <b>${page}</b> 页` : "上次阅读位置已记录"}</span>
        <span><b>${formatRelative(candidate.lastOpenedAt)}</b>打开</span>
      </div>
      <span class="resume-go" data-book="${candidate.id}">继续阅读
        <svg class="ic" style="width:13px;height:13px"><use href="#i-chevron-right"/></svg>
      </span>
    </div>
    <div class="resume-progress">
      <div class="bar"><i style="width:${percent}%"></i></div>
      <div class="label"><span>阅读进度</span><span>${percent}%</span></div>
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
  $("#tbTitle").textContent = isReading ? ($("#docTitle").textContent || "阅读") : "书架";
  if (!isReading) {
    flushProgress();
    renderLibrary();
  }
  updateStatus();
}

/* ---------------- 打开文档 ---------------- */
async function openBook(id) {
  const book = state.books.find((item) => item.id === id);
  if (!book) return;

  flushProgress();
  spyCleanup();
  spyCleanup = () => {};
  mdHits = [];
  state.currentId = id;
  state.current = book;
  state.pdfOutline = null;
  state.findQuery = "";
  state.ctxTab = "toc";
  state.pdfPage = clamp(book.progress.page || 1, 1, Math.max(1, book.pages || 1));
  state.pdfZoom = clamp(book.progress.zoom || 1, 0.5, 2.5);
  state.pdfTotal = book.pages || 0;

  $("#docTitle").textContent = book.title;
  $("#starBtn").classList.toggle("is-on", book.favorite);
  $("#pdfStack").style.display = book.kind === "pdf" ? "flex" : "none";
  $("#mdDoc").style.display = book.kind === "pdf" ? "none" : "block";
  $("#ctxTabs").style.display = "flex";
  $("#ctxTabs [data-ctx='thumbs']").hidden = book.kind !== "pdf";
  $("#ctxTabs [data-ctx='toc']").classList.add("is-on");
  $("#ctxTabs [data-ctx='find']").classList.remove("is-on");
  $("#ctxTabs [data-ctx='thumbs']").classList.remove("is-on");

  setView("reading");
  updateDocSub();

  let doc;
  try {
    doc = await invoke("open_book", { id });
  } catch (error) {
    toast(String(error));
    state.currentId = null;
    state.current = null;
    state.doc = null;
    setView("library");
    return;
  }
  if (state.currentId !== id) return;
  state.doc = doc;

  if (doc.kind === "pdf") {
    await openPdf(doc);
  } else {
    openMarkdown(doc);
  }

  setCtxOpen(state.settings.showCtx);
  renderBookList(visibleBooks());
  renderGrid(visibleBooks());
  updateStatus();
}

function updateDocSub() {
  const book = state.current;
  if (!book) return;
  $("#docSub").textContent = book.kind === "pdf"
    ? `PDF · ${state.pdfTotal || book.pages || "…"} 页 · ${formatBytes(book.size)}`
    : `MARKDOWN · ${book.words || 0} 字 · ${formatBytes(book.size)}`;
}

async function openPdf(doc) {
  state.pdfTotal = doc.pages || state.pdfTotal || state.current?.pages || 0;
  const reader = ensurePdfReader();
  renderToolbar();
  renderCtx();
  updateDocSub();

  try {
    await reader.open(doc.path, { startPage: state.pdfPage, zoom: state.pdfZoom, size: doc.size || 0 });
  } catch (error) {
    $("#pdfStack").innerHTML = `<div class="pdf-error">无法打开这份 PDF<br><small>${escapeHtml(error?.message || error)}</small></div>`;
    toast("PDF 打开失败，文件可能已被移动");
  }
}

function openMarkdown(doc) {
  const area = $("#scrollArea");
  area.scrollTop = 0;
  headingEls = renderMarkdown(doc, $("#mdDoc"));
  spyCleanup = setupScrollSpy(area, headingEls, (id) => markTocActive(id));
  renderToolbar();
  renderCtx();

  requestAnimationFrame(() => {
    const max = Math.max(0, $("#mdDoc").scrollHeight - area.clientHeight);
    area.scrollTop = Math.round((state.current?.progress.ratio || 0) * max);
  });
}

/* ---------------- PDF 阅读器 ---------------- */
function ensurePdfReader() {
  if (pdfReader) return pdfReader;
  pdfReader = new PdfReader({
    stack: $("#pdfStack"),
    scrollArea: $("#scrollArea"),
    onPageChange: ({ page, zoom, ratio, total }) => {
      state.pdfPage = page;
      state.pdfZoom = zoom;
      if (total) state.pdfTotal = total;
      if (state.current) {
        state.current.progress = { ratio, page, zoom };
        if (total) state.current.pages = total;
      }
      updateToolbarPage();
      markThumbActive();
      markTocActive();
      updateDocSub();
      updateStatus();
      scheduleSave();
    },
    onReady: ({ pages }) => {
      state.pdfTotal = pages;
      if (state.current) state.current.pages = pages;
      updateToolbarPage();
      updateDocSub();
      updateStatus();
      renderToolbar();
      renderCtx();
      flushProgress();
    },
  });
  return pdfReader;
}

/* ---------------- 工具栏 ---------------- */
function renderToolbar() {
  const book = state.current;
  const bar = $("#readToolbar");
  if (!book) {
    bar.innerHTML = "";
    return;
  }

  if (book.kind === "pdf") {
    const total = state.pdfTotal || book.pages || 0;
    bar.innerHTML = `
      <div class="tool-group">
        <button class="tool-btn" data-act="prev" title="上一页"><svg class="ic"><use href="#i-chevron-left"/></svg></button>
        <input class="page-input" id="pageInput" type="number" min="1" max="${total || 1}" value="${state.pdfPage}" aria-label="页码" />
        <span class="page-total">/ ${total || "…"}</span>
        <button class="tool-btn" data-act="next" title="下一页"><svg class="ic"><use href="#i-chevron-right"/></svg></button>
      </div>
      <span class="tool-sep"></span>
      <div class="tool-group">
        <button class="tool-btn" data-act="zoom-out" title="缩小"><svg class="ic"><use href="#i-minus"/></svg></button>
        <button class="tool-btn" data-act="zoom-label" title="重置缩放">${Math.round(state.pdfZoom * 100)}%</button>
        <button class="tool-btn" data-act="zoom-in" title="放大"><svg class="ic"><use href="#i-plus"/></svg></button>
        <button class="tool-btn" data-act="fit" title="适合宽度"><svg class="ic"><use href="#i-maximize"/></svg></button>
      </div>
      <span class="tool-sep"></span>
      <div class="tool-group">
        <button class="tool-btn ${state.ctxOpen ? "is-on" : ""}" data-act="ctx" title="目录面板"><svg class="ic"><use href="#i-list"/></svg></button>
      </div>`;
  } else {
    const settings = state.settings;
    bar.innerHTML = `
      <div class="tool-group">
        <button class="tool-btn" data-act="font-down" title="减小字号">A−</button>
        <span class="page-total" style="min-width:34px;text-align:center">${settings.fontSize}px</span>
        <button class="tool-btn" data-act="font-up" title="增大字号">A+</button>
      </div>
      <span class="tool-sep"></span>
      <div class="tool-group">
        <button class="tool-btn" data-act="lh" title="切换行高">行高 ${settings.lineHeight}</button>
        <button class="tool-btn" data-act="measure" title="切换版心">版心 ${settings.measure}</button>
      </div>
      <span class="tool-sep"></span>
      <div class="tool-group">
        <button class="tool-btn ${state.ctxOpen ? "is-on" : ""}" data-act="ctx" title="目录面板"><svg class="ic"><use href="#i-list"/></svg></button>
      </div>`;
  }
  updateToolbarPage();
}

function updateToolbarPage() {
  const input = $("#pageInput");
  if (input) input.value = state.pdfPage;
  const label = $('[data-act="zoom-label"]');
  if (label) label.textContent = `${Math.round(state.pdfZoom * 100)}%`;
  const prev = $('[data-act="prev"]');
  const next = $('[data-act="next"]');
  if (prev) prev.disabled = state.pdfPage <= 1;
  if (next) next.disabled = state.pdfTotal > 0 && state.pdfPage >= state.pdfTotal;
}

function goPage(page, smooth = true) {
  if (!pdfReader) return;
  pdfReader.goPage(page, smooth);
}

function setZoom(zoom) {
  if (!pdfReader) return;
  pdfReader.setZoom(zoom, state.pdfPage);
  state.pdfZoom = pdfReader.zoom;
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

function switchCtxTab(tab) {
  state.ctxTab = tab;
  $$("#ctxTabs .ctx-tab").forEach((item) => item.classList.toggle("is-on", item.dataset.ctx === tab));
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
  const book = state.current;
  if (!book) return;

  if (book.kind === "pdf") {
    if (!state.pdfOutline) {
      // PDF 尚未解析完成时先占位，等 onReady 再取大纲
      if (!pdfReader?.pdf) {
        body.innerHTML = `<div class="ctx-empty">正在读取目录…</div>`;
        return;
      }
      let outline = [];
      try {
        outline = await pdfReader.outline() || [];
      } catch (_) {
        outline = [];
      }
      if (state.ctxTab !== "toc" || state.currentId !== book.id) return;
      state.pdfOutline = outline;
    }
    if (!state.pdfOutline.length) {
      body.innerHTML = `<div class="ctx-empty">这份 PDF 没有内嵌目录<br>可用页码或缩略图跳转</div>`;
      return;
    }
    body.innerHTML = state.pdfOutline.map((item) => `
      <button class="toc-item ${item.page === state.pdfPage ? "is-active" : ""}"
        data-level="${item.level}" data-goto="${item.page}" data-kind="pdf">
        ${escapeHtml(item.text)}<span class="toc-page">${item.page}</span>
      </button>`).join("");
    return;
  }

  const toc = state.doc?.toc || [];
  if (!toc.length) {
    body.innerHTML = `<div class="ctx-empty">这份 Markdown 没有标题层级<br>用「搜索」定位内容</div>`;
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
  if (!state.pdfOutline?.length) return;
  // PDF：取最后一个页码不超过当前页的条目
  let activeIndex = 0;
  state.pdfOutline.forEach((item, index) => {
    if (item.page <= state.pdfPage) activeIndex = index;
  });
  items.forEach((item, index) => item.classList.toggle("is-active", index === activeIndex));
}

function renderThumbs() {
  const body = $("#ctxBody");
  const total = state.pdfTotal || state.current?.pages || 0;
  if (!total) {
    body.innerHTML = `<div class="ctx-empty">正在准备缩略图…</div>`;
    return;
  }
  body.innerHTML = Array.from({ length: total }, (_, index) => `
    <button class="thumb-item ${index + 1 === state.pdfPage ? "is-active" : ""}" data-goto="${index + 1}" data-kind="pdf">
      <div class="thumb-page"><canvas data-thumb="${index + 1}"></canvas></div>
      <span class="thumb-no">第 ${index + 1} 页</span>
    </button>`).join("");

  thumbObserver?.disconnect();
  thumbObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const canvas = entry.target;
      thumbObserver.unobserve(canvas);
      if (canvas.dataset.done) continue;
      canvas.dataset.done = "1";
      pdfReader?.renderThumb(Number(canvas.dataset.thumb), canvas).catch(() => {});
    }
  }, { root: body, rootMargin: "200px" });
  $$("canvas[data-thumb]", body).forEach((canvas) => thumbObserver.observe(canvas));

  body.querySelector(".thumb-item.is-active")?.scrollIntoView({ block: "nearest" });
}

function markThumbActive() {
  $$("#ctxBody .thumb-item").forEach((item) => {
    item.classList.toggle("is-active", Number(item.dataset.goto) === state.pdfPage);
  });
}

function renderFind() {
  const body = $("#ctxBody");
  body.innerHTML = `
    <div class="find-box">
      <input id="findInput" type="text" placeholder="在文档内搜索…" value="${escapeHtml(state.findQuery)}" />
    </div>
    <div class="find-summary" id="findSummary">输入关键词开始搜索</div>
    <div id="findHits"></div>`;

  const input = $("#findInput");
  input.addEventListener("input", () => {
    state.findQuery = input.value.trim();
    clearTimeout(findTimer);
    findTimer = setTimeout(runFind, 320);
  });
  if (state.findQuery) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    runFind();
  }
}

async function runFind() {
  const query = state.findQuery;
  const summary = $("#findSummary");
  const hitsWrap = $("#findHits");
  if (!summary || !hitsWrap) return;
  if (!query) {
    summary.textContent = "输入关键词开始搜索";
    hitsWrap.innerHTML = "";
    return;
  }

  const token = ++findToken;
  const book = state.current;
  summary.textContent = book?.kind === "pdf" ? "正在检索全文…" : "正在检索…";

  const mark = (text) => {
    const safe = escapeHtml(text);
    const pattern = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    return safe.replace(pattern, "<mark>$1</mark>");
  };

  let hits = [];
  if (book?.kind === "pdf") {
    hits = await pdfReader?.search(query) || [];
    if (token !== findToken) return;
    summary.textContent = hits.length ? `找到 ${hits.length} 处匹配${hits.length >= 60 ? "（仅显示前 60 处）" : ""}` : "没有匹配结果";
    hitsWrap.innerHTML = hits.map((hit, index) => `
      <button class="find-hit" data-hit="${index}" data-page="${hit.page}" data-kind="pdf">
        <span class="hit-page">第 ${hit.page} 页</span>${mark(hit.text)}
      </button>`).join("");
    mdHits = [];
    return;
  }

  const nodes = $$("#mdDoc h1, #mdDoc h2, #mdDoc h3, #mdDoc p, #mdDoc li, #mdDoc td, #mdDoc blockquote");
  mdHits = nodes.filter((node) => node.textContent.includes(query)).slice(0, 40);
  summary.textContent = mdHits.length ? `找到 ${mdHits.length} 处匹配` : "没有匹配结果";
  hitsWrap.innerHTML = mdHits.map((node, index) => {
    const text = node.textContent.trim();
    const at = text.indexOf(query);
    const snippet = text.length > 70 ? `${text.slice(Math.max(0, at - 24), at + 46)}…` : text;
    const label = /^H[123]$/.test(node.tagName) ? `标题 ${node.tagName.slice(1)}` : "正文";
    return `<button class="find-hit" data-hit="${index}" data-kind="md">
      <span class="hit-page">${label}</span>${mark(snippet)}
    </button>`;
  }).join("");
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
  $("#statusMid").textContent = THEME_LABEL[theme] || THEME_LABEL.paper;
  $$(".theme-swatch").forEach((item) => item.classList.toggle("is-on", item.dataset.themeValue === theme));
  persistSettings();
  if (!silent) toast(`已切换至${THEME_LABEL[theme] || "纸白主题"}`);
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
  toast(state.settings.zen ? "已进入专注模式" : "已退出专注模式");
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
  const book = state.current;
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
      ? `第 ${state.pdfPage} / ${state.pdfTotal || book.pages || "…"} 页 · ${Math.round(state.pdfZoom * 100)}%`
      : `MARKDOWN · ${book.words || 0} 字 · ${state.settings.fontSize}px / ${state.settings.lineHeight}`;
  } else {
    $("#statusLeft").textContent = "就绪";
    $("#statusRight").textContent = `${state.books.length} 份文档 · 本地存储`;
  }
  $("#statusMid").textContent = THEME_LABEL[state.settings.theme] || THEME_LABEL.paper;
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
  toast(`已导入 ${list.length} 份文档`);
  if (list.length === 1 && imported) openBook(imported.id);
  return list.length;
}

async function removeBook(id) {
  const book = state.books.find((item) => item.id === id);
  if (!book) return;
  if (!window.confirm(`从书架移除《${book.title}》？\n只会移除记录，不会删除本地文件。`)) return;
  try {
    state.books = await invoke("remove_book", { id });
  } catch (error) {
    toast(String(error));
    return;
  }
  if (state.currentId === id) {
    state.currentId = null;
    state.current = null;
    state.doc = null;
    pdfReader?.destroy();
    setView("library");
  }
  renderLibrary();
  updateStatus();
  toast(`已移除《${book.title}》`);
}

async function toggleFavorite(id) {
  try {
    const updated = await invoke("toggle_favorite", { id });
    const index = state.books.findIndex((book) => book.id === id);
    if (index >= 0) state.books[index] = updated;
    if (state.currentId === id) state.current = updated;
    $("#starBtn").classList.toggle("is-on", updated.favorite);
    renderLibrary();
    toast(updated.favorite ? `已收藏《${updated.title}》` : `已取消收藏《${updated.title}》`);
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
      group: "文档",
      icon: book.kind === "pdf" ? "file-text" : "book-open",
      title: book.title,
      sub: `${KIND_LABEL[book.kind] || "文档"} · ${formatRelative(book.lastOpenedAt)}`,
      run: `open:${book.id}`,
    }));

  const actions = [
    { title: "导入本地文档", sub: "系统文件对话框 · PDF / Markdown", icon: "folder-plus", run: "import" },
    { title: "切换主题", sub: "纸白 / 夜读 / 护眼", icon: "sun", run: "theme" },
    { title: "专注模式", sub: "隐藏书架与导航", icon: "maximize", run: "zen" },
    { title: "阅读设置", sub: "字号、行高、版心", icon: "settings", run: "settings" },
    { title: "返回书架", sub: "关闭当前文档", icon: "library", run: "back" },
  ].filter((action) => !keyword || `${action.title} ${action.sub}`.toLowerCase().includes(keyword))
    .map((action) => ({ ...action, group: "动作" }));

  return [...books, ...actions];
}

function renderPalette(query) {
  const items = paletteItems(query);
  const list = $("#paletteList");
  if (!items.length) {
    list.innerHTML = `<div class="ctx-empty">没有匹配项</div>`;
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
  $("#switchCtx").classList.toggle("is-on", settings.showCtx);
  $("#switchCtx").setAttribute("aria-checked", String(settings.showCtx));
  $("#switchZen").classList.toggle("is-on", settings.zen);
  $("#switchZen").setAttribute("aria-checked", String(settings.zen));
  $$(".theme-swatch").forEach((item) => item.classList.toggle("is-on", item.dataset.themeValue === settings.theme));
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
        toast("外部链接已复制到剪贴板：" + href);
        navigator.clipboard?.writeText(href).catch(() => {});
        return;
      }
      if (href.startsWith("#")) {
        event.preventDefault();
        scrollToHeading($("#scrollArea"), href.slice(1));
        return;
      }
      if (/\.(md|markdown)$/i.test(href)) {
        event.preventDefault();
        toast("暂不支持跨文档跳转");
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
      if (state.currentId) setView("reading");
      else if (state.books.length) openBook(state.books.slice().sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0].id);
      else toast("书架还是空的，先导入一份文档");
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
      else scrollToHeading($("#scrollArea"), goto.dataset.goto);
      return;
    }
    const hit = event.target.closest("[data-hit]");
    if (hit) {
      if (hit.dataset.kind === "pdf") goPage(Number(hit.dataset.page));
      else {
        const node = mdHits[Number(hit.dataset.hit)];
        if (node) {
          const area = $("#scrollArea");
          const offset = node.getBoundingClientRect().top - area.getBoundingClientRect().top;
          area.scrollTo({ top: area.scrollTop + offset - 80, behavior: "smooth" });
        }
      }
    }
  });

  // 阅读工具栏
  $("#readToolbar").addEventListener("click", (event) => {
    const button = event.target.closest("[data-act]");
    if (!button) return;
    const act = button.dataset.act;
    const settings = state.settings;
    if (act === "prev") goPage(state.pdfPage - 1);
    if (act === "next") goPage(state.pdfPage + 1);
    if (act === "zoom-in") setZoom(state.pdfZoom + 0.1);
    if (act === "zoom-out") setZoom(state.pdfZoom - 0.1);
    if (act === "zoom-label") setZoom(1);
    if (act === "fit") {
      pdfReader?.fitWidth();
      state.pdfZoom = pdfReader?.zoom || 1;
      updateToolbarPage();
      toast("已适合宽度");
    }
    if (act === "ctx") {
      setCtxOpen(!state.ctxOpen);
      renderToolbar();
    }
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
    toast(state.settings.showCtx ? "打开文档时显示目录" : "打开文档时隐藏目录");
  });
  $("#switchZen").addEventListener("click", toggleZen);
  $("#resetBtn").addEventListener("click", () => {
    state.settings = { ...DEFAULT_SETTINGS };
    setTheme("paper", true);
    applySettings();
    syncSettingsUI();
    renderToolbar();
    updateStatus();
    persistSettings();
    toast("已恢复默认设置");
  });

  // 窗口按钮
  $("#winMin").addEventListener("click", () => currentWindow?.minimize());
  $("#winMax").addEventListener("click", () => currentWindow?.toggleMaximize());
  $("#winClose").addEventListener("click", () => currentWindow?.close());

  // 阅读区滚动（Markdown 进度）
  $("#scrollArea").addEventListener("scroll", () => {
    if (scrollTick) return;
    scrollTick = requestAnimationFrame(() => {
      scrollTick = 0;
      if (state.doc?.kind !== "markdown" || !state.current) return;
      const area = $("#scrollArea");
      const max = Math.max(1, area.scrollHeight - area.clientHeight);
      const ratio = clamp(area.scrollTop / max, 0, 1);
      state.current.progress = { ratio, page: 0, zoom: 1 };
      updateStatus();
      scheduleSave();
    });
  }, { passive: true });

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
        toast("只支持 PDF 与 Markdown 文件");
        return;
      }
      importDocuments(paths);
    });
  }

  // 键盘
  document.addEventListener("keydown", (event) => {
    const paletteOpen = !$("#paletteOverlay").hidden;
    const settingsOpen = !$("#settingsOverlay").hidden;
    const modifier = event.ctrlKey || event.metaKey;

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
    if (event.key === "Escape") {
      if (paletteOpen) closePalette();
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
    if ((event.key === "+" || event.key === "=") && state.current?.kind === "pdf") {
      event.preventDefault();
      setZoom(state.pdfZoom + 0.1);
    }
    if (event.key === "-" && state.current?.kind === "pdf") {
      event.preventDefault();
      setZoom(state.pdfZoom - 0.1);
    }
    if (modifier && event.key.toLowerCase() === "b") {
      event.preventDefault();
      setCtxOpen(!state.ctxOpen);
      renderToolbar();
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

  if (!isTauri) {
    renderLibrary();
    bind();
    setView("library");
    toast("请通过 npm run dev 启动桌面应用");
    return;
  }

  try {
    const [settings, books] = await Promise.all([invoke("get_settings"), invoke("get_library")]);
    state.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    state.books = books || [];
  } catch (error) {
    toast(`读取本地数据失败：${error}`);
  }

  setTheme(state.settings.theme, true);
  applySettings();
  syncSettingsUI();
  bind();
  renderLibrary();
  setView("library");
}

boot();
