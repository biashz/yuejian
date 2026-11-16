/**
 * 分类的纯计算：排序、计数、筛选、下一个可用配色。
 * 不碰 DOM、不发请求 —— 渲染在 category-ui.js，写入在 actions.js。
 */
import { state } from "./core/session.js";
import { CATEGORY_COLORS } from "./core/constants.js";

/** 按创建时间升序；同一毫秒创建时用 id 兜底，保证顺序稳定 */
function sortedCategories() {
  return state.categories
    .slice()
    .sort((a, b) => (a.createdAt - b.createdAt) || a.id.localeCompare(b.id));
}

const categoryById = (id) => state.categories.find((category) => category.id === id) || null;

function countInCategory(categoryId) {
  return state.books.filter((book) => book.categoryId === categoryId).length;
}

/** 未分类数量：categoryId 为空串的文档 */
const uncategorizedCount = () => countInCategory("");

/** 取第一个没被占用的配色；全部占满后按分类数量取模循环 */
function nextCategoryColor() {
  const used = new Set(state.categories.map((category) => category.color));
  return CATEGORY_COLORS.find((color) => !used.has(color))
    || CATEGORY_COLORS[state.categories.length % CATEGORY_COLORS.length];
}

/** 文档是否通过当前分类筛选：categoryId 为 null 表示不按分类过滤 */
const matchCategory = (book) => state.categoryId === null || book.categoryId === state.categoryId;

export {
  sortedCategories, categoryById, countInCategory, uncategorizedCount,
  nextCategoryColor, matchCategory,
};
