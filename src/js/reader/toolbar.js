/**
 * 阅读工具栏与缩放：页码、缩放档位与比例菜单、缩放菜单的展开状态。
 */
import { $, $$ } from "../core/dom.js";
import { t } from "../i18n.js";
import { state } from "../core/session.js";
import { ZOOM_STEPS, ZOOM_PRESETS } from "../core/constants.js";
import { ZOOM_MIN, ZOOM_MAX } from "../reader-pdf.js";
import { activePane, activeReader, canLinkPanes, splitMode, linkSync, setSplit, setLink } from "./panes.js";
import { ebookToolbar } from "./toolbar-ebook.js";
import { docCapabilities } from "./doc-export.js";
import { docMenuHtml, setDocMenu } from "./doc-menu.js";
import { toast } from "../core/feedback.js";
import { updateStatus } from "../view.js";


/* 本模块自有的可变句柄，不对外暴露 */
let zoomMenuOpen = false;
/* ---------------- 工具栏 ---------------- */
/** 缩放比例气泡菜单：常用比例 + 适合宽度 / 适合页面 */
function zoomMenuHtml() {
  return `<div class="zoom-menu" role="menu" aria-label="${t("reader.zoomMenu")}" hidden>
    <p class="zoom-menu-head">${t("reader.zoomMenu")}</p>
    ${ZOOM_PRESETS.map((value) => `
      <button class="zoom-item" role="menuitemradio" aria-checked="false" data-zoom="${value}">
        <span>${Math.round(value * 100)}%</span>
        <svg class="ic zoom-check"><use href="#i-check"/></svg>
      </button>`).join("")}
    <span class="zoom-menu-sep"></span>
    <button class="zoom-item" role="menuitemradio" aria-checked="false" data-fit-width>
      <svg class="ic zoom-fit"><use href="#i-fit-width"/></svg>
      <span>${t("reader.fitWidth")}</span>
      <svg class="ic zoom-check"><use href="#i-check"/></svg>
    </button>
    <button class="zoom-item" role="menuitemradio" aria-checked="false" data-fit-zoom>
      <svg class="ic zoom-fit"><use href="#i-maximize"/></svg>
      <span>${t("reader.fitPage")}</span>
      <svg class="ic zoom-check"><use href="#i-check"/></svg>
    </button>
  </div>`;
}

