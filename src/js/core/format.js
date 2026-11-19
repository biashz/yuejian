/**
 * 展示层格式化：封面配色、进度百分比、相对时间、文件体积。
 */
import { t, formatMonthDay } from "../i18n.js";
import { TINTS } from "./constants.js";
import { clamp } from "./dom.js";

function tintOf(id) {
  let hash = 0;
  for (const ch of String(id)) hash = (hash * 31 + ch.charCodeAt(0)) % 997;
  return TINTS[hash % TINTS.length];
}

function percentOf(book) {
  return Math.round(clamp(book?.progress?.ratio || 0, 0, 1) * 100);
}

function formatRelative(ms) {
  if (!ms) return t("time.notOpened");
  const diff = Date.now() - ms;
  if (diff < 60_000) return t("time.justNow");
  if (diff < 3_600_000) return t("time.minutesAgo", { count: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t("time.hoursAgo", { count: Math.floor(diff / 3_600_000) });
  if (diff < 7 * 86_400_000) return t("time.daysAgo", { count: Math.floor(diff / 86_400_000) });
  const date = new Date(ms);
  return formatMonthDay(date.getMonth(), date.getDate());
}

function formatBytes(size) {
  if (!size) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** 一位补零：`9` → `09` */
const pad = (value) => String(value).padStart(2, "0");

/**
 * `2026-11-19 14:30`：日期完整、时间到分钟。
 *
 * 导出的文件里要写「导出于什么时候」——摘录的 Markdown 与正文的 HTML 都用这一种，
 * 免得两份导出文件写着两种格式的时间。不用 `toLocaleString`：它跟随系统区域设置，
 * 同一个用户在不同机器上导出的文件会长得不一样。
 */
function stampDateTime(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export { tintOf, percentOf, formatRelative, formatBytes, stampDateTime };
