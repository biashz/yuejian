/**
 * 书架「全文命中」区：把 `library-search.js` 的结果画成一列可点的行。
 *
 * 放在主区 `#bookGrid` 之后，而不是塞进书列表：书名筛选的结果与正文命中的结果
 * 是两件事——一本书可能书名没匹配上、正文里却有一堆命中。混在一起的话，
 * 用户会以为「搜索没找到这本」。
 *
 * 渲染是幂等的：`renderHits` 每次整段重画，`setStatus` 只改状态行。检索过程中
 * 反复调用的就是后者，避免每本书都让已有结果闪一下。
 */
import { $, escapeHtml } from "./core/dom.js";
import { t } from "./i18n.js";
import { kindLabel } from "./core/constants.js";

function root() {
  return $("#libHits");
}

/** 收起整个区域（清空关键词、切换视图时用） */
function clearHits() {
  const box = root();
  if (!box) return;
  box.hidden = true;
  box.innerHTML = "";
  delete box.dataset.state;
}

/** 状态行：检索中 / 建索引中 / 没有命中 */
function setStatus(text) {
  const box = root();
  if (!box) return;
  box.hidden = false;
  box.dataset.state = "pending";
  box.innerHTML = `<div class="hits-status">${escapeHtml(text)}</div>`;
}

function renderHits(result) {
  const box = root();
  if (!box) return;
  const groups = result?.groups || [];
  if (!groups.length) {
    // 没有命中也要说一句：否则用户分不清「正文里确实没有」与「还没搜」
    box.hidden = false;
    box.dataset.state = "empty";
    box.innerHTML = `<div class="hits-status">${t("library.searchNone")}</div>`;
    return;
  }

  const books = groups.length;
  const total = result.total || 0;
  const skipped = result.skipped
    ? `<span class="hits-skip">${escapeHtml(t("library.searchSkipped", { count: result.skipped }))}</span>`
    : "";

  box.hidden = false;
  box.dataset.state = "done";
  box.innerHTML = `
    <div class="hits-head">
      <span>${t("library.searchFull")}</span>
      <span class="hits-count">${escapeHtml(t("library.searchCount", { books, count: total }))}</span>
      ${skipped}
    </div>
    ${groups.map((group) => `
      <div class="hits-group">
        <div class="hits-book">
          <span class="hits-book-title">${escapeHtml(group.book.title)}</span>
          <span class="hits-book-sub">${escapeHtml(kindLabel(group.book.kind, group.book))} · ${escapeHtml(t("library.searchHits", { count: group.hits.length }))}</span>
        </div>
        ${group.hits.map((hit) => {
          // PDF 的单元标签是空的，位置靠页码；电子书反过来，有章节名没页码
          const where = hit.label || (hit.page ? t("reader.pageN", { page: hit.page }) : "");
          return `
          <button class="hits-row" data-hit-book="${escapeHtml(group.book.id)}" data-hit-page="${hit.page || 0}">
            ${where ? `<span class="hits-where">${escapeHtml(where)}</span>` : ""}
            <span class="hits-text">${escapeHtml(hit.pre)}<mark>${escapeHtml(hit.hit)}</mark>${escapeHtml(hit.post)}</span>
          </button>`;
        }).join("")}
      </div>`).join("")}`;
}

/** 当前是否已经摆出了正文命中。书架的空态要据此换一句话，避免自相矛盾 */
function hasHits() {
  const box = root();
  return Boolean(box && box.dataset.state === "done" && box.querySelector(".hits-group"));
}

export { clearHits, setStatus, renderHits, hasHits };
