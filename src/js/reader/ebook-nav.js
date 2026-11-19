/**
 * 翻页与跳转的算法部分：翻一页、翻一章、按比例跳。
 *
 * 从 `reader-epub.js` 拆出来的。三件都不碰生命周期，只读写 `reader` 上已有的
 * `view` / `book` / `toc` / `location`，所以做成接受 reader 的纯函数，
 * 不必再往类里挂一堆只被调用一次的方法。
 */
import { clamp } from "../core/dom.js";

/**
 * 把库的 `relocate` 明细折成本项目的位置对象。
 *
 * 只留四样：CFI（存进度与跳转）、比例（书架进度条）、章节名（状态栏）、href（目录高亮）。
 * 库给的其余字段（size、pageItem）都是排版中间量，存下来只会在换版式之后骗人。
 */
function toLocation(detail) {
  return {
    cfi: typeof detail?.cfi === "string" ? detail.cfi : "",
    fraction: clamp(Number(detail?.fraction) || 0, 0, 1),
    label: detail?.tocItem?.label || "",
    href: detail?.tocItem?.href || "",
  };
}

/**
 * 翻一页并判断是不是已经到头。
 *
 * 库在首尾处是静默 no-op（`prev()` 直接 resolve，什么也不发生），用户按了没反应
 * 只会以为卡了。这里比前后 CFI：没变就是没动，回一句提示。
 * 留一帧再比——`relocate` 是在渲染完成后才派发的，紧跟着读可能还没更新。
 */
async function stepBook(reader, direction) {
  const before = reader.location?.cfi || "";
  if (direction > 0) await reader.view?.next();
  else await reader.view?.prev();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const after = reader.location?.cfi || "";
  if (before && after && before === after) reader.onEdge?.(direction > 0 ? "end" : "start");
}

/**
 * 上一章 / 下一章。按目录顺序走，不按 spine——读者心里的「章」是目录里的那一条，
 * 而 spine 里的分节可能只是排版切分。
 */
function chapterStep(reader, direction) {
  const items = reader.toc;
  if (!items.length) return;
  const href = reader.location?.href || "";
  const file = href.split("#")[0];
  let index = -1;
  items.forEach((item, i) => {
    if (item.href === href) index = i;
    else if (index < 0 && item.href.split("#")[0] === file) index = i;
  });
  if (index < 0) return;
  const target = items[index + direction];
  if (!target) {
    reader.onEdge?.(direction > 0 ? "end" : "start");
    return;
  }
  return reader.view?.goTo(target.href);
}

/**
 * 按比例跳转。
 *
 * 回流的书交给库（`#sectionProgress` 把字符位置折算成节内锚点）。固定版面
 * 没有字符位置可折算——那本书的「比例」就是一页占多少，直接按节数取整，
 * 别去碰库里的私有进度表（漫画能走 `goToFraction`，KF8 固定版面不一定）。
 */
function goToFraction(reader, fraction) {
  const ratio = clamp(fraction, 0, 1);
  if (reader.fixed) {
    const total = reader.book?.sections?.length || 0;
    if (!total) return undefined;
    return reader.view?.goTo(Math.min(total - 1, Math.round(ratio * (total - 1))));
  }
  return reader.view?.goToFraction(ratio);
}

export { toLocation, stepBook, chapterStep, goToFraction };
