/**
 * 侧栏「书签」页。
 *
 * 顺序按加入时间，不按阅读位置：CFI 的先后关系要解析才能比，而书签本来就少，
 * 「最近加的在哪」比「在书里哪一处」更有用。
 *
 * 每条右侧带删除按钮——书签是随手加的，删不掉的话很快就变成一堆没用的定位点。
 */
import { $, escapeHtml } from "../core/dom.js";
import { t } from "../i18n.js";
import { activePane } from "./panes.js";
import { marksToolsHtml } from "./marks-tools.js";

function renderMarks() {
  const body = $("#ctxBody");
  const pane = activePane();
  const marks = pane?.book?.bookmarks || [];
  if (!marks.length) {
    body.innerHTML = `<div class="ctx-empty">${t("reader.marksEmpty")}</div>`;
    return;
  }
  body.innerHTML = `
    <div class="mark-count"><span>${t("reader.markCount", { count: marks.length })}</span>${
      marksToolsHtml(true)}</div>
    ${marks.map((mark, index) => `
      <div class="mark-row">
        <button class="find-hit mark-main" data-mark-hit="${index}">
          <span class="hit-page">${escapeHtml(mark.label || t("reader.ebookNoChapter"))}</span>
          ${escapeHtml(markAt(mark))}
        </button>
        <button class="mark-del" data-unmark="${index}" title="${t("reader.markRemove")}" aria-label="${t("reader.markRemove")}">×</button>
      </div>`).join("")}`;
}

/** 书签的时刻：只到分钟，够区分「今天读的两段」 */
function markAt(mark) {
  const date = new Date(Number(mark.createdAt) || 0);
  if (Number.isNaN(date.getTime()) || !mark.createdAt) return "";
  return date.toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export { renderMarks };
