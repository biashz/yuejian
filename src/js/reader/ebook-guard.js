/**
 * 资源钩子：EPUB 的清单项在变成 blob URL 之前的最后一道。
 *
 * 两个事件都在库内部（`book.transformTarget`，也就是 loader 的 eventTarget）：
 *
 * - `load`：允许 / 拒绝某个清单项。脚本类直接拒掉，连字节都不读；
 * - `data`：资源字节在变成 blob URL 之前过一遍清洗，把脚本与内联事件砍掉。
 *
 * 与 `hardenBook` 是一对：那个管 FB2 / MOBI（没有这组钩子，只能在读回后洗），
 * 这个管 EPUB（有钩子，能在源头拦）。放在同一个文件里，
 * 是因为「哪本书走哪条路」这件事必须一起看才不出洞。
 */
import { stripActiveContent } from "./ebook-sanitize.js";

function guardBook(book) {
  const target = book?.transformTarget;
  if (!target) return;
  target.addEventListener("load", (event) => {
    if (event.detail?.isScript) event.detail.allow = false;
  });
  target.addEventListener("data", (event) => {
    const type = String(event.detail?.type || "");
    if (!/xhtml|html|svg/i.test(type)) return;
    event.detail.data = Promise.resolve(event.detail.data)
      .then((bytes) => stripActiveContent(bytes, type));
  });
}

export { guardBook };
