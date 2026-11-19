/**
 * 跨书检索：把「每本书里命中了什么」统一成同一个形状，交给书架渲染。
 *
 * 两条完全不同的取数路径：
 * - 文本 / Markdown / CSV / 代码 → Rust `search_text`，按行流式扫，不必先建全文副本；
 * - PDF / 电子书 → 先取索引（`library-index.js`），再在单元里找子串。
 *
 * 对上层只暴露一种结果：`{ book, hits: [{ label, page, line, href, pre, hit, post }] }`。
 * 界面因此不需要知道哪本书走的是哪条路。
 *
 * `page` / `line` / `href` 是定位信息，三选一有效：PDF 有页码、文本有行号、
 * 电子书有章节 href。点命中时按书的类型挑一个用，谁有就用谁。
 *
 * 抗抖动的前提是「结果可作废」：输入框每敲一下都会发起一轮，慢的那轮可能后到。
 * 调用方传 `token`，每完成一本书就查一次 `cancelled`，一旦作废立刻停手——
 * 不做这件事，用户会在几轮搜索之后看到上一个关键词的结果。
 */
import { invoke } from "./api.js";
import { t } from "./i18n.js";
import { ensureIndex, needsIndex } from "./library-index.js";

/** 少于两个字符不搜正文：单字在几十本书里能命中上千处，既慢又没有信息量 */
const MIN_QUERY = 2;
/** 一本书最多显示几条命中；再多就把别处挤没了 */
const PER_BOOK = 5;
/** 最多列出几本有命中的书 */
const MAX_BOOKS = 8;
/** 片段前后各留多少字符 */
const PRE = 34;
const POST = 56;

/** 文本类走 Rust 按行扫，命中带行号 */
function searchPlain(book, query, token) {
  return invoke("search_text", { path: book.path, query, limit: PER_BOOK })
    .then((lines) => (token.cancelled ? [] : lines.map((line) => ({
      label: t("reader.findLine", { line: line.line }),
      page: 0,
      // 行号带着走：点命中时可以直接滚到那一行，不必再让侧栏搜一遍
      line: Number(line.line) || 0,
      href: "",
      ...snippet(line.text, query),
    }))))
    // 单本书读失败（文件被删、编码崩）不该让整轮检索失败
    .catch(() => []);
}

/** 在索引单元里找子串 */
function searchIndexed(index, query, token) {
  const needle = query.toLowerCase();
  const hits = [];
  for (const unit of index.units || []) {
    if (token.cancelled) return [];
    const at = String(unit.text || "").toLowerCase().indexOf(needle);
    if (at < 0) continue;
    hits.push({
      label: unit.label || "",
      page: Number(unit.page) || 0,
      line: 0,
      // 电子书的章节 href 是跳转依据：有它才能落到那一节，而不是只把关键词填进搜索
      href: unit.href || "",
      ...snippet(unit.text, query, at),
    });
    if (hits.length >= PER_BOOK) break;
  }
  return hits;
}

/** 命中处的三段切片：界面不必再做正则，也就不会因为转义顺序出错 */
function snippet(text, query, at = -1) {
  const source = String(text || "");
  const needle = String(query || "").toLowerCase();
  const index = at >= 0 ? at : source.toLowerCase().indexOf(needle);
  if (index < 0) return { pre: source.slice(0, POST), hit: "", post: "" };
  const start = Math.max(0, index - PRE);
  const end = Math.min(source.length, index + needle.length + POST);
  return {
    pre: (start > 0 ? "…" : "") + source.slice(start, index),
    hit: source.slice(index, index + needle.length),
    post: source.slice(index + needle.length, end) + (end < source.length ? "…" : ""),
  };
}

/**
 * 跑一轮跨书检索。
 *
 * 顺序扫而不是并发：真正慢的是 PDF / 电子书的索引重建，并发只会同时开几个
 * pdf.js worker 抢 CPU；文本类的 IPC 单次也就几毫秒，串行完全够。
 *
 * `onProgress` 每开始一本书报一次，用于在界面上说清「为什么还没结果」。
 */
async function searchLibrary({ query, books, onProgress, token = { cancelled: false } }) {
  const keyword = String(query || "").trim();
  const empty = { query: keyword, groups: [], total: 0, skipped: 0 };
  if (keyword.length < MIN_QUERY) return empty;

  const candidates = (books || []).filter((book) => book?.path);
  const groups = [];
  let total = 0;
  let skipped = 0;

  for (let i = 0; i < candidates.length; i += 1) {
    if (token.cancelled) break;
    const book = candidates[i];
    onProgress?.({ done: i, total: candidates.length, title: book.title });

    let hits = [];
    try {
      if (needsIndex(book)) {
        const index = await ensureIndex(book, {
          token,
          onProgress: (fraction) => onProgress?.({
            done: i, total: candidates.length, title: book.title, building: fraction,
          }),
        });
        if (!index) continue;
        hits = searchIndexed(index, keyword, token);
      } else if (book.kind === "text" || book.kind === "markdown") {
        hits = await searchPlain(book, keyword, token);
      } else {
        // 不认识的类型：跳过并计数，界面上说明「有几本没参与」而不是假装搜过了
        skipped += 1;
      }
    } catch {
      // 单本书打不开（DRM、文件被删、PDF 结构坏）只跳过它自己。
      // 让整轮检索失败的话，书架里一本坏书就能让其余几十本都搜不了
      skipped += 1;
      continue;
    }

    if (token.cancelled) break;
    if (!hits.length) continue;
    total += hits.length;
    groups.push({ book, hits });
    if (groups.length >= MAX_BOOKS) break;
  }

  return { query: keyword, groups, total, skipped, cancelled: Boolean(token.cancelled) };
}

export { searchLibrary, searchIndexed, snippet, MIN_QUERY, PER_BOOK, MAX_BOOKS };
