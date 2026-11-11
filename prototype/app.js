/* 阅笺原型 · 交互逻辑
   状态集中管理；数据来自 mock.js；无任何真实后端。 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const THEME_LABEL = { paper: "纸白主题", night: "夜读主题", sepia: "护眼主题" };
const THEME_ORDER = ["paper", "night", "sepia"];

const state = {
  view: "library",
  currentBookId: null,
  filter: "all",
  query: "",
  ctxTab: "toc",
  ctxOpen: true,
  theme: "paper",
  pdf: { page: 1, zoom: 1 },
  findQuery: "",
  paletteIndex: 0,
  settings: { fontSize: 17, lineHeight: 1.9, measure: 720, showCtx: true, zen: false }
};

/* ---------------- 持久化（原型用 localStorage 模拟本地存储） ---------------- */
function loadPrefs() {
  try {
    const raw = localStorage.getItem("yuejian.prefs");
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.theme) state.theme = data.theme;
    if (data.settings) Object.assign(state.settings, data.settings);
  } catch (_) { /* 忽略损坏数据 */ }
}
function savePrefs() {
  localStorage.setItem("yuejian.prefs", JSON.stringify({ theme: state.theme, settings: state.settings }));
}

/* ---------------- 渲染：书架面板 ---------------- */
function visibleBooks() {
  return BOOKS.filter((b) => {
    if (state.filter === "star" && !b.favorite) return false;
    if ((state.filter === "pdf" || state.filter === "md") && b.kind !== state.filter) return false;
    if (state.query) {
      const q = state.query.toLowerCase();
      return (b.title + b.subtitle + b.author).toLowerCase().includes(q);
    }
    return true;
  });
}

function renderBookList() {
  const list = $("#bookList");
  const books = visibleBooks();
  $("#libCount").textContent = books.length;
  if (!books.length) {
    list.innerHTML = `<div class="ctx-empty">没有匹配的文档<br>换个关键词试试</div>`;
    return;
  }
  list.innerHTML = books.map((b) => `
    <div class="book-row ${b.id === state.currentBookId ? "is-current" : ""}" data-book="${b.id}" role="button" tabindex="0">
      <div class="mini-cover tint-${b.tint}"><span>${b.title.slice(0, 1)}</span></div>
      <div class="book-row-main">
        <div class="book-row-title">${b.title}</div>
        <div class="book-row-meta">
          <i class="type-dot ${b.kind}"></i>${b.kind === "pdf" ? "PDF" : "MARKDOWN"} · ${b.lastOpened}
        </div>
        <div class="progress-line"><i style="width:${Math.round(b.progress * 100)}%"></i></div>
      </div>
    </div>`).join("");
}

/* ---------------- 渲染：书架主视图 ---------------- */
function renderGrid() {
  const grid = $("#bookGrid");
  const books = visibleBooks();
  grid.innerHTML = books.map((b, i) => `
    <div class="book-card" data-book="${b.id}" tabindex="0" style="animation-delay:${140 + i * 40}ms">
      <div class="cover tint-${b.tint}">
        <div class="cover-inner">
          <span class="cover-kind">${b.kind === "pdf" ? "PDF" : "MARKDOWN"}</span>
          <span class="cover-title">${b.title}</span>
          <span class="cover-rule"></span>
          <span class="cover-author">${b.author}</span>
        </div>
        <span class="cover-badge ${b.favorite ? "is-on" : ""}" data-star="${b.id}" title="收藏">
          <svg class="ic"><use href="#i-star"/></svg>
        </span>
      </div>
      <div class="card-meta">
        <div class="card-title">${b.title}</div>
        <div class="card-sub">${b.subtitle}</div>
        <div class="card-foot">
          <span class="progress-line"><i style="width:${Math.round(b.progress * 100)}%"></i></span>
          <span class="card-pct">${Math.round(b.progress * 100)}%</span>
        </div>
      </div>
    </div>`).join("");
  $("#statBooks").textContent = BOOKS.length;
  $("#statReading").textContent = BOOKS.filter((b) => b.progress > 0 && b.progress < 1).length;
}

