/**
 * 侧栏三视图：文档大纲、页面缩略图、全文搜索。全部针对「当前活动栏」渲染。
 */
import { $, $$, escapeHtml } from "../core/dom.js";
import { t } from "../i18n.js";
import { state } from "../core/session.js";
import { activePane } from "./panes.js";


/* 本模块自有的可变句柄，不对外暴露 */
let findTimer = 0;
let findToken = 0;
let thumbObserver = null;
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

export { setCtxOpen, setCtxTabActive, switchCtxTab, renderCtx, renderToc, markTocActive, renderThumbs, markThumbActive, renderFind, runFind };
