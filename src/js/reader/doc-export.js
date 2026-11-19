/**
 * 当前文档的导出：Markdown / 文本 → 独立 HTML；PDF / 电子书 → 原文件副本。
 *
 * 「导出」在四种格式上没有共同点，硬做一套统一实现只会得到四份都不像样的结果：
 * PDF 的版面、电子书的排版都由原文件本身决定，前端再渲染一遍是更差的近似品
 * （图丢了、字体换了、分页全乱），所以那两类只交字节；而 Markdown 与文本本来就是
 * 一串字符，导出成自带样式的 HTML 反而比原件更好用——双击就能在浏览器里看、能直接打印。
 *
 * 两条实现约束：
 * ① **取当前渲染结果，不重跑 Markdown 解析**。屏幕上什么样，导出的就是什么样，
 *    包括代码高亮、表格视图、行号开关。另起一条渲染管线意味着同一个文件在应用里
 *    和导出的 HTML 里排版不一致，而这种不一致只在用户打开文件时才会发现。
 * ② **图片必须内联**。应用内的图片是 `asset://` 地址，只有本应用认；不内联，
 *    导出的文件拿到别的机器上就是一排碎图标。
 */
import { readImageDataUrl, saveFileCopy, saveTextFile } from "../api.js";
import { t } from "../i18n.js";
import { escapeHtml } from "../core/dom.js";
import { toast } from "../core/feedback.js";
import { stampDateTime } from "../core/format.js";
import { resolvePath } from "../reader-md.js";

/**
 * 当前文档能做什么。菜单据此决定出现哪几项——判定集中在这里，而不是散在
 * 菜单模板里，「菜单里少了什么、为什么少」因此只有一个答案可查。
 */
function docCapabilities(pane) {
  const book = pane?.book;
  if (!book) return null;
  // 大文件走窗口渲染，DOM 里只有一千多行：整篇打印或导出都会缺内容，
  // 与其交出一份看起来正常、实则少了 99% 的文档，不如只留「另存原文件」
  const windowed = Boolean(pane?.doc?.windowed);
  const textual = book.kind !== "pdf" && book.kind !== "ebook";
  return {
    print: textual && !windowed,
    html: textual && !windowed,
    copy: true,
    // 缺项的原因要写出来。少一项却不解释，用户只会以为功能坏了
    note: textual ? (windowed ? "reader.docNoteWindowed" : "") : "reader.docNoteBinary",
  };
}

