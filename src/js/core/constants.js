/**
 * 常量与随语言变化的标签：主题顺序、文档类型、封面配色、排版档位、默认设置。
 */
import { t } from "../i18n.js";

const THEME_ORDER = ["paper", "night", "sepia"];
const KIND_LABEL = { pdf: "PDF", markdown: "MARKDOWN", text: "文本" };
const KIND_CLASS = { pdf: "pdf", markdown: "md", text: "txt" };
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
const kindLabel = (kind, book) => (kind === "text" ? textBadge(book) : KIND_LABEL[kind] || t("library.document"));
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
  autoCheckUpdate: true,
};

export { THEME_ORDER, KIND_LABEL, KIND_CLASS, themeLabel, kindLabel, TINTS, SIZE_STEPS, ZOOM_STEPS, ZOOM_PRESETS, DEFAULT_SETTINGS, CATEGORY_COLORS, MAX_CATEGORIES, MAX_CATEGORY_NAME };
