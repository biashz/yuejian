/**
 * 双栏阅读的唯一状态持有者。
 * splitMode / linkSync / activePaneIndex 的写入全部发生在本模块，
 * 其它模块通过 live binding 读取，避免跨模块赋值带来的隐式耦合。
 */
import { $, $$, clamp } from "../core/dom.js";
import { t } from "../i18n.js";
import { state } from "../core/session.js";
import { toast } from "../core/feedback.js";
import { openBook, updateDocSub } from "./open.js";
import { openPalette } from "../palette.js";
import { flushPaneProgress, scheduleSave } from "./progress.js";
import { renderToolbar, zoomByStep } from "./toolbar.js";
import { unmountWindowed } from "../reader-bigtext.js";
import { renderCtx, setCtxOpen, setCtxTabActive, markTocActive } from "./ctx.js";
import { updateStatus } from "../view.js";
import { persistSettings } from "../preferences.js";

/* 双栏阅读：每个分栏各自持有 DOM、PDF reader 与阅读位置 */
const panes = [];
let activePaneIndex = 0;
let splitMode = false;
let linkSync = true;

/* ---------------- 双栏阅读 ---------------- */
/** 当前活动栏：工具栏、目录、状态栏都以它为准 */
function activePane() {
  return panes[activePaneIndex] || null;
}

function activeReader() {
  return activePane()?.reader || null;
}

/** 两栏是否打开同一份文档（联动只在同文档时生效） */
function canLinkPanes() {
  return Boolean(splitMode && panes[0]?.book && panes[1]?.book && panes[0].book.id === panes[1].book.id);
}

/** 把活动栏的阅读状态回写到全局 state，复用原有工具栏/状态栏逻辑 */
function mirrorPane(pane) {
  state.currentId = pane.book?.id || null;
  state.current = pane.book || null;
  state.doc = pane.doc || null;
  state.pdfPage = pane.page;
  state.pdfZoom = pane.zoom;
  state.pdfTotal = pane.total;
  state.pdfOutline = pane.outline;
  state.findQuery = pane.query;
}

function initPanes() {
  $$("[data-pane-root]").forEach((root) => {
    const index = Number(root.dataset.paneRoot);
    const pane = {
      index,
      root,
      head: $(".pane-head", root),
      headTitle: $(".pane-title", root),
      headPos: $(".pane-pos", root),
      scrollArea: $(".scroll-area", root),
      pdfStack: $(".pdf-stack", root),
      mdDoc: $(".md-doc", root),
      reader: null,
      doc: null,
      book: null,
      page: 1,
      zoom: 1,
      total: 0,
      ratio: 0,
      outline: null,
      query: "",
      hits: [],
      headingEls: [],
      spyCleanup: () => {},
      loadToken: 0,
      // 文本类文档的视图状态（正文/等宽/表格、行号、软换行）。只在本次会话内记住：
      // 把上一次读日志选的「等宽」带到下一次打开的散文里，是很烦人的事
      textView: null,
      // 表格视图的摘要（行列数、分隔符、是否截断行），每次渲染时重算
      table: null,
      // 大文件的窗口渲染状态（已加载到第几行、窗口缓存、在途请求 token）。
      // 只有 windowed 文档有值，见 reader-bigtext.js
      win: null,
    };

    // 点击或滚轮即激活该栏，避免“看着右栏却在操作左栏”
    root.addEventListener("pointerdown", () => activatePane(index));
    root.addEventListener("wheel", () => activatePane(index), { passive: true });
    // Ctrl + 滚轮缩放：与常见阅读器一致，同时拦住 WebView 默认的整页缩放。
    // 触控板会连续发出大量小 delta，累计到阈值才步进一档，避免一次手势跳好几档
    let zoomWheelAccum = 0;
    let zoomWheelTimer = 0;
    root.addEventListener("wheel", (event) => {
      if (!event.ctrlKey || pane.doc?.kind !== "pdf") return;
      event.preventDefault();
      if (pane.index !== activePaneIndex) activatePane(index);
      zoomWheelAccum += event.deltaY;
      clearTimeout(zoomWheelTimer);
      zoomWheelTimer = setTimeout(() => {
        zoomWheelAccum = 0;
      }, 220);
      if (Math.abs(zoomWheelAccum) < 40) return;
      zoomByStep(zoomWheelAccum < 0 ? 1 : -1);
      zoomWheelAccum = 0;
    }, { passive: false });
    $(".pane-open", root)?.addEventListener("click", (event) => {
      event.stopPropagation();
      activatePane(index);
      openPalette();
    });

    // Markdown 滚动：记录本栏位置，活动栏同时更新全局进度与联动
    let ticking = 0;
    pane.scrollArea.addEventListener("scroll", () => {
      if (ticking) return;
      ticking = requestAnimationFrame(() => {
        ticking = 0;
        const area = pane.scrollArea;
        const max = Math.max(1, area.scrollHeight - area.clientHeight);
        const ratio = clamp(area.scrollTop / max, 0, 1);
        pane.ratio = ratio;
        updatePaneHeads();
        if (pane.index !== activePaneIndex) return;
        if (pane.doc?.kind !== "markdown" || !pane.book) return;
        pane.book.progress = { ratio, page: 0, zoom: 1 };
        updateStatus();
        scheduleSave();
        maybeSync(pane, { page: 0, ratio });
      });
    }, { passive: true });

    panes[index] = pane;
  });
}

