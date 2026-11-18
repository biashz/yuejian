/**
 * 电子书那一排工具按钮的 HTML。
 *
 * 从 `toolbar.js` 挪出来的：那个文件同时管 PDF、文本、Markdown、电子书四套按钮，
 * 已经顶到 300 行的上限，而电子书这套的判定条件又最多（有没有书、是不是固定版面、
 * 有没有书签）。抽成纯函数之后，条件全在这里，`toolbar.js` 只负责决定何时调用。
 */
import { t } from "../i18n.js";

/**
 * @param {object} options
 * @param {number} options.fraction 0–1 的阅读进度
 * @param {boolean} options.spread 用户选的双页偏好
 * @param {boolean} options.fixed 固定版面（漫画）：没有单双页可言
 * @param {boolean} options.dead 打开失败：没有书可翻，只剩侧栏开关有意义
 * @param {boolean} options.marked 当前页是否已加书签
 * @param {boolean} options.ctxOpen 侧栏是否展开
 * @param {string} options.paneTools 分栏工具（双栏时才有）
 * @returns {string}
 */
export function ebookToolbar({ fraction, spread, fixed, dead, marked, ctxOpen, paneTools }) {
  const pct = Math.round((fraction || 0) * 100);
  const separator = '<span class="tool-sep"></span>';
  const contents = `<div class="tool-group">
        <button class="tool-btn ${ctxOpen ? "is-on" : ""}" data-act="ctx" title="${t("reader.ctx")}"><svg class="ic"><use href="#i-list"/></svg></button>
      </div>${paneTools}`;

  // 打不开的书：翻页、进度条、书签全是死的，摆出来只会让人以为可以点
  if (dead) return contents;

  return `<div class="tool-group">
        <button class="tool-btn" data-act="ebook-prev" title="${t("reader.prev")}"><svg class="ic"><use href="#i-chevron-left"/></svg></button>
        <input class="ebook-slider" id="ebookSlider" type="range" min="0" max="1000" value="${Math.round((fraction || 0) * 1000)}"
          style="--_fill:${pct}%" aria-label="${t("reader.ebookSeek")}" title="${t("reader.ebookSeek")}" />
        <span class="page-total ebook-pct">${pct}%</span>
        <button class="tool-btn" data-act="ebook-next" title="${t("reader.next")}"><svg class="ic"><use href="#i-chevron-right"/></svg></button>
      </div>
      ${separator}
      <div class="tool-group">
        <button class="tool-btn ${spread ? "is-on" : ""}" data-act="ebook-spread"
          ${fixed ? "hidden" : ""} title="${t("reader.ebookSpread")}">
          <svg class="ic"><use href="#i-book-spread"/></svg>
        </button>
        <button class="tool-btn ${marked ? "is-on" : ""}" data-act="ebook-mark" title="${t("reader.ebookMark")}">
          <svg class="ic"><use href="#i-bookmark"/></svg>
        </button>
      </div>
      ${separator}
      ${contents}`;
}
