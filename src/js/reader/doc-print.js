/**
 * 打印当前文档：把正文搬进一个只在纸张上出现的舞台，再交给系统的打印对话框。
 *
 * 为什么不在原处打印：阅读区是 `overflow: auto` 的滚动容器，纸张没有「视口」，
 * 直接打印只会得到当前看得见的那一屏；而工具栏、侧栏、文档栏这些界面元素在纸上
 * 全是噪音。
 *
 * 于是做法是：克隆正文 → 塞进 `#printStage` → 给 `<body>` 打上 `is-printing`，
 * `@media print` 里只留舞台、其余全部 `display: none`。屏幕上看不出任何变化
 * （舞台在屏上是 `display: none`），纸上只有正文。
 *
 * 平台差异不在这里处理：macOS 的 WKWebView 不支持 `window.print()`，Windows /
 * Linux 反过来只认它。这层判断在 Rust 的 `print_webview` 里，前端只发一个命令。
 */
import { printWebview } from "../api.js";
import { t } from "../i18n.js";
import { toast } from "../core/feedback.js";
import { docCapabilities, snapshot } from "./doc-export.js";

const STAGE_ID = "printStage";

/** 打印舞台：常驻但屏上不可见，每次打印前重填内容 */
function stage() {
  let el = document.getElementById(STAGE_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = STAGE_ID;
    el.setAttribute("aria-hidden", "true");
    document.body.append(el);
  }
  return el;
}

/**
 * 打印完收摊。
 *
 * 由 `afterprint` 触发（见 bind/reader.js）。即便某些环境下这个事件不来，
 * 后果也只是页面里多留一份副本——`is-printing` 只在纸张媒体里起作用，
 * 屏幕上照样看不见它。
 */
function clearPrintStage() {
  document.body.classList.remove("is-printing");
  const el = document.getElementById(STAGE_ID);
  if (el) el.innerHTML = "";
}

async function printDoc(pane) {
  if (!docCapabilities(pane)?.print) {
    toast(t("toast.printUnsupported"));
    return;
  }
  const snap = snapshot(pane);
  if (!snap) return;
  const el = stage();
  // 容器类名一并带过去：文本的等宽视图、行号开关都靠它
  el.className = snap.className;
  el.innerHTML = snap.el.innerHTML;
  document.body.classList.add("is-printing");
  try {
    await printWebview();
  } catch (err) {
    // 对话框没起来就立刻收摊，否则下一次打印会打在旧内容上
    clearPrintStage();
    toast(t("toast.printFailed", { error: err?.message ?? err }));
  }
}

export { printDoc, clearPrintStage };
