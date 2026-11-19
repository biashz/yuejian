/**
 * 摘录导出：把一本书的划线 + 书签拼成 Markdown。
 *
 * 这里只有字符串处理，不碰 DOM、不发请求。分成纯函数是有原因的：导出的
 * 真正麻烦在「输出长什么样」，而不是「怎么弹保存框」；把它独立出来，冒烟里
 * 直接调它断言结构，不用卷进系统对话框。
 *
 * 输出面向笔记软件（Obsidian / Notion / Typora）：每条摘录是一个引用块，
 * 下面一行 `—— 章节 · 颜色` 作为出处。用引用块而不是无序列表，是因为引用块
 * 在多行原文下不会把每行都变成一个列表项。
 */
import { t } from "../i18n.js";
import { colorOf } from "./highlight.js";

/** 一位补零：`9` → `09`，用于时间戳 */
const pad = (value) => String(value).padStart(2, "0");

/** `2026-11-19 14:30`：日期完整、时间到分钟，够定位「哪天导的」 */
function stamp(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `11-19 14:30`：逐条的时间只留月日，与侧栏书签列表同一口径 */
function shortStamp(createdAt) {
  const date = new Date(Number(createdAt) || 0);
  if (!createdAt || Number.isNaN(date.getTime())) return "";
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 引用块里的一行。
 *
 * 单纯加 `> ` 并不够：`> # 标题` 在 Markdown 里仍然是标题，`> - 项` 仍然是列表。
 * 书的正文里出现这两种开头很常见（尤其技术书），不转义的话导出的摘录在笔记
 * 软件里会被重新排版成别的结构。只处理「行首」这一种情况——行中的符号不构成
 * 块级语义，转了反而是多余的反斜杠。
 */
function quoteLine(line) {
  const escaped = line.replace(/^(\s*)(#{1,6}\s|[-+*]\s|\d+[.)]\s)/, "$1\\$2");
  return escaped.trim() ? `> ${escaped}` : ">";
}

/** 单条摘录：引用块 + 出处行 */
function quoteBlock(highlight) {
  const body = String(highlight.text || "").split(/\r?\n/).map(quoteLine).join("\n");
  const color = t(`reader.hlColor.${colorOf(highlight.color)}`);
  const label = String(highlight.label || "").replace(/[\r\n]+/g, " ").trim()
    || t("reader.ebookNoChapter");
  return `${body}\n\n—— ${label} · ${color}`;
}

/** 有划线或书签才值得导出；两者都没有时侧栏不该出现导出按钮 */
function hasMarks(book) {
  return Boolean(book)
    && (book.highlights?.length > 0 || book.bookmarks?.length > 0);
}

/**
 * 生成整份摘录。
 *
 * 顺序按加入时间（数组本来的顺序就是 push 顺序）：CFI 的先后要解析才知道，
 * 而「先划的在前面」既符合直觉，也不需要额外计算。与侧栏列表的倒序不同——
 * 那边最近的在最上面是方便回看，导出成文档则应该顺着读。
 */
function buildMarksMarkdown(book, { now = new Date() } = {}) {
  const highlights = book?.highlights || [];
  const bookmarks = book?.bookmarks || [];
  const title = String(book?.title || "").trim() || t("reader.exportUntitled");
  const author = String(book?.author || "").trim();

  const head = [`# ${title}`];
  if (author) head.push(`作者：${author}`);

  const counts = [];
  if (highlights.length) counts.push(t("reader.noteCount", { count: highlights.length }));
  if (bookmarks.length) counts.push(t("reader.markCount", { count: bookmarks.length }));
  if (counts.length) counts.push(t("reader.exportAt", { time: stamp(now) }));
  if (counts.length) head.push("", counts.join(" · "));

  const sections = [];
  if (highlights.length) {
    sections.push(["## " + t("reader.exportHighlights"), highlights.map(quoteBlock).join("\n\n")].join("\n\n"));
  }
  if (bookmarks.length) {
    const items = bookmarks.map((mark) => {
      const label = String(mark.label || "").replace(/[\r\n]+/g, " ").trim()
        || t("reader.ebookNoChapter");
      const at = shortStamp(mark.createdAt);
      return `- ${label}${at ? ` · ${at}` : ""}`;
    });
    sections.push(["## " + t("reader.exportBookmarks"), items.join("\n")].join("\n\n"));
  }

  return [head.join("\n"), ...sections].join("\n\n") + "\n";
}

/** 文件名里不能出现的字符：Windows 的九个保留字符 + 控制字符 */
const UNSAFE_NAME = /[\\/:*?"<>|\u0000-\u001f]/g;

/** 建议文件名：`书名-摘录.md`；书名里的非法字符换成空格，避免保存框直接报错 */
function suggestFileName(book) {
  const title = String(book?.title || "").replace(UNSAFE_NAME, " ").replace(/\s+/g, " ").trim();
  // 留出扩展名与路径的余量，标题过长时截断即可——文件名不是书名
  const name = (title || t("reader.exportUntitled")).slice(0, 80).trim();
  return `${name}-${t("reader.exportSuffix")}.md`;
}

export { buildMarksMarkdown, suggestFileName, hasMarks };
