/**
 * 书架与导航的事件绑定：委托点击打开文档 / 收藏 / 移除、md 内链、
 * 图标栏导航、书架搜索与筛选、导入入口。
 */
import { $, $$ } from "../core/dom.js";
import { t } from "../i18n.js";
import { state } from "../core/session.js";
import { toast } from "../core/feedback.js";
import { scrollToHeading } from "../reader-md.js";
import { panes, activatePane } from "../reader/panes.js";
import { setView } from "../view.js";
import { visibleBooks, renderBookList, renderGrid } from "../shelf.js";
import { openBook } from "../reader/open.js";
import { importDocuments, removeBook, toggleFavorite } from "../actions.js";
import { openPalette } from "../palette.js";
import { openSettings } from "../preferences.js";

export function bindShelfEvents() {
  // 文档打开 / 收藏 / 移除
  document.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-remove]");
    if (remove) {
      event.stopPropagation();
      removeBook(remove.dataset.remove);
      return;
    }
    const star = event.target.closest("[data-star]");
    if (star) {
      event.stopPropagation();
      toggleFavorite(star.dataset.star);
      return;
    }
    const anchor = event.target.closest(".md-doc a[href]");
    if (anchor) {
      const href = anchor.getAttribute("href") || "";
      if (/^https?:/i.test(href)) {
        event.preventDefault();
        toast(t("toast.linkCopied", { url: href }));
        navigator.clipboard?.writeText(href).catch(() => {});
        return;
      }
      if (href.startsWith("#")) {
        event.preventDefault();
        const paneRoot = event.target.closest("[data-pane-root]");
        const area = paneRoot ? $(".scroll-area", paneRoot) : null;
        if (area) scrollToHeading(area, href.slice(1));
        return;
      }
      if (/\.(md|markdown)$/i.test(href)) {
        event.preventDefault();
        toast(t("toast.crossDoc"));
        return;
      }
    }
    const bookEl = event.target.closest("[data-book]");
    if (bookEl) openBook(bookEl.dataset.book);
  });

  // 导航
  $$(".rail-btn").forEach((button) => button.addEventListener("click", () => {
    const nav = button.dataset.nav;
    if (nav === "library") setView("library");
    if (nav === "reading") {
      if (state.currentId) {
        setView("reading");
      } else if (panes.some((pane) => pane.book)) {
        // 活动栏为空但另一栏有文档时，直接切到有文档的那一栏
        const opened = panes.find((pane) => pane.book);
        activatePane(opened.index, true);
        setView("reading");
      } else if (state.books.length) {
        openBook(state.books.slice().sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0].id);
      } else {
        toast(t("toast.emptyShelf"));
      }
    }
    if (nav === "search") openPalette();
    if (nav === "settings") openSettings();
  }));

  // 书架搜索与过滤
  $("#libSearch").addEventListener("input", (event) => {
    state.query = event.target.value.trim();
    renderBookList(visibleBooks());
    renderGrid(visibleBooks());
  });
  $("#filterRow").addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (!chip) return;
    state.filter = chip.dataset.filter;
    $$("#filterRow .chip").forEach((item) => item.classList.toggle("is-on", item === chip));
    renderBookList(visibleBooks());
    renderGrid(visibleBooks());
  });

  // 导入
  ["#importBtn", "#importCta", "#emptyImport"].forEach((selector) => $(selector)?.addEventListener("click", () => importDocuments()));
}
