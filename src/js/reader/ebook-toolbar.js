/**
 * 电子书专属的工具带（「书口」）。
 *
 * 和 PDF / 文本的浮动胶囊分开实现：那三种是「看一份文件」，工具栏浮在内容上方、
 * 用不着时最好完全消失；电子书是「读一本书」，工具栏改成一条停靠在版面底部的横带，
 * 占自己的高度、不压正文。三段各司其职——左端常驻当前章节（相当于印刷书的书眉），
 * 中间一条通栏的进度轨道，右端是成组的阅读姿势与界面开关。
 *
 * 带子只有一条，挂在阅读区底部（`index.html` 里的 `#ebookBand`），横跨单栏与双栏：
 * 双栏时它跟着活动栏换书——带子属于「正在读的那一本」，不属于某一栏。
 * 早先每栏各挂一条，分栏后带子只剩半幅、两栏的书页高度也差一个带高，页底像被切了。
 *
 * 两条规矩：
 *
 * 1. **只改值时不要重建**。翻页、拖进度条都会走到 `syncEbookBands()`，它只写数值与
 *    类名；重建 DOM 会把正在进行的拖动手势打断。
 * 2. **打不开的书只剩界面开关**。翻页、进度、书签全没有书可操作，摆出来是骗点击。
 */
import { t } from "../i18n.js";
import { state } from "../core/session.js";
import { $, escapeHtml } from "../core/dom.js";
import { activePane } from "./panes.js";
import { assistOf } from "./ebook-assist.js";
import { isScroll } from "./ebook-mode.js";
import { ticksHtml } from "./ebook-seek.js";
import { paneToolsHtml } from "./pane-tools.js";

