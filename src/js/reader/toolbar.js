/**
 * 阅读工具栏与缩放：页码、缩放档位与比例菜单、缩放菜单的展开状态。
 */
import { $, $$ } from "../core/dom.js";
import { t } from "../i18n.js";
import { state } from "../core/session.js";
import { ZOOM_STEPS, ZOOM_PRESETS } from "../core/constants.js";
import { ZOOM_MIN, ZOOM_MAX } from "../reader-pdf.js";
import { activePane, activeReader, canLinkPanes, splitMode, linkSync, setSplit, setLink } from "./panes.js";
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
  // 工具栏整体重建，缩放菜单随之关闭
  zoomMenuOpen = false;
  if (!book) {
    bar.innerHTML = "";
    return;
  }

  // 双栏开关对所有文档生效；联动开关只在两栏同文档时出现
  const paneTools = `
      <span class="tool-sep"></span>
      <div class="tool-group">
        <button class="tool-btn ${splitMode ? "is-on" : ""}" data-act="split" title="${t("reader.split")}">
          <svg class="ic"><use href="#i-columns"/></svg>
        </button>
        ${canLinkPanes() ? `<button class="tool-btn ${linkSync ? "is-on" : ""}" data-act="link" title="${t("reader.link")}">
          <svg class="ic"><use href="#i-link"/></svg>
        </button>` : ""}
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
    // 文本类：视图三态（一期只有正文/等宽，「表格」随 CSV 那一期上线）
    const pane = activePane();
    const view = pane?.textView || { mode: "code", gutter: true, wrap: false };
    const doc = pane?.doc || {};
    const stat = view.mode === "code"
      ? t("reader.textStatLines", { lines: doc.lines || 0 })
      : t("reader.textStatChars", { chars: doc.chars || 0 });
    bar.innerHTML = `
      <div class="tool-group">
        <button class="tool-btn ${view.mode === "plain" ? "is-on" : ""}" data-act="text-plain" title="${t("reader.textPlainTip")}">${t("reader.textPlain")}</button>
        <button class="tool-btn ${view.mode === "code" ? "is-on" : ""}" data-act="text-code" title="${t("reader.textCodeTip")}">${t("reader.textCode")}</button>
      </div>
      <span class="tool-sep"></span>
      <div class="tool-group">
        <button class="tool-btn ${view.gutter ? "is-on" : ""}" data-act="text-gutter"
          ${view.mode === "code" && view.wrap ? "disabled" : ""}
          title="${view.mode === "code" && view.wrap ? t("reader.textGutterOffTip") : t("reader.textGutterTip")}">${t("reader.textGutter")}</button>
        <button class="tool-btn ${view.wrap ? "is-on" : ""}" data-act="text-wrap"
          ${view.mode === "plain" ? "disabled" : ""}
          title="${view.mode === "plain" ? t("reader.textWrapPlainTip") : t("reader.textWrapTip")}">${t("reader.textWrap")}</button>
      </div>
      <span class="tool-sep"></span>
      <div class="tool-group">
        <button class="tool-btn ${state.ctxOpen ? "is-on" : ""}" data-act="ctx" title="${t("reader.ctx")}"><svg class="ic"><use href="#i-list"/></svg></button>
      </div>
      <span class="page-total">${stat}</span>${paneTools}`;
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
