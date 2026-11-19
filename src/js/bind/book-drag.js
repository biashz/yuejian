/**
 * 文档 → 分类的拖拽归类（指针事件版）。
 *
 * 为什么不用 HTML5 拖放：真机上这条路一直不稳。事后按原逻辑重放，dragstart / drop /
 * getData 都能走通，说明它并不是「完全不触发」，而是依赖 dragover 里那次 preventDefault
 * 与 drop / dragend 的先后顺序——窗口级还压着 Tauri 的文件拖入（原生拖放），任一处被打断
 * 就整个失效，而且没有任何报错，只能看到「拖过去没反应」。
 * 这里改成用指针事件自己搬：行为只取决于按下 / 移动 / 松手三个监听，能测、能断言，
 * 也不受拖放引擎与平台差异影响。
 *
 * 落点只看 `.cat-row`：分类行、`全部`、`未分类` 都带 data-cat，取值统一交给
 * targetCategoryId 换算（`__none` / `__all` 都表示「移出分类」）。
 */
import { state } from "../core/session.js";
import { targetCategoryId } from "../categories.js";
import { assignCategory } from "../actions.js";

const THRESHOLD = 4; // 位移小于这个值仍然算点击，不算拖拽
const GHOST_OFFSET = { x: 14, y: 12 };
const EDGE = 18; // 拖到分类列表上下边缘这么近就自动滚
const SCROLL_STEP = 8;

let drag = null; // { id, el, x0, y0, started, ghost }
let swallowClick = false; // 拖完那一下的 click 要吃掉，否则会顺手把文档打开

const rowAt = (x, y) => {
  const hit = document.elementFromPoint(x, y);
  return hit?.closest?.(".cat-row") || null;
};

function makeGhost(title) {
  const ghost = document.createElement("div");
  ghost.className = "book-ghost";
  ghost.textContent = title;
  document.body.append(ghost);
  return ghost;
}

/** 收尾：幽灵、落点高亮、拖拽态类名一起清掉（点取消、松手、Esc 都走这里） */
function finish() {
  if (!drag) return;
  drag.ghost?.remove();
  document.querySelectorAll(".cat-row.is-drop").forEach((row) => row.classList.remove("is-drop"));
  drag.el?.classList.remove("is-dragging");
  document.body.classList.remove("is-book-dragging");
  drag = null;
}

function beginDrag(event) {
  const book = state.books.find((item) => item.id === drag.id);
  const title = book?.title || "文档";
  drag.started = true;
  drag.ghost = makeGhost(title.length > 24 ? `${title.slice(0, 24)}…` : title);
  drag.el.classList.add("is-dragging");
  document.body.classList.add("is-book-dragging");
  moveGhost(event);
}

function moveGhost(event) {
  drag.ghost.style.transform =
    `translate3d(${event.clientX + GHOST_OFFSET.x}px, ${event.clientY + GHOST_OFFSET.y}px, 0)`;
}

/**
 * 分类列表只有 168px 高，分类一多就得滚。拖拽期间滚轮是用不了的，
 * 光标压到上下边缘时替它滚一点，否则排在下面的分类根本够不着。
 */
function autoScroll(clientY) {
  const list = document.querySelector("#catList");
  if (!list || list.scrollHeight <= list.clientHeight) return;
  const box = list.getBoundingClientRect();
  if (clientY < box.top + EDGE) list.scrollTop -= SCROLL_STEP;
  else if (clientY > box.bottom - EDGE) list.scrollTop += SCROLL_STEP;
}

function markTarget(row) {
  const current = document.querySelector(".cat-row.is-drop");
  if (current === row) return;
  current?.classList.remove("is-drop");
  row?.classList.add("is-drop");
}

export function bindBookDrag() {
  window.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || state.view !== "library") return;
    // 行内的按钮（删除、收藏）和输入框有自己的事要做
    if (event.target.closest("button, input, textarea, [data-star], [data-remove]")) return;
    const el = event.target.closest(".book-row, .book-card");
    const id = el?.dataset.book;
    if (!id) return;
    drag = { id, el, x0: event.clientX, y0: event.clientY, started: false, ghost: null };
  });

  window.addEventListener("pointermove", (event) => {
    if (!drag) return;
    if (!drag.started) {
      const dx = event.clientX - drag.x0;
      const dy = event.clientY - drag.y0;
      if (Math.hypot(dx, dy) < THRESHOLD) return;
      beginDrag(event);
    }
    event.preventDefault();
    moveGhost(event);
    autoScroll(event.clientY);
    markTarget(rowAt(event.clientX, event.clientY));
  });

  window.addEventListener("pointerup", (event) => {
    if (!drag) return;
    const started = drag.started;
    const id = drag.id;
    const row = rowAt(event.clientX, event.clientY);
    finish();
    if (!started) return;
    // 这一次松手会补一个 click，别让它把文档打开
    swallowClick = true;
    const book = state.books.find((item) => item.id === id);
    // 拖回原分类不写盘，避免无意义的重绘与提示
    if (!row || !book || book.categoryId === targetCategoryId(row.dataset.cat)) return;
    assignCategory([id], targetCategoryId(row.dataset.cat));
  });

  window.addEventListener("pointercancel", finish);
  window.addEventListener("blur", finish);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && drag?.started) {
      event.preventDefault();
      event.stopPropagation();
      finish();
    }
  }, true);

  // 捕获阶段先把拖拽后的那一次点击吃掉，再放行给正常点击
  window.addEventListener("click", (event) => {
    if (!swallowClick) return;
    swallowClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);
}
