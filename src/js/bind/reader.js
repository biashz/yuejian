/**
 * 阅读视图的事件绑定：文档栏按钮、目录三个标签与跳转、阅读工具栏、
 * 缩放菜单的外部点击收起，以及演示模式的分辨率变化与全屏退出。
 */
import { $, $$, clamp } from "../core/dom.js";
import { state } from "../core/session.js";
import { SIZE_STEPS } from "../core/constants.js";
import { scrollToHeading } from "../reader-md.js";
import { activePane, splitMode, linkSync, setSplit, setLink, panes } from "../reader/panes.js";
import { setView, updateStatus } from "../view.js";
import { goPage, setZoom, setZoomMenu, zoomMenuOpen, zoomByStep, fitPdfPage, fitPdfWidth, renderToolbar } from "../reader/toolbar.js";
import { setCtxOpen, switchCtxTab, renderCtx } from "../reader/ctx.js";
import { listOf, removeHighlight } from "../reader/highlight.js";
import { refreshTextView, openBook } from "../reader/open.js";
import { ebookStep, ebookSeek, toggleEbookSpread } from "../reader/ebook-open.js";
import { toggleLayoutPanel } from "../reader/ebook-layout-panel.js";
import { toggleBookmark, removeBookmark } from "../reader/bookmarks.js";
import { exportMarks, copyMarks } from "../reader/marks-export.js";
import { scrollToLine } from "../reader-bigtext.js";
import { presenting, presentEntering, enterPresent, exitPresent, presentStep, handlePresentWheel, schedulePresentPaint } from "../reader/present.js";
import { applySettings, syncSettingsUI, persistSettings, toggleZen } from "../preferences.js";
import { toggleFavorite } from "../actions.js";

/**
 * 换一个编码重开当前文本。
 *
 * 走完整的 openBook 而不是就地重新解码：换编码会改变行数、字符数、是否走窗口
 * 模式、甚至表格的列数，所有派生状态都得重算，复用打开链路最省事也最难漏。
 */
function switchEncoding(encoding) {
  const pane = activePane();
  if (!pane?.book || pane.book.kind !== "text") return;
  // 选的就是当前项：不重开，免得白闪一下
  if ((pane.book.encoding || "") === encoding) return;
  const id = pane.book.id;
  openBook(id, pane, { encoding });
  // 分栏时另一栏若开着同一份文档，也得跟着换：否则同一个文件两栏两种解码，
  // 一栏已经正常、另一栏还是乱码，比整体乱码更难理解
  for (const other of panes) {
    if (other !== pane && other.book?.id === id) openBook(id, other, { encoding });
  }
}

