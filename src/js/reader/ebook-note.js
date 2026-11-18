/**
 * 脚注解析：把书内 `#fragment` 链接的目标取成一段纯文本，交给弹层显示。
 *
 * 只在目标确实是「注」的时候返回内容，普通章节内跳转仍走正常 `goTo`——
 * 把每个 `#` 链接都当脚注弹窗，会让「跳到小节」这种导航变成一个个小窗，
 * 比整页跳走更烦人。
 *
 * 解析路径刻意不走 CFI：`book.resolveHref(href)` 已经给出了 spine 下标与
 * 「按 id 取节点」的函数，比 CFI 反解更直接，也不受排版影响。
 */

/**
 * @param {{ book: any, sectionDoc: (index: number) => Promise<Document|null> }} reader
 * @param {string} href 已由 foliate 解析成全书路径（形如 `OEBPS/ch1.xhtml#fn1`）
 * @returns {Promise<{ text: string, href: string } | null>}
 */
export async function resolveFootnote(reader, href) {
  const book = reader?.book;
  if (!book?.resolveHref || !href?.includes("#")) return null;

  let resolved;
  try {
    resolved = book.resolveHref(href);
  } catch (_) {
    return null;
  }
  if (!resolved || resolved.index == null || resolved.index < 0) return null;
  // 漫画这类书的 `resolveHref` 只回节下标，没有「按 id 取节点」这一步
  if (typeof resolved.anchor !== "function") return null;

  const doc = await reader.sectionDoc(resolved.index);
  if (!doc) return null;
  const el = resolved.anchor(doc);
  if (!el || el.nodeType !== 1) return null;
  if (!looksLikeNote(el)) return null;

  const text = noteText(el);
  return text ? { text, href } : null;
}

/**
 * 目标元素像不像一条「注」。
 *
 * 只认三种证据：`epub:type` 声明、`fn1` / `note-3` 这类 id、类名里的 footnote 词根。
 * 不按「文字很短」之类的猜测——正文小节也很短，猜错的代价是导航变成弹窗。
 */
function looksLikeNote(el) {
  const typeAttr = el.getAttribute?.("epub:type") || el.getAttribute?.("type") || "";
  if (/(footnote|endnote|rearnote)/i.test(typeAttr)) return true;
  const id = el.id || "";
  if (/^(fn|note|footnote|endnote|rearnote)[-_]?\d*$/i.test(id)) return true;
  const cls = typeof el.className === "string" ? el.className : "";
  return /(^|[\s_-])(footnote|endnote|rearnote)([\s_-]|$)/i.test(cls);
}

/** 取注文的纯文本：去掉返回箭头一类的回链，压缩空白，过长就截断 */
function noteText(el, limit = 1200) {
  const clone = el.cloneNode(true);
  for (const link of clone.querySelectorAll?.("a[href^='#']") || []) {
    // 只剩符号（↩ 1 ↑）的回链整条删掉，带正文的保留
    if (!link.textContent.replace(/[^\p{L}]/gu, "")) link.remove();
  }
  const text = String(clone.textContent || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export { looksLikeNote };
