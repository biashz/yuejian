/**
 * 摘录的两个出口：存成 .md 文件、复制到剪贴板。
 *
 * 两边都用 `buildMarksMarkdown` 同一份结果，不各拼一套——导出与复制的内容
 * 若不一致，「复制出来看看」就不能用来预览将要导出的东西。
 *
 * 边界：取的是**当前活动栏**的书。分栏时两栏可能是两本书，导出谁取决于
 * 用户最后点的是哪一栏的侧栏，与侧栏本身的口径一致（`renderMarks` 同源）。
 */
import { saveTextFile } from "../api.js";
import { toast } from "../core/feedback.js";
import { t } from "../i18n.js";
import { activePane } from "./panes.js";
import { buildMarksMarkdown, hasMarks, suggestFileName } from "./export-marks.js";

/** 存到用户选定的文件；取消时不提示（后端回空串），失败才报 */
async function exportMarks() {
  const book = activePane()?.book;
  if (!hasMarks(book)) {
    toast(t("toast.noMarks"));
    return;
  }
  try {
    const path = await saveTextFile(suggestFileName(book), buildMarksMarkdown(book));
    if (path) toast(t("toast.exported", { path }));
  } catch (err) {
    toast(t("toast.exportFailed", { error: err?.message ?? err }));
  }
}

/**
 * 复制到剪贴板。
 *
 * 不静默失败：WebView 里 `navigator.clipboard` 可能因为焦点或权限不可用，
 * 此时明确告诉用户「改用导出」，而不是让人以为复制成功、去粘贴时发现是空的。
 */
async function copyMarks() {
  const book = activePane()?.book;
  if (!hasMarks(book)) {
    toast(t("toast.noMarks"));
    return;
  }
  try {
    await navigator.clipboard.writeText(buildMarksMarkdown(book));
    toast(t("toast.marksCopied"));
  } catch {
    toast(t("toast.copyFailed"));
  }
}

export { exportMarks, copyMarks };