/** 文件名里不能出现的字符：Windows 的九个保留字符 + 控制字符 */
const UNSAFE_NAME = /[\\/:*?"<>|\u0000-\u001f]/g;

/** 建议文件名：`书名.html`；书名里的非法字符换成空格，避免保存框直接报错 */
function suggestDocName(book, ext = "html") {
  const title = String(book?.title || "").replace(UNSAFE_NAME, " ").replace(/\s+/g, " ").trim();
  // 留出扩展名与路径的余量，标题过长时截断即可——文件名不是书名
  const name = (title || t("reader.exportUntitled")).slice(0, 80).trim();
  return ext ? `${name}.${ext}` : name;
}

/**
 * 取一份可离开展示环境的副本。
 *
 * 只做三件事：克隆、去掉 `loading="lazy"`（离开应用后没有任何东西会触发加载）、
 * 去掉交互态类（`is-broken` / `is-focus` 描述的是「刚才点过哪儿」，不是文档内容）。
 * 容器类名一并带出去：`text-code show-gutter` 这些决定了正文怎么排，导出后应当
 * 保持用户选的视图。
 */
function snapshot(pane) {
  const source = pane?.mdDoc;
  if (!source) return null;
  const el = source.cloneNode(true);
  el.querySelectorAll("img").forEach((img) => {
    img.removeAttribute("loading");
    img.classList.remove("is-broken");
  });
  el.querySelectorAll("[class]").forEach((node) => {
    node.classList.remove("is-focus", "is-active", "is-hit");
  });
  return { el, className: source.className || "md-doc" };
}

/**
 * 把本地图片内联成 data URL，返回没能内联的张数。
 *
 * 单张读失败不中断整份导出：一张图丢了比整个文件导不出来好。失败的图保留
 * `alt` 文本，读者至少知道这里原本有张图。
 */
async function inlineImages(el, dir) {
  const images = [...el.querySelectorAll("img[data-src]")];
  let failed = 0;
  for (const img of images) {
    const path = resolvePath(dir || "", img.dataset.src || "");
    try {
      img.setAttribute("src", await readImageDataUrl(path));
    } catch {
      img.removeAttribute("src");
      failed += 1;
    }
    img.removeAttribute("data-src");
  }
  return failed;
}

/**
 * 导出的 HTML 自带的样式。
 *
 * 不复用应用的 `styles.css`：那份 CSS 有四百多个选择器、依赖主题变量与界面
 * 外壳，粘进来既带不走变量也带不走布局。这里只保留正文需要的那部分，颜色
 * 取「纸」主题的实际值写死——导出的文件不跟随主题，它就该是一份稳定的版式。
 */
const EXPORT_CSS = `
  :root {
    color-scheme: light;
    --ink: #241f1a; --ink-2: #5e5548; --ink-3: #8c8272;
    --line: #dfd4c0; --paper: #fbf7ee; --accent: #b23a2b; --ok: #4f7355;
    --mono: "Cascadia Code", "JetBrains Mono", Consolas, monospace;
    --read: "Songti SC", "Source Han Serif SC", "Noto Serif CJK SC", SimSun, Georgia, serif;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 48px 24px 96px;
    background: var(--paper); color: var(--ink);
    font: 17px/1.9 var(--read);
    -webkit-font-smoothing: antialiased;
  }
  .doc-head, .md-doc { max-width: 46rem; margin: 0 auto; }
  .doc-head { margin-bottom: 40px; padding-bottom: 18px; border-bottom: 1px solid var(--line); }
  .doc-head h1 { margin: 0; font-size: 30px; line-height: 1.35; letter-spacing: 0.01em; }
  .doc-head p { margin: 8px 0 0; font: 12px/1.6 var(--mono); color: var(--ink-3); letter-spacing: 0.06em; }
  .md-doc > :first-child { margin-top: 0; }
  h1, h2, h3, h4, h5, h6 { line-height: 1.4; margin: 1.8em 0 0.6em; font-weight: 600; }
  h1 { font-size: 1.6em; } h2 { font-size: 1.3em; } h3 { font-size: 1.12em; }
  h4, h5, h6 { font-size: 1em; color: var(--ink-2); }
  p, ul, ol, blockquote, pre, table { margin: 0 0 1.1em; }
  ul, ol { padding-left: 1.6em; }
  li { margin: 0.25em 0; }
  a { color: var(--accent); text-decoration: none; border-bottom: 1px solid var(--line); }
  strong { font-weight: 700; }
  hr { border: 0; border-top: 1px solid var(--line); margin: 2em 0; }
  blockquote {
    margin-left: 0; padding: 4px 0 4px 16px;
    border-left: 3px solid var(--line); color: var(--ink-2);
  }
  img { max-width: 100%; height: auto; border-radius: 4px; }
  code, pre, kbd { font-family: var(--mono); font-size: 0.88em; }
  code { padding: 1px 5px; border-radius: 3px; background: #efe6d6; }
  pre {
    padding: 14px 16px; overflow-x: auto;
    background: #efe6d6; border: 1px solid var(--line); border-radius: 6px;
    line-height: 1.65;
  }
  pre code { padding: 0; background: none; }
  table { width: 100%; border-collapse: collapse; font-size: 0.94em; }
  th, td { padding: 6px 10px; border: 1px solid var(--line); text-align: left; }
  thead th { background: #efe6d6; }
  .hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-doctag { color: var(--accent); }
  .hljs-string, .hljs-attr, .hljs-template-tag { color: var(--ok); }
  .hljs-number, .hljs-symbol, .hljs-bullet, .hljs-meta { color: #a8792c; }
  .hljs-comment, .hljs-quote { color: var(--ink-3); font-style: italic; }
  .hljs-title, .hljs-section { color: #6b5b95; }
  /* 纯文本与表格视图：等宽、不折行；行号只在 show-gutter 时出现 */
  .is-text { font-family: var(--mono); font-size: 13.5px; line-height: 1.7; }
  .tx-code { display: flex; align-items: flex-start; gap: 0; }
  .tx-gutter {
    margin: 0; padding: 14px 10px 14px 0; border: 0; border-radius: 0;
    background: none; color: var(--ink-3); text-align: right; user-select: none;
  }
  .is-text:not(.show-gutter) .tx-gutter { display: none; }
  .tx-lines { margin: 0; flex: 1; min-width: 0; border-radius: 0; border: 0; background: none; }
  .is-wrap .tx-lines { white-space: pre-wrap; }
  .tx-para { margin: 0 0 1.1em; white-space: pre-wrap; }
  .tx-table-wrap { overflow-x: auto; }
  .tx-table { font-size: 0.92em; }
  .tx-rowno { color: var(--ink-3); text-align: right; }
  .tx-empty { color: var(--ink-3); }
  @media print {
    body { padding: 0; background: #fff; font-size: 11.5pt; }
    .doc-head { border-bottom-color: #ddd; }
    a { color: inherit; }
    pre, blockquote, table, img { break-inside: avoid; }
    h1, h2, h3 { break-after: avoid; }
  }
`;

/**
 * 拼一份可以直接双击打开的 HTML。
 *
 * 纯字符串处理：不碰 DOM、不发请求。导出的真正麻烦在「输出长什么样」，
 * 把它独立出来，冒烟里能直接断言结构，不必卷进系统对话框。
 */
function buildStandaloneHtml({ title, subtitle = "", className = "md-doc", body = "", lang = "zh" }) {
  return `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${EXPORT_CSS}</style>
</head>
<body>
<header class="doc-head">
<h1>${escapeHtml(title)}</h1>
${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ""}
</header>
<article class="${escapeHtml(className)}">${body}</article>
</body>
</html>
`;
}

/** 导出为独立 HTML 文件；取消时不提示（后端回空串），失败才报 */
async function exportHtml(pane) {
  if (!docCapabilities(pane)?.html) {
    toast(t("toast.exportUnsupported"));
    return;
  }
  const snap = snapshot(pane);
  if (!snap) return;
  const book = pane.book;
  const title = String(book?.title || "").trim() || t("reader.exportUntitled");
  const missing = await inlineImages(snap.el, pane.doc?.dir);
  const html = buildStandaloneHtml({
    title,
    subtitle: t("reader.exportAt", { time: stampDateTime(new Date()) }),
    className: snap.className,
    body: snap.el.innerHTML,
    lang: document.documentElement.lang || "zh",
  });
  try {
    const path = await saveTextFile(suggestDocName(book, "html"), html, "html");
    if (!path) return;
    toast(missing
      ? t("toast.exportedPartial", { path, count: missing })
      : t("toast.exported", { path }));
  } catch (err) {
    toast(t("toast.exportFailed", { error: err?.message ?? err }));
  }
}

/**
 * 另存一份原文件副本。
 *
 * PDF 与电子书走这条路：它们的「导出」就是原样的字节。文本类也给这一项——
 * 「把原件拿出来」与「导出一份带排版的 HTML」是两件不同的事，前者要的是原文件。
 */
async function saveCopy(pane) {
  const book = pane?.book;
  if (!book?.path) return;
  // 扩展名取「最后一段点分后缀」：`a.b.c.pdf` → `pdf`，没有后缀就不硬拼一个点
  const ext = String(book.path).match(/\.([A-Za-z0-9]{1,5})$/)?.[1] || "";
  try {
    const path = await saveFileCopy(book.path, suggestDocName(book, ext));
    if (path) toast(t("toast.exported", { path }));
  } catch (err) {
    toast(t("toast.exportFailed", { error: err?.message ?? err }));
  }
}

// 只导出被真正用到的：能力判定与快照给 doc-print.js，两个出口给事件绑定。
// 其余（文件名建议、图片内联、HTML 拼装）是实现细节，冒烟通过导出结果整体断言
export { docCapabilities, snapshot, exportHtml, saveCopy };