function renderResume() {
  const b = BOOKS[0];
  const pct = Math.round(b.progress * 100);
  $("#resumeCard").innerHTML = `
    <div class="resume-cover tint-${b.tint}">
      <div class="cover-inner">
        <span class="cover-kind">PDF</span>
        <span class="cover-title" style="font-size:17px">${b.title}</span>
        <span class="cover-rule"></span>
        <span class="cover-author">${b.author}</span>
      </div>
    </div>
    <div class="resume-info">
      <h3>${b.title}</h3>
      <p>${b.subtitle} · ${b.author}</p>
      <div class="resume-meta">
        <span>PDF · <b>${b.pages} 页</b></span>
        <span>上次停在第 <b>${Math.max(1, Math.round(b.progress * b.pages))} 页</b></span>
        <span><b>${b.lastOpened}</b>打开</span>
      </div>
      <span class="resume-go" data-book="${b.id}">继续阅读
        <svg class="ic" style="width:13px;height:13px"><use href="#i-chevron-right"/></svg>
      </span>
    </div>
    <div class="resume-progress">
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="label"><span>阅读进度</span><span>${pct}%</span></div>
    </div>`;
}

/* ---------------- 视图切换 ---------------- */
function setView(view) {
  state.view = view;
  document.body.dataset.view = view;
  const isReading = view === "reading";
  $("#view-library").classList.toggle("is-visible", !isReading);
  $("#view-reader").classList.toggle("is-visible", isReading);
  $$(".rail-btn").forEach((btn) => {
    const nav = btn.dataset.nav;
    btn.classList.toggle("is-active", nav === view || (view === "reading" && nav === "reading"));
  });
  $("#tbTitle").textContent = isReading
    ? ($("#docTitle").textContent || "阅读")
    : view === "settings" ? "阅读设置" : "书架";
}

/* ---------------- 打开文档 ---------------- */
function openBook(id) {
  const book = BOOKS.find((b) => b.id === id);
  if (!book) return;
  state.currentBookId = id;
  state.findQuery = "";
  $("#docTitle").textContent = book.title;
  $("#docSub").textContent = book.kind === "pdf"
    ? `${book.author} · PDF · ${book.pages} 页`
    : `${book.author} · MARKDOWN · ${book.words} 字`;
  $("#starBtn").classList.toggle("is-on", book.favorite);

  const isPdf = book.kind === "pdf";
  $("#pdfStack").style.display = isPdf ? "flex" : "none";
  $("#mdDoc").style.display = isPdf ? "none" : "block";
  $("#ctxTabs").style.display = isPdf ? "flex" : "none";
  $$("#ctxTabs .ctx-tab").forEach((t) => t.classList.toggle("is-on", t.dataset.ctx === "toc"));
  state.ctxTab = "toc";

  // 先切到阅读视图，保证后续布局测量（scrollHeight / offsetTop）有效
  setView("reading");

  if (isPdf) {
    state.pdf.page = Math.min(book.pages, Math.max(1, Math.round(book.progress * book.pages) || 1));
    state.pdf.zoom = 1;
    renderPdf();
    renderToolbar();
    renderCtx();
    $("#scrollArea").scrollTop = 0;
    requestAnimationFrame(() => goPage(state.pdf.page, false));
  } else {
    $("#mdDoc").innerHTML = MD_HTML;
    renderToolbar();
    renderCtx();
    requestAnimationFrame(() => {
      const area = $("#scrollArea");
      area.scrollTop = Math.round(book.progress * Math.max(0, $("#mdDoc").scrollHeight - area.clientHeight));
    });
  }

  setCtxOpen(state.settings.showCtx);
  renderBookList();
  renderGrid();
  updateStatus();
}

/* ---------------- PDF 渲染 ---------------- */
function renderPdf() {
  $("#pdfStack").innerHTML = PDF_PAGES.map((p, i) => `
    <div class="pdf-page" data-page="${p.no}" style="animation-delay:${i * 70}ms">${p.html}</div>`).join("");
  $("#pdfStack").style.setProperty("--pdf-zoom", state.pdf.zoom);
}

