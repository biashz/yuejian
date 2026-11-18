/**
 * 章节输出再过一道：把不带资源钩子的书（FB2 / MOBI）的 HTML 洗一遍。
 *
 * EPUB 走的是 `book.transformTarget`——资源在变成 blob URL **之前**就被拦下，
 * 这是 `guard()` 的位置。但 FB2 与 MOBI 没有那个入口：
 *
 * - FB2 由库里按白名单元素现拼 XHTML，本身安全，但顺手洗一遍不花钱；
 * - MOBI 的正文**来自文件自身**，`loadSection` 把解析好的 DOM 序列化成 HTML 再
 *   做成 blob URL。里面写一段 `<script>` 就会在章节 iframe 里执行，而那个 iframe
 *   带着 `allow-same-origin`（WebKit 的事件 bug 逼着必须开 `allow-scripts`），
 *   等于能摸到 `window.parent` 上的 Tauri 接口。
 *
 * 所以这里包一层 `load()`：拿到 blob URL 之后读回文本、洗掉活动内容、换一个新 URL。
 * 位置虽然晚了一步，但脚本这时还没被任何浏览上下文加载过，来得及。
 */
import { stripActiveContent } from "./ebook-sanitize.js";

/**
 * @param {any} book foliate 的书对象
 * @returns {any} 同一个对象（就地包装）
 */
export function hardenBook(book) {
  // 有 transformTarget 说明是 EPUB，已经由 `guard()` 在资源层拦过了
  if (!book?.sections || book.transformTarget) return book;
  for (const section of book.sections) {
    if (typeof section.load !== "function") continue;
    wrapSection(section);
  }
  return book;
}

function wrapSection(section) {
  const original = section.load.bind(section);
  section.load = async () => {
    const url = await original();
    if (typeof url !== "string" || !url.startsWith("blob:")) return url;
    const text = await fetch(url).then((res) => res.text()).catch(() => "");
    // 读不回来就原样放行：宁可少洗一道，也不要把能读的书变成打不开
    if (!text) return url;
    const clean = stripActiveContent(text, "text/html");
    // 没改动就别换 URL——漫画一页一张图，白换一遍 URL 只会多出几百个待回收的 blob
    if (clean === text) return url;
    URL.revokeObjectURL(url);
    return URL.createObjectURL(new Blob([clean], { type: "text/html" }));
  };
}
