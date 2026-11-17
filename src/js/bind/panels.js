/**
 * 面板与窗口事件：命令面板、设置面板、窗口按钮、拖拽导入、右键菜单拦截。
 */
import { $, $$, isSelectionInTextLayer } from "../core/dom.js";
import { t, getLanguage } from "../i18n.js";
import { currentWindow } from "../api.js";
import { state } from "../core/session.js";
import { toast } from "../core/feedback.js";
import { DEFAULT_SETTINGS } from "../core/constants.js";
import { openReleasePage } from "../update.js";
import { splitMode, setSplit } from "../reader/panes.js";
import { switchLanguage, updateStatus } from "../view.js";
import { renderToolbar } from "../reader/toolbar.js";
import { setCtxOpen } from "../reader/ctx.js";
import { applySettings, syncSettingsUI, persistSettings, setTheme, cycleTheme, toggleZen, closeSettings } from "../preferences.js";
import { importDocuments } from "../actions.js";
import { openPalette, closePalette, renderPalette, paletteItems, runPalette } from "../palette.js";
import { updater, handleUpdateAction, installUpdate, hideInstallPrompt } from "../update-ui.js";

export function bindPanelEvents() {
  // 命令面板
  $("#paletteBtn").addEventListener("click", openPalette);
  $("#paletteOverlay").addEventListener("click", (event) => {
    if (event.target.id === "paletteOverlay") closePalette();
  });
  $("#paletteInput").addEventListener("input", (event) => {
    state.paletteIndex = 0;
    renderPalette(event.target.value);
  });
  $("#paletteList").addEventListener("click", (event) => {
    const item = event.target.closest("[data-pi]");
    if (!item) return;
    const runs = JSON.parse($("#paletteList").dataset.items || "[]");
    runPalette(runs[Number(item.dataset.pi)]);
  });

  // 设置
  $("#themeBtn").addEventListener("click", cycleTheme);
  // 导航栏语言按钮：在中文 / English 之间直接切换
  $("#langBtn").addEventListener("click", () => {
    switchLanguage(getLanguage() === "zh" ? "en" : "zh");
  });
  $("#settingsOverlay").addEventListener("click", (event) => {
    if (event.target.id === "settingsOverlay") closeSettings();
  });
  $("#settingsClose").addEventListener("click", closeSettings);
  $("#settingsDone").addEventListener("click", closeSettings);
  $("#themeRow").addEventListener("click", (event) => {
    const swatch = event.target.closest("[data-theme-value]");
    if (swatch) {
      setTheme(swatch.dataset.themeValue);
      syncSettingsUI();
    }
  });
  $("#langSeg").addEventListener("click", (event) => {
    const button = event.target.closest("[data-lang]");
    if (button) switchLanguage(button.dataset.lang);
  });
  $("#fontSizeSeg").addEventListener("click", (event) => {
    const button = event.target.closest("[data-size]");
    if (!button) return;
    state.settings.fontSize = Number(button.dataset.size);
    applySettings();
    syncSettingsUI();
    renderToolbar();
    updateStatus();
    persistSettings();
  });
  $("#lineHeightSeg").addEventListener("click", (event) => {
    const button = event.target.closest("[data-lh]");
    if (!button) return;
    state.settings.lineHeight = Number(button.dataset.lh);
    applySettings();
    syncSettingsUI();
    renderToolbar();
    updateStatus();
    persistSettings();
  });
  $("#measureSeg").addEventListener("click", (event) => {
    const button = event.target.closest("[data-measure]");
    if (!button) return;
    state.settings.measure = Number(button.dataset.measure);
    applySettings();
    syncSettingsUI();
    renderToolbar();
    persistSettings();
  });
  $("#switchCtx").addEventListener("click", () => {
    state.settings.showCtx = !state.settings.showCtx;
    setCtxOpen(state.settings.showCtx);
    syncSettingsUI();
    persistSettings();
    toast(state.settings.showCtx ? t("settings.showCtxOn") : t("settings.showCtxOff"));
  });
  $("#switchZen").addEventListener("click", toggleZen);
  $("#switchAutoUpdate").addEventListener("click", () => {
    state.settings.autoCheckUpdate = !state.settings.autoCheckUpdate;
    syncSettingsUI();
    persistSettings();
  });
  $("#updateAction").addEventListener("click", handleUpdateAction);
  // 安装提示：点「立即安装」才退出应用，「稍后再说」只收起卡片（设置里的红点与按钮仍在）
  $("#installPromptInstall").addEventListener("click", () => installUpdate());
  $("#installPromptLater").addEventListener("click", hideInstallPrompt);
  $("#updateLink").addEventListener("click", () => {
    openReleasePage(updater.release?.pageUrl).catch(() => {});
  });
  $("#resetBtn").addEventListener("click", () => {
    if (splitMode) setSplit(false);  // 默认设置是单栏，先合并再重置
    // 恢复默认不应把界面语言改回中文，保留当前语言
    state.settings = { ...DEFAULT_SETTINGS, language: getLanguage() };
    setTheme("paper", true);
    applySettings();
    syncSettingsUI();
    renderToolbar();
    updateStatus();
    persistSettings();
    toast(t("settings.resetDone"));
  });

  // 窗口按钮
  $("#winMin").addEventListener("click", () => currentWindow?.minimize());
  $("#winMax").addEventListener("click", () => currentWindow?.toggleMaximize());
  $("#winClose").addEventListener("click", () => currentWindow?.close());

  // 拖拽导入（Tauri 窗口级事件）
  if (currentWindow?.onDragDropEvent) {
    currentWindow.onDragDropEvent((event) => {
      const payload = event.payload || {};
      if (payload.type === "enter" || payload.type === "over") {
        document.body.classList.add("is-dragging");
        return;
      }
      document.body.classList.remove("is-dragging");
      if (payload.type !== "drop") return;
      // 不在前端过滤扩展名：Rust 侧决定哪些能导入，导不进的文件会被跳过并计数，
      // 用户看到的是「导入 2 份，跳过 1 个」，而不是拖进来毫无反应
      const paths = payload.paths || [];
      if (!paths.length) return;
      importDocuments(paths);
    });
  }

  // 屏蔽 WebView2 默认右键菜单（刷新 / 另存为 / 检查等），保持桌面应用观感；
  // 输入框、可编辑区域以及 PDF 文本层中已选中的文字保留原生菜单，便于复制粘贴
  document.addEventListener("contextmenu", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement) {
      if (target.isContentEditable || target.closest("input, textarea")) return;
      if (target.closest(".textLayer") && isSelectionInTextLayer()) return;
    }
    event.preventDefault();
  });
}
