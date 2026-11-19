/**
 * 划线：颜色、落盘、以及往正文里画。
 *
 * 三个约束决定了它长这样：
 *
 * 1. **位置是 Range CFI**。电子书是流式排版，页码换个窗口就作废；`view.getCFI(index, range)`
 *    拿到的是指向「从哪个节点第几个字到哪」的路径，重排、换字号、换主题都不影响。
 * 2. **画在 overlayer 的 SVG 上**，不改书里的 DOM。往正文里插 `<mark>` 会动到分页器
 *    量出来的尺寸，一次划线就可能让整章重排；overlayer 是覆在章节 iframe 上的一层
 *    `pointer-events: none` 的 SVG，画什么都不参与布局。
 * 3. **颜色必须是字面量**。SVG 在书的 iframe 里，拿不到主文档的 CSS 变量，
 *    所以色板在这里写死一份——主题切换只影响书页底色，划线保持自己的颜色。
 */
import { invoke } from "../api.js";
import { toast } from "../core/feedback.js";
import { t } from "../i18n.js";
import { applyBook } from "./book-state.js";

/**
 * 五种笔色。与分类/书签共用一个色板的名字，但取的是**纸白底上能看清**的取值：
 * 划线要跟正文叠在一起，太深会盖住字，太浅又看不见。
 */
const HIGHLIGHT_COLORS = {
  amber: "#d8a13a",
  olive: "#7f9463",
  indigo: "#6a7bb8",
  plum: "#a5698b",
  ink: "#6b6155",
};

/** 工具栏与小窗里的顺序：常用的黄在第一格 */
const COLOR_ORDER = ["amber", "olive", "indigo", "plum", "ink"];

function colorOf(key) {
  return HIGHLIGHT_COLORS[key] ? key : "amber";
}

function colorValue(key) {
  return HIGHLIGHT_COLORS[colorOf(key)];
}

function listOf(pane) {
  return pane?.book?.highlights || [];
}

/** 一条划线的原文是否与当前选中/点击的那条相同（按 CFI 比） */
function find(pane, cfi) {
  return listOf(pane).find((item) => item.cfi === cfi) || null;
}

/**
 * 加一条划线。
 *
 * 原文截断到 400 字：侧栏只显示两三行，而一次误选整章（Ctrl+A）会把
 * state.json 撑大，也把列表挤满。
 */
async function addHighlight(pane, { cfi, text, color, label }) {
  const book = pane?.book;
  if (!book || !cfi) return null;
  try {
    const updated = await invoke("set_highlight", {
      id: book.id,
      cfi,
      text: String(text || "").replace(/\s+/g, " ").trim().slice(0, 400),
      color: colorOf(color),
      label: label || "",
      on: true,
    });
    applyBook(updated);
    repaint(pane);
    toast(t("reader.highlightAdded"));
    return find(pane, cfi);
  } catch (error) {
    toast(String(error));
    return null;
  }
}

/** 改一条划线的颜色。后端 `set_highlight` 对同一条是「更新」而不是「再加一条」 */
async function recolor(pane, cfi, color) {
  const book = pane?.book;
  const item = find(pane, cfi);
  if (!book || !item) return false;
  try {
    const updated = await invoke("set_highlight", {
      id: book.id,
      cfi,
      text: item.text || "",
      color: colorOf(color),
      label: item.label || "",
      on: true,
    });
    applyBook(updated);
    repaint(pane);
    return true;
  } catch (error) {
    toast(String(error));
    return false;
  }
}

async function removeHighlight(pane, cfi) {
  const book = pane?.book;
  if (!book || !cfi) return false;
  try {
    const updated = await invoke("set_highlight", { id: book.id, cfi, text: "", color: "", label: "", on: false });
    applyBook(updated);
    repaint(pane);
    return true;
  } catch (error) {
    toast(String(error));
    return false;
  }
}

/**
 * 把这本书的划线重新贴到阅读器上。
 *
 * 每次增删都整份重贴而不是增量补一条：`addAnnotation` 本身是幂等的
 * （overlayer 里同 key 先删再画），而增量的话「换章之后哪条还在」要自己记账。
 */
function repaint(pane) {
  pane?.ebook?.setHighlights(listOf(pane));
}

export { HIGHLIGHT_COLORS, COLOR_ORDER, colorOf, colorValue, listOf, find, addHighlight, removeHighlight, recolor };
