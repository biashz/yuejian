/**
 * 侧栏「目录」页：PDF 大纲、Markdown 标题树、电子书 NAV/NCX，以及「当前读到哪一条」的高亮。
 *
 * 三种文档的目录来源完全不同（PDF 要异步解析、Markdown 在打开时就拿到了、
 * 电子书来自书自身），但渲染出来的都是同一个 `.toc-item` 列表——所以放在一起，
 * 高亮逻辑也只写一遍。
 */
import { $, $$, escapeHtml } from "../core/dom.js";
import { t } from "../i18n.js";
import { state } from "../core/session.js";
import { activePane } from "./panes.js";

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

  // 电子书的目录是书自带的 NAV/NCX，可能是空的一本（只有正文没有目录）。
  // 打不开的书也没有目录，但它不是「翻页就行」——照空态说「用方向键翻页」是假话
  if (book.kind === "ebook") {
    const items = pane.ebookToc || [];
    if (!items.length) {
      const key = pane.ebook?.book ? "reader.tocEbookEmpty" : "reader.tocEbookDead";
      body.innerHTML = `<div class="ctx-empty">${t(key)}</div>`;
      return;
    }
    body.innerHTML = items.map((item) => `
      <button class="toc-item" data-level="${item.level}" data-goto="${escapeHtml(item.href)}" data-kind="ebook">
        ${escapeHtml(item.label)}
      </button>`).join("");
    markTocActive();
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
  // 电子书：目录项的 href 可能带锚点，当前定位也可能是同一文件的另一处，
  // 所以先找完全相同的，再退化成「同一个文件」的最后一项
  if (pane?.book?.kind === "ebook") {
    const href = state.ebookHref || pane.ebook?.location?.href || "";
    if (!href) return;
    const file = href.split("#")[0];
    let activeIndex = -1;
    items.forEach((item, index) => {
      const target = item.dataset.goto || "";
      if (target === href) activeIndex = index;
      else if (activeIndex < 0 && target.split("#")[0] === file) activeIndex = index;
    });
    items.forEach((item, index) => item.classList.toggle("is-active", index === activeIndex));
    return;
  }
  if (!pane?.outline?.length) return;
  // PDF：取最后一个页码不超过当前页的条目
  let activeIndex = 0;
  pane.outline.forEach((item, index) => {
    if (item.page <= pane.page) activeIndex = index;
  });
  items.forEach((item, index) => item.classList.toggle("is-active", index === activeIndex));
}

export { renderToc, markTocActive };
