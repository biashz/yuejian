/**
 * 侧栏「书签」与「划线」两页共用的顶部工具区：导出、复制。
 *
 * 显示条件由调用方给（`show`），而不是这里自己判「这本书有没有摘录」：
 * 两页的空列表各有一句引导文案，若在空列表上方还挂两个按钮，看起来像渲染错了。
 * 因此「本页有内容」才显示工具区。
 *
 * 导出的内容始终是**整本书**的摘录（划线 + 书签），不只是当前页签那一种——
 * 按钮的 tooltip 已写明，用户点「导出」要的通常是一份完整笔记而不是半份。
 *
 * 两个按钮不各自绑事件：侧栏每次重绘都换掉整段 `innerHTML`，绑在按钮上的监听
 * 会一起丢掉，所以统一由 `bind/reader.js` 做委托。
 */
import { escapeHtml } from "../core/dom.js";
import { t } from "../i18n.js";

function marksToolsHtml(show) {
  if (!show) return "";
  const copyTip = escapeHtml(t("reader.copyMarksTip"));
  const exportTip = escapeHtml(t("reader.exportMarksTip"));
  return `
    <span class="mark-tools">
      <button class="mark-tool" data-copy-marks title="${copyTip}" aria-label="${copyTip}">${
        escapeHtml(t("reader.copyMarks"))}</button>
      <button class="mark-tool" data-export-marks title="${exportTip}" aria-label="${exportTip}">${
        escapeHtml(t("reader.exportMarks"))}</button>
    </span>`;
}

export { marksToolsHtml };
