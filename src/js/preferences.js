/**
 * 阅读偏好：主题 / 字号 / 行高 / 版心 / 专注模式，以及设置面板与设置持久化。
 */
import { $, $$ } from "./core/dom.js";
import { t, getLanguage } from "./i18n.js";
import { state } from "./core/session.js";
import { THEME_ORDER, themeLabel } from "./core/constants.js";
import { invoke } from "./api.js";
import { toast } from "./core/feedback.js";

/* ---------------- 主题与排版 ---------------- */
function applySettings() {
  const settings = state.settings;
  document.documentElement.style.setProperty("--read-size", `${settings.fontSize}px`);
  document.documentElement.style.setProperty("--read-lh", String(settings.lineHeight));
  document.documentElement.style.setProperty("--measure", `${settings.measure}px`);
  document.body.classList.toggle("zen", Boolean(settings.zen));
}

function setTheme(theme, silent = false) {
  state.settings.theme = theme;
  document.documentElement.dataset.theme = theme;
  $("#themeBtn use").setAttribute("href", theme === "night" ? "#i-moon" : "#i-sun");
  $("#statusMid").textContent = themeLabel(theme);
  $$(".theme-swatch").forEach((item) => item.classList.toggle("is-on", item.dataset.themeValue === theme));
  persistSettings();
  if (!silent) toast(t("theme.switched", { theme: themeLabel(theme) }));
}

function cycleTheme() {
  const next = THEME_ORDER[(THEME_ORDER.indexOf(state.settings.theme) + 1) % THEME_ORDER.length];
  setTheme(next);
}

function toggleZen() {
  state.settings.zen = !state.settings.zen;
  applySettings();
  syncSettingsUI();
  persistSettings();
  toast(state.settings.zen ? t("zen.on") : t("zen.off"));
}

/* ---------------- 持久化 ---------------- */
let settingsTimer = 0;
function persistSettings() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    invoke("save_settings", { settings: state.settings }).catch(() => {});
  }, 200);
}

/* ---------------- 设置面板 ---------------- */
function openSettings() {
  syncSettingsUI();
  $("#settingsOverlay").hidden = false;
}

function closeSettings() {
  $("#settingsOverlay").hidden = true;
}

function syncSettingsUI() {
  const settings = state.settings;
  $$("#fontSizeSeg button").forEach((button) => button.classList.toggle("is-on", Number(button.dataset.size) === settings.fontSize));
  $$("#lineHeightSeg button").forEach((button) => button.classList.toggle("is-on", Number(button.dataset.lh) === settings.lineHeight));
  $$("#measureSeg button").forEach((button) => button.classList.toggle("is-on", Number(button.dataset.measure) === settings.measure));
  $$("#langSeg button").forEach((button) => button.classList.toggle("is-on", button.dataset.lang === getLanguage()));
  $("#switchCtx").classList.toggle("is-on", settings.showCtx);
  $("#switchCtx").setAttribute("aria-checked", String(settings.showCtx));
  $("#switchZen").classList.toggle("is-on", settings.zen);
  $("#switchZen").setAttribute("aria-checked", String(settings.zen));
  const autoUpdate = settings.autoCheckUpdate !== false;
  $("#switchAutoUpdate").classList.toggle("is-on", autoUpdate);
  $("#switchAutoUpdate").setAttribute("aria-checked", String(autoUpdate));
  $$(".theme-swatch").forEach((item) => item.classList.toggle("is-on", item.dataset.themeValue === settings.theme));
}

export { applySettings, setTheme, cycleTheme, toggleZen, persistSettings, openSettings, closeSettings, syncSettingsUI };
