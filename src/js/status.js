/**
 * 阅读状态轴：完全派生自 progress.ratio，不存任何新数据。
 * 阈值与 shelf.js 的 renderResume / renderStats 逐字一致，三处口径不允许分叉。
 */
import { t } from "./i18n.js";

const readingStatus = (book) => {
  const ratio = book?.progress?.ratio || 0;
  if (ratio >= 0.999) return "finished";
  if (ratio > 0.001) return "reading";
  return "unread";
};

/* 图形是 12px 迷你进度线 / 对勾：状态会随阅读自己变，不配彩色徽章 */
const STATUS_FILTERS = [
  { key: null, label: () => t("status.all"), mark: "" },
  { key: "reading", label: () => t("status.reading"), mark: '<span class="status-glyph"><span class="line"><i style="width:50%"></i></span></span>' },
  { key: "unread", label: () => t("status.unread"), mark: '<span class="status-glyph"><span class="line"></span></span>' },
  { key: "finished", label: () => t("status.finished"), mark: '<span class="status-glyph"><svg class="ic"><use href="#i-check"/></svg></span>' },
];

const statusCount = (books, key) =>
  (key === null ? books : books.filter((book) => readingStatus(book) === key)).length;

const statusLabel = (key) => (STATUS_FILTERS.find((f) => f.key === key) || STATUS_FILTERS[0]).label();

export { readingStatus, STATUS_FILTERS, statusCount, statusLabel };