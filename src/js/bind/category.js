/**
 * 分类相关的事件绑定：分类行的选中与编辑、新建分类、折叠、批量归类、拖拽归类。
 * 归类手势只影响书架面板内的 DOM，不触发窗口级的文件拖入逻辑。
 */
import { $ } from "../core/dom.js";
import { state } from "../core/session.js";
import { MAX_CATEGORIES } from "../core/constants.js";
import { renderLibrary } from "../shelf.js";
import {
  openCategoryDialog, closeCategoryDialog, submitCategoryDialog,
  syncCategoryDialogValidation, pickCategoryDialogColor, categoryDialogOpen,
  requestCategoryDialogDelete,
} from "../category-ui.js";
import { createCategory, updateCategory, deleteCategory, assignCategory } from "../actions.js";

/* 拖拽中的文档 id：只在本次拖拽期间有效 */
let draggingBookId = null;

/** 拖拽结束 / 取消时清掉所有落点高亮 */
function clearDropTargets() {
  document.querySelectorAll(".cat-row.is-drop").forEach((row) => row.classList.remove("is-drop"));
  document.querySelectorAll(".book-row.is-dragging, .book-card.is-dragging")
    .forEach((el) => el.classList.remove("is-dragging"));
}

/** 把「归类到…」下拉选中的目标值转成后端用的分类 id（"__none" → 空串即移出分类） */
const targetCategoryId = (value) => (value === "__none" || value === "__all" ? "" : value);

/** 有弹层打开时，全局 Esc 交给弹层自己处理，避免一次按键关两层 */
const anyOverlayOpen = () =>
  categoryDialogOpen() || !$("#paletteOverlay").hidden || !$("#settingsOverlay").hidden
  || !$("#confirmOverlay").hidden;

export function bindCategoryEvents() {
  /* ---------------- 分类行的点击与编辑 ---------------- */
  $("#catList").addEventListener("click", (event) => {
    const edit = event.target.closest("[data-cat-edit]");
    if (edit) {
      event.stopPropagation();
      const id = edit.dataset.catEdit;
      openCategoryDialog({ mode: "edit", categoryId: id }).then(async (result) => {
        if (!result) return;
        if (result.action === "delete") {
          await deleteCategory(id);
          return;
        }
        await updateCategory(id, result.name, result.color);
      });
      return;
    }
    const row = event.target.closest(".cat-row");
    if (!row) return;
    const value = row.dataset.cat;
    // 再点一次已选中的分类即「取消该分类筛选」，避免用户找不到退路
    const next = value === "__all" ? null : value === "__none" ? "" : value;
    state.categoryId = state.categoryId === next && next !== null ? null : next;
    renderLibrary();
  });

  $("#catAdd").addEventListener("click", () => {
    if (state.categories.length >= MAX_CATEGORIES) return;
    openCategoryDialog({ mode: "create" }).then(async (result) => {
      if (!result || result.action !== "save") return;
      await createCategory(result.name, result.color);
    });
  });

  $("#catToggle").addEventListener("click", () => {
    state.catCollapsed = !state.catCollapsed;
    $("#catBlock").classList.toggle("is-collapsed", state.catCollapsed);
  });

  /* ---------------- 分类编辑弹层 ---------------- */
  $("#catDlgName").addEventListener("input", syncCategoryDialogValidation);
  $("#catDlgSwatches").addEventListener("click", (event) => {
    const swatch = event.target.closest("[data-color]");
    if (swatch) pickCategoryDialogColor(swatch.dataset.color);
  });
  $("#catDlgOk").addEventListener("click", submitCategoryDialog);
  $("#catDlgCancel").addEventListener("click", () => closeCategoryDialog(null));
  $("#catDlgDelete").addEventListener("click", requestCategoryDialogDelete);
  $("#catOverlay").addEventListener("click", (event) => {
    if (event.target === $("#catOverlay")) closeCategoryDialog(null);
  });
  $("#catOverlay").addEventListener("keydown", (event) => {
    if (!categoryDialogOpen()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeCategoryDialog(null);
    } else if (event.key === "Enter" && event.target.id === "catDlgName") {
      event.preventDefault();
      submitCategoryDialog();
    }
  });

  /* ---------------- 批量归类条 ---------------- */
  $("#batchSelect").addEventListener("change", (event) => {
    const value = event.target.value;
    event.target.value = "";
    if (!value) return;
    assignCategory([...state.selected], targetCategoryId(value));
  });
  $("#batchCancel").addEventListener("click", () => {
    state.selected.clear();
    renderLibrary();
  });

  /* ---------------- 清除筛选 ---------------- */
  $("#headClear").addEventListener("click", () => {
    state.categoryId = null;
    state.filter = "all";
    state.query = "";
    $("#libSearch").value = "";
    document.querySelectorAll("#filterRow .chip")
      .forEach((chip) => chip.classList.toggle("is-on", chip.dataset.filter === "all"));
    renderLibrary();
  });

  /* ---------------- 拖拽归类 ---------------- */
  document.addEventListener("dragstart", (event) => {
    const el = event.target.closest(".book-row, .book-card");
    if (!el?.dataset.book) return;
    draggingBookId = el.dataset.book;
    el.classList.add("is-dragging");
    if (!event.dataTransfer) return;
    event.dataTransfer.effectAllowed = "move";
    // 自定义 MIME 供内部识别，同时写 text/plain —— WebView2 对纯自定义类型偶有不认
    try { event.dataTransfer.setData("application/x-yuejian-book", draggingBookId); } catch (_) { /* 忽略 */ }
    event.dataTransfer.setData("text/plain", draggingBookId);
  });

  document.addEventListener("dragend", () => {
    draggingBookId = null;
    clearDropTargets();
  });

  document.addEventListener("dragover", (event) => {
    if (!draggingBookId) return;
    const row = event.target.closest(".cat-row");
    if (!row) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    document.querySelectorAll(".cat-row.is-drop")
      .forEach((el) => { if (el !== row) el.classList.remove("is-drop"); });
    row.classList.add("is-drop");
  });

  document.addEventListener("dragleave", (event) => {
    const row = event.target.closest(".cat-row");
    if (row && !row.contains(event.relatedTarget)) row.classList.remove("is-drop");
  });

  document.addEventListener("drop", (event) => {
    const row = event.target.closest(".cat-row");
    if (!row || !draggingBookId) return;
    event.preventDefault();
    event.stopPropagation();
    const id = event.dataTransfer?.getData("application/x-yuejian-book")
      || event.dataTransfer?.getData("text/plain")
      || draggingBookId;
    const categoryId = targetCategoryId(row.dataset.cat);
    const book = state.books.find((item) => item.id === id);
    draggingBookId = null;
    clearDropTargets();
    // 拖回原分类不写盘，避免无意义的重绘与提示
    if (!book || book.categoryId === categoryId) return;
    assignCategory([id], categoryId);
  });

  /* ---------------- Esc 清空选中 ---------------- */
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !state.selected.size) return;
    if (state.view !== "library" || anyOverlayOpen()) return;
    state.selected.clear();
    renderLibrary();
  });
}
