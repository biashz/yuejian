/**
 * 阅笺 · 应用入口
 * 书架（Rust 持久化）→ 打开文档 → PDF（pdf.js）/ Markdown（comrak）阅读
 *
 * 只负责装配：读取数据、应用设置、绑定事件，业务逻辑分散在同目录各模块。
 */
import { $ } from "./core/dom.js";
import { invoke, isTauri } from "./api.js";
import { t, setLanguage, applyDom } from "./i18n.js";
import { DEFAULT_SETTINGS } from "./core/constants.js";
import { state } from "./core/session.js";
import { toast } from "./core/feedback.js";
import { initPanes, applySplitState } from "./reader/panes.js";
import { applySettings, syncSettingsUI, setTheme } from "./preferences.js";
import { bind } from "./bind/index.js";
import { renderLibrary } from "./shelf.js";
import { setView, syncWindowTitle } from "./view.js";
import { renderUpdateUI, initUpdate } from "./update-ui.js";

/* ---------------- 启动 ---------------- */
async function boot() {
  $("#emptyLibrary").hidden = true;
  applySettings();
  initPanes();

  if (!isTauri) {
    setLanguage(state.settings.language);
    applyDom();
    applySplitState();
    renderLibrary();
    bind();
    setView("library");
    renderUpdateUI();
    toast(t("toast.desktopOnly"));
    return;
  }

  try {
    const [settings, books, categories] = await Promise.all([
      invoke("get_settings"), invoke("get_library"), invoke("get_categories"),
    ]);
    state.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    state.books = books || [];
    state.categories = categories || [];
  } catch (error) {
    toast(t("toast.loadFailed", { error }));
  }

  // 语言必须在其余渲染之前落地：后续动态文案都依赖当前语言
  setLanguage(state.settings.language);
  applyDom();
  syncWindowTitle();
  setTheme(state.settings.theme, true);
  applySettings();
  syncSettingsUI();
  applySplitState();
  bind();
  renderLibrary();
  setView("library");
  initUpdate();
}

boot();

