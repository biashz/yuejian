/**
 * 电子书的打开与阅读动作：打开、续读、翻页、跳章、版式、书内链接。
 *
 * 从 `open.js` 里拆出来，是因为这段的依赖面和 PDF/Markdown 完全不同：
 * 它要手势层、脚注弹层、书签、foliate 引擎四样东西，而 `open.js` 只管
 * 「按 kind 分派 + 把回调折成状态」。分开放之后两边都读得动。
 *
 * 状态写入的规矩和别处一样：位置变化只往 `pane` 与 `state` 写，
 * 落盘交给 `progress.scheduleSave()`（节流），谁都不在这里直接 invoke 存进度。
 */
import { activePane, activePaneIndex, maybeSync, updatePaneHeads, panes } from "./panes.js";
import { state } from "../core/session.js";
import { t } from "../i18n.js";
import { toast } from "../core/feedback.js";
import { escapeHtml } from "../core/dom.js";
import { updateStatus } from "../view.js";
import { persistSettings } from "../preferences.js";
import { EbookReader } from "../reader-epub.js";
import { flattenToc } from "./ebook-toc.js";
import { renderToolbar, updateToolbarPage } from "./toolbar.js";
import { renderCtx, markTocActive } from "./ctx.js";
import { scheduleSave } from "./progress.js";
import { updateDocSub } from "./open.js";
import { bindEbookGestures } from "./ebook-gesture.js";
import { showFootnote, hideFootnote } from "./footnote.js";
import { isBookmarked } from "./bookmarks.js";
import { buildEbookStyles } from "./ebook-style.js";
import { readLayout } from "./ebook-layout.js";
import { explainEbookError } from "./ebook-error.js";
import { closeHighlightMenu, highlightMenuAge } from "./highlight-menu.js";
import { openImage } from "./image-view.js";
import { askHighlight, pickAnnotation } from "./highlight-actions.js";

/**
 * 版式折成四个值：写进章节文档的 CSS（字号/行高/字体/对齐/缩进/段距/标点），
 * 以及三个归分页器管的页面参数（页边距 / 版心宽度 / 列间距）。
 *
 * 分开的理由见 `ebook-style.js` 的头注释：页面参数必须走属性，分页器自己拿它们
 * 算每栏宽度和翻页偏移，注入 CSS 去改会与它的分栏计算打架。
 */
function layoutValues() {
  const layout = readLayout(state.settings);
  return {
    css: buildEbookStyles(state.settings),
    layout: { margin: layout.margin, measure: layout.measure, gap: layout.gap },
  };
}

function ensureEbookReader(pane) {
  if (pane.ebook) return pane.ebook;
  pane.ebook = new EbookReader({
    stack: pane.ebookStack,
    spread: state.settings.ebookSpread !== false,
    onRelocate: (loc) => handleRelocate(pane, loc),
    // 每章渲染完就把手势挂上去：键盘与点击都发生在 iframe 里，主文档收不到
    onContent: (doc) => bindEbookGestures(doc, handlers(pane)),
    onEdge: (edge) => toast(t(edge === "end" ? "reader.ebookAtEnd" : "reader.ebookAtStart")),
    onLink: (detail) => followLink(pane, detail),
    // 点中已有的划线：库把它命中出来，这里决定是改色还是删掉
    onAnnotation: (detail) => pickAnnotation(pane, detail),
  });
  // 先存进实例：此刻还没有 `<foliate-view>`，等 `open()` 起完首帧再贴
  const { css, layout } = layoutValues();
  pane.ebook.applyLayout(css, layout);
  // 正文 iframe 之外的留白也要能点、能滚
  bindEbookGestures(pane.ebookStack, handlers(pane));
  return pane.ebook;
}

/**
 * 版式改动落到所有已打开的书上：左右两栏各有一份实例，谁都不该被落下。
 * 版式面板、主题切换都走这一个入口。
 *
 * @param {object} [options]
 * @param {boolean} [options.render] 是否立刻重排；拖动滑杆期间传 false，松手再补
 * @param {boolean} [options.live] 拖动中：跳过版心宽度——改它会让分页器整章重排，
 *   一次 `input` 一次重排会直接卡住；松手那一次才写进去
 */
