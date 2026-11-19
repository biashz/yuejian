/**
 * 后端返回整本书之后，把它写回所有持有同一份数据的地方。
 *
 * `state.books`、`state.current` 与两栏的 `pane.book` 都指向同一个对象。
 * 替换引用会让某处悄悄留在旧对象上（收藏功能当初就踩过这个坑），所以一律就地合并。
 */
import { state } from "../core/session.js";

function applyBook(updated) {
  if (!updated?.id) return;
  const target = state.books.find((book) => book.id === updated.id);
  if (target) Object.assign(target, updated);
  if (state.current?.id === updated.id) Object.assign(state.current, updated);
}

export { applyBook };