function clamp01(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function bandHtml(pane) {
  const dead = !pane.ebook?.book;
  const fixed = Boolean(pane.ebook?.fixed);
  const scroll = !dead && isScroll(pane.ebook);
  const assist = assistOf(pane);
  const fraction = clamp01(state.ebookFraction ?? pane.ratio ?? 0);
  const pct = Math.round(fraction * 100);
  const label = pane.ebookLabel || pane.book?.title || "";

  // 版式入口对「打不开的书」也留着：用户可能只是这本书坏了，改完偏好再去开别的书
  const screenTools = `<div class="band-group">
        <button class="tool-btn ${state.layoutOpen ? "is-on" : ""}" data-act="ebook-layout"
          title="${t("layout.title")}" aria-pressed="${Boolean(state.layoutOpen)}"><svg class="ic"><use href="#i-type"/></svg></button>
        <button class="tool-btn ${state.ctxOpen ? "is-on" : ""}" data-act="ctx" title="${t("reader.ctx")}"><svg class="ic"><use href="#i-list"/></svg></button>
      </div>`;

  const head = `<span class="band-ch" title="${escapeHtml(label)}">${escapeHtml(label)}</span>`;

  if (dead) {
    return `${head}<div class="band-end">${screenTools}${paneToolsHtml(pane)}</div>`;
  }

  const poses = `<div class="band-group">
        <button class="tool-btn ${scroll ? "is-on" : ""}" data-act="ebook-flow" ${fixed ? "disabled" : ""}
          title="${t(fixed ? "reader.ebookFlowFixed" : "reader.ebookFlow")}" aria-pressed="${Boolean(scroll)}">
          <svg class="ic"><use href="#i-scroll"/></svg>
        </button>
        <button class="tool-btn ${assist?.kind === "tts" ? "is-on" : ""}" data-act="ebook-tts" ${fixed ? "hidden" : ""}
          title="${t("reader.tts")}" aria-pressed="${Boolean(assist?.kind === "tts")}">
          <svg class="ic"><use href="#i-speech"/></svg>
        </button>
        <button class="tool-btn ${assist?.kind === "auto" ? "is-on" : ""}" data-act="ebook-auto" ${fixed ? "hidden" : ""}
          title="${t("reader.auto")}" aria-pressed="${Boolean(assist?.kind === "auto")}">
          <svg class="ic"><use href="#i-auto"/></svg>
        </button>
        <button class="tool-btn ${state.settings.ebookSpread !== false && !scroll ? "is-on" : ""}" data-act="ebook-spread"
          ${fixed || scroll ? "hidden" : ""} title="${t("reader.ebookSpread")}">
          <svg class="ic"><use href="#i-book-spread"/></svg>
        </button>
        <button class="tool-btn ${state.ebookMarked ? "is-on" : ""}" data-act="ebook-mark" title="${t("reader.ebookMark")}">
          <svg class="ic"><use href="#i-bookmark"/></svg>
        </button>
      </div>`;

  // 刻度数据是异步算的（要翻遍全书），首帧可能还是空的，先留一个壳
  const seek = `<div class="band-seek">
        <button class="tool-btn" data-act="ebook-prev" title="${t("reader.prev")}"><svg class="ic"><use href="#i-chevron-left"/></svg></button>
        <span class="ebook-seek-wrap">
          <input class="ebook-slider" id="ebookSlider" type="range" min="0" max="1000" value="${Math.round(fraction * 1000)}"
            style="--_fill:${pct}%" aria-label="${t("reader.ebookSeek")}" title="${t("reader.ebookSeek")}" />
          <span class="ebook-ticks" aria-hidden="true">${ticksHtml(pane)}</span>
          <span class="ebook-seek-bubble" hidden></span>
        </span>
        <span class="page-total ebook-pct">${pct}%</span>
        <button class="tool-btn" data-act="ebook-next" title="${t("reader.next")}"><svg class="ic"><use href="#i-chevron-right"/></svg></button>
      </div>`;

  return `${head}${seek}<div class="band-end">${poses}<span class="tool-sep"></span>${screenTools}${paneToolsHtml(pane)}</div>`;
}

/** 阅读区底部那条唯一的带子 */
const bandEl = () => $("#ebookBand");

/** 活动栏换成电子书、或翻到新章节后重建整条带 */
function renderEbookBands() {
  const band = bandEl();
  if (!band) return;
  const active = activePane();
  const mine = Boolean(active && active.book?.kind === "ebook");
  band.hidden = !mine;
  if (!mine) {
    band.innerHTML = "";
    return;
  }
  band.setAttribute("aria-label", t("reader.ebookBand"));
  band.innerHTML = bandHtml(active);
}

/** PDF / 文本 / 无文档：电子书带收起 */
function hideEbookBands() {
  const band = bandEl();
  if (!band) return;
  band.hidden = true;
  band.innerHTML = "";
}

/** 翻页 / 拖进度 / 辅助条开关：只改值与类名，不重建（重建会打断拖动） */
function syncEbookBands() {
  const pane = activePane();
  const band = bandEl();
  if (!band || band.hidden || !pane) return;

  const label = pane.ebookLabel || pane.book?.title || "";
  const ch = band.querySelector(".band-ch");
  if (ch && ch.textContent !== label) {
    ch.textContent = label;
    ch.title = label;
  }

  const fraction = clamp01(state.ebookFraction ?? pane.ratio ?? 0);
  const pct = Math.round(fraction * 100);
  const percent = band.querySelector(".ebook-pct");
  if (percent) percent.textContent = `${pct}%`;

  const slider = band.querySelector("#ebookSlider");
  if (slider) {
    slider.style.setProperty("--_fill", `${pct}%`);
    // 正在拖的时候不回写：否则用户拖到 80%，还没松手就被 relocate 拽回去
    if (document.activeElement !== slider) slider.value = String(Math.round(fraction * 1000));
  }

  band.querySelector('[data-act="ebook-mark"]')?.classList.toggle("is-on", Boolean(state.ebookMarked));

  const scroll = isScroll(pane.ebook);
  const spread = band.querySelector('[data-act="ebook-spread"]');
  if (spread) {
    spread.classList.toggle("is-on", state.settings.ebookSpread !== false && !scroll);
    spread.hidden = Boolean(pane.ebook?.fixed) || scroll;
  }
  const flow = band.querySelector('[data-act="ebook-flow"]');
  if (flow) {
    flow.classList.toggle("is-on", scroll);
    flow.setAttribute("aria-pressed", String(scroll));
  }

  const assist = assistOf(pane);
  for (const [act, kind] of [["ebook-tts", "tts"], ["ebook-auto", "auto"]]) {
    const button = band.querySelector(`[data-act="${act}"]`);
    if (!button) continue;
    const on = assist?.kind === kind;
    button.classList.toggle("is-on", on);
    button.setAttribute("aria-pressed", String(on));
  }

  const ticks = band.querySelector(".ebook-ticks");
  if (ticks && !ticks.childElementCount) ticks.innerHTML = ticksHtml(pane);
}

export { renderEbookBands, hideEbookBands, syncEbookBands };
