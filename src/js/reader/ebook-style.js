/**
 * 电子书版式：把偏好折成一段注入章节文档的 CSS。
 *
 * 为什么不是改 iframe 的 style 而是注入样式表：分页器在 `afterLoad` 里往
 * `doc.head` 末尾**追加**了一个空 `<style>`，专门留给调用方写覆盖规则——它排在
 * 书自己的样式之后，同权重下后者胜出。这是库里唯一的公开口子（`renderer.setStyles`），
 * 别的地方动不到章节文档。
 *
 * 两条分界线：
 *
 * 1. **字号、行高、字体、对齐永远生效**，不加 `!important`：书里用 `em` / `100%`
 *    写的正文会跟着走，用 `px` 写死的（少数）则不受影响。
 * 2. **配色只在「强制覆盖」时动**。理由不是懒：书页底色来自书自己的 CSS，
 *    夜间模式把书页压成深色就必须同时改字色，否则黑字压黑底。两件事一起做才对，
 *    所以它们绑在同一个开关上。
 */
import { clamp } from "../core/dom.js";
import { EBOOK_FONTS } from "../core/constants.js";

/** 字号上下限：再小读不动，再大一页放不下十个字 */
const SIZE_RANGE = [12, 40];
/** 行高上下限：1 以下是压在一起，3 以上是散架 */
const LH_RANGE = [1, 3];

/**
 * 主题色从应用自身的 CSS 变量读，不在这里写第二份色值：
 * 主题切换时 `data-theme` 一改，这些变量就变了，抄进代码里的副本永远同步不上。
 */
function themeColors() {
  const style = getComputedStyle(document.documentElement);
  const read = (name) => style.getPropertyValue(name).trim();
  return { ink: read("--ink"), paper: read("--paper"), accent: read("--accent") };
}

/**
 * 正文元素清单：覆盖模式下这些元素一律用设置里的字体/行高/对齐。
 *
 * 标题（h1–h6）故意不在其中——它们靠 `em` 相对字号拉开层级，压成一样大就没法读了。
 */
const TEXT_SELECTOR = [
  "p", "div", "span", "li", "a", "td", "th", "blockquote", "dd", "dt",
  "em", "i", "b", "strong", "small", "sup", "sub", "aside", "section", "article", "figcaption",
].map((tag) => `body ${tag}`).join(", ");

/**
 * 生成注入用的 CSS。
 *
 * @param {object} settings 阅读偏好（`ebookFontSize` 等）
 * @returns {string} 整段样式文本
 */
function buildEbookStyles(settings) {
  const size = Math.round(clamp(Number(settings?.ebookFontSize) || 18, SIZE_RANGE[0], SIZE_RANGE[1]));
  const lh = clamp(Number(settings?.ebookLineHeight) || 1.8, LH_RANGE[0], LH_RANGE[1]).toFixed(2);
  const family = EBOOK_FONTS[settings?.ebookFamily] || EBOOK_FONTS.serif;
  const align = settings?.ebookAlign === "left" ? "left" : "justify";

  // 根元素也写字号：书里常用 `html { font-size: 16px }` 打底，只改 body 会让
  // 那些 `em` 单位仍然按旧值算
  const rules = [
    `html { font-size: ${size}px; }`,
    `body { font-family: ${family}; font-size: ${size}px; line-height: ${lh}; text-align: ${align}; }`,
    // 两端对齐要作用到块级子元素：只写在 body 上会被书的 `p { text-align: left }` 盖掉
    `body p, body li, body dd, body dt, body blockquote, body div { text-align: ${align}; }`,
  ];

  if (settings?.ebookOverride) {
    const { ink, paper, accent } = themeColors();
    rules.push(
      `body { font-size: ${size}px !important; line-height: ${lh} !important; font-family: ${family} !important; }`,
      `${TEXT_SELECTOR} { font-family: ${family} !important; font-size: inherit !important;`
        + ` line-height: ${lh} !important; text-align: ${align} !important; }`,
      `body h1, body h2, body h3, body h4, body h5, body h6 { font-family: ${family} !important;`
        + ` line-height: ${lh} !important; text-align: ${align} !important; }`,
    );
    if (ink && paper) {
      // 底色透明而不是涂成 --paper：容器本身已经是主题色，
      // 涂一层只会与周围差出一点色，显出一条「书页」的边
      rules.push(
        `html, body { background: transparent !important; }`,
        `body, body *:not(img):not(svg) { color: ${ink} !important; }`,
      );
    }
    if (accent) rules.push(`body a { color: ${accent} !important; }`);
    rules.push(`body img, body svg { background: transparent !important; }`);
  }

  return rules.join("\n");
}

export { buildEbookStyles, SIZE_RANGE, LH_RANGE };
