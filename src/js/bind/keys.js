/**
 * 键盘与退出：演示态按键、全局快捷键、命令面板与设置面板的方向键接管，
 * 以及窗口卸载前的进度落盘。
 */
import { $ } from "../core/dom.js";
import { state } from "../core/session.js";
import { activePane, activeReader, splitMode, setSplit } from "../reader/panes.js";
import { setView } from "../view.js";
import { closeSettings, toggleZen } from "../preferences.js";
import { goPage, setZoom, setZoomMenu, zoomMenuOpen, zoomByStep, renderToolbar } from "../reader/toolbar.js";
import { docMenuOpen, setDocMenu } from "../reader/doc-menu.js";
import { printDoc } from "../reader/doc-print.js";
import { setCtxOpen, renderCtx } from "../reader/ctx.js";
import { presenting, enterPresent, exitPresent, presentStep } from "../reader/present.js";
import { importDocuments } from "../actions.js";
import { openPalette, closePalette, paletteItems, renderPalette, runPalette } from "../palette.js";
import { flushProgress } from "../reader/progress.js";
import { ebookStep, ebookChapter, toggleEbookFlow } from "../reader/ebook-open.js";
import { assistOf, toggleTts, toggleAuto, stopAssist, pauseResumeAssist, stepAssist } from "../reader/ebook-assist.js";
import { isScroll } from "../reader/ebook-mode.js";
import { setLayoutPanel } from "../reader/ebook-layout-panel.js";
import { toggleBookmark } from "../reader/bookmarks.js";

