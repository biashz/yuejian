/**
 * 书架排序：轴定义与比较器，纯函数。
 * 排序是偏好（落盘到 settings），筛选是动作（不落盘）——两者生命周期不同。
 */
import { t } from "./i18n.js";

/* desc 是该轴的自然方向：切轴时重置为它，点当前轴才翻转 */
const SORT_AXES = [
  { key: "recent", label: () => t("sort.recent"), desc: true },
  { key: "added", label: () => t("sort.added"), desc: true },
  { key: "title", label: () => t("sort.title"), desc: false },
  { key: "progress", label: () => t("sort.progress"), desc: true },
];

const sortAxis = (key) => SORT_AXES.find((axis) => axis.key === key) || SORT_AXES[0];

function sortBooks(books, sort, desc) {
  const dir = desc ? -1 : 1;
  const value = (book) =>
    sort === "added" ? book.addedAt
      : sort === "progress" ? (book.progress?.ratio || 0)
        : book.lastOpenedAt;
  return books.slice().sort((a, b) => {
    const r = sort === "title"
      ? a.title.localeCompare(b.title, "zh", { numeric: true })
      : value(a) - value(b);
    // 同值兜底固定为最近打开降序：不随方向翻，保证顺序稳定不抖
    if (r === 0) return b.lastOpenedAt - a.lastOpenedAt;
    return r * dir;
  });
}

export { SORT_AXES, sortAxis, sortBooks };