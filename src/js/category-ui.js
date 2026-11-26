/**
 * 分类区与批量条的渲染，以及分类编辑弹层的状态机。
 * 只负责「把 state 画成 DOM」和「收集用户输入」，写操作全部交给 actions.js。
 */
import { $, escapeHtml } from "./core/dom.js";
import { t } from "./i18n.js";
import { state } from "./core/session.js";
import { CATEGORY_COLORS, MAX_CATEGORIES, MAX_CATEGORY_NAME, KIND_LABEL } from "./core/constants.js";
import { sortedCategories, countInCategory, uncategorizedCount, categoryById, nextCategoryColor } from "./categories.js";
import { STATUS_FILTERS, statusCount, statusLabel } from "./status.js";

/* ---------------- 书架目录：类型组 ---------------- */
/* 类型是系统视角，用 4px 类型色点（与书脊元信息同语言）；收藏例外，用朱砂星 */
const TYPE_FILTERS = [
  { key: "all", label: () => t("library.filterAll"), mark: "" },
  { key: "pdf", label: () => KIND_LABEL.pdf, mark: '<i class="type-dot pdf"></i>' },
  { key: "markdown", label: () => KIND_LABEL.markdown, mark: '<i class="type-dot md"></i>' },
  { key: "text", label: () => t("library.filterText"), mark: '<i class="type-dot txt"></i>' },
  { key: "ebook", label: () => t("library.filterEbook"), mark: '<i class="type-dot epub"></i>' },
  { key: "star", label: () => t("library.filterStar"), mark: '<svg class="ic"><use href="#i-star"/></svg>' },
];

const typeCount = (key) => {
  if (key === "all") return state.books.length;
  if (key === "star") return state.books.filter((book) => book.favorite).length;
  return state.books.filter((book) => book.kind === key).length;
};

const typeLabel = (key) => (TYPE_FILTERS.find((f) => f.key === key) || TYPE_FILTERS[0]).label();

function renderTypeList() {
  $("#typeList").innerHTML = TYPE_FILTERS.map((f) => `
    <div class="idx-row ${f.key === "all" ? "is-all" : ""} ${state.filter === f.key ? "is-active" : ""}"
      data-filter="${f.key}" role="button" tabindex="0">
      ${f.mark}
      <span class="cat-name">${escapeHtml(f.label())}</span>
      <span class="cat-num">${typeCount(f.key)}</span>
    </div>`).join("");
  $("#typeCurrent").textContent = typeLabel(state.filter);
  $("#typeCount").textContent = typeCount(state.filter);
  $("#typeHead").classList.toggle("is-collapsed", state.typeCollapsed);
  $("#typeToggle").setAttribute("aria-expanded", String(!state.typeCollapsed));
}

/* ---------------- 书架目录：状态组 ---------------- */
/* 状态派生自进度，图形用 12px 迷你进度线 / 对勾；行语言与类型组完全一致 */
function renderStatusList() {
  $("#statusList").innerHTML = STATUS_FILTERS.map((f) => `
    <div class="idx-row ${f.key === null ? "is-all" : ""} ${state.status === f.key ? "is-active" : ""}"
      data-status="${f.key === null ? "__all" : f.key}" role="button" tabindex="0">
      ${f.mark}
      <span class="cat-name">${escapeHtml(f.label())}</span>
      <span class="cat-num">${statusCount(state.books, f.key)}</span>
    </div>`).join("");
  $("#statusCurrent").textContent = state.status ? statusLabel(state.status) : "";
  $("#statusCount").textContent = statusCount(state.books, state.status);
  $("#statusHead").classList.toggle("is-collapsed", state.statusCollapsed);
  $("#statusToggle").setAttribute("aria-expanded", String(!state.statusCollapsed));
}

/* ---------------- 分类组 ---------------- */
const dotClass = (color) => `cat-dot c-${CATEGORY_COLORS.includes(color) ? color : "clay"}`;

function categoryRowHtml(category) {
  const active = state.categoryId === category.id;
  return `
    <div class="cat-row ${active ? "is-active" : ""}" data-cat="${category.id}" role="button" tabindex="0">
      <span class="${dotClass(category.color)}"></span>
      <span class="cat-name">${escapeHtml(category.name)}</span>
      <span class="cat-num">${countInCategory(category.id)}</span>
      <button class="cat-more" data-cat-edit="${category.id}" title="${t("category.more")}">
        <svg class="ic"><use href="#i-more"/></svg>
      </button>
    </div>`;
}

