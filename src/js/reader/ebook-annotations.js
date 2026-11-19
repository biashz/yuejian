/**
 * 划线在阅读器这一侧的落点：绑定库的三个事件、把列表贴上去、从选中文字算出 CFI。
 *
 * 从 `reader-epub.js` 拆出来的。那边管的是「打开一本书、翻页、销毁」这条生命周期，
 * 划线只在中间借用两个东西——`<foliate-view>` 与章节文档里的 Range——
 * 混在一起时那个文件已经 400 行。
 *
 * 三件事的分工：
 * - `create-overlay`：换章会重建 overlayer，旧的画全没了，必须重贴；
 * - `draw-annotation`：库只算出「这段文字在页面上的矩形」，画成什么颜色由这里定；
 * - `show-annotation`：点在已有划线上，库把它命中出来，交给调用方决定改色还是删。
 */
import { Overlayer } from "../../vendor/foliate/overlayer.js";
import { HIGHLIGHT_COLORS } from "./highlight.js";

function bindAnnotations(reader, view) {
  view.addEventListener("create-overlay", () => paintAnnotations(reader));
  view.addEventListener("draw-annotation", (event) => {
    const { draw, annotation } = event.detail;
    const color = HIGHLIGHT_COLORS[annotation?.color] || HIGHLIGHT_COLORS.amber;
    // 半透明填充：划线的目的是「一眼看到」，不是把字盖住。库的默认值是 0.3，
    // 在纸白底上偏淡（加了强制覆盖的深色主题更看不出），这里提到 0.42
    draw((rects, options) => {
      const group = Overlayer.highlight(rects, options);
      group.style.opacity = "0.42";
      return group;
    }, { color });
  });
  view.addEventListener("show-annotation", (event) => reader.onAnnotation?.(event.detail));
}

/**
 * 整份重贴。
 *
 * 不做增量：`addAnnotation` 本身幂等（overlayer 里同 key 先删再画），而增量维护
 * 「换章之后哪条还在」要自己记账，账一乱就是「划线凭空消失」。
 * 删掉的那些要从 `painted` 里认出来单独撤，否则会留到下次换章。
 */
function paintAnnotations(reader) {
  if (reader.fixed) return;
  const view = reader.view;
  if (!view) return;
  const wanted = new Map(reader.highlights.map((item) => [item.cfi, item]));
  for (const cfi of reader.painted) {
    if (!wanted.has(cfi)) view.deleteAnnotation({ value: cfi }).catch(() => {});
  }
  reader.painted = new Set(wanted.keys());
  for (const item of wanted.values()) {
    // 只有落在当前这一章的才会真的画出来，其余由库自己忽略
    view.addAnnotation({ value: item.cfi, color: item.color }).catch(() => {});
  }
}

/**
 * 选中文字的 CFI。
 *
 * 要先知道这段文字落在哪一节：`getCFI(index, range)` 的第一段是 spine 下标，
 * 而从 Range 反查 index 只能靠渲染器当前的 contents（每份文档都带着自己的 index）。
 * 拿不到就返回空串——固定版面没有字符流，本来也没得划线。
 */
function selectionCfi(reader, range) {
  if (reader.fixed || !range) return "";
  const doc = range.startContainer?.ownerDocument;
  const contents = reader.view?.renderer?.getContents?.() || [];
  const hit = contents.find((item) => item.doc === doc);
  if (!hit) return "";
  try {
    return reader.view.getCFI(hit.index, range);
  } catch (_) {
    return "";
  }
}

export { bindAnnotations, paintAnnotations, selectionCfi };
