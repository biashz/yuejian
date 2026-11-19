/**
 * 分类相关的事件绑定：分类行的选中与编辑、新建分类、折叠、批量归类。
 * 把文档拖到分类行上的手势在 book-drag.js（指针事件版，绕开 WebView2 的原生拖放）。
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
import { targetCategoryId } from "../categories.js";

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

  /* ---------------- Esc 清空选中 ---------------- */
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !state.selected.size) return;
    if (state.view !== "library" || anyOverlayOpen()) return;
    state.selected.clear();
    renderLibrary();
  });
}
