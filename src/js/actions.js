/**
 * 书架上的写操作：导入、移出、收藏。
 */
import { invoke } from "./api.js";
import { $ } from "./core/dom.js";
import { t } from "./i18n.js";
import { state } from "./core/session.js";
import { toast, askConfirm } from "./core/feedback.js";
import { panes, activePaneIndex, activePane, activatePane, closePaneDoc } from "./reader/panes.js";
import { setView, updateStatus } from "./view.js";
import { renderLibrary } from "./shelf.js";
import { openBook } from "./reader/open.js";

/* ---------------- 导入文档 ---------------- */
async function importDocuments(paths) {
  let list = paths;
  if (!list?.length) {
    try {
      list = await invoke("pick_files");
    } catch (error) {
      toast(String(error));
      return 0;
    }
  }
  if (!list?.length) return 0;

  try {
    state.books = await invoke("import_files", { paths: list });
  } catch (error) {
    toast(String(error));
    return 0;
  }
  renderLibrary();
  updateStatus();

  const normalized = list.map((path) => path.replace(/\//g, "\\").toLowerCase());
  const imported = state.books.find((book) => normalized.includes(book.path.toLowerCase()));
  toast(t("toast.imported", { count: list.length }));
  if (list.length === 1 && imported) openBook(imported.id);
  return list.length;
}

async function removeBook(id) {
  const book = state.books.find((item) => item.id === id);
  if (!book) return;
  const confirmed = await askConfirm({
    title: t("confirm.title"),
    book: book.title,
    note: t("confirm.note"),
    okText: t("confirm.ok"),
  });
  if (!confirmed) return;
  try {
    state.books = await invoke("remove_book", { id });
  } catch (error) {
    toast(String(error));
    return;
  }
  // 任何一栏打开了这份文档都要一起关闭
  let closedActive = false;
  panes.forEach((pane) => {
    if (pane.book?.id !== id) return;
    if (pane.index === activePaneIndex) closedActive = true;
    closePaneDoc(pane);
  });
  if (!panes.some((pane) => pane.book)) setView("library");
  else if (closedActive) {
    // 活动栏被清空时切到还有文档的那一栏
    const fallback = panes.find((pane) => pane.book) || activePane();
    activatePane(fallback.index, true);
  }
  renderLibrary();
  updateStatus();
  toast(t("confirm.removed", { title: book.title }));
}

async function toggleFavorite(id) {
  try {
    const updated = await invoke("toggle_favorite", { id });
    const index = state.books.findIndex((book) => book.id === id);
    if (index >= 0) state.books[index] = updated;
    // 分栏里保存的是书籍对象引用，替换后要同步，否则收藏状态会丢
    panes.forEach((pane) => {
      if (pane.book?.id === id) pane.book = updated;
    });
    if (state.currentId === id) {
      state.current = updated;
      $("#starBtn").classList.toggle("is-on", updated.favorite);
    }
    renderLibrary();
    toast(updated.favorite ? t("toast.favorited", { title: updated.title }) : t("toast.unfavorited", { title: updated.title }));
  } catch (error) {
    toast(String(error));
  }
}

export { importDocuments, removeBook, toggleFavorite };
