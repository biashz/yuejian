/**
 * 全局提示与纸感确认框：两者都与具体业务无关，只依赖 DOM。
 */
import { $ } from "./dom.js";

/* ---------------- Toast ---------------- */
let toastTimer = null;
// 复用同一个提示元素：连续触发时重建内容并重置计时，旧动作按钮随内容一起失效
function toast(message, opts = {}) {
  const wrap = $("#toastWrap");
  let el = wrap.firstElementChild;
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    wrap.appendChild(el);
  }
  const duration = opts.duration || 2200;
  el.innerHTML = '<svg class="ic"><use href="#i-check"/></svg><span></span>'
    + (opts.actionText ? '<button class="toast-action" type="button"></button><i class="toast-life"></i>' : "");
  el.querySelector("span").textContent = message;
  if (opts.actionText) {
    const action = el.querySelector(".toast-action");
    action.textContent = opts.actionText;
    el.querySelector(".toast-life").style.animationDuration = `${duration}ms`;
    action.addEventListener("click", () => {
      clearTimeout(toastTimer);
      el.remove();
      opts.onAction?.();
    });
  }
  el.classList.remove("is-out");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.add("is-out");
    toastTimer = setTimeout(() => el.remove(), 220);
  }, duration);
}

/* ---------------- 确认弹框 ---------------- */
let confirmSettle = null;

/**
 * 纸感「注销单」确认框，替代系统弹框。
 * 返回 Promise<boolean>：点确认为 true，取消 / ESC / 点遮罩为 false。
 * `eyebrow` 为单据顶部的小标签，调用方按场景区分（移出书架 / 删除分类）。
 */
function askConfirm({ title, book, note, okText, eyebrow }) {
  const overlay = $("#confirmOverlay");
  const card = $("#confirmCard");
  const lastFocus = document.activeElement;
  $("#confirmTitle").textContent = title;
  if (eyebrow) $("#confirmEyebrow").textContent = eyebrow;
  // 书名放进内层 span，由 CSS 单独做两行截断（外层 padding 不参与裁切）
  $("#confirmBook").innerHTML = "<span></span>";
  $("#confirmBook span").textContent = book;
  $("#confirmNote").textContent = note;
  $("#confirmOk").textContent = okText;
  overlay.hidden = false;
  // 焦点落在单据本体而非按钮上：避免默认聚焦「取消」造成的强调边框，Tab 再进入按钮
  card.focus();

  return new Promise((resolve) => {
    // 结算只做一次：双击按钮、ESC 与遮罩点击不会重复触发
    const settle = (result) => {
      if (!confirmSettle) return;
      confirmSettle = null;
      overlay.hidden = true;
      overlay.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKeydown, true);
      lastFocus?.focus?.();
      resolve(result);
    };
    const onClick = (event) => {
      if (event.target.closest("#confirmOk")) settle(true);
      else if (event.target === overlay || event.target.closest("#confirmCancel")) settle(false);
    };
    // 捕获阶段截下 ESC：否则会继续冒泡触发全局「退出阅读」快捷键
    const onKeydown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      settle(false);
    };
    confirmSettle = settle;
    overlay.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeydown, true);
  });
}

export { toast, askConfirm };
