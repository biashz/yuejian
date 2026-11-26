/**
 * 「栏级」按钮组：双栏、联动、文档操作菜单。
 *
 * PDF / 文本 / Markdown 的浮动工具栏与电子书的底部工具带都要用它，
 * 所以从 `toolbar.js` 里抽出来单独一份——两边各抄一遍的话，
 * 以后给菜单加一项必须记得改两处，迟早漏掉一边。
 */
import { t } from "../i18n.js";
import { splitMode, linkSync, canLinkPanes } from "./panes.js";
import { docCapabilities } from "./doc-export.js";
import { docMenuHtml } from "./doc-menu.js";

/** @param {object} pane 活动栏：文档操作菜单按它的格式取舍条目 */
function paneToolsHtml(pane) {
  return `
      <span class="tool-sep"></span>
      <div class="tool-group">
        <button class="tool-btn ${splitMode ? "is-on" : ""}" data-act="split" title="${t("reader.split")}">
          <svg class="ic"><use href="#i-columns"/></svg>
        </button>
        ${canLinkPanes() ? `<button class="tool-btn ${linkSync ? "is-on" : ""}" data-act="link" title="${t("reader.link")}">
          <svg class="ic"><use href="#i-link"/></svg>
        </button>` : ""}
        <span class="doc-anchor">
          <button class="tool-btn" data-act="doc-menu" aria-haspopup="menu" aria-expanded="false"
            title="${t("reader.docMenu")}"><svg class="ic"><use href="#i-more"/></svg></button>
          ${docMenuHtml(docCapabilities(pane))}
        </span>
      </div>`;
}

export { paneToolsHtml };
