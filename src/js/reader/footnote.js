/**
 * 脚注弹层：点书内注号，在当前位置浮一张小卡片，不把整页翻走。
 *
 * 为什么不是「跳到注释页」：实体书翻到书后看注是没办法，电子书没有这个约束。
 * 跳过去再跳回来，等于把读者的阅读位置打乱两次。
 *
 * 只有一个实例：同时开两个脚注窗没有意义，而且定位逻辑会互相打架。
 */

let popup = null;

function ensurePopup() {
  if (popup) return popup;
  popup = document.createElement("div");
  popup.className = "ebook-note";
  popup.setAttribute("role", "dialog");
  popup.hidden = true;
  popup.innerHTML = `<div class="ebook-note-body"></div><button class="ebook-note-close" aria-label="关闭">×</button>`;
  document.body.append(popup);

  popup.querySelector(".ebook-note-close").addEventListener("click", () => hideFootnote());
  // 点卡片本身不该关：脚注可能有好几行，用户要在里面选中复制
  popup.addEventListener("click", (event) => event.stopPropagation());
  document.addEventListener("click", () => hideFootnote());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !popup.hidden) {
      event.stopPropagation();
      hideFootnote();
    }
  }, true);
  window.addEventListener("resize", () => hideFootnote());
  return popup;
}

/**
 * @param {object} options
 * @param {{ x: number, y: number }} options.anchor 注号在视口里的位置（卡片贴着它弹出）
 * @param {string} options.text 注文纯文本
 * @param {string} [options.label] 卡片顶部的小标题（章节名）
 */
export function showFootnote({ anchor, text, label = "" }) {
  const card = ensurePopup();
  card.querySelector(".ebook-note-body").innerHTML = `
    ${label ? `<p class="ebook-note-label"></p>` : ""}
    <p class="ebook-note-text"></p>`;
  if (label) card.querySelector(".ebook-note-label").textContent = label;
  card.querySelector(".ebook-note-text").textContent = text;

  card.hidden = false;
  // 先量再摆：宽度靠 CSS 定，位置必须按实际尺寸算，否则靠右边时会溢出屏幕
  const rect = card.getBoundingClientRect();
  const margin = 12;
  const x = Math.min(Math.max(margin, anchor.x - rect.width / 2), window.innerWidth - rect.width - margin);
  // 默认放在注号上方（脚注通常贴着正文底部）；上方不够就翻到下方
  const above = anchor.y - rect.height - 10;
  const y = above > margin ? above : Math.min(anchor.y + 14, window.innerHeight - rect.height - margin);
  card.style.left = `${Math.round(x)}px`;
  card.style.top = `${Math.round(y)}px`;
  return true;
}

export function hideFootnote() {
  if (!popup || popup.hidden) return;
  popup.hidden = true;
}

/** 当前是否有脚注窗（供测试与外部判断） */
export function footnoteOpen() {
  return Boolean(popup && !popup.hidden);
}