function renderToolbar() {
  const book = state.current;
  const bar = $("#readToolbar");
  // 工具栏整体重建，缩放菜单与文档操作菜单随之关闭
  zoomMenuOpen = false;
  if (!book) {
    bar.innerHTML = "";
    return;
  }

  // 双栏开关对所有文档生效；联动开关只在两栏同文档时出现。
  // 「文档操作」四类格式都有——只是菜单里的项按格式取舍
  const paneTools = `
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
          ${docMenuHtml(docCapabilities(activePane()))}
        </span>
      </div>`;

  if (book.kind === "pdf") {
    const total = state.pdfTotal || book.pages || 0;
    bar.innerHTML = `
      <div class="tool-group">
        <button class="tool-btn" data-act="prev" title="${t("reader.prev")}"><svg class="ic"><use href="#i-chevron-left"/></svg></button>
        <input class="page-input" id="pageInput" type="number" min="1" max="${total || 1}" value="${state.pdfPage}" aria-label="${t("reader.pageInput")}" />
        <span class="page-total">/ ${total || "…"}</span>
        <button class="tool-btn" data-act="next" title="${t("reader.next")}"><svg class="ic"><use href="#i-chevron-right"/></svg></button>
      </div>
      <span class="tool-sep"></span>
      <div class="tool-group">
        <button class="tool-btn" data-act="zoom-out" title="${t("reader.zoomOut")}"><svg class="ic"><use href="#i-minus"/></svg></button>
        <span class="zoom-anchor">
          <button class="tool-btn zoom-label" data-act="zoom-menu" aria-haspopup="menu" aria-expanded="false" title="${t("reader.zoomMenu")}">${Math.round(state.pdfZoom * 100)}%</button>
          ${zoomMenuHtml()}
        </span>
        <button class="tool-btn" data-act="zoom-in" title="${t("reader.zoomIn")}"><svg class="ic"><use href="#i-plus"/></svg></button>
        <button class="tool-btn" data-act="present" title="${t("reader.present")}"><svg class="ic"><use href="#i-present"/></svg></button>
      </div>
      <span class="tool-sep"></span>
      <div class="tool-group">
        <button class="tool-btn ${state.ctxOpen ? "is-on" : ""}" data-act="ctx" title="${t("reader.ctx")}"><svg class="ic"><use href="#i-list"/></svg></button>
      </div>${paneTools}`;
  } else if (book.kind === "text") {
    // 文本类：视图三态。表格只对 CSV/TSV 出现——doc.mode 是打开时按扩展名定的
    // 默认模式，不会因为用户切视图而变，用它判断最稳
    const pane = activePane();
    const view = pane?.textView || { mode: "code", gutter: true, wrap: false };
    const doc = pane?.doc || {};
    // 大文件（窗口渲染）锁死等宽：软换行会改变行高，滚动位置就算不出来了
    const windowed = Boolean(doc.windowed);
    const tableMode = doc.mode === "table" && !windowed;
    const table = pane?.table;
    const stat = windowed
      ? t("reader.textStatLines", { lines: doc.lines || 0 })
      : view.mode === "table"
        ? t("reader.textStatTable", { rows: table?.rows || 0, cols: table?.cols || 0 })
        : view.mode === "code"
          ? t("reader.textStatLines", { lines: doc.lines || 0 })
          : t("reader.textStatChars", { chars: doc.chars || 0 });
    // 行号与软换行只对等宽视图有意义：表格自带行号列，正文不需要行号
    const codeView = windowed || view.mode === "code";
    const gutterOff = codeView && view.wrap && !windowed;
    const lockTip = t("reader.textWindowedTip");
    bar.innerHTML = `
      <div class="tool-group">
        <button class="tool-btn ${!windowed && view.mode === "plain" ? "is-on" : ""}" data-act="text-plain"
          ${windowed ? "disabled" : ""} title="${windowed ? lockTip : t("reader.textPlainTip")}">${t("reader.textPlain")}</button>
        <button class="tool-btn ${codeView ? "is-on" : ""}" data-act="text-code" title="${t("reader.textCodeTip")}">${t("reader.textCode")}</button>
        ${tableMode ? `<button class="tool-btn ${view.mode === "table" ? "is-on" : ""}" data-act="text-table" title="${t("reader.textTableTip")}">${t("reader.textTable")}</button>` : ""}
      </div>
      <span class="tool-sep"></span>
      <div class="tool-group">
        <button class="tool-btn ${view.gutter && codeView ? "is-on" : ""}" data-act="text-gutter"
          ${codeView && !gutterOff && !windowed ? "" : "disabled"}
          title="${windowed ? lockTip : gutterOff ? t("reader.textGutterOffTip") : t("reader.textGutterTip")}">${t("reader.textGutter")}</button>
        <button class="tool-btn ${view.wrap && codeView && !windowed ? "is-on" : ""}" data-act="text-wrap"
          ${codeView && !windowed ? "" : "disabled"}
          title="${windowed ? lockTip : codeView ? t("reader.textWrapTip") : t("reader.textWrapPlainTip")}">${t("reader.textWrap")}</button>
      </div>
      <span class="tool-sep"></span>
      <div class="tool-group">
        <button class="tool-btn ${state.ctxOpen ? "is-on" : ""}" data-act="ctx" title="${t("reader.ctx")}"><svg class="ic"><use href="#i-list"/></svg></button>
      </div>
      <span class="page-total">${stat}</span>${paneTools}`;
  } else if (book.kind === "ebook") {
    // 电子书：翻页 + 可拖进度条 + 单双页 + 书签。仍然不给页码输入框——
    // 页码是排版算出来的，窗口一变就作废，能输入只会让人以为可以「跳到第 200 页」。
    // 这四个按钮该不该出现，条件比另外三种阅读器加起来都多，整段在 toolbar-ebook.js
    const pane = activePane();
    bar.innerHTML = ebookToolbar({
      fraction: state.ebookFraction || 0,
      spread: state.settings.ebookSpread !== false,
      // 固定版面（漫画）没有单双页可言：左右页由书里的 page-spread 说了算
      fixed: Boolean(pane?.ebook?.fixed),
      // 打不开的书（DRM、损坏、改错后缀）：没有书可翻，按钮全收掉，只留侧栏开关
      dead: !pane?.ebook?.book,
      marked: state.ebookMarked,
      ctxOpen: state.ctxOpen,
      layoutOpen: state.layoutOpen,
      paneTools,
    });
  } else {
    const settings = state.settings;
    bar.innerHTML = `
      <div class="tool-group">
        <button class="tool-btn" data-act="font-down" title="${t("reader.fontDown")}">A−</button>
        <span class="page-total" style="min-width:34px;text-align:center">${settings.fontSize}px</span>
        <button class="tool-btn" data-act="font-up" title="${t("reader.fontUp")}">A+</button>
      </div>
      <span class="tool-sep"></span>
      <div class="tool-group">
        <button class="tool-btn" data-act="lh" title="${t("reader.lineHeightTip")}">${t("reader.lineHeightBtn", { value: settings.lineHeight })}</button>
        <button class="tool-btn" data-act="measure" title="${t("reader.measureTip")}">${t("reader.measureBtn", { value: settings.measure })}</button>
      </div>
      <span class="tool-sep"></span>
      <div class="tool-group">
        <button class="tool-btn ${state.ctxOpen ? "is-on" : ""}" data-act="ctx" title="${t("reader.ctx")}"><svg class="ic"><use href="#i-list"/></svg></button>
      </div>${paneTools}`;
  }
  // 工具栏刚重建，新菜单默认收起；状态跟着走，否则 Esc / 外点会对着「已经关了」的菜单空转
  setDocMenu(false);
  updateToolbarPage();
}