/** 同文档联动：把活动栏的位置同步给另一栏（PDF 精确到页内相对位置） */
function maybeSync(source, { page, ratio, pageOffset }) {
  if (!splitMode || !linkSync || source.index !== activePaneIndex) return;
  if (!canLinkPanes()) return;
  const target = panes[1 - source.index];
  if (!target?.book) return;
  if (source.book.kind === "pdf") {
    // 只同步页码会因两栏页内滚动量不同而错位，这里按页码 + 页内比例对齐
    if (!target.reader?.sheets?.length) return;
    target.reader.goPosition(page, pageOffset || 0);
    return;
  }
  if (Math.abs((target.ratio || 0) - ratio) < 0.002) return;
  scrollPaneToRatio(target, ratio);
}

/** 把另一栏对齐到活动栏当前位置：开启联动、分栏后新栏加载完成时调用 */
function syncToActivePane() {
  const source = activePane();
  if (!source?.book) return;
  const pos = source.reader?.currentPosition?.();
  maybeSync(source, { page: pos?.page ?? source.page, ratio: source.ratio, pageOffset: pos?.fraction ?? 0 });
}

function scrollPaneToRatio(pane, ratio) {
  const area = pane.scrollArea;
  const max = Math.max(0, area.scrollHeight - area.clientHeight);
  // 容器默认平滑滚动，联动时必须直接落位，否则每次同步都会重新开一段动画导致两栏追不上
  const previous = area.style.scrollBehavior;
  area.style.scrollBehavior = "auto";
  area.scrollTop = Math.round(clamp(ratio, 0, 1) * max);
  area.style.scrollBehavior = previous;
  pane.ratio = ratio;
}

/** 切换活动栏：把全局阅读状态切到新栏后刷新工具栏/目录/状态栏 */
function activatePane(index, force = false) {
  if (!panes[index]) return;
  if (index === activePaneIndex && !force) return;
  activePaneIndex = index;
  panes.forEach((pane) => pane.root.classList.toggle("is-active", pane.index === index));
  const pane = panes[index];
  // 用户接管这一栏后，放弃还没走完的联动落位校正
  pane.reader?.clearAnchor?.();
  mirrorPane(pane);

  $("#docTitle").textContent = pane.book?.title || t("reader.untitled");
  $("#starBtn").classList.toggle("is-on", Boolean(pane.book?.favorite));
  $("#ctxTabs").style.display = pane.book ? "flex" : "none";
  $("#ctxTabs [data-ctx='thumbs']").hidden = pane.book?.kind !== "pdf";
  $("#presentBtn").hidden = pane.book?.kind !== "pdf";
  // Markdown 栏没有缩略图，切回目录
  if (state.ctxTab === "thumbs" && pane.book?.kind !== "pdf") setCtxTabActive("toc");
  if (!pane.book) $("#ctxBody").innerHTML = "";

  updateDocSub();
  renderToolbar();
  renderCtx();
  updateStatus();
  updatePaneHeads();
}

