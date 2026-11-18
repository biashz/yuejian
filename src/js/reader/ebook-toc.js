/**
 * 目录（EPUB 的 NAV / NCX）折算。
 *
 * 书的目录天生是嵌套的：部、卷、章、节。但应用里所有用到目录的地方——侧栏列表、
 * 章跳转、「当前在第几章」——要的都是一条能按下标走的直线。层级用 `level` 带出去，
 * 缩进与高亮交给渲染层，比在这里拼一棵 DOM 树干净。
 */

/** 目录项总数（含子项）；`book.toc` 是嵌套结构 */
function countChapters(items, depth = 0) {
  if (!Array.isArray(items) || depth > 8) return 0;
  return items.reduce((sum, item) => sum + 1 + countChapters(item.subitems, depth + 1), 0);
}

/** 拍平成侧栏能用的列表：`{label, href, level}` */
function flattenToc(items, depth = 0, out = []) {
  if (!Array.isArray(items) || depth > 8) return out;
  for (const item of items) {
    if (item?.label && item?.href) out.push({ label: item.label, href: item.href, level: depth });
    if (item?.subitems?.length) flattenToc(item.subitems, depth + 1, out);
  }
  return out;
}

export { flattenToc, countChapters };
