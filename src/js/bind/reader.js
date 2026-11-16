/**
 * 阅读视图的事件绑定：文档栏按钮、目录三个标签与跳转、阅读工具栏、
 * 缩放菜单的外部点击收起，以及演示模式的分辨率变化与全屏退出。
 */
import { $, $$, clamp } from "../core/dom.js";
import { state } from "../core/session.js";
import { SIZE_STEPS } from "../core/constants.js";
import { scrollToHeading } from "../reader-md.js";
import { activePane, splitMode, linkSync, setSplit, setLink } from "../reader/panes.js";
import { setView, updateStatus } from "../view.js";
import { goPage, setZoom, setZoomMenu, zoomMenuOpen, zoomByStep, fitPdfPage, fitPdfWidth, renderToolbar } from "../reader/toolbar.js";
import { setCtxOpen, switchCtxTab } from "../reader/ctx.js";
import { presenting, presentEntering, enterPresent, exitPresent, presentStep, handlePresentWheel, schedulePresentPaint } from "../reader/present.js";
import { applySettings, syncSettingsUI, persistSettings, toggleZen } from "../preferences.js";
import { toggleFavorite } from "../actions.js";

export function bindReaderEvents() {
  // 文档栏
  $("#backBtn").addEventListener("click", () => setView("library"));
  $("#starBtn").addEventListener("click", () => state.current && toggleFavorite(state.current.id));
  $("#zenBtn").addEventListener("click", toggleZen);
  $("#presentBtn").addEventListener("click", enterPresent);
  // 点击右半屏下一页、左半屏上一页，方便鼠标/投屏笔操作
  $("#presentStage").addEventListener("click", (event) => {
    // 底部是提示与页码区域，不当作翻页
    if (event.clientY > window.innerHeight - 60) return;
    presentStep(event.clientX < window.innerWidth / 2 ? -1 : 1);
  });
  // 滚轮/触控板翻页：向下下一页、向上上一页
  $("#presentStage").addEventListener("wheel", handlePresentWheel, { passive: false });
  window.addEventListener("resize", () => {
    // 全屏切换会连续触发 resize：防抖后只重画最后一次的尺寸；
    // 全屏过渡期间先不画，等 fullscreen 的 promise 落地后再排首帧
    if (presenting && !presentEntering) schedulePresentPaint();
  });
  document.addEventListener("fullscreenchange", () => {
    // 用户按系统快捷键退出全屏时，同步退出演示（presenting 已复位则不会递归）
    if (presenting && !document.fullscreenElement) exitPresent();
  });
  $("#ctxBtn").addEventListener("click", () => {
    setCtxOpen(!state.ctxOpen);
    renderToolbar();
  });

  // 目录标签
  $("#ctxTabs").addEventListener("click", (event) => {
    const tab = event.target.closest(".ctx-tab");
    if (tab && !tab.hidden) switchCtxTab(tab.dataset.ctx);
  });

  // 目录 / 缩略图 / 搜索结果跳转
  $("#ctxBody").addEventListener("click", (event) => {
    const goto = event.target.closest("[data-goto]");
    if (goto) {
      if (goto.dataset.kind === "pdf") goPage(Number(goto.dataset.goto));
      else if (activePane()) scrollToHeading(activePane().scrollArea, goto.dataset.goto);
      return;
    }
    const hit = event.target.closest("[data-hit]");
    if (hit) {
      if (hit.dataset.kind === "pdf") goPage(Number(hit.dataset.page));
      else {
        const pane = activePane();
        const node = pane?.hits[Number(hit.dataset.hit)];
        if (node && pane) {
          const area = pane.scrollArea;
          const offset = node.getBoundingClientRect().top - area.getBoundingClientRect().top;
          area.scrollTo({ top: area.scrollTop + offset - 80, behavior: "smooth" });
        }
      }
    }
  });

  // 阅读工具栏
  $("#readToolbar").addEventListener("click", (event) => {
    // 缩放菜单里的选项先于 [data-act] 处理（菜单项没有 data-act）
    const preset = event.target.closest("[data-zoom]");
    if (preset) {
      setZoom(Number(preset.dataset.zoom));
      setZoomMenu(false);
      return;
    }
    if (event.target.closest("[data-fit-width]")) {
      fitPdfWidth();
      setZoomMenu(false);
      return;
    }
    if (event.target.closest("[data-fit-zoom]")) {
      fitPdfPage();
      setZoomMenu(false);
      return;
    }
    const button = event.target.closest("[data-act]");
    if (!button) return;
    const act = button.dataset.act;
    const settings = state.settings;
    if (act === "prev") goPage(state.pdfPage - 1);
    if (act === "next") goPage(state.pdfPage + 1);
    if (act === "zoom-in") zoomByStep(1);
    if (act === "zoom-out") zoomByStep(-1);
    if (act === "zoom-menu") setZoomMenu(!zoomMenuOpen);
    if (act === "ctx") {
      setCtxOpen(!state.ctxOpen);
      renderToolbar();
    }
    if (act === "split") setSplit(!splitMode);
    if (act === "link") setLink(!linkSync);
    if (act === "present") enterPresent();
    if (act === "font-up" || act === "font-down") {
      const index = SIZE_STEPS.indexOf(settings.fontSize);
      const nextIndex = clamp((index < 0 ? 1 : index) + (act === "font-up" ? 1 : -1), 0, SIZE_STEPS.length - 1);
      settings.fontSize = SIZE_STEPS[nextIndex];
      applySettings();
      syncSettingsUI();
      renderToolbar();
      updateStatus();
      persistSettings();
    }
    if (act === "lh") {
      settings.lineHeight = settings.lineHeight === 1.7 ? 1.9 : settings.lineHeight === 1.9 ? 2.1 : 1.7;
      applySettings();
      syncSettingsUI();
      renderToolbar();
      updateStatus();
      persistSettings();
    }
    if (act === "measure") {
      settings.measure = settings.measure === 620 ? 720 : settings.measure === 720 ? 820 : 620;
      applySettings();
      syncSettingsUI();
      renderToolbar();
      persistSettings();
    }
  });

  $("#readToolbar").addEventListener("change", (event) => {
    if (event.target.id === "pageInput") goPage(Number(event.target.value) || 1);
  });

  // 点工具栏以外的地方收起缩放比例菜单
  document.addEventListener("click", (event) => {
    if (zoomMenuOpen && !event.target.closest(".zoom-anchor")) setZoomMenu(false);
  });
}
