/**
 * 书签：加 / 删当前页，以及当前页是否已加。
 *
 * 只存 CFI（见 `store::Bookmark`）。这里刻意不持有 DOM 也不渲染列表——
 * 列表在侧栏（`ctx.js`），按钮状态在工具栏（读 `state.ebookMarked`），
 * 三者靠 `state` 与 `Book.bookmarks` 这一份数据对齐，谁也不直接改别人的界面。
 */
import { invoke } from "../api.js";
import { t } from "../i18n.js";
import { toast } from "../core/feedback.js";
import { applyBook } from "./book-state.js";

/** 当前页的 CFI；还没定位到时为空串 */
function currentCfi(pane) {
  return pane?.ebook?.location?.cfi || "";
}

function isBookmarked(pane) {
  const cfi = currentCfi(pane);
  if (!cfi) return false;
  return (pane.book?.bookmarks || []).some((mark) => mark.cfi === cfi);
}

/** 加 / 删书签；返回操作后的状态，界面据此刷新 */
async function toggleBookmark(pane) {
  const cfi = currentCfi(pane);
  const book = pane?.book;
  if (!book) return false;
  if (!cfi) {
    toast(t("reader.bookmarkNoPos"));
    return false;
  }
  const on = !isBookmarked(pane);
  try {
    const updated = await invoke("set_bookmark", {
      id: book.id,
      cfi,
      label: pane.ebook?.location?.label || book.title || "",
      on,
    });
    applyBook(updated);
    toast(on ? t("reader.bookmarkAdded") : t("reader.bookmarkRemoved"));
    return on;
  } catch (error) {
    toast(String(error));
    return !on;
  }
}

/** 删一条指定书签（侧栏列表用）；不依赖当前阅读位置 */
async function removeBookmark(pane, cfi) {
  const book = pane?.book;
  if (!book || !cfi) return false;
  try {
    const updated = await invoke("set_bookmark", { id: book.id, cfi, label: "", on: false });
    applyBook(updated);
    return true;
  } catch (error) {
    toast(String(error));
    return false;
  }
}

export { currentCfi, isBookmarked, toggleBookmark, removeBookmark };
