/**
 * 书架渲染：列表、网格、继续阅读与统计。只读 state.books，不发起任何后端调用。
 */
import { $, $$, escapeHtml } from "./core/dom.js";
import { t } from "./i18n.js";
import { state } from "./core/session.js";
import { KIND_CLASS, kindLabel } from "./core/constants.js";
import { tintOf, percentOf, formatRelative, formatBytes } from "./core/format.js";
import { matchCategory, categoryById } from "./categories.js";
import { renderCategorySection, renderBatchBar } from "./category-ui.js";

/* ---------------- 书架渲染 ---------------- */
function visibleBooks() {
  const query = state.query.toLowerCase();
  return state.books
    .filter((book) => {
      if (state.filter === "star" && !book.favorite) return false;
      if (["pdf", "markdown", "text", "ebook"].includes(state.filter) && book.kind !== state.filter) return false;
      if (!matchCategory(book)) return false;
      if (query && !`${book.title} ${book.author}`.toLowerCase().includes(query)) return false;
      return true;
    })
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

/* 分类色点：与分类区共用 .cat-dot 的取色规则 */
function bookCategoryDot(book) {
  const category = book.categoryId ? categoryById(book.categoryId) : null;
  if (!category) return "";
  return `<span class="cat-dot is-tiny c-${category.color}"></span>`;
}

function bookProgressText(book) {
  if (book.kind === "pdf") {
    const pages = book.pages ? t("reader.pagesCount", { count: book.pages }) : "";
    return pages ? `${pages} · ${formatBytes(book.size)}` : formatBytes(book.size);
  }
  if (book.kind === "text") {
    const words = book.words ? t("reader.wordsCount", { count: book.words }) : "";
    return words ? `${words} · ${formatBytes(book.size)}` : formatBytes(book.size);
  }
  if (book.kind === "ebook") {
    // 章节数要解析完 OPF 才有，书架这一层拿不到，只报体积
    return `${kindLabel("ebook", book)} · ${formatBytes(book.size)}`;
  }
  const words = book.words ? t("reader.wordsCount", { count: book.words }) : "Markdown";
  return `${words} · ${formatBytes(book.size)}`;
}

/**
 * 空态文案：优先解释「为什么空」。
 * 只有该分类本身一份文档都没有时，才提示「拖文档进来」；
 * 分类里有文档但被类型/关键词筛掉了，提示清除筛选，否则会误导用户以为分类是空的。
 */
function emptyStateText() {
  if (state.query) return `${t("library.noMatch")}<br>${t("library.tryAnother")}`;
  if (state.categoryId !== null) {
    const inCategory = state.books.filter((book) => book.categoryId === state.categoryId).length;
    if (inCategory === 0) {
      return `${t("category.emptyCategory")}<br>${t("category.emptyCategoryHint")}`;
    }
  }
  if (state.categoryId !== null || state.filter !== "all") {
    return `${t("library.noMatch")}<br>${t("library.clearHint")}`;
  }
  return t("library.noMatch");
}

function renderBookList(books) {
  const list = $("#bookList");
  $("#libCount").textContent = state.books.length;
  if (!books.length) {
    const emptyText = state.books.length
      ? emptyStateText()
      : `${t("library.emptyList")}<br>${t("library.emptyListHint")}`;
    list.innerHTML = `<div class="ctx-empty">${emptyText}</div>`;
    return;
  }
  list.innerHTML = books.map((book) => `
    <div class="book-row ${book.id === state.currentId ? "is-current" : ""} ${state.selected.has(book.id) ? "is-selected" : ""}"
      data-book="${book.id}" role="button" tabindex="0" draggable="true">
      <div class="mini-cover tint-${tintOf(book.id)}"><span>${escapeHtml(book.title.slice(0, 1))}</span></div>
      <div class="book-row-main">
        <div class="book-row-title">${escapeHtml(book.title)}</div>
        <div class="book-row-meta">
          <i class="type-dot ${KIND_CLASS[book.kind] || "md"}"></i>${kindLabel(book.kind, book)} · ${formatRelative(book.lastOpenedAt)}
          ${bookCategoryDot(book)}
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
    grid.innerHTML = state.books.length ? `<div class="ctx-empty">${emptyStateText()}</div>` : "";
    return;
  }
  grid.innerHTML = books.map((book, index) => {
    const category = book.categoryId ? categoryById(book.categoryId) : null;
    return `
    <div class="book-card ${state.selected.has(book.id) ? "is-selected" : ""}" data-book="${book.id}"
      tabindex="0" draggable="true" style="animation-delay:${140 + index * 40}ms">
      <div class="cover tint-${tintOf(book.id)}">
        <div class="cover-inner">
          <span class="cover-kind">${kindLabel(book.kind, book)}</span>
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
        <div class="card-sub">
          ${category ? `<span class="cat-dot is-tiny c-${category.color}" title="${escapeHtml(category.name)}"></span>` : ""}
          ${kindLabel(book.kind, book)} · ${formatRelative(book.lastOpenedAt)}
        </div>
        <div class="card-foot">
          <span class="progress-line"><i style="width:${percentOf(book)}%"></i></span>
          <span class="card-pct">${percentOf(book)}%</span>
        </div>
      </div>
    </div>`;
  }).join("");
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
        <span class="cover-kind">${kindLabel(candidate.kind, candidate)}</span>
        <span class="cover-title">${escapeHtml(candidate.title)}</span>
        <span class="cover-rule"></span>
        <span class="cover-author">${escapeHtml(bookProgressText(candidate))}</span>
      </div>
    </div>
    <div class="resume-info">
      <h3>${escapeHtml(candidate.title)}</h3>
      <p>${kindLabel(candidate.kind, candidate)} · ${escapeHtml(bookProgressText(candidate))}</p>
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

/** 当前筛选组合的可读描述：分类轴 + 类型轴 + 搜索词，用于区块标题 */
function filterSummary() {
  const parts = [];
  if (state.categoryId === "") parts.push(t("category.none"));
  else if (state.categoryId !== null) {
    const category = categoryById(state.categoryId);
    if (category) parts.push(category.name);
  }
  if (state.filter === "pdf") parts.push("PDF");
  if (state.filter === "markdown") parts.push("MARKDOWN");
  if (state.filter === "text") parts.push(t("library.filterText"));
  if (state.filter === "ebook") parts.push("EPUB");
  if (state.filter === "star") parts.push(t("library.filterStar"));
  if (state.query) parts.push(`“${state.query}”`);
  return parts;
}

function renderSectionHead() {
  const parts = filterSummary();
  $("#gridHead h2").textContent = parts.length ? parts.join(" · ") : t("library.allDocs");
  $("#gridHead .section-sub").textContent = parts.length ? t("category.filteredSub") : t("library.sortRecent");
  $("#headClear").hidden = parts.length === 0;
}

/** 选中态只切 class，不重绘列表：避免长列表下滚动位置被重置 */
function syncSelection() {
  $$(".book-row[data-book], .book-card[data-book]").forEach((el) => {
    el.classList.toggle("is-selected", state.selected.has(el.dataset.book));
  });
  renderBatchBar();
}

/** 丢弃指向已不存在的文档的选中项（移除、重新导入后可能出现） */
function pruneSelection() {
  if (!state.selected.size) return;
  const alive = new Set(state.books.map((book) => book.id));
  let changed = false;
  state.selected.forEach((id) => {
    if (!alive.has(id)) {
      state.selected.delete(id);
      changed = true;
    }
  });
  return changed;
}

function renderLibrary() {
  pruneSelection();
  const books = visibleBooks();
  renderCategorySection();
  renderBookList(books);
  renderGrid(books);
  renderResume();
  renderStats();
  renderSectionHead();

  const empty = state.books.length === 0;
  $("#emptyLibrary").hidden = !empty;
  $("#gridHead").hidden = empty;
  $("#bookGrid").hidden = empty;
}

export { visibleBooks, bookProgressText, renderBookList, renderGrid, renderResume, renderStats, renderLibrary, syncSelection };
