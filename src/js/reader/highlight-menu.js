/**
 * 划线小窗：选中文字后浮出来的那一条（五个颜色 + 删除）。
 *
 * 它是主文档里的 fixed 元素，不是章节 iframe 里的：iframe 用 `blob:` 且被分页器
 * 横向摊开，在里头定位一个不被裁切的小窗要多绕两圈，而遮不住的好处几乎没有。
 *
 * 收起规则只有三条：点窗外、按 Esc、翻页。滚动不当作收起——选中的位置会跟着走，
 * 小窗本来就是锚在那一段文字上的。
 */
import { t } from "../i18n.js";
import { escapeHtml } from "../core/dom.js";
import { COLOR_ORDER, colorValue } from "./highlight.js";

let menu = null;
let pick = null;
let remove = null;
let openedAt = 0;

function ensureMenu() {
  if (menu) return menu;
  menu = document.createElement("div");
  menu.className = "hl-menu";
  menu.id = "hlMenu";
  menu.hidden = true;
  document.body.append(menu);
  menu.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const dot = event.target.closest("[data-hl-color]");
    if (dot && pick) {
      // 先取出回调再收窗：`closeHighlightMenu` 会把模块里的 pick 清成 null
      const run = pick;
      const value = dot.dataset.hlColor;
      closeHighlightMenu();
      run(value);
      return;
    }
    if (event.target.closest("[data-hl-remove]") && remove) {
      const run = remove;
      closeHighlightMenu();
      run();
    }
  });
  return menu;
}

/**
 * @param {object} options
 * @param {number} options.x 视口坐标（选中文字的左端）
 * @param {number} options.y 视口坐标（选中文字的上沿）
 * @param {string} [options.color] 已有的划线颜色，没有则显示为空
 * @param {boolean} [options.removable] 是否显示「删除」（点已有划线时才给）
 * @param {(color: string) => void} options.onPick
 * @param {() => void} [options.onRemove]
 */
function openHighlightMenu({ x, y, color = "", removable = false, onPick, onRemove }) {
  const box = ensureMenu();
  pick = onPick;
  remove = onRemove || null;
  box.innerHTML = `
    <span class="hl-menu-colors">
      ${COLOR_ORDER.map((key) => `
        <button class="hl-dot ${key === color ? "is-on" : ""}" data-hl-color="${key}"
          style="--_dot:${colorValue(key)}" title="${escapeHtml(t(`reader.hlColor.${key}`))}"
          aria-label="${escapeHtml(t(`reader.hlColor.${key}`))}"></button>`).join("")}
    </span>
    ${removable ? `<span class="hl-menu-sep"></span>
      <button class="hl-del" data-hl-remove title="${t("reader.highlightRemove")}">${t("reader.highlightRemove")}</button>` : ""}`;
  box.hidden = false;
  // 先量再摆：宽度取决于语言与有没有删除项，写死会算错
  const rect = box.getBoundingClientRect();
  const left = Math.min(Math.max(8, x - rect.width / 2), window.innerWidth - rect.width - 8);
  const top = y - rect.height - 10 < 8 ? y + 22 : y - rect.height - 10;
  box.style.left = `${Math.round(left)}px`;
  box.style.top = `${Math.round(top)}px`;
  openedAt = Date.now();
  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("keydown", onKey, true);
}

function onOutside(event) {
  // 刚打开的那一下不能算「点窗外」：触发小窗的 mouseup 之后紧跟 pointerdown
  if (Date.now() - openedAt < 120) return;
  if (menu?.contains(event.target)) return;
  closeHighlightMenu();
}

function onKey(event) {
  if (event.key !== "Escape") return;
  event.stopPropagation();
  closeHighlightMenu();
}

function closeHighlightMenu() {
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  pick = null;
  remove = null;
  document.removeEventListener("pointerdown", onOutside, true);
  document.removeEventListener("keydown", onKey, true);
}

/** 小窗是否开着（翻页时顺手收起来） */
function highlightMenuOpen() {
  return Boolean(menu && !menu.hidden);
}

/** 已经摆了多久（毫秒）；没开着时返回 Infinity，方便调用方直接比 */
function highlightMenuAge() {
  return highlightMenuOpen() ? Date.now() - openedAt : Number.POSITIVE_INFINITY;
}

export { openHighlightMenu, closeHighlightMenu, highlightMenuOpen, highlightMenuAge };
