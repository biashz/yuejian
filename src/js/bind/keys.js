/**
 * 键盘与退出：演示态按键、全局快捷键、命令面板与设置面板的方向键接管，
 * 以及窗口卸载前的进度落盘。
 */
import { $ } from "../core/dom.js";
import { state } from "../core/session.js";
import { activeReader, splitMode, setSplit } from "../reader/panes.js";
import { setView } from "../view.js";
import { closeSettings, toggleZen } from "../preferences.js";
import { goPage, setZoom, setZoomMenu, zoomMenuOpen, zoomByStep } from "../reader/toolbar.js";
import { setCtxOpen } from "../reader/ctx.js";
import { presenting, enterPresent, exitPresent, presentStep } from "../reader/present.js";
import { importDocuments } from "../actions.js";
import { openPalette, closePalette, paletteItems, renderPalette, runPalette } from "../palette.js";
import { flushProgress } from "../reader/progress.js";

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
      else if (paletteOpen) closePalette();
      else if (settingsOpen) closeSettings();
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
    if (document.activeElement?.tagName === "INPUT") return;

    if (event.key === "ArrowRight" && state.current?.kind === "pdf") {
      event.preventDefault();
      goPage(state.pdfPage + 1);
    }
    if (event.key === "ArrowLeft" && state.current?.kind === "pdf") {
      event.preventDefault();
      goPage(state.pdfPage - 1);
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
