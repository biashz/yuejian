/**
 * 跨书检索的正文索引：只有 PDF 与电子书需要。
 *
 * 文本 / Markdown / CSV / 代码不在这里——它们的正文能按需解码，检索直接走 Rust 的
 * `search_text`（流式、按行索引，扫一份 100MB 日志也不必先存一份全文副本）。
 * 真正需要先抽出纯文本的只有两类：PDF 是压缩对象流，电子书是打包的 XHTML，
 * 而解它们要用的工具（pdf.js / foliate）都在前端，所以索引也在这里生成，
 * 再由 Rust 落盘到 `data/search/<id>.json`。
 *
 * 索引按「单元」存：PDF 一页一个单元，电子书一节一个单元。检索就是在这串单元里
 * 找子串——命中之后还知道落在第几页、哪一章，这是纯全文拼接做不到的。
 */
import { convertFileSrc, invoke } from "./api.js";
import { t } from "./i18n.js";
import * as pdfjsLib from "../vendor/pdfjs/pdf.mjs";
import { flattenToc } from "./reader/ebook-toc.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.mjs", import.meta.url).href;

/** 结构版本；改了单元形状就加一，旧缓存自动作废 */
const V = 1;
/** 一本书最多索引多少字符。一本书 60 万字已远超「检索得到」的需要，再存只是占盘 */
const MAX_CHARS = 600_000;
/** 页数 / 节数上限：防一份异常文件把索引过程拖成几分钟 */
const MAX_PDF_PAGES = 1200;
const MAX_SECTIONS = 400;

/**
 * 把 pdf.js 的文本项拼成一行可读文本。
 *
 * pdf.js 给的是「按坐标切好的碎片」，不带空格也不带换行：直接 `join("")` 会把
 * `hello` 与 `world` 粘成 `helloworld`，直接 `join(" ")` 又会把中文拆成 `你 好 世 界`。
 * 折中办法是看相邻两片的边缘——都是 ASCII 字母数字才补一个空格，CJK 一律直接相接；
 * 换行靠 `hasEOL` 判断。
 */
function joinItems(items) {
  let out = "";
  for (const item of items) {
    const text = item?.str || "";
    if (text) {
      const prev = out.slice(-1);
      if (prev && /[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(text[0])) out += " ";
      out += text;
    }
    if (item?.hasEOL) out += "\n";
  }
  return out;
}

/** 索引是否还能用：结构版本、体积、修改时间三者全对得上才算 */
function isFresh(index, book) {
  return Boolean(index)
    && index.v === V
    && Number(index.size) === Number(book.size)
    && Number(index.mtime) === Number(book.mtime)
    // mtime 为 0 表示取不到（旧数据或文件系统不支持），一律当过期处理
    && Number(book.mtime) > 0;
}

/** 只索引这几类；其余（含 kind 不认识的）直接返回空索引，免得每次敲字都重试 */
function needsIndex(book) {
  return book?.kind === "pdf" || book?.kind === "ebook";
}

async function buildPdf(book, { onProgress, token } = {}) {
  const doc = await pdfjsLib.getDocument({ url: convertFileSrc(book.path) }).promise;
  const total = Math.min(doc.numPages, MAX_PDF_PAGES);
  const units = [];
  let chars = 0;
  try {
    for (let n = 1; n <= total; n += 1) {
      if (token?.cancelled || chars >= MAX_CHARS) break;
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = joinItems(content.items).trim();
      // 空白页（扫描件、纯图页）不占单元：检索它永远不命中，留着只会拉长扫描
      if (text) {
        units.push({ label: "", page: n, href: "", text });
        chars += text.length;
      }
      page.cleanup?.();
      onProgress?.(n / total);
    }
  } finally {
    // 中途取消也要把 worker 与缓存放掉，否则每搜一次就漏一个 PDFDocumentProxy
    await doc.destroy().catch(() => {});
  }
  return units;
}

async function buildEbook(book, { onProgress, token } = {}) {
  const { makeBook } = await import("../vendor/foliate/view.js");
  // 书是本地文件：走 asset 协议，不必经 IPC 搬几百兆字符串（与打开电子书同一路径）
  const response = await fetch(convertFileSrc(book.path));
  if (!response.ok) throw new Error(t("reader.ebookReadFailed", { code: response.status }));
  const blob = await response.blob();
  const name = book.path.split(/[\\/]/).pop() || "book.epub";
  const parsed = await makeBook(new File([blob], name));

  // 章节名按 href 对到目录上；对不上就留空，由界面显示「第 N 节」而不是硬编一个假标题
  const labels = new Map();
  for (const item of flattenToc(parsed.toc)) {
    const key = String(item.href || "").split("#")[0];
    if (key && !labels.has(key)) labels.set(key, item.label);
  }

  const sections = (parsed.sections || []).slice(0, MAX_SECTIONS);
  const units = [];
  let chars = 0;
  for (let i = 0; i < sections.length; i += 1) {
    if (token?.cancelled || chars >= MAX_CHARS) break;
    const section = sections[i];
    try {
      const doc = await section.createDocument();
      const text = String(doc?.body?.textContent || "").replace(/[\s\u00a0]+/g, " ").trim();
      if (text) {
        const key = String(section.id || section.href || "").split("#")[0];
        units.push({ label: labels.get(key) || "", page: 0, href: section.id || "", text });
        chars += text.length;
      }
    } catch {
      // 单节解析失败不拖垮整本：跳过它，其余的照常可搜
    }
    onProgress?.((i + 1) / sections.length);
  }
  return units;
}

async function buildIndex(book, options) {
  const units = book.kind === "pdf"
    ? await buildPdf(book, options)
    : await buildEbook(book, options);
  return { v: V, size: Number(book.size) || 0, mtime: Number(book.mtime) || 0, units };
}

/**
 * 取这本书的索引：命中缓存就直接用，否则重建并落盘。
 *
 * 取消返回 null 而不是抛错——调用方是靠「结果过期」自然丢弃的，不该为此写 try。
 */
async function ensureIndex(book, options = {}) {
  if (!needsIndex(book)) return { v: V, size: 0, mtime: 0, units: [] };
  let cached = null;
  try {
    cached = await invoke("read_search_index", { id: book.id });
  } catch {
    // 读不出来就当没有：重建一次比让一个坏缓存永久卡住检索更好
    cached = null;
  }
  if (isFresh(cached, book)) return cached;
  if (options.token?.cancelled) return null;

  const index = await buildIndex(book, options);
  if (options.token?.cancelled) return null;
  // 落盘失败不影响这次检索，只是下次还得重建一次
  invoke("write_search_index", { id: book.id, index }).catch(() => {});
  return index;
}

export { ensureIndex, needsIndex, isFresh, joinItems, V, MAX_CHARS };