function goPage(page, smooth = true) {
  const total = PDF_PAGES.length;
  const target = Math.min(total, Math.max(1, page));
  state.pdf.page = target;
  const el = $(`.pdf-page[data-page="${target}"]`);
  if (el) {
    const area = $("#scrollArea");
    area.scrollTo({ top: el.offsetTop - 24, behavior: smooth ? "smooth" : "auto" });
  }
  if (state.ctxTab === "toc") renderCtx();
  renderThumbsActive();
  updateToolbarPage();
  updateStatus();
}

function setZoom(zoom) {
  state.pdf.zoom = Math.min(2, Math.max(0.5, Math.round(zoom * 10) / 10));
  $("#pdfStack").style.setProperty("--pdf-zoom", state.pdf.zoom);
  updateToolbarPage();
  updateStatus();
}

function fitWidth() {
  const areaW = $("#scrollArea").clientWidth - 64;
  setZoom(Math.min(2, Math.max(0.5, Math.round((areaW / 720) * 10) / 10)));
  toast("已适合宽度");
}

/* ---------------- 工具栏 ---------------- */
function renderToolbar() {
  const book = BOOKS.find((b) => b.id === state.currentBookId);
  const bar = $("#readToolbar");
  if (!book) { bar.innerHTML = ""; return; }

  if (book.kind === "pdf") {
    bar.innerHTML = `
      <div class="tool-group">
        <button class="tool-btn" data-act="prev" title="上一页"><svg class="ic"><use href="#i-chevron-left"/></svg></button>
        <input class="page-input" id="pageInput" type="number" min="1" max="${book.pages}" value="${state.pdf.page}" aria-label="页码" />
        <span class="page-total">/ ${book.pages}</span>
        <button class="tool-btn" data-act="next" title="下一页"><svg class="ic"><use href="#i-chevron-right"/></svg></button>
      </div>
      <span class="tool-sep"></span>
      <div class="tool-group">
        <button class="tool-btn" data-act="zoom-out" title="缩小"><svg class="ic"><use href="#i-minus"/></svg></button>
        <button class="tool-btn" data-act="zoom-label" title="重置缩放">${Math.round(state.pdf.zoom * 100)}%</button>
        <button class="tool-btn" data-act="zoom-in" title="放大"><svg class="ic"><use href="#i-plus"/></svg></button>
        <button class="tool-btn" data-act="fit" title="适合宽度"><svg class="ic"><use href="#i-maximize"/></svg></button>
      </div>
      <span class="tool-sep"></span>
      <div class="tool-group">
        <button class="tool-btn ${state.ctxOpen ? "is-on" : ""}" data-act="ctx" title="目录面板"><svg class="ic"><use href="#i-list"/></svg></button>
      </div>`;
  } else {
    bar.innerHTML = `
      <div class="tool-group">
        <button class="tool-btn" data-act="font-down" title="减小字号">A−</button>
        <span class="page-total" style="min-width:34px;text-align:center">${state.settings.fontSize}px</span>
        <button class="tool-btn" data-act="font-up" title="增大字号">A+</button>
      </div>
      <span class="tool-sep"></span>
      <div class="tool-group">
        <button class="tool-btn" data-act="lh" title="切换行高">行高 ${state.settings.lineHeight}</button>
        <button class="tool-btn" data-act="measure" title="切换版心">版心 ${state.settings.measure}</button>
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
  if (input) input.value = state.pdf.page;
  const label = $('[data-act="zoom-label"]');
  if (label) label.textContent = `${Math.round(state.pdf.zoom * 100)}%`;
  const prev = $('[data-act="prev"]');
  const next = $('[data-act="next"]');
  if (prev) prev.disabled = state.pdf.page <= 1;
  if (next) next.disabled = state.pdf.page >= PDF_PAGES.length;
}

/* ---------------- 目录 / 缩略图 / 搜索面板 ---------------- */
function renderCtx() {
  const book = BOOKS.find((b) => b.id === state.currentBookId);
  if (!book) return;
  const body = $("#ctxBody");

  if (state.ctxTab === "toc") {
    const toc = book.kind === "pdf" ? PDF_TOC : MD_TOC;
    body.innerHTML = toc.map((t) => `
      <button class="toc-item ${book.kind === "pdf" && t.page === state.pdf.page ? "is-active" : ""}"
        data-level="${t.level}" data-goto="${book.kind === "pdf" ? t.page : t.id}" data-kind="${book.kind}">
        ${t.text}${book.kind === "pdf" ? `<span class="toc-page">${t.page}</span>` : ""}
      </button>`).join("");
    return;
  }

  if (state.ctxTab === "thumbs") {
    body.innerHTML = PDF_PAGES.map((p) => `
      <button class="thumb-item ${p.no === state.pdf.page ? "is-active" : ""}" data-goto="${p.no}" data-kind="pdf">
        <div class="thumb-page">
          <i></i><i></i><i></i><i style="width:88%"></i><i></i><i style="width:70%"></i>
          <i style="width:92%"></i><i></i><i style="width:55%"></i><i></i><i style="width:80%"></i>
        </div>
        <span class="thumb-no">第 ${p.no} 页</span>
      </button>`).join("");
    return;
  }

  body.innerHTML = `
    <div class="find-box">
      <input id="findInput" type="text" placeholder="在文档内搜索…" value="${state.findQuery}" />
    </div>
    <div class="find-summary" id="findSummary">输入关键词开始搜索</div>
    <div id="findHits"></div>`;
  $("#findInput").addEventListener("input", (e) => {
    state.findQuery = e.target.value.trim();
    renderFindHits();
  });
  renderFindHits();
  if (state.findQuery) $("#findInput").focus();
}

function renderFindHits() {
  const book = BOOKS.find((b) => b.id === state.currentBookId);
  const q = state.findQuery;
  const summary = $("#findSummary");
  const hitsWrap = $("#findHits");
  if (!summary || !hitsWrap) return;
  if (!q) {
    summary.textContent = "输入关键词开始搜索";
    hitsWrap.innerHTML = "";
    return;
  }

  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const mark = (s) => esc(s).replace(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "<mark>$1</mark>");

  let hits = [];
  if (book.kind === "pdf") {
    hits = PDF_PAGES
      .filter((p) => p.text.includes(q))
      .map((p) => ({ label: `第 ${p.no} 页`, text: p.text, page: p.no }));
  } else {
    hits = $$("#mdDoc h1, #mdDoc h2, #mdDoc h3, #mdDoc p, #mdDoc li")
      .filter((el) => el.textContent.includes(q))
      .slice(0, 12)
      .map((el, i) => ({ label: el.tagName.toLowerCase() === "h2" ? "章节" : "段落", text: el.textContent, index: i }));
  }

  summary.textContent = hits.length ? `找到 ${hits.length} 处匹配` : "没有匹配结果";
  hitsWrap.innerHTML = hits.map((h, i) => {
    const snippet = h.text.length > 62 ? h.text.slice(Math.max(0, h.text.indexOf(q) - 22), h.text.indexOf(q) + 42) + "…" : h.text;
    return `<button class="find-hit" data-hit="${i}" data-page="${h.page || ""}" data-index="${h.index ?? ""}">
      <span class="hit-page">${h.label}</span>${mark(snippet)}
    </button>`;
  }).join("");
}

function renderThumbsActive() {
  $$("#ctxBody .thumb-item").forEach((el) => {
    el.classList.toggle("is-active", Number(el.dataset.goto) === state.pdf.page);
  });
}

function setCtxOpen(open) {
  state.ctxOpen = open;
  $("#ctxPanel").classList.toggle("is-hidden", !open);
  $("#ctxBtn").classList.toggle("is-on", open);
  const btn = $('[data-act="ctx"]');
  if (btn) btn.classList.toggle("is-on", open);
}

/* ---------------- 主题与排版 ---------------- */
function applySettings() {
  const s = state.settings;
  document.documentElement.style.setProperty("--read-size", `${s.fontSize}px`);
  document.documentElement.style.setProperty("--read-lh", s.lineHeight);
  document.documentElement.style.setProperty("--measure", `${s.measure}px`);
  document.body.classList.toggle("zen", s.zen);
}

function setTheme(theme, silent = false) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  const icon = $("#themeBtn use");
  icon.setAttribute("href", theme === "night" ? "#i-moon" : "#i-sun");
  $("#statusMid").textContent = THEME_LABEL[theme];
  $$(".theme-swatch").forEach((el) => el.classList.toggle("is-on", el.dataset.themeValue === theme));
  savePrefs();
  if (!silent) toast(`已切换至${THEME_LABEL[theme]}`);
}

function cycleTheme() {
  const next = THEME_ORDER[(THEME_ORDER.indexOf(state.theme) + 1) % THEME_ORDER.length];
  setTheme(next);
}

/* ---------------- 状态栏 ---------------- */
function updateStatus() {
  const book = BOOKS.find((b) => b.id === state.currentBookId);
  if (state.view === "reading" && book) {
    $("#statusLeft").textContent = book.title;
    $("#statusRight").textContent = book.kind === "pdf"
      ? `第 ${state.pdf.page} / ${book.pages} 页 · ${Math.round(state.pdf.zoom * 100)}%`
      : `MARKDOWN · ${book.words} 字 · ${state.settings.fontSize}px / ${state.settings.lineHeight}`;
  } else {
    $("#statusLeft").textContent = "就绪";
    $("#statusRight").textContent = `${BOOKS.length} 份文档 · 本地存储`;
  }
  $("#statusMid").textContent = THEME_LABEL[state.theme];
}

/* ---------------- Toast ---------------- */
let toastTimer = null;
function toast(message) {
  const wrap = $("#toastWrap");
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<svg class="ic"><use href="#i-check"/></svg><span>${message}</span>`;
  wrap.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.add("is-out");
    setTimeout(() => el.remove(), 220);
  }, 2000);
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
  const q = query.trim().toLowerCase();
  const books = BOOKS
    .filter((b) => !q || (b.title + b.subtitle + b.author).toLowerCase().includes(q))
    .slice(0, 6)
    .map((b) => ({
      group: "文档", icon: b.kind === "pdf" ? "file-text" : "book-open",
      title: b.title, sub: `${b.kind === "pdf" ? "PDF" : "Markdown"} · ${b.author}`,
      run: `open:${b.id}`
    }));
  const actions = ACTIONS
    .filter((a) => !q || (a.title + a.sub).toLowerCase().includes(q))
    .map((a) => ({ group: "动作", icon: a.icon, title: a.title, sub: a.sub, run: a.run }));
  return [...books, ...actions];
}

