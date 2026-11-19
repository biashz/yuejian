/**
 * 电子书版式：把版式对象折成一段注入章节文档的 CSS。
 *
 * 为什么不是改 iframe 的 style 而是注入样式表：分页器在 `afterLoad` 里往
 * `doc.head` 末尾**追加**了一个空 `<style>`，专门留给调用方写覆盖规则——它排在
 * 书自己的样式之后，同权重下后者胜出。这是库里唯一的公开口子（`renderer.setStyles`），
 * 别的地方动不到章节文档。
 *
 * 三条分界线：
 *
 * 1. **排版永远生效，不加 `!important`**：书里用 `em` / `100%` 写的正文会跟着走，
 *    用 `px` 写死的（少数）则不受影响。要连那些也接管，打开「覆盖排版」。
 * 2. **配色只在「覆盖配色」时动**。书页底色来自书自己的 CSS，夜间模式把书页压成深色
 *    就必须同时改字色，否则黑字压黑底——所以它跟着字色一起归一个开关管。
 * 3. **这里绝不写 `max-width` / `column-width` / `column-count`**：版心宽度、列间距、
 *    列数归分页器的属性管，在这里再写一遍会和它的分栏计算打架。同理不写 `vh`
 *    （分页器会把 `vh` 换算成落笔那一刻的视口高），不写 `-epub-` 前缀（会被剥掉）。
 */
import { EBOOK_FONTS } from "../core/constants.js";
import { readLayout } from "./ebook-layout.js";

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

/** 要跟着「字体/行高/缩进」走的块级元素；不含 blockquote，引文该保持自己的样子 */
const BLOCK_SELECTOR = "body p, body li, body dd, body dt";

/**
 * 生成注入用的 CSS。
 *
 * @param {object} settings 阅读偏好（`ebookFontSize` 等平铺字段）
 * @returns {string} 整段样式文本
 */
function buildEbookStyles(settings) {
  const layout = readLayout(settings);
  const family = EBOOK_FONTS[layout.family] || EBOOK_FONTS.serif;
  const size = layout.size;
  const lh = layout.lineHeight.toFixed(2);
  const align = layout.align;

  // 根元素也写字号：书里常用 `html { font-size: 16px }` 打底，只改 body 会让
  // 那些 `em` 单位仍然按旧值算
  const body = [
    `font-family: ${family};`,
    `font-size: ${size}px;`,
    `line-height: ${lh};`,
    `text-align: ${align};`,
  ];
  if (layout.letter) body.push(`letter-spacing: ${layout.letter}px;`);
  if (layout.hyphenate) body.push("hyphens: auto;");

  const rules = [
    `html { font-size: ${size}px; }`,
    `body { ${body.join(" ")} }`,
    // 对齐与缩进要作用到块级子元素：只写在 body 上会被书的 `p { text-align: left }` 盖掉
    `${BLOCK_SELECTOR}, body blockquote, body div { text-align: ${align}; }`,
  ];

  // 分段方式：两种策略都把书自己的段距清零再按我们的来，否则「缩进 + 原书段距」
  // 会同时出现缩进和拉开，节奏重复。引文 blockquote 不参与，它本来就该分开。
  if (layout.breakMode === "indent") {
    rules.push(`${BLOCK_SELECTOR} { margin-block: 0; text-indent: ${layout.indent}em; }`);
    rules.push("body blockquote { text-indent: 0; }");
  } else if (layout.breakMode === "space") {
    rules.push(`${BLOCK_SELECTOR} { text-indent: 0; margin-block: 0; }`);
    // 只加在「两段之间」：给每段上下都留白的话，首段会凭空多出一段高度
    rules.push(`body p + p, body li + li, body dd + dd { margin-block-start: ${layout.paraSpacing}px; }`);
  }

  // 标点：中文正文的三件套。`hanging-punctuation` Chromium 不支持，
  // 这里用「挤压」近似——行内标点压半角、中西文之间自动留缝、标点不走行首。
  if (layout.punctuate) {
    rules.push(
      "body { text-justify: inter-character; font-feature-settings: \"palt\";"
        + " text-autospace: normal; line-break: strict; }",
    );
  }

  if (layout.override) {
    rules.push(
      `body { font-size: ${size}px !important; line-height: ${lh} !important; font-family: ${family} !important; }`,
      `${TEXT_SELECTOR} { font-family: ${family} !important; font-size: inherit !important;`
        + ` line-height: ${lh} !important; text-align: ${align} !important; }`,
      `body h1, body h2, body h3, body h4, body h5, body h6 { font-family: ${family} !important;`
        + ` line-height: ${lh} !important; text-align: ${align} !important; }`,
    );
    // 缩进与段距也要能压过书里的 `!important`，否则「覆盖排版」只管字号不管段落
    if (layout.breakMode === "indent") {
      rules.push(`${BLOCK_SELECTOR} { text-indent: ${layout.indent}em !important; }`);
    } else if (layout.breakMode === "space") {
      rules.push(`${BLOCK_SELECTOR} { text-indent: 0 !important; }`);
      rules.push(`body p + p, body li + li { margin-block-start: ${layout.paraSpacing}px !important; }`);
    }
  }

  if (layout.overrideColor) {
    const { ink, paper, accent } = themeColors();
    if (ink && paper) {
      // 底色透明而不是涂成 --paper：容器本身已经是主题色，
      // 涂一层只会与周围差出一点色，显出一条「书页」的边
      rules.push(
        "html, body { background: transparent !important; }",
        `body, body *:not(img):not(svg) { color: ${ink} !important; }`,
      );
    }
    if (accent) rules.push(`body a { color: ${accent} !important; }`);
    rules.push("body img, body svg { background: transparent !important; }");
  }

  return rules.join("\n");
}

export { buildEbookStyles };
