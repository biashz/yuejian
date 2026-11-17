/**
 * 命令面板：搜书、跳章节、切主题、开设置、导入文件。
 */
import { $, clamp, escapeHtml } from "./core/dom.js";
import { t } from "./i18n.js";
import { state } from "./core/session.js";
import { kindLabel } from "./core/constants.js";
import { formatRelative } from "./core/format.js";
import { openBook } from "./reader/open.js";
import { setSplit, splitMode } from "./reader/panes.js";
import { enterPresent } from "./reader/present.js";
import { cycleTheme, toggleZen, openSettings } from "./preferences.js";
import { setView } from "./view.js";
import { importDocuments } from "./actions.js";

/* ---------------- 命令面板 ---------------- */
function openPalette() {
  $("#paletteOverlay").hidden = false;
  state.paletteIndex = 0;
  const input = $("#paletteInput");
  input.value = "";
  renderPalette("");
  setTimeout(() => input.focus(), 30);
}

function closePalette() {
  $("#paletteOverlay").hidden = true;
}

function paletteItems(query) {
  const keyword = query.trim().toLowerCase();
  const books = state.books
    .filter((book) => !keyword || `${book.title} ${book.author}`.toLowerCase().includes(keyword))
    .slice(0, 6)
    .map((book) => ({
      group: t("palette.documents"),
      icon: book.kind === "pdf" ? "file-text" : "book-open",
      title: book.title,
      sub: `${kindLabel(book.kind, book)} · ${formatRelative(book.lastOpenedAt)}`,
      run: `open:${book.id}`,
    }));

  const actions = [
    { title: t("palette.import"), sub: t("palette.importSub"), icon: "folder-plus", run: "import" },
    { title: t("palette.theme"), sub: t("palette.themeSub"), icon: "sun", run: "theme" },
    { title: t("palette.zen"), sub: t("palette.zenSub"), icon: "maximize", run: "zen" },
    { title: splitMode ? t("palette.merge") : t("palette.split"), sub: t("palette.splitSub"), icon: "columns", run: "split" },
    { title: t("palette.present"), sub: t("palette.presentSub"), icon: "present", run: "present" },
    { title: t("palette.settings"), sub: t("palette.settingsSub"), icon: "settings", run: "settings" },
    { title: t("palette.back"), sub: t("palette.backSub"), icon: "library", run: "back" },
  ].filter((action) => !keyword || `${action.title} ${action.sub}`.toLowerCase().includes(keyword))
    .map((action) => ({ ...action, group: t("palette.actions") }));

  return [...books, ...actions];
}

function renderPalette(query) {
  const items = paletteItems(query);
  const list = $("#paletteList");
  if (!items.length) {
    list.innerHTML = `<div class="ctx-empty">${t("palette.empty")}</div>`;
    return;
  }
  state.paletteIndex = clamp(state.paletteIndex, 0, items.length - 1);

  let html = "";
  let lastGroup = "";
  items.forEach((item, index) => {
    if (item.group !== lastGroup) {
      html += `<div class="palette-group">${item.group}</div>`;
      lastGroup = item.group;
    }
    html += `<button class="palette-item ${index === state.paletteIndex ? "is-active" : ""}" data-pi="${index}">
      <svg class="ic"><use href="#i-${item.icon}"/></svg>
      <span class="pi-main">
        <span class="pi-title">${escapeHtml(item.title)}</span>
        <span class="pi-sub">${escapeHtml(item.sub)}</span>
      </span>
      <svg class="ic" style="width:13px;height:13px;color:var(--ink-3)"><use href="#i-corner-down-right"/></svg>
    </button>`;
  });
  list.innerHTML = html;
  list.dataset.items = JSON.stringify(items.map((item) => item.run));
  list.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
}

function runPalette(run) {
  closePalette();
  if (!run) return;
  if (run.startsWith("open:")) return openBook(run.slice(5));
  if (run === "import") return importDocuments();
  if (run === "theme") return cycleTheme();
  if (run === "zen") return toggleZen();
  if (run === "split") return setSplit(!splitMode);
  if (run === "present") return enterPresent();
  if (run === "settings") return openSettings();
  if (run === "back") return setView("library");
}

export { openPalette, closePalette, paletteItems, renderPalette, runPalette };