function updatePaneHeads() {
  panes.forEach((pane) => {
    pane.head.hidden = !splitMode;
    pane.head.classList.toggle("is-active", pane.index === activePaneIndex);
    const book = pane.book;
    pane.headTitle.textContent = book?.title || t("reader.untitled");
    pane.headPos.textContent = book
      ? (book.kind === "pdf" ? t("reader.pageOf", { page: pane.page, total: pane.total || book.pages || "…" }) : `${Math.round((pane.ratio || 0) * 100)}%`)
      : "";
  });
}

/** 清空某个分栏；reader 实例保留，下次 open 时会自行重置 */
function closePaneDoc(pane) {
  pane.spyCleanup();
  pane.spyCleanup = () => {};
  // 窗口渲染的滚动监听挂在 scrollArea 上，换文档前必须摘掉，
  // 否则 Markdown / PDF 也会触发它去取窗口
  unmountWindowed(pane);
  pane.reader?.destroy();
  pane.doc = null;
  pane.book = null;
  pane.outline = null;
  pane.query = "";
  pane.hits = [];
  pane.headingEls = [];
  pane.page = 1;
  pane.zoom = 1;
  pane.total = 0;
  pane.ratio = 0;
  pane.loadToken += 1;
  pane.pdfStack.innerHTML = "";
  pane.mdDoc.innerHTML = "";
  pane.pdfStack.style.display = "none";
  pane.mdDoc.style.display = "none";
  pane.scrollArea.scrollTop = 0;
  if (pane.index === activePaneIndex) mirrorPane(pane);
  updatePaneHeads();
}

/** 拆分 / 合并双栏。拆分时右栏默认打开当前正在读的同一份文档 */
function setSplit(enabled) {
  if (enabled === splitMode || !panes[1]) return;
  splitMode = enabled;
  panes[1].root.hidden = !enabled;
  $("#readerPanes").classList.toggle("is-split", enabled);

  if (enabled) {
    if (panes[0].book) openBook(panes[0].book.id, panes[1]);
  } else {
    flushPaneProgress(panes[1]);
    // 左栏为空而只有右栏有文档时，把文档接回左栏，避免合并后什么都看不到
    const orphanId = panes[0].book ? null : panes[1].book?.id;
    closePaneDoc(panes[1]);
    if (activePaneIndex === 1) activatePane(0, true);
    if (orphanId) openBook(orphanId, panes[0]);
  }

  renderToolbar();
  updatePaneHeads();
  // 栏宽变化后重新计算 PDF 的适配宽度
  requestAnimationFrame(() => panes.forEach((pane) => pane.reader?.handleResize()));
}

function setLink(enabled) {
  linkSync = enabled;
  state.settings.linkSync = enabled;
  persistSettings();
  renderToolbar();
  // 开启联动时立刻把另一栏对齐到当前阅读位置，避免两栏停在各自位置等下一次滚动
  if (enabled && canLinkPanes()) syncToActivePane();
  toast(enabled ? t("toast.linkOn") : t("toast.linkOff"));
}

/** 分栏是临时操作，启动时一律单栏；联动开关按上次选择恢复（不自动打开文档） */
function applySplitState() {
  splitMode = false;
  linkSync = state.settings.linkSync !== false;
  if (panes[1]) panes[1].root.hidden = true;
  $("#readerPanes").classList.remove("is-split");
  updatePaneHeads();
}

export { panes, activePaneIndex, splitMode, linkSync, activePane, activeReader, canLinkPanes, mirrorPane, initPanes, maybeSync, syncToActivePane, scrollPaneToRatio, activatePane, updatePaneHeads, closePaneDoc, setSplit, setLink, applySplitState };