function refreshEbookStyles({ render = true, live = false } = {}) {
  const { css, layout } = layoutValues();
  const values = live ? { margin: layout.margin, gap: layout.gap } : layout;
  for (const pane of panes) pane.ebook?.applyLayout(css, values, { render });
}

/** 手势动作统一走这里：主文档与 iframe 内用的是同一套 */
function handlers(pane) {
  return {
    onStep: (direction) => (direction > 0 ? pane.ebook?.next() : pane.ebook?.prev()),
    onJump: (where) => (where === "start" ? pane.ebook?.goTo(0) : pane.ebook?.goToFraction(1)),
    onChapter: (direction) => pane.ebook?.chapterStep(direction),
    onSelect: (range) => askHighlight(pane, range),
    onImage: (img) => openImage(img.currentSrc || img.src, img.alt || ""),
  };
}

/**
 * 书内链接：脚注弹小窗，其余照常跳转。
 *
 * 一律拦下默认行为再自己决定——`link` 事件是 cancelable 的，foliate 会看返回值
 * 决定要不要 `goTo`；而「是不是脚注」要读另一章的文档，是异步的，
 * 没法和这个事件同步地给出答案。
 */
async function followLink(pane, detail) {
  const href = detail?.href || "";
  const anchorEl = detail?.a;
  const note = await pane.ebook?.footnote(href);
  if (!note) {
    if (href) pane.ebook?.goTo(href);
    return;
  }
  showFootnote({ anchor: linkPosition(pane, anchorEl), text: note.text, label: state.ebookLabel });
}

/** 注号在视口里的位置：iframe 内的坐标要加上 iframe 自己的偏移 */
function linkPosition(pane, el) {
  const frameRect = el?.ownerDocument?.defaultView?.frameElement?.getBoundingClientRect?.();
  const rect = el?.getBoundingClientRect?.();
  const box = pane.ebookStack.getBoundingClientRect();
  const point = rect && frameRect
    ? { x: frameRect.left + rect.left + rect.width / 2, y: frameRect.top + rect.bottom }
    : null;
  // 注号可能不在当前这一页：分页排版把整章摊成很宽的一条，别的页的元素坐标仍然
  // 「有效」，只是落在可视区之外。硬按它定位会把弹层贴到屏幕角落，所以先判断
  // 这个点是否真的在当前阅读区里，不在就退回阅读区底部居中
  const visible = point
    && point.x > box.left + 8 && point.x < box.right - 8
    && point.y > box.top && point.y < box.bottom - 8;
  // 退回到阅读区底部，但要让到浮动工具栏上方：工具栏是 absolute 定位的，
  // 被弹层盖住会把翻页与进度条一起挡掉，比弹层位置偏一点糟糕得多
  if (!visible) {
    const toolTop = document.querySelector("#readToolbar")?.getBoundingClientRect?.().top;
    const limit = toolTop ? toolTop - 12 : box.top + box.height - 40;
    return { x: box.left + box.width / 2, y: limit };
  }
  return point;
}

