/**
 * 划线的两个入口动作：选中文字时要一块色板，点已有划线时要能换色或删掉。
 *
 * 从 `ebook-open.js` 拆出来的。那边已经背着打开、续读、版式、脚注、书内链接，
 * 而这两件事只跟「划线」有关，和打开流程一个字都不重叠。
 *
 * 位置计算是这里最容易错的一处：Range 的矩形相对章节 iframe，iframe 又可能被
 * 分页器横向移到屏幕之外，所以两段坐标要相加，再夹回窗口内。
 */
import { clamp } from "../core/dom.js";
import { state } from "../core/session.js";
import { renderCtx } from "./ctx.js";
import { addHighlight, find as findHighlight, recolor, removeHighlight } from "./highlight.js";
import { openHighlightMenu } from "./highlight-menu.js";

/**
 * 选中一段文字 → 浮出色板。
 *
 * CFI 在选中这一刻算定：滚一下、翻一页之后再算，选区早就没了。
 * 位置拿不到（选区跨到容器外、或固定版面没有字符流）就什么也不弹——
 * 一个点不出结果的色板比不弹更糟。
 */
function askHighlight(pane, range) {
  const cfi = pane.ebook?.selectionCfi(range) || "";
  const text = String(range?.toString?.() || "");
  if (!cfi || !text.trim()) return;
  const at = rangePoint(pane, range);
  openHighlightMenu({
    x: at.x,
    y: at.y,
    onPick: (color) => {
      // 划完就把选区收掉：原生选区是一层灰，压在新划的线上，看着像没上色
      range.startContainer?.ownerDocument?.getSelection?.()?.removeAllRanges?.();
      addHighlight(pane, { cfi, text, color, label: pane.ebook?.location?.label || "" })
        .then((item) => {
          // 侧栏正停在划线页时要立刻看到新增的那条
          if (item && state.ctxTab === "notes") renderCtx();
        });
    },
  });
}

/** 点已有的划线：换色或删除，锚在那一行文字上 */
function pickAnnotation(pane, detail) {
  const cfi = detail?.value || "";
  const item = findHighlight(pane, cfi);
  if (!item) return;
  const at = rangePoint(pane, detail.range);
  openHighlightMenu({
    x: at.x,
    y: at.y,
    color: item.color,
    removable: true,
    onPick: (color) => {
      recolor(pane, cfi, color).then(() => {
        if (state.ctxTab === "notes") renderCtx();
      });
    },
    onRemove: () => {
      removeHighlight(pane, cfi).then(() => {
        if (state.ctxTab === "notes") renderCtx();
      });
    },
  });
}

/**
 * Range 在视口里的位置。
 *
 * Range 的矩形相对章节 iframe，要加上 iframe 自己的偏移才是主文档里的位置。
 * 两者都量不到时退回阅读区中心——宁可小窗出现在正中，也不要出现在 (0,0)。
 */
function rangePoint(pane, range) {
  const rect = range?.getBoundingClientRect?.();
  const frame = range?.startContainer?.ownerDocument?.defaultView?.frameElement;
  const frameRect = frame?.getBoundingClientRect?.();
  if (rect && frameRect && rect.width) {
    return {
      x: clamp(frameRect.left + rect.left + rect.width / 2, 40, window.innerWidth - 40),
      y: clamp(frameRect.top + rect.top, 60, window.innerHeight - 120),
    };
  }
  const box = pane.ebookStack.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

export { askHighlight, pickAnnotation };
