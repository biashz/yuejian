/**
 * 侧栏视图：文档大纲、页面缩略图、文本信息、全文搜索。全部针对「当前活动栏」渲染。
 */
import { $, $$, escapeHtml } from "../core/dom.js";
import { t } from "../i18n.js";
import { state } from "../core/session.js";
import { kindLabel } from "../core/constants.js";
import { formatBytes } from "../core/format.js";
import { activePane } from "./panes.js";
import { canHighlight, willHighlight } from "../reader-text.js";
import { delimiterLabel } from "../reader-csv.js";

/* 每种文档能用的侧栏视图：PDF 有缩略图，文本类没有大纲但有文件信息 */
const TABS_BY_KIND = {
  pdf: ["toc", "thumbs", "find"],
  text: ["info", "find"],
};


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
  if (state.ctxTab === "thumbs") return renderThumbs();
  return renderFind();
}

/**
 * 信息面板里「高亮」这一行只回答「开没开」，不写语言名。
 * 语言是哪个，上面「类型」徽标（RS / JSON / YAML）已经说了；而且 hljs 的
 * 语言名是给内部用的，`ini` 会显示成「TOML, also INI」，直接放出来更糊涂。
 */
function highlightLabel(doc) {
  if (!doc.lang) return t("reader.infoLangNone");
  if (!canHighlight(doc)) return t("reader.infoLangOff");
  return willHighlight(doc) ? t("reader.infoLangOn") : t("reader.infoLangUnsupported");
}

/** 文本类的文件信息：编码、行数、字符数、换行符。编码是重点——探测可能不准 */
function renderInfo() {
  const body = $("#ctxBody");
  const pane = activePane();
  const doc = pane?.doc;
  if (!doc || doc.kind !== "text") {
    body.innerHTML = `<div class="ctx-empty">${t("reader.infoEmpty")}</div>`;
    return;
  }
  const rows = [
    [t("reader.infoKind"), kindLabel("text", pane.book)],
    [t("reader.infoEncoding"), doc.encoding],
    [t("reader.infoLines"), String(doc.lines)],
    [t("reader.infoChars"), String(doc.chars)],
    [t("reader.infoEol"), doc.eol],
    [t("reader.infoSize"), formatBytes(pane.book?.size || 0)],
    [t("reader.infoLang"), highlightLabel(doc)],
  ];
  // 分隔符只在表格类文档上有意义：它决定了列是怎么拆的，拆错了要能看出来
  if (doc.mode === "table") {
    const delimiter = pane.table?.delimiter || ",";
    rows.push([t("reader.infoDelimiter"), t(`reader.infoDelimiter.${delimiterLabel(delimiter)}`)]);
  }
  body.innerHTML = `
    <dl class="info-list">
      ${rows.map(([key, value]) => `<div class="info-row"><dt>${key}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}
    </dl>
    ${doc.truncated ? `<p class="info-note">${t("reader.infoTruncated")}</p>` : ""}
    ${pane.table?.clipped ? `<p class="info-note">${t("reader.infoTableClipped")}</p>` : ""}`;
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