function renderPalette(query) {
  const items = paletteItems(query);
  const list = $("#paletteList");
  if (!items.length) {
    list.innerHTML = `<div class="ctx-empty">没有匹配项</div>`;
    return;
  }
  state.paletteIndex = Math.min(state.paletteIndex, items.length - 1);
  let html = "";
  let lastGroup = "";
  items.forEach((item, i) => {
    if (item.group !== lastGroup) {
      html += `<div class="palette-group">${item.group}</div>`;
      lastGroup = item.group;
    }
    html += `<button class="palette-item ${i === state.paletteIndex ? "is-active" : ""}" data-pi="${i}">
      <svg class="ic"><use href="#i-${item.icon}"/></svg>
      <span class="pi-main">
        <span class="pi-title">${item.title}</span>
        <span class="pi-sub">${item.sub}</span>
      </span>
      <svg class="ic" style="width:13px;height:13px;color:var(--ink-3)"><use href="#i-corner-down-right"/></svg>
    </button>`;
  });
  list.innerHTML = html;
  list.dataset.items = JSON.stringify(items.map((i) => i.run));
  const active = list.querySelector(".is-active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

function runPalette(run) {
  closePalette();
  if (run.startsWith("open:")) return openBook(run.slice(5));
  switch (run) {
    case "import": toast("原型演示：调用系统文件对话框导入 PDF / Markdown"); break;
    case "theme": cycleTheme(); break;
    case "zen": toggleZen(); break;
    case "settings": openSettings(); break;
  }
}

/* ---------------- 设置 ---------------- */
function openSettings() {
  $("#settingsOverlay").hidden = false;
  syncSettingsUI();
  $("#tbTitle").textContent = "阅读设置";
}
function closeSettings() {
  $("#settingsOverlay").hidden = true;
  $("#tbTitle").textContent = state.view === "reading" ? ($("#docTitle").textContent || "阅读") : "书架";
}
function syncSettingsUI() {
  const s = state.settings;
  $$("#fontSizeSeg button").forEach((b) => b.classList.toggle("is-on", Number(b.dataset.size) === s.fontSize));
  $$("#lineHeightSeg button").forEach((b) => b.classList.toggle("is-on", Number(b.dataset.lh) === s.lineHeight));
  $$("#measureSeg button").forEach((b) => b.classList.toggle("is-on", Number(b.dataset.measure) === s.measure));
  $("#switchCtx").classList.toggle("is-on", s.showCtx);
  $("#switchCtx").setAttribute("aria-checked", String(s.showCtx));
  $("#switchZen").classList.toggle("is-on", s.zen);
  $("#switchZen").setAttribute("aria-checked", String(s.zen));
  $$(".theme-swatch").forEach((el) => el.classList.toggle("is-on", el.dataset.themeValue === state.theme));
}

function toggleZen() {
  state.settings.zen = !state.settings.zen;
  applySettings();
  syncSettingsUI();
  savePrefs();
  toast(state.settings.zen ? "已进入专注模式" : "已退出专注模式");
}

/* ---------------- 滚动进度 ---------------- */
let scrollTick = 0;
function onReaderScroll() {
  if (scrollTick) return;
  scrollTick = requestAnimationFrame(() => {
    scrollTick = 0;
    const book = BOOKS.find((b) => b.id === state.currentBookId);
    if (!book) return;
    const area = $("#scrollArea");
    const ratio = area.scrollTop / Math.max(1, area.scrollHeight - area.clientHeight);
    book.progress = Math.min(1, Math.max(0, ratio));

    if (book.kind === "pdf") {
      let current = 1;
      $$("#pdfStack .pdf-page").forEach((page) => {
        if (page.offsetTop - area.scrollTop <= 140) current = Number(page.dataset.page);
      });
      if (current !== state.pdf.page) {
        state.pdf.page = current;
        updateToolbarPage();
        renderThumbsActive();
        if (state.ctxTab === "toc") renderCtx();
      }
    }
    updateStatus();
  });
}

/* ---------------- 事件绑定 ---------------- */
function bind() {
  // 文档列表 / 网格 / 继续阅读
  document.addEventListener("click", (e) => {
    const star = e.target.closest("[data-star]");
    if (star) {
      e.stopPropagation();
      const book = BOOKS.find((b) => b.id === star.dataset.star);
      book.favorite = !book.favorite;
      star.classList.toggle("is-on", book.favorite);
      renderBookList(); renderGrid();
      toast(book.favorite ? `已收藏《${book.title}》` : `已取消收藏《${book.title}》`);
      return;
    }
    const bookEl = e.target.closest("[data-book]");
    if (bookEl) { openBook(bookEl.dataset.book); return; }
  });

  // 导航
  $$(".rail-btn").forEach((btn) => btn.addEventListener("click", () => {
    const nav = btn.dataset.nav;
    if (nav === "library") { setView("library"); updateStatus(); }
    if (nav === "reading") { setView("reading"); if (!state.currentBookId) openBook("b1"); }
    if (nav === "search") openPalette();
    if (nav === "settings") openSettings();
  }));

  // 书架搜索 / 过滤
  $("#libSearch").addEventListener("input", (e) => {
    state.query = e.target.value.trim();
    renderBookList(); renderGrid();
  });
  $("#filterRow").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    state.filter = chip.dataset.filter;
    $$("#filterRow .chip").forEach((c) => c.classList.toggle("is-on", c === chip));
    renderBookList(); renderGrid();
  });

  // 导入
  ["#importBtn", "#importCta"].forEach((sel) => $(sel).addEventListener("click", () => {
    toast("原型演示：调用系统文件对话框导入 PDF / Markdown");
  }));

  // 返回 / 收藏 / 专注 / 目录
  $("#backBtn").addEventListener("click", () => { setView("library"); updateStatus(); });
  $("#starBtn").addEventListener("click", () => {
    const book = BOOKS.find((b) => b.id === state.currentBookId);
    if (!book) return;
    book.favorite = !book.favorite;
    $("#starBtn").classList.toggle("is-on", book.favorite);
    renderBookList(); renderGrid();
    toast(book.favorite ? `已收藏《${book.title}》` : "已取消收藏");
  });
  $("#zenBtn").addEventListener("click", toggleZen);
  $("#ctxBtn").addEventListener("click", () => { setCtxOpen(!state.ctxOpen); renderToolbar(); });

  // 目录标签页
  $("#ctxTabs").addEventListener("click", (e) => {
    const tab = e.target.closest(".ctx-tab");
    if (!tab) return;
    state.ctxTab = tab.dataset.ctx;
    $$("#ctxTabs .ctx-tab").forEach((t) => t.classList.toggle("is-on", t === tab));
    renderCtx();
  });

  // 目录 / 缩略图 / 搜索结果跳转
  $("#ctxBody").addEventListener("click", (e) => {
    const goto = e.target.closest("[data-goto]");
    if (goto) {
      if (goto.dataset.kind === "pdf") goPage(Number(goto.dataset.goto));
      else {
        const el = document.getElementById(goto.dataset.goto);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      return;
    }
    const hit = e.target.closest("[data-hit]");
    if (hit) {
      const book = BOOKS.find((b) => b.id === state.currentBookId);
      if (book.kind === "pdf" && hit.dataset.page) goPage(Number(hit.dataset.page));
      else {
        const els = $$("#mdDoc h1, #mdDoc h2, #mdDoc h3, #mdDoc p, #mdDoc li")
          .filter((el) => el.textContent.includes(state.findQuery));
        const el = els[Number(hit.dataset.index)];
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  });

  // 阅读工具栏
  $("#readToolbar").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    const s = state.settings;
    if (act === "prev") goPage(state.pdf.page - 1);
    if (act === "next") goPage(state.pdf.page + 1);
    if (act === "zoom-in") setZoom(state.pdf.zoom + 0.1);
    if (act === "zoom-out") setZoom(state.pdf.zoom - 0.1);
    if (act === "zoom-label") setZoom(1);
    if (act === "fit") fitWidth();
    if (act === "ctx") { setCtxOpen(!state.ctxOpen); renderToolbar(); }
    if (act === "font-up") { s.fontSize = Math.min(21, s.fontSize + 2); applySettings(); syncSettingsUI(); renderToolbar(); updateStatus(); savePrefs(); }
    if (act === "font-down") { s.fontSize = Math.max(15, s.fontSize - 2); applySettings(); syncSettingsUI(); renderToolbar(); updateStatus(); savePrefs(); }
    if (act === "lh") { s.lineHeight = s.lineHeight === 1.7 ? 1.9 : s.lineHeight === 1.9 ? 2.1 : 1.7; applySettings(); syncSettingsUI(); renderToolbar(); updateStatus(); savePrefs(); }
    if (act === "measure") { s.measure = s.measure === 620 ? 720 : s.measure === 720 ? 820 : 620; applySettings(); syncSettingsUI(); renderToolbar(); savePrefs(); }
  });

  $("#readToolbar").addEventListener("change", (e) => {
    if (e.target.id === "pageInput") goPage(Number(e.target.value) || 1);
  });

  // 命令面板
  $("#paletteBtn").addEventListener("click", openPalette);
  $("#paletteOverlay").addEventListener("click", (e) => { if (e.target.id === "paletteOverlay") closePalette(); });
  $("#paletteInput").addEventListener("input", (e) => {
    state.paletteIndex = 0;
    renderPalette(e.target.value);
  });
  $("#paletteList").addEventListener("click", (e) => {
    const item = e.target.closest("[data-pi]");
    if (!item) return;
    const runs = JSON.parse($("#paletteList").dataset.items || "[]");
    runPalette(runs[Number(item.dataset.pi)]);
  });

  // 设置
  $("#themeBtn").addEventListener("click", cycleTheme);
  $("#settingsOverlay").addEventListener("click", (e) => { if (e.target.id === "settingsOverlay") closeSettings(); });
  $("#settingsClose").addEventListener("click", closeSettings);
  $("#settingsDone").addEventListener("click", closeSettings);
  $("#themeRow").addEventListener("click", (e) => {
    const swatch = e.target.closest("[data-theme-value]");
    if (swatch) { setTheme(swatch.dataset.themeValue); syncSettingsUI(); }
  });
  $("#fontSizeSeg").addEventListener("click", (e) => {
    const b = e.target.closest("[data-size]");
    if (!b) return;
    state.settings.fontSize = Number(b.dataset.size);
    applySettings(); syncSettingsUI(); renderToolbar(); updateStatus(); savePrefs();
  });
  $("#lineHeightSeg").addEventListener("click", (e) => {
    const b = e.target.closest("[data-lh]");
    if (!b) return;
    state.settings.lineHeight = Number(b.dataset.lh);
    applySettings(); syncSettingsUI(); renderToolbar(); updateStatus(); savePrefs();
  });
  $("#measureSeg").addEventListener("click", (e) => {
    const b = e.target.closest("[data-measure]");
    if (!b) return;
    state.settings.measure = Number(b.dataset.measure);
    applySettings(); syncSettingsUI(); renderToolbar(); savePrefs();
  });
  $("#switchCtx").addEventListener("click", () => {
    state.settings.showCtx = !state.settings.showCtx;
    setCtxOpen(state.settings.showCtx);
    syncSettingsUI(); savePrefs();
    toast(state.settings.showCtx ? "打开文档时显示目录" : "打开文档时隐藏目录");
  });
  $("#switchZen").addEventListener("click", toggleZen);
  $("#resetBtn").addEventListener("click", () => {
    state.settings = { fontSize: 17, lineHeight: 1.9, measure: 720, showCtx: true, zen: false };
    setTheme("paper", true);
    applySettings(); syncSettingsUI(); renderToolbar(); updateStatus(); savePrefs();
    toast("已恢复默认设置");
  });
  $("#openDataBtn").addEventListener("click", () => toast("原型演示：正式版将打开本地应用数据目录"));

  // 阅读区滚动
  $("#scrollArea").addEventListener("scroll", onReaderScroll, { passive: true });
  $("#scrollArea").addEventListener("dragover", (e) => e.preventDefault());
  $("#scrollArea").addEventListener("drop", (e) => e.preventDefault());
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) toast(`原型演示：已接收《${file.name}》，正式版将导入书架`);
  });

  // 键盘
  document.addEventListener("keydown", (e) => {
    const paletteOpen = !$("#paletteOverlay").hidden;
    const settingsOpen = !$("#settingsOverlay").hidden;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      paletteOpen ? closePalette() : openPalette();
      return;
    }
    if (e.key === "Escape") {
      if (paletteOpen) closePalette();
      else if (settingsOpen) closeSettings();
      return;
    }
    if (paletteOpen) {
      const items = paletteItems($("#paletteInput").value);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        state.paletteIndex = Math.min(items.length - 1, state.paletteIndex + 1);
        renderPalette($("#paletteInput").value);
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        state.paletteIndex = Math.max(0, state.paletteIndex - 1);
        renderPalette($("#paletteInput").value);
      }
      if (e.key === "Enter" && items[state.paletteIndex]) {
        e.preventDefault();
        runPalette(items[state.paletteIndex].run);
      }
      return;
    }
    if (settingsOpen) return;
    if (state.view !== "reading") return;
    const book = BOOKS.find((b) => b.id === state.currentBookId);
    if (!book || book.kind !== "pdf" || document.activeElement?.tagName === "INPUT") return;
    if (e.key === "ArrowRight") { e.preventDefault(); goPage(state.pdf.page + 1); }
    if (e.key === "ArrowLeft") { e.preventDefault(); goPage(state.pdf.page - 1); }
    if (e.key === "+" || e.key === "=") { e.preventDefault(); setZoom(state.pdf.zoom + 0.1); }
    if (e.key === "-") { e.preventDefault(); setZoom(state.pdf.zoom - 0.1); }
  });
}

/* ---------------- 启动 ---------------- */
function init() {
  loadPrefs();
  setTheme(state.theme, true);
  applySettings();
  renderBookList();
  renderGrid();
  renderResume();
  bind();
  setView("library");
  updateStatus();
}

init();
