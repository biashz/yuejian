/**
 * 阅读姿势与翻页动效：分页 ↔ 连续滚动、滑动 / 淡入 / 无。
 *
 * 三件事都落在 vendored 分页器已有的公共口上，不重写渲染：
 * 1. `flow="scrolled"` 是 observed attribute，改它分页器自己重排成纵向单栏；
 * 2. `animated` 属性存在时翻页位移走引擎自带的 300ms 动画（「滑动」档）；
 * 3. 滚动模式的章间连接听 renderer 的 `scroll` 事件，用公共 getter
 *    `start / end / viewSize` 判边——shadow root 是 closed 的，容器摸不到，
 *    但这几个 getter 就是为外面留的。
 *
 * 「淡入」是宿主补的：引擎没有透明度档，自己在 relocate(reason=page) 时
 * 对阅读区做一次 opacity 脉冲。只动画 opacity 不位移——位移会和分页器的
 * 列偏移打架，看起来像页面抖了两下。
 */

/** 判边容差：与分页器内部 `#turnPage` 的 2px 同一口径 */
const EDGE = 2;
/** 接章冷却：换章落地会再派一次 scroll（start=0），不冷却就会立刻弹回上一章 */
const EDGE_COOLDOWN = 600;

const flowOf = (settings) => (settings?.ebookFlow === "scroll" ? "scroll" : "paged");

/** reduce-motion 时三档一律表现为 none；设置值照存，关掉系统偏好就恢复 */
const turnOf = (settings) => {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return "none";
  const value = settings?.ebookTurn;
  return ["slide", "fade", "none"].includes(value) ? value : "slide";
};

const ready = (reader) => Boolean(reader?.view?.renderer?.getContents?.()?.[0]?.doc?.body);

/**
 * 把设置里的姿势 / 动效贴到一本书上。打开书后与切换设置时都走这里。
 * 钩子（fade 脉冲、滚动判边）每次重挂：renderer 随 `<foliate-view>` 重建，
 * 旧钩子挂在旧元素上，不摘也不会触发，但摘掉免得闭包留着旧 reader 状态。
 */
function applyReadingMode(reader, settings) {
  const renderer = reader?.view?.renderer;
  if (!renderer || !ready(reader)) return;
  reader.__modeDispose?.();
  const disposers = [];
  const flow = flowOf(settings);
  const turn = turnOf(settings);

  renderer.setAttribute("flow", flow === "scroll" ? "scrolled" : "paginated");
  if (flow === "paged" && turn === "slide") renderer.setAttribute("animated", "");
  else renderer.removeAttribute("animated");

  if (flow === "paged" && turn === "fade") {
    const onRelocate = (event) => {
      if (event.detail?.reason !== "page") return;
      reader.stack.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: "cubic-bezier(.22,.8,.24,1)" });
    };
    reader.view.addEventListener("relocate", onRelocate);
    disposers.push(() => reader.view?.removeEventListener("relocate", onRelocate));
  }

  if (flow === "scroll") {
    let cooledAt = 0;
    const onScroll = () => {
      const now = Date.now();
      if (now - cooledAt < EDGE_COOLDOWN) return;
      const atEnd = renderer.viewSize - renderer.end <= EDGE;
      const atStart = renderer.start <= EDGE;
      if (!atEnd && !atStart) return;
      cooledAt = now;
      // 到边才调，调完由分页器自己接章。全书首尾要先问 atStart/atEnd：
      // 滚动姿势下分页器在首尾不是静默 no-op，会去加载不存在的邻节
      if (atEnd && !renderer.atEnd) reader.view.next();
      else if (atStart && !renderer.atStart) reader.view.prev();
    };
    renderer.addEventListener("scroll", onScroll);
    disposers.push(() => renderer.removeEventListener("scroll", onScroll));
  }

  reader.__modeDispose = () => disposers.forEach((run) => run());
}

/** 此刻是不是滚动模式（手势层 / 工具条 / 自动滚动都问它） */
const isScroll = (reader) => Boolean(reader?.view?.renderer?.scrolled);

/** 自动滚动的推进口：走分页器公共 scrollBy，边界与 RTL 都由它夹好 */
function scrollByPx(reader, px) {
  // scrollBy 取哪个轴看书写方向：横排取 dx、竖排取 dy。两轴同值，
  // 只传 (0, px) 会让横排书永远收到 0 增量，看起来就是「自动不动」
  reader?.view?.renderer?.scrollBy?.(px, px);
}

export { flowOf, turnOf, applyReadingMode, isScroll, scrollByPx };