async function openEbook(doc, pane) {
  const reader = ensureEbookReader(pane);
  const active = pane.index === activePaneIndex;
  if (active) {
    state.ebookLabel = "";
    state.ebookHref = "";
    state.ebookFraction = 0;
    state.ebookMarked = false;
    renderToolbar();
    renderCtx();
    updateDocSub();
  }

  // 续读位置只认 CFI；ratio 是给书架进度条看的，用它反算章节会偏
  const cfi = pane.book?.progress?.cfi || "";
  try {
    await reader.open(doc.path, {
      size: doc.size || 0,
      cfi,
      name: pane.book?.path?.split(/[\\/]/).pop() || "",
    });
    // 漫画的目录条目就是图片文件名（page-1.png），换成人读的页码
    pane.ebookToc = flattenToc(reader.book?.toc).map((item, index, all) => (
      reader.format === "cbz" && all.length === (reader.book?.sections?.length || 0)
        ? { ...item, label: t("reader.ebookPage", { n: index + 1 }) }
        : item
    ));
    // 划线在打开之后贴：`setHighlights` 要等首帧把 overlayer 建出来
    reader.setHighlights(pane.book?.highlights || []);
    // 书里的元数据比文件名可靠：书名、作者都在 OPF 里，书架当初只拿到了文件名
    const meta = reader.book?.metadata;
    if (meta?.title && pane.book) pane.book.title = String(meta.title);
    if (meta?.author && pane.book && meta.author !== "本地文档") pane.book.author = String(meta.author);
  } catch (error) {
    // 解析器的原话是给开发者看的（英文 + 类名），这里折成「不支持 / 文件不完整」两句
    const reason = explainEbookError(error, pane.ebook?.format, t);
    pane.ebookStack.innerHTML = `<div class="pdf-error">${t("reader.ebookErrorTitle")}<br><small>${escapeHtml(reason)}</small></div>`;
    pane.ebookStack.hidden = false;
    toast(t("reader.ebookErrorToast"));
  }

  if (pane.index === activePaneIndex) {
    state.ebookMarked = isBookmarked(pane);
    renderToolbar();
    renderCtx();
    updateDocSub();
    updateStatus();
  }
}

/** 位置变化：写进度、更新状态栏与目录高亮，并按节流落盘 */
function handleRelocate(pane, loc) {
  pane.ratio = loc.fraction;
  pane.page = 0;
  pane.ebookLabel = loc.label;
  if (pane.book) {
    pane.book.progress = { ratio: loc.fraction, page: 0, zoom: 1, cfi: loc.cfi };
  }
  updatePaneHeads();
  // 脚注窗锚在旧位置，翻页之后留着就是错的
  hideFootnote();
  // 色板同理，但刚摆上的那一个不能收：从侧栏点过来时，库是先导航再派发「命中」，
  // 导航引起的这次 relocate 往往比命中回调晚一帧，照收就是「刚摆上就没了」
  if (highlightMenuAge() > 300) closeHighlightMenu();
  if (pane.index !== activePaneIndex) return;

  state.ebookLabel = loc.label;
  state.ebookHref = loc.href;
  state.ebookFraction = loc.fraction;
  state.ebookMarked = isBookmarked(pane);
  markTocActive();
  updateDocSub();
  updateStatus();
  updateToolbarPage();
  scheduleSave();
  maybeSync(pane, { page: 0, ratio: loc.fraction });
}

/** 键盘与点击翻页：两栏各自翻自己那本 */
function ebookStep(step) {
  const pane = activePane();
  if (!pane?.ebook) return;
  if (step > 0) pane.ebook.next();
  else pane.ebook.prev();
}

/** 进度条跳转：0–1 的比例 */
function ebookSeek(fraction) {
  activePane()?.ebook?.goToFraction(fraction);
}

/** 上一章 / 下一章（Ctrl+←/→ 与工具栏都用它） */
function ebookChapter(step) {
  activePane()?.ebook?.chapterStep(step);
}

/**
 * 单页 / 双页切换。
 *
 * 是全局偏好而不是每本书一份：同一个人读不同的书，版式习惯不会变；
 * 反过来「这本双页那本单页」只会让人每次打开都要重设一次。
 * 窗口窄的时候分页器自己会降成单页，不改这个值。
 */
function toggleEbookSpread() {
  const spread = !(state.settings.ebookSpread !== false);
  state.settings.ebookSpread = spread;
  activePane()?.ebook?.setSpread(spread);
  persistSettings();
  renderToolbar();
  toast(t(spread ? "reader.ebookSpreadOn" : "reader.ebookSpreadOff"));
}

export { openEbook, ebookStep, ebookSeek, ebookChapter, toggleEbookSpread, refreshEbookStyles };
