/**
 * 划线小窗：选中文字后浮出来的那一条（五个颜色 + 复制 / 笔记 / 删除）。
 *
 * 它是主文档里的 fixed 元素，不是章节 iframe 里的：iframe 用 `blob:` 且被分页器
 * 横向摊开，在里头定位一个不被裁切的小窗要多绕两圈，而遮不住的好处几乎没有。
 *
 * 收起规则只有三条：点窗外、按 Esc、翻页。滚动不当作收起——选中的位置会跟着走，
 * 小窗本来就是锚在那一段文字上的。笔记弹层叠在小窗之上，Esc 先收弹层再收小窗。
 */
import { t } from "../i18n.js";
import { toast } from "../core/feedback.js";
import { escapeHtml } from "../core/dom.js";
import { COLOR_ORDER, colorValue } from "./highlight.js";

let menu = null;
let pick = null;
let remove = null;
let copy = null;
let noteSave = null;
let openedAt = 0;
let notePop = null;

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
    if (event.target.closest("[data-hl-copy]") && copy) {
      const run = copy;
      closeHighlightMenu();
      run();
      return;
    }
    if (event.target.closest("[data-hl-note]") && noteSave) {
      openNotePopover();
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
 * @param {() => void} [options.onCopy] 复制原文；给了才出现「复制」
 * @param {(note: string) => void} [options.onNoteSave] 保存笔记；给了才出现「笔记」
 * @param {string} [options.note] 已有笔记（决定按钮写「笔记」还是「编辑笔记」）
 */
function openHighlightMenu({ x, y, color = "", removable = false, onPick, onRemove, onCopy, onNoteSave, note = "" }) {
  const box = ensureMenu();
  pick = onPick;
  remove = onRemove || null;
  copy = onCopy || null;
  noteSave = onNoteSave || null;
  const acts = [];
  if (copy) acts.push(`<button class="hl-act" data-hl-copy>${t("reader.hlCopy")}</button>`);
  if (noteSave) acts.push(`<button class="hl-act" data-hl-note>${t(note ? "reader.hlNoteEdit" : "reader.hlNote")}</button>`);
  if (removable) acts.push(`<button class="hl-act hl-act-danger" data-hl-remove>${t("reader.highlightRemove")}</button>`);
  box.innerHTML = `
    <span class="hl-menu-colors">
      ${COLOR_ORDER.map((key) => `
        <button class="hl-dot ${key === color ? "is-on" : ""}" data-hl-color="${key}"
          style="--_dot:${colorValue(key)}" title="${escapeHtml(t(`reader.hlColor.${key}`))}"
          aria-label="${escapeHtml(t(`reader.hlColor.${key}`))}"></button>`).join("")}
    </span>
    ${acts.length ? `<span class="hl-acts">${acts.join("")}</span>` : ""}`;
  box.dataset.note = note;
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

/* ---------------- 笔记弹层 ---------------- */

function ensureNotePop() {
  if (notePop) return notePop;
  notePop = document.createElement("div");
  notePop.className = "hl-note-pop";
  notePop.hidden = true;
  notePop.innerHTML = `
    <textarea class="hl-note-input" maxlength="500" rows="3"
      placeholder="${t("reader.hlNotePlaceholder")}" aria-label="${t("reader.hlNote")}"></textarea>
    <span class="hl-note-foot">
      <span class="hl-note-count">0 / 500</span>
      <button class="hl-note-btn" data-note-cancel>${t("reader.hlNoteCancel")}</button>
      <button class="hl-note-btn hl-note-save" data-note-save>${t("reader.hlNoteSave")}</button>
    </span>`;
  document.body.append(notePop);
  const input = notePop.querySelector(".hl-note-input");
  const count = notePop.querySelector(".hl-note-count");
  input.addEventListener("input", () => {
    count.textContent = `${input.value.length} / 500`;
  });
  notePop.addEventListener("click", (event) => {
    event.stopPropagation();
    if (event.target.closest("[data-note-cancel]")) return closeNotePopover();
    if (event.target.closest("[data-note-save]")) {
      const value = input.value.trim();
      if (value.length > 500) return toast(t("reader.hlNoteTooLong"));
      const run = noteSave;
      closeNotePopover();
      closeHighlightMenu();
      run?.(value);
    }
  });
  return notePop;
}

function openNotePopover() {
  const pop = ensureNotePop();
  const input = pop.querySelector(".hl-note-input");
  input.value = menu?.dataset.note || "";
  pop.querySelector(".hl-note-count").textContent = `${input.value.length} / 500`;
  pop.hidden = false;
  // 贴在小窗下方；小窗在屏幕底部时翻到上方
  const box = menu.getBoundingClientRect();
  const rect = pop.getBoundingClientRect();
  const left = Math.min(Math.max(8, box.left + box.width / 2 - rect.width / 2), window.innerWidth - rect.width - 8);
  const below = box.bottom + 8;
  const top = below + rect.height > window.innerHeight - 8 ? Math.max(8, box.top - rect.height - 8) : below;
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
  input.focus();
  document.addEventListener("pointerdown", onNoteOutside, true);
  document.addEventListener("keydown", onNoteKey, true);
}

function onNoteOutside(event) {
  if (notePop?.contains(event.target)) return;
  closeNotePopover();
  closeHighlightMenu();
}

function onNoteKey(event) {
  if (event.key !== "Escape") return;
  event.stopPropagation();
  closeNotePopover();
}

function closeNotePopover() {
  if (!notePop || notePop.hidden) return;
  notePop.hidden = true;
  document.removeEventListener("pointerdown", onNoteOutside, true);
  document.removeEventListener("keydown", onNoteKey, true);
}

function notePopoverOpen() {
  return Boolean(notePop && !notePop.hidden);
}

function onOutside(event) {
  // 刚打开的那一下不能算「点窗外」：触发小窗的 mouseup 之后紧跟 pointerdown
  if (Date.now() - openedAt < 120) return;
  if (menu?.contains(event.target)) return;
  if (notePop?.contains(event.target)) return;
  closeHighlightMenu();
}

function onKey(event) {
  if (event.key !== "Escape") return;
  // 笔记弹层开着时 Esc 归它：它的 capture 监听挂得比小窗晚，先让行
  if (notePopoverOpen()) return;
  event.stopPropagation();
  closeHighlightMenu();
}

function closeHighlightMenu() {
  if (!menu || menu.hidden) return;
  closeNotePopover();
  menu.hidden = true;
  pick = null;
  remove = null;
  copy = null;
  noteSave = null;
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

export { openHighlightMenu, closeHighlightMenu, highlightMenuOpen, highlightMenuAge, notePopoverOpen };