export function bindKeyEvents() {
  // 键盘
  document.addEventListener("keydown", (event) => {
    const paletteOpen = !$("#paletteOverlay").hidden;
    const settingsOpen = !$("#settingsOverlay").hidden;
    const modifier = event.ctrlKey || event.metaKey;

    // 演示模式：只认翻页与退出，屏蔽其它快捷键
    if (presenting) {
      event.preventDefault();
      if (event.key === "Escape" || event.key === "F5") exitPresent();
      else if (["ArrowRight", "ArrowDown", "PageDown", " ", "Spacebar", "Enter"].includes(event.key)) presentStep(1);
      else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(event.key)) presentStep(-1);
      else if (event.key === "Home") presentStep(1 - presentPage);
      else if (event.key === "End") presentStep((activeReader()?.numPages || 0) - presentPage);
      return;
    }

    if (modifier && event.key.toLowerCase() === "k") {
      event.preventDefault();
      paletteOpen ? closePalette() : openPalette();
      return;
    }
    if (modifier && event.key.toLowerCase() === "o") {
      event.preventDefault();
      importDocuments();
      return;
    }
    // F5 进入演示（避免 WebView 刷新整个界面）
    if (event.key === "F5") {
      event.preventDefault();
      enterPresent();
      return;
    }
    if (event.key === "Escape") {
      if (zoomMenuOpen) setZoomMenu(false);
      else if (docMenuOpen) setDocMenu(false);
      else if (paletteOpen) closePalette();
      else if (settingsOpen) closeSettings();
      // 辅助条（朗读 / 自动）先于版式面板收：Esc 先停「正在自己走」的东西。
      // 只看 kind：条停了但 assist 记录还在（关书才撤），拿 assistOf 判会让 Esc 永远出不了阅读视图
      else if (assistOf(activePane())?.kind) stopAssist(activePane());
      // 版式面板在「退出阅读」之前收：它是阅读视图里的一层，Esc 应该先关这一层
      else if (state.layoutOpen) setLayoutPanel(false);
      else if (state.view === "reading") setView("library");
      return;
    }
    if (paletteOpen) {
      const items = paletteItems($("#paletteInput").value);
      if (event.key === "ArrowDown") {
        event.preventDefault();
        state.paletteIndex = Math.min(items.length - 1, state.paletteIndex + 1);
        renderPalette($("#paletteInput").value);
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        state.paletteIndex = Math.max(0, state.paletteIndex - 1);
        renderPalette($("#paletteInput").value);
      }
      if (event.key === "Enter" && items[state.paletteIndex]) {
        event.preventDefault();
        runPalette(items[state.paletteIndex].run);
      }
      return;
    }
    if (settingsOpen) return;
    if (state.view !== "reading") return;
    const focusTag = document.activeElement?.tagName;
    if (focusTag === "INPUT" || focusTag === "SELECT" || focusTag === "TEXTAREA") return;

    // Ctrl+P：打印当前文档。只放在「阅读视图」之后判——在书架页按 Ctrl+P
    // 不该把书架的界面打印机出来，那和用户想印的文档没有关系
    if (modifier && event.key.toLowerCase() === "p") {
      event.preventDefault();
      printDoc(activePane());
      return;
    }
    if (event.key === "ArrowRight" && state.current?.kind === "pdf") {
      event.preventDefault();
      goPage(state.pdfPage + 1);
    }
    if (event.key === "ArrowLeft" && state.current?.kind === "pdf") {
      event.preventDefault();
      goPage(state.pdfPage - 1);
    }
    // 电子书：←/→ 与空格翻页。页码是排版算出来的，所以只认「上一页 / 下一页」
    if (state.current?.kind === "ebook") {
      const pane = activePane();
      // Shift+J/L/A：姿势 / 朗读 / 自动三个开关，与工具栏按钮同一入口
      if (event.shiftKey && !modifier) {
        const key = event.key.toLowerCase();
        if (key === "j" || key === "l" || key === "a") {
          event.preventDefault();
          if (key === "j") toggleEbookFlow();
          else if (key === "l") toggleTts(pane);
          else toggleAuto(pane);
          return;
        }
      }
      // 辅助运行中：Space 播放/暂停，Ctrl+[ / ] 上一句/下一句
      if (event.key === " " && pauseResumeAssist(pane)) {
        event.preventDefault();
        return;
      }
      if (modifier && (event.key === "[" || event.key === "]")) {
        if (stepAssist(pane, event.key === "]" ? 1 : -1)) {
          event.preventDefault();
          return;
        }
      }
      // Ctrl+←/→ 跳章、Home/End 到书首书尾：两种姿势通用
      if (modifier && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        ebookChapter(event.key === "ArrowRight" ? 1 : -1);
        return;
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        stopAssist(pane);
        pane?.ebook?.[event.key === "Home" ? "goTo" : "goToFraction"](event.key === "Home" ? 0 : 1);
        return;
      }
      // 滚动模式：纵向键交给浏览器原生滚动，←/→ 保留为跳章
      if (isScroll(pane?.ebook)) {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          ebookChapter(event.key === "ArrowRight" ? 1 : -1);
        }
        return;
      }
      const nextKey = ["ArrowRight", "ArrowDown", "PageDown", " "].includes(event.key);
      const prevKey = ["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(event.key);
      if (nextKey || prevKey) {
        event.preventDefault();
        ebookStep(nextKey ? 1 : -1);
        return;
      }
    }
    // Ctrl+M：给当前页加 / 删书签（M 记 bookmark 不好记，但 B 已经被目录面板占了）
    if (modifier && event.key.toLowerCase() === "m" && state.current?.kind === "ebook") {
      event.preventDefault();
      const pane = activePane();
      toggleBookmark(pane).then((marked) => {
        state.ebookMarked = marked;
        renderToolbar();
        if (state.ctxTab === "marks") renderCtx();
      }).catch(() => {});
      return;
    }
    // 缩放：Ctrl +/- 按档位步进，Ctrl+0 回到 100%；不带修饰键的 +/- 同样可用
    if (modifier && (event.key === "+" || event.key === "=" || event.key === "-")) {
      event.preventDefault();
      zoomByStep(event.key === "-" ? -1 : 1);
      return;
    }
    if (modifier && event.key === "0") {
      event.preventDefault();
      setZoom(1);
      return;
    }
    if ((event.key === "+" || event.key === "=") && state.current?.kind === "pdf") {
      event.preventDefault();
      zoomByStep(1);
    }
    if (event.key === "-" && state.current?.kind === "pdf") {
      event.preventDefault();
      zoomByStep(-1);
    }
    if (modifier && event.key.toLowerCase() === "b") {
      event.preventDefault();
      setCtxOpen(!state.ctxOpen);
      renderToolbar();
    }
    // Ctrl+\ 拆分 / 合并双栏
    if (modifier && event.key === "\\") {
      event.preventDefault();
      setSplit(!splitMode);
    }
    if (modifier && event.key.toLowerCase() === "d") {
      event.preventDefault();
      toggleZen();
    }
  });

  window.addEventListener("beforeunload", flushProgress);
}
