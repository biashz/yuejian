/**
 * 电子书的翻页手势：点击左右半屏、滚轮 / 触控板、翻页键。
 *
 * 为什么不能只在主文档上绑一次：正文跑在每章一个的 `blob:` iframe 里，iframe 内的
 * 事件不会冒泡到主文档，焦点进去之后连键盘都收不到。所以同一套手势要在两个层面
 * 各挂一份——外层容器（负责点击四周留白与焦点在容器上时的按键）和每个章节文档。
 *
 * 三条「不要翻」的规则，都来自真实误触：
 * 1. 点在链接上不翻——脚注、跨章引用都靠它；
 * 2. 正在选中文字不翻——拖选到右半屏就跳页，是最容易把人逼疯的一种；
 * 3. 中间 30% 不翻——那是视线中心，也是误触最多的地方。
 */

/** 左右各 35% 是翻页热区，中间留白 */
const EDGE_RATIO = 0.35;
/** 触控板一格的 deltaY 远小于这个值，累计够了才翻 */
const WHEEL_THRESHOLD = 48;
/** 两次滚轮翻页之间的冷却：一次惯性滑动不该连翻五页 */
const WHEEL_COOLDOWN = 320;

/**
 * @param {Document|HTMLElement} target 章节文档或承载 `<foliate-view>` 的容器
 * @param {object} handlers
 * @param {(direction: 1|-1) => void} handlers.onStep
 * @param {(where: "start"|"end") => void} [handlers.onJump]    Home / End 跳到书首 / 书尾
 * @param {(direction: 1|-1) => void} [handlers.onChapter]    上一章 / 下一章
 */
export function bindEbookGestures(target, { onStep, onJump, onChapter }) {
  if (!target || target.__yuejianGesture) return () => {};
  target.__yuejianGesture = true;

  const isDoc = target.nodeType === 9;
  const view = isDoc ? target.defaultView : null;

  const width = () => (isDoc ? view?.innerWidth || 0 : target.getBoundingClientRect().width);
  const left = () => (isDoc ? 0 : target.getBoundingClientRect().left);

  /* ---------------- 点击半屏 ---------------- */
  const onClick = (event) => {
    if (event.button !== 0) return;
    if (event.target.closest?.("a[href], button, input, textarea, select")) return;
    const selection = (isDoc ? view : window)?.getSelection?.();
    if (selection && String(selection).trim()) return;
    const span = width();
    if (!span) return;
    const x = (event.clientX - left()) / span;
    if (x < EDGE_RATIO) onStep(-1);
    else if (x > 1 - EDGE_RATIO) onStep(1);
  };

  /* ---------------- 滚轮 / 触控板 ---------------- */
  let accum = 0;
  let cooledAt = 0;
  const onWheel = (event) => {
    // Ctrl+滚轮是缩放语义，别拿去翻页；横向滚动交给触控板自己
    if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    // 分页排版里没有「滚动」这件事，不拦下来只会让 iframe 自己抖一下
    event.preventDefault();
    accum += event.deltaY;
    if (Math.abs(accum) < WHEEL_THRESHOLD) return;
    const now = Date.now();
    if (now - cooledAt < WHEEL_COOLDOWN) {
      accum = 0;
      return;
    }
    const direction = accum > 0 ? 1 : -1;
    accum = 0;
    cooledAt = now;
    onStep(direction);
  };

  /* ---------------- 键盘 ---------------- */
  const onKeyDown = (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) {
      // Ctrl+←/→ 跳章，与目录里的「上一章 / 下一章」等价
      if (event.ctrlKey && onChapter && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        onChapter(event.key === "ArrowRight" ? 1 : -1);
      }
      return;
    }
    const next = ["ArrowRight", "ArrowDown", "PageDown", " "].includes(event.key);
    const prev = ["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(event.key);
    if (next || prev) {
      // 空格在正文里默认滚动一屏，不拦就会和翻页叠成两页
      event.preventDefault();
      onStep(next ? 1 : -1);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      onJump?.(event.key === "Home" ? "start" : "end");
    }
  };

  target.addEventListener("click", onClick);
  target.addEventListener("wheel", onWheel, { passive: false });
  target.addEventListener("keydown", onKeyDown);
  return () => {
    target.removeEventListener("click", onClick);
    target.removeEventListener("wheel", onWheel);
    target.removeEventListener("keydown", onKeyDown);
    target.__yuejianGesture = false;
  };
}
