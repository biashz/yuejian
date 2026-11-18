/**
 * 常量与随语言变化的标签：主题顺序、文档类型、封面配色、排版档位、默认设置。
 */
import { t } from "../i18n.js";

const THEME_ORDER = ["paper", "night", "sepia"];
const KIND_LABEL = { pdf: "PDF", markdown: "MARKDOWN", text: "文本", ebook: "EPUB" };
const KIND_CLASS = { pdf: "pdf", markdown: "md", text: "txt", ebook: "epub" };
/* 电子书角标按真实格式显示：书架上摆着 EPUB 与 CBZ 时，「都叫 EPUB」等于没标 */
const EBOOK_BADGE = { epub: "EPUB", fb2: "FB2", fbz: "FB2.ZIP", cbz: "CBZ", mobi: "MOBI", azw: "AZW", azw3: "AZW3" };
/** 电子书的格式标识（小写）；`.fb2.zip` 要按整名判断，扩展名只有 `zip` */
const ebookFormat = (path) => {
  const name = String(path || "").toLowerCase();
  if (name.endsWith(".fb2.zip")) return "fbz";
  const match = /\.([a-z0-9]+)$/.exec(name);
  return match ? match[1] : "";
};
/* 主题名与文档类型名随语言切换，用函数取值避免缓存旧语言文案 */
const themeLabel = (theme) => t(`status.theme.${theme}`);
/**
 * 文本类的角标直接用扩展名（TXT / LOG / CSV / RS…）：
 * 一份日志和一份散文都叫「文本」的话，书架上就分不出该点哪个了。
 */
const textBadge = (book) => {
  const match = /\.([a-z0-9]{1,6})$/i.exec(book?.path || "");
  return match ? match[1].toUpperCase() : t("library.document");
};
const kindLabel = (kind, book) => {
  if (kind === "text") return textBadge(book);
  if (kind === "ebook") return EBOOK_BADGE[ebookFormat(book?.path)] || KIND_LABEL.ebook;
  return KIND_LABEL[kind] || t("library.document");
};
const TINTS = ["clay", "indigo", "olive", "sand", "plum"];
/* 分类色板：取值同时用作 CSS 类名后缀（.c-clay）与 state.json 里的 color 字段 */
const CATEGORY_COLORS = ["clay", "indigo", "olive", "amber", "plum", "slate"];
/* 上限与 Rust 侧 MAX_CATEGORIES / MAX_CATEGORY_NAME 保持一致，前端只做提前禁用 */
const MAX_CATEGORIES = 40;
const MAX_CATEGORY_NAME = 20;
const SIZE_STEPS = [15, 17, 19, 21];
/* 缩放档位：按钮、Ctrl+滚轮与快捷键都按档位步进，与常见阅读器一致 */
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
/* 菜单里展示的常用比例：点击即可切换，不必反复点加减 */
const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const DEFAULT_SETTINGS = {
  theme: "paper", fontSize: 17, lineHeight: 1.9, measure: 720,
  showCtx: true, zen: false, linkSync: true, language: "zh",
  autoCheckUpdate: true, ebookSpread: true,
  /* 电子书专属：字号/行高/边距/字体/对齐/覆盖，与 PDF 的排版档位互不影响 */
  ebookFontSize: 18, ebookLineHeight: 1.8, ebookMargin: 48,
  ebookFamily: "serif", ebookAlign: "justify", ebookOverride: false,
};
/* 电子书字体的可选值与字体栈：值存盘，栈只在这里出现一次 */
const EBOOK_FONTS = {
  serif: '"Songti SC", "SimSun", "Source Han Serif SC", "Noto Serif CJK SC", Georgia, serif',
  sans: '"PingFang SC", "Microsoft YaHei", "Source Han Sans SC", "Noto Sans CJK SC", system-ui, sans-serif',
  kai: '"Kaiti SC", "KaiTi", "STKaiti", "Source Han Serif SC", Georgia, serif',
};

export { THEME_ORDER, KIND_LABEL, KIND_CLASS, EBOOK_BADGE, ebookFormat, themeLabel, kindLabel, TINTS, SIZE_STEPS, ZOOM_STEPS, ZOOM_PRESETS, DEFAULT_SETTINGS, EBOOK_FONTS, CATEGORY_COLORS, MAX_CATEGORIES, MAX_CATEGORY_NAME };
