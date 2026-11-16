/**
 * 书架渲染：列表、网格、继续阅读与统计。只读 state.books，不发起任何后端调用。
 */
import { $, escapeHtml } from "./core/dom.js";
import { t } from "./i18n.js";
import { state } from "./core/session.js";
import { KIND_CLASS, kindLabel } from "./core/constants.js";
import { tintOf, percentOf, formatRelative, formatBytes } from "./core/format.js";

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

export { visibleBooks, bookProgressText, renderBookList, renderGrid, renderResume, renderStats, renderLibrary };
