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

  // 不在前端维护「支持哪些扩展名」的副本：Rust 侧 text::classify 是唯一事实来源，
  // 这里只比对导入后书架上真实存在的条目，得出「跳过了几个」。
  // Windows 上 Rust 的 fs::canonicalize 会给入架路径加 \\?\ 前缀（UNC 则是 \\?\UNC\），
  // 拖入 / 对话框给的是普通路径——两边都剥掉前缀再比，否则全被误判成「跳过」
  const normalizePath = (path) => String(path)
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/i, "")
    .replace(/\//g, "\\")
    .toLowerCase();
  const normalized = list.map(normalizePath);
  const imported = state.books.filter((book) => normalized.includes(normalizePath(book.path)));
  const skipped = list.length - imported.length;
  if (!imported.length) {
    toast(t("toast.onlySupported"));
    return 0;
  }
  toast(skipped
    ? t("toast.importedSkipped", { count: imported.length, skipped })
    : t("toast.imported", { count: imported.length }));
  if (list.length === 1) openBook(imported[0].id);
  return imported.length;
}

async function removeBook(id) {
  const book = state.books.find((item) => item.id === id);
  if (!book) return;
  const confirmed = await askConfirm({
    title: t("confirm.title"),
    book: book.title,
    note: t("confirm.note"),
    okText: t("confirm.ok"),
    eyebrow: t("confirm.eyebrow"),
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
  // 快照就是确认前找到的 book 对象：remove_book 返回新数组，不会改动它
  toast(t("confirm.removed", { title: book.title }), {
    actionText: t("undo.action"),
    duration: 6000,
    onAction: () => restoreBook(book),
  });
}

/** 撤销移除：快照原样传回，幂等；不重开文档、不恢复检索索引（按需重建） */
async function restoreBook(book) {
  try {
    state.books = await invoke("restore_book", { book });
  } catch (error) {
    toast(String(error));
    // 失败时重新拉取，避免界面显示与实际磁盘不一致
    try { state.books = await invoke("get_library"); } catch (_) { /* 拉取失败就保持原样 */ }
    renderLibrary();
    updateStatus();
    return false;
  }
  renderLibrary();
  updateStatus();
  toast(t("undo.restored", { title: book.title }));
  return true;
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

/* ---------------- 分类 ---------------- */
async function createCategory(name, color) {
  try {
    const category = await invoke("create_category", { name, color });
    state.categories = [...state.categories, category];
    renderLibrary();
    toast(t("category.created", { name: category.name }));
    return category;
  } catch (error) {
    toast(String(error));
    return null;
  }
}

async function updateCategory(id, name, color) {
  try {
    const updated = await invoke("update_category", { id, name, color });
    state.categories = state.categories.map((category) => (category.id === id ? updated : category));
    renderLibrary();
    toast(t("category.updated", { name: updated.name }));
    return updated;
  } catch (error) {
    toast(String(error));
    return null;
  }
}

async function deleteCategory(id) {
  const category = state.categories.find((item) => item.id === id);
  if (!category) return false;
  const count = state.books.filter((book) => book.categoryId === id).length;
  // 空分类没有需要保护的数据，直接删除；有文档时必须让用户知道文档会去未分类
  if (count > 0) {
    const confirmed = await askConfirm({
      title: t("category.deleteTitle"),
      book: category.name,
      note: t("category.deleteNote", { name: category.name, count }),
      okText: t("category.delete"),
      eyebrow: t("category.deleteEyebrow"),
    });
    if (!confirmed) return false;
  }
  try {
    state.books = await invoke("delete_category", { id });
  } catch (error) {
    toast(String(error));
    return false;
  }
  state.categories = state.categories.filter((item) => item.id !== id);
  // 正筛选着被删掉的分类时退回全部分类，否则界面会停在一个不存在的分类上
  if (state.categoryId === id) state.categoryId = null;
  renderLibrary();
  toast(count > 0
    ? t("category.deletedWithDocs", { name: category.name, count })
    : t("category.deleted", { name: category.name }));
  return true;
}

/** 批量归类：ids 一次提交，后端单次写盘；categoryId 传空串即移出分类 */
async function assignCategory(ids, categoryId) {
  const list = (ids || []).filter(Boolean);
  if (!list.length) return false;
  try {
    state.books = await invoke("assign_category", { ids: list, categoryId });
  } catch (error) {
    toast(String(error));
    // 失败时重新拉取，避免界面显示与实际磁盘不一致
    try { state.books = await invoke("get_library"); } catch (_) { /* 拉取失败就保持原样 */ }
    renderLibrary();
    return false;
  }
  state.selected.clear();
  renderLibrary();
  const target = categoryId ? state.categories.find((category) => category.id === categoryId) : null;
  const label = target ? target.name : t("category.none");
  toast(list.length === 1
    ? t("category.assigned", { name: label })
    : t("category.assignedMany", { count: list.length, name: label }));
  return true;
}

export { importDocuments, removeBook, restoreBook, toggleFavorite, createCategory, updateCategory, deleteCategory, assignCategory };