export function bindReaderEvents() {
  // 文档栏
  $("#backBtn").addEventListener("click", () => setView("library"));
  $("#starBtn").addEventListener("click", () => state.current && toggleFavorite(state.current.id));
  $("#zenBtn").addEventListener("click", toggleZen);
  $("#presentBtn").addEventListener("click", enterPresent);
  // 点击右半屏下一页、左半屏上一页，方便鼠标/投屏笔操作
  $("#presentStage").addEventListener("click", (event) => {
    // 底部是提示与页码区域，不当作翻页
    if (event.clientY > window.innerHeight - 60) return;
    presentStep(event.clientX < window.innerWidth / 2 ? -1 : 1);
  });
  // 滚轮/触控板翻页：向下下一页、向上上一页
  $("#presentStage").addEventListener("wheel", handlePresentWheel, { passive: false });
  window.addEventListener("resize", () => {
    // 全屏切换会连续触发 resize：防抖后只重画最后一次的尺寸；
    // 全屏过渡期间先不画，等 fullscreen 的 promise 落地后再排首帧
    if (presenting && !presentEntering) schedulePresentPaint();
  });
  document.addEventListener("fullscreenchange", () => {
    // 用户按系统快捷键退出全屏时，同步退出演示（presenting 已复位则不会递归）
    if (presenting && !document.fullscreenElement) exitPresent();
  });
  $("#ctxBtn").addEventListener("click", () => {
    setCtxOpen(!state.ctxOpen);
    renderToolbar();
  });

  // 目录标签
  $("#ctxTabs").addEventListener("click", (event) => {
    const tab = event.target.closest(".ctx-tab");
    if (tab && !tab.hidden) switchCtxTab(tab.dataset.ctx);
  });

  // 目录 / 缩略图 / 搜索结果跳转
  $("#ctxBody").addEventListener("click", (event) => {
    // 编码菜单：先于跳转处理，菜单项没有 data-goto / data-hit
    const encToggle = event.target.closest("[data-enc-toggle]");
    if (encToggle) {
      const menu = $("#encMenu");
      if (menu) {
        menu.hidden = !menu.hidden;
        encToggle.setAttribute("aria-expanded", String(!menu.hidden));
      }
      return;
    }
    const encItem = event.target.closest("[data-enc]");
    if (encItem) {
      switchEncoding(encItem.dataset.enc);
      return;
    }
    const goto = event.target.closest("[data-goto]");
    if (goto) {
      if (goto.dataset.kind === "pdf") goPage(Number(goto.dataset.goto));
      else if (goto.dataset.kind === "ebook") activePane()?.ebook?.goTo(goto.dataset.goto);
      else if (activePane()) scrollToHeading(activePane().scrollArea, goto.dataset.goto);
      return;
    }
    // 摘录的两个出口。放在书签/划线的列表项之前判：这两个按钮是列表的兄弟
    // 节点而不是列表项内部，顺序其实无妨，但先判「页级动作」更符合阅读顺序
    if (event.target.closest("[data-export-marks]")) {
      exportMarks();
      return;
    }
    if (event.target.closest("[data-copy-marks]")) {
      copyMarks();
      return;
    }
    // 书签：跳过去 / 删掉。两者是兄弟节点，先判删除，免得被上一条抢走
    const unmark = event.target.closest("[data-unmark]");
    if (unmark) {
      const pane = activePane();
      const mark = pane?.book?.bookmarks?.[Number(unmark.dataset.unmark)];
      if (mark) removeBookmark(pane, mark.cfi).then(() => renderCtx()).catch(() => {});
      return;
    }
    const unnote = event.target.closest("[data-unnote]");
    if (unnote) {
      const pane = activePane();
      // 列表是倒序渲染的，按下标取不到——用渲染时的顺序反推
      const notes = [...listOf(pane)].reverse();
      const note = notes[Number(unnote.dataset.unnote)];
      if (note) removeHighlight(pane, note.cfi).then(() => renderCtx()).catch(() => {});
      return;
    }
    const noteHit = event.target.closest("[data-note-hit]");
    if (noteHit) {
      const pane = activePane();
      const notes = [...listOf(pane)].reverse();
      const note = notes[Number(noteHit.dataset.noteHit)];
      // 跳过去并把它标出来：一屏上可能有好几处划线，光「跳到了」分不出是哪一条
      if (note) pane?.ebook?.showAnnotation?.(note);
      return;
    }
    const markHit = event.target.closest("[data-mark-hit]");
    if (markHit) {
      const pane = activePane();
      const mark = pane?.book?.bookmarks?.[Number(markHit.dataset.markHit)];
      if (mark) pane?.ebook?.goTo(mark.cfi);
      return;
    }
    const hit = event.target.closest("[data-hit]");
    if (hit) {
      if (hit.dataset.kind === "pdf") goPage(Number(hit.dataset.page));
      else if (hit.dataset.kind === "ebook") {
        // 电子书的命中带的是 CFI：按它跳过去，位置与排版无关
        const pane = activePane();
        const item = pane?.hits[Number(hit.dataset.hit)];
        if (item?.cfi) pane?.ebook?.goTo(item.cfi);
      } else if (hit.dataset.kind === "line") {
        // 大文件的命中只有行号，没有 DOM 节点可量，直接按行高算位置
        const pane = activePane();
        const item = pane?.hits[Number(hit.dataset.hit)];
        if (item && pane) scrollToLine(pane, item.line);
      } else {
        const pane = activePane();
        const node = pane?.hits[Number(hit.dataset.hit)];
        if (node && pane) {
          const area = pane.scrollArea;
          const offset = node.getBoundingClientRect().top - area.getBoundingClientRect().top;
          area.scrollTo({ top: area.scrollTop + offset - 80, behavior: "smooth" });
        }
      }
    }
  });

  // 阅读工具栏
  $("#readToolbar").addEventListener("click", (event) => {
    // 缩放菜单里的选项先于 [data-act] 处理（菜单项没有 data-act）
    const preset = event.target.closest("[data-zoom]");
    if (preset) {
      setZoom(Number(preset.dataset.zoom));
      setZoomMenu(false);
      return;
    }
    if (event.target.closest("[data-fit-width]")) {
      fitPdfWidth();
      setZoomMenu(false);
      return;
    }
    if (event.target.closest("[data-fit-zoom]")) {
      fitPdfPage();
      setZoomMenu(false);
      return;
    }
    const button = event.target.closest("[data-act]");
    if (!button) return;
    const act = button.dataset.act;
    const settings = state.settings;
    if (act === "prev") goPage(state.pdfPage - 1);
    if (act === "next") goPage(state.pdfPage + 1);
    if (act === "ebook-prev") ebookStep(-1);
    if (act === "ebook-next") ebookStep(1);
    if (act === "ebook-spread") toggleEbookSpread();
    if (act === "ebook-layout") toggleLayoutPanel();
    if (act === "ebook-mark") {
      const pane = activePane();
      toggleBookmark(pane).then((marked) => {
        state.ebookMarked = marked;
        renderToolbar();
        // 侧栏正开着书签列表时要立刻反映出来
        if (state.ctxTab === "marks") renderCtx();
      }).catch(() => {});
    }
    if (act === "zoom-in") zoomByStep(1);
    if (act === "zoom-out") zoomByStep(-1);
    if (act === "zoom-menu") setZoomMenu(!zoomMenuOpen);
    if (act === "ctx") {
      setCtxOpen(!state.ctxOpen);
      renderToolbar();
    }
    if (act === "split") setSplit(!splitMode);
    if (act === "link") setLink(!linkSync);
    if (act === "present") enterPresent();
    if (act === "font-up" || act === "font-down") {
      const index = SIZE_STEPS.indexOf(settings.fontSize);
      const nextIndex = clamp((index < 0 ? 1 : index) + (act === "font-up" ? 1 : -1), 0, SIZE_STEPS.length - 1);
      settings.fontSize = SIZE_STEPS[nextIndex];
      applySettings();
      syncSettingsUI();
      renderToolbar();
      updateStatus();
      persistSettings();
    }
    if (act === "lh") {
      settings.lineHeight = settings.lineHeight === 1.7 ? 1.9 : settings.lineHeight === 1.9 ? 2.1 : 1.7;
      applySettings();
      syncSettingsUI();
      renderToolbar();
      updateStatus();
      persistSettings();
    }
    if (act === "measure") {
      settings.measure = settings.measure === 620 ? 720 : settings.measure === 720 ? 820 : 620;
      applySettings();
      syncSettingsUI();
      renderToolbar();
      persistSettings();
    }
    if (act === "text-plain" || act === "text-code" || act === "text-table") {
      const pane = activePane();
      if (pane?.textView) {
        const mode = act === "text-plain" ? "plain" : act === "text-code" ? "code" : "table";
        pane.textView.mode = mode;
        // 每种视图各有一套常用开关：正文不要行号、要软换行；等宽反过来；
        // 表格自带行号列，两个开关都不适用
        pane.textView.gutter = mode === "code";
        pane.textView.wrap = mode === "plain";
        // 三种视图的结构都不同，必须重绘
        refreshTextView(pane);
      }
    }
    if (act === "text-gutter" || act === "text-wrap") {
      const pane = activePane();
      if (pane?.textView) {
        const key = act === "text-gutter" ? "gutter" : "wrap";
        pane.textView[key] = !pane.textView[key];
        // 软换行与行号在等宽视图里是互斥的：一旦折行，一个逻辑行占多行，
        // 行号就不再与左侧行首对齐。打开软换行就关掉行号，避免屏幕看起来「坏了」
        if (key === "wrap" && pane.textView.wrap) pane.textView.gutter = false;
        // 只加删类名：重绘会丢掉算好的高亮，还会把滚动位置弹走
        refreshTextView(pane, { rerender: false });
      }
    }
  });

  $("#readToolbar").addEventListener("change", (event) => {
    if (event.target.id === "pageInput") goPage(Number(event.target.value) || 1);
    // 滑杆只在松手时跳：拖动过程中连续 goToFraction 会让分页器反复重排，卡得没法用
    if (event.target.id === "ebookSlider") ebookSeek(Number(event.target.value) / 1000);
  });

  // 拖动时先只更新数字，让人看得见落点在哪
  $("#readToolbar").addEventListener("input", (event) => {
    if (event.target.id !== "ebookSlider") return;
    const percent = $(".ebook-pct");
    const value = Number(event.target.value);
    if (percent) percent.textContent = `${Math.round(value / 10)}%`;
    event.target.style.setProperty("--_fill", `${Math.round(value / 10)}%`);
  });

  // 点工具栏以外的地方收起缩放比例菜单
  document.addEventListener("click", (event) => {
    if (zoomMenuOpen && !event.target.closest(".zoom-anchor")) setZoomMenu(false);
  });
}