function renderCategoryList() {
  const list = $("#catList");
  const all = sortedCategories();
  const rows = [`
    <div class="cat-row is-all ${state.categoryId === null ? "is-active" : ""}" data-cat="__all" role="button" tabindex="0">
      <span class="cat-name">${t("category.all")}</span>
      <span class="cat-num">${state.books.length}</span>
    </div>`];

  rows.push(...all.map(categoryRowHtml));
  if (!all.length) {
    rows.push(`<div class="cat-empty">${t("category.emptyHint")}</div>`);
  }
  rows.push(`
    <div class="cat-row is-none ${state.categoryId === "" ? "is-active" : ""}" data-cat="__none" role="button" tabindex="0">
      <span class="cat-dot is-none-dot"></span>
      <span class="cat-name">${t("category.none")}</span>
      <span class="cat-num">${uncategorizedCount()}</span>
    </div>`);

  list.innerHTML = rows.join("");
  $("#catCount").textContent = all.length;
  $("#catAdd").disabled = all.length >= MAX_CATEGORIES;
  $("#catAdd").title = all.length >= MAX_CATEGORIES ? t("category.errLimit") : t("category.new");
  $("#catHead").classList.toggle("is-collapsed", state.catCollapsed);
  $("#catToggle").setAttribute("aria-expanded", String(!state.catCollapsed));
}

/* ---------------- 批量归类条 ---------------- */
function renderBatchBar() {
  const bar = $("#batchBar");
  const count = state.selected.size;
  bar.hidden = count === 0;
  if (!count) return;
  $("#batchCount").textContent = t("batch.selected", { count });
  const options = [`<option value="">${t("batch.assignTo")}</option>`]
    .concat(sortedCategories().map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`))
    .concat([`<option value="__none">${t("category.none")}</option>`]);
  const select = $("#batchSelect");
  select.innerHTML = options.join("");
  select.value = "";
}

/** 目录三组 + 批量条一起刷新（计数与可选项都依赖同一份 state） */
function renderCategorySection() {
  renderTypeList();
  renderStatusList();
  renderCategoryList();
  renderBatchBar();
}

/* ---------------- 编辑弹层 ---------------- */
/* dialogState 非空即表示弹层打开；resolve 只结算一次 */
let dialogState = null;

function renderSwatches() {
  $("#catDlgSwatches").innerHTML = CATEGORY_COLORS.map((color) => `
    <button class="swatch c-${color} ${color === dialogState.color ? "is-on" : ""}"
      data-color="${color}" title="${color}" type="button"></button>`).join("");
}

/** 校验当前输入，返回错误文案（空串表示合法） */
function categoryDialogError() {
  const name = $("#catDlgName").value.trim();
  if (!name) return t("category.errEmpty");
  if (name.length > MAX_CATEGORY_NAME) return t("category.errTooLong");
  const lowered = name.toLowerCase();
  const duplicate = state.categories.some(
    (category) => category.id !== dialogState.categoryId && category.name.trim().toLowerCase() === lowered);
  return duplicate ? t("category.errDup") : "";
}

function syncCategoryDialogValidation() {
  const message = categoryDialogError();
  $("#catDlgErr").textContent = message;
  $("#catDlgOk").disabled = Boolean(message);
}

function openCategoryDialog({ mode, categoryId = null }) {
  const category = categoryId ? categoryById(categoryId) : null;
  const isEdit = mode === "edit" && Boolean(category);
  dialogState = {
    mode: isEdit ? "edit" : "create",
    categoryId: isEdit ? category.id : null,
    // 新建时用第一个没人用的颜色，避免连续创建得到一模一样的色点
    color: isEdit ? category.color : nextCategoryColor(),
    resolve: null,
  };

  $("#catDlgTitle").textContent = isEdit ? t("category.edit") : t("category.new");
  $("#catDlgSub").textContent = isEdit ? t("category.editSub") : t("category.createSub");
  $("#catDlgName").value = isEdit ? category.name : "";
  $("#catDlgDelete").hidden = !isEdit;
  renderSwatches();
  syncCategoryDialogValidation();
  $("#catOverlay").hidden = false;
  $("#catDlgName").focus();
  $("#catDlgName").select();

  return new Promise((resolve) => {
    if (dialogState) dialogState.resolve = resolve;
  });
}

function closeCategoryDialog(result) {
  if (!dialogState) return;
  const { resolve } = dialogState;
  dialogState = null;
  $("#catOverlay").hidden = true;
  resolve?.(result || null);
}

/** 点「保存」：合法则结算为 save，否则保持打开（校验已把按钮置灰，这里再兜一次） */
function submitCategoryDialog() {
  if (!dialogState) return;
  if (categoryDialogError()) {
    syncCategoryDialogValidation();
    return;
  }
  closeCategoryDialog({
    action: "save",
    name: $("#catDlgName").value.trim(),
    color: dialogState.color,
  });
}

function pickCategoryDialogColor(color) {
  if (!dialogState) return;
  dialogState.color = color;
  renderSwatches();
}

const categoryDialogOpen = () => Boolean(dialogState);

/** 删除按钮只负责结算，二次确认与实际删除由 actions.deleteCategory 完成 */
const requestCategoryDialogDelete = () => closeCategoryDialog({ action: "delete" });

export {
  renderCategoryList, renderCategorySection, renderBatchBar,
  openCategoryDialog, closeCategoryDialog, submitCategoryDialog,
  syncCategoryDialogValidation, pickCategoryDialogColor,
  categoryDialogOpen, requestCategoryDialogDelete,
};