function updateToolbarPage() {
  const input = $("#pageInput");
  if (input) input.value = state.pdfPage;
  const label = $('[data-act="zoom-menu"]');
  if (label) label.textContent = `${Math.round(state.pdfZoom * 100)}%`;
  const prev = $('[data-act="prev"]');
  const next = $('[data-act="next"]');
  if (prev) prev.disabled = state.pdfPage <= 1;
  if (next) next.disabled = state.pdfTotal > 0 && state.pdfPage >= state.pdfTotal;
  // 到缩放上下限时禁用对应按钮，避免点了没反应
  const zoomOut = $('[data-act="zoom-out"]');
  const zoomIn = $('[data-act="zoom-in"]');
  if (zoomOut) zoomOut.disabled = state.pdfZoom <= ZOOM_MIN + 0.005;
  if (zoomIn) zoomIn.disabled = state.pdfZoom >= ZOOM_MAX - 0.005;
  syncZoomMenu();
  syncEbookBar();
}

/**
 * 电子书的进度显示。
 *
 * 只改值与类名，不重建工具栏：拖滑杆的过程中重建 DOM 会把拖动手势打断，
 * 表现为「拖到一半就弹回原位」。
 */
function syncEbookBar() {
  const percent = $(".ebook-pct");
  if (!percent) return;
  const fraction = clamp01(state.ebookFraction);
  percent.textContent = `${Math.round(fraction * 100)}%`;
  const slider = $("#ebookSlider");
  // 正在拖的时候不回写：否则用户拖到 80%，手指还没抬起来就被 relocate 拽回去
  if (slider) {
    slider.style.setProperty("--_fill", `${Math.round(fraction * 100)}%`);
    if (document.activeElement !== slider) slider.value = String(Math.round(fraction * 1000));
  }
  const mark = $('[data-act="ebook-mark"]');
  if (mark) mark.classList.toggle("is-on", Boolean(state.ebookMarked));
  const spread = $('[data-act="ebook-spread"]');
  if (spread) spread.classList.toggle("is-on", state.settings.ebookSpread !== false);
}

function clamp01(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

/** 展开 / 收起缩放比例菜单 */
function setZoomMenu(open) {
  const menu = $(".zoom-menu");
  const label = $('[data-act="zoom-menu"]');
  if (!menu || !label) return;
  zoomMenuOpen = open;
  menu.hidden = !open;
  label.setAttribute("aria-expanded", String(open));
  label.classList.toggle("is-on", open);
  if (open) syncZoomMenu();
}

/** 当前比例与适配模式在菜单里打勾 */
function syncZoomMenu() {
  const menu = $(".zoom-menu");
  if (!menu) return;
  const fitMode = activeReader()?.fitMode || null;
  $$("[data-zoom]", menu).forEach((item) => {
    const matched = !fitMode && Math.abs(Number(item.dataset.zoom) - state.pdfZoom) < 0.005;
    item.setAttribute("aria-checked", String(matched));
  });
  $("[data-fit-width]", menu)?.setAttribute("aria-checked", String(fitMode === "width"));
  $("[data-fit-zoom]", menu)?.setAttribute("aria-checked", String(fitMode === "page"));
}

function goPage(page, smooth = true) {
  const reader = activeReader();
  if (!reader) return;
  reader.goPage(page, smooth);
}

function setZoom(zoom) {
  const reader = activeReader();
  if (!reader) return;
  // 不传页码：以当前阅读位置为锚点，缩放后视线保持在同一处
  reader.setZoom(zoom);
  applyReaderZoom(reader);
}

/** 按档位步进缩放：方向 1 放大、-1 缩小；到头则停在边界 */
function zoomByStep(direction) {
  if (state.current?.kind !== "pdf" || !activeReader()) return;
  const current = state.pdfZoom;
  const epsilon = 0.005;
  const target = direction > 0
    ? ZOOM_STEPS.find((step) => step > current + epsilon)
    : [...ZOOM_STEPS].reverse().find((step) => step < current - epsilon);
  if (target == null) return;
  setZoom(target);
}

/** 适合页面（菜单项）：整页完整显示 */
function fitPdfPage() {
  const reader = activeReader();
  if (!reader) return;
  reader.fitPage();
  applyReaderZoom(reader);
  toast(t("reader.fitToast"));
}

/** 适合宽度（菜单项）：页宽撑满显示区域 */
function fitPdfWidth() {
  const reader = activeReader();
  if (!reader) return;
  reader.fitWidth();
  applyReaderZoom(reader);
  toast(t("reader.fitWidthToast"));
}

/** 把阅读器当前缩放回写到全局状态与工具栏 */
function applyReaderZoom(reader) {
  state.pdfZoom = reader.zoom;
  const pane = activePane();
  if (pane) pane.zoom = reader.zoom;
  updateToolbarPage();
  updateStatus();
}

export { zoomMenuOpen, zoomMenuHtml, renderToolbar, updateToolbarPage, setZoomMenu, syncZoomMenu, goPage, setZoom, zoomByStep, fitPdfPage, fitPdfWidth, applyReaderZoom };
