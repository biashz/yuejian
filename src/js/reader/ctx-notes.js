/**
 * 侧栏「划线」页：这本书上所有划线，一条一行。
 *
 * 与书签列表同一套骨架（章节名 + 原文 + 右侧删除），差别是行首多一个颜色点、
 * 正文可能占两三行。顺序按阅读位置排不了——CFI 的先后要解析才知道，
 * 所以按加入时间倒序：刚划的那条总在最上面。
 */
import { $, escapeHtml } from "../core/dom.js";
import { t } from "../i18n.js";
import { activePane } from "./panes.js";
import { colorValue, listOf } from "./highlight.js";

function renderNotes() {
  const body = $("#ctxBody");
  const pane = activePane();
  const notes = [...listOf(pane)].reverse();
  if (!notes.length) {
    body.innerHTML = `<div class="ctx-empty">${t("reader.notesEmpty")}</div>`;
    return;
  }
  body.innerHTML = `
    <div class="mark-count">${t("reader.noteCount", { count: notes.length })}</div>
    ${notes.map((note, index) => `
      <div class="mark-row note-row">
        <button class="find-hit mark-main" data-note-hit="${index}">
          <span class="hit-page"><i class="note-dot" style="--_dot:${colorValue(note.color)}"></i>${
            escapeHtml(note.label || t("reader.ebookNoChapter"))}</span>
          ${escapeHtml(note.text || "")}
        </button>
        <button class="mark-del" data-unnote="${index}" title="${t("reader.highlightRemove")}"
          aria-label="${t("reader.highlightRemove")}">×</button>
      </div>`).join("")}`;
}

export { renderNotes };
