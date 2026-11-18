/**
 * 电子书阅读：把 foliate-js 的 <foliate-view> 装进某个分栏，
 * 并把它的 relocate / load 事件折算成项目的进度与状态。
 *
 * 三条边界，决定了这个文件为什么长这样：
 *
 * 1. **解析全在库里**。Rust 只回路径，这里把文件读成 Blob 交给 `makeBook`；
 *    EPUB 的 OPF、NCX/NAV、加密字体解混淆、章节资源替换都是库的活。
 * 2. **位置只记 CFI**。电子书是流式排版，页码由视口算出来——窗口一变，「第 87 页」
 *    就是另一段文字了。CFI 指向 DOM 节点偏移，与排版无关，才存得下来。
 * 3. **书里的脚本一律不执行**。库自身不提供沙箱（iframe 用 same-origin 的 blob:，
 *    为了事件还不得不开 allow-scripts），所以在这儿把脚本资源与内联脚本砍掉，
 *    再由 tauri.conf.json 的 CSP 兜底。两道，缺一道都不算完。
 */
import { convertFileSrc, invoke } from "./api.js";
import { clamp } from "./core/dom.js";
import { t } from "./i18n.js";
import { formatBytes } from "./core/format.js";

/** 超过这个体积就不读了：整份进内存，再大只会把进程拖死 */
const MAX_BYTES = 512 * 1024 * 1024;

/** 动态 import 只做一次；`view.js` 在被求值时注册 `foliate-view` 自定义元素 */
let foliate = null;
function importFoliate() {
  if (!foliate) foliate = import("../vendor/foliate/view.js");
  return foliate;
}

const DANGEROUS_TAGS = "script,iframe,object,embed,base";
const HAS_DANGEROUS = new RegExp(`<(${DANGEROUS_TAGS.split(",").join("|")})\\b|\\son[a-z]+\\s*=|\\bjavascript:`, "i");

/**
 * 清洗一个章节资源：删脚本类标签、内联事件属性、`javascript:` 链接。
 *
 * 先看有没有可疑内容，没有就原样返回——绝大多数章节只有正文和 `<img>`，
 * 不值得为每一章都走一遍解析与重新序列化（500 章的书差别很明显）。
 *
 * **入参可能是字符串也可能是字节**：走 `loadReplaced` 的 XHTML 在库里已经被解成字符串，
 * 只有二进制资源才是 Blob 的字节；返回类型必须与入参一致，否则库里 `new Blob([data])`
 * 会把二进制写坏，章节直接加载失败。
 *
 * 解析失败（不是良构 XML）时退化成按标签裁掉 `<script>`：宁可少删几个事件属性，
 * 也不能因为清洗把一章正文弄没了。
 */
function stripActiveContent(input, type) {
  const isBytes = typeof input !== "string";
  const text = isBytes ? new TextDecoder().decode(input) : input;
  const same = (out) => (isBytes ? new TextEncoder().encode(out) : out);
  if (!HAS_DANGEROUS.test(text)) return input;

  try {
    const isXml = /xml|svg/i.test(type);
    const doc = new DOMParser().parseFromString(text, type);
    if (doc.querySelector("parsererror")) throw new Error("not well-formed");
    doc.querySelectorAll(DANGEROUS_TAGS).forEach((node) => node.remove());
    for (const el of doc.querySelectorAll("*")) {
      for (const attr of [...el.attributes]) {
        if (/^on/i.test(attr.name) || /^\s*javascript:/i.test(attr.value)) {
          el.removeAttribute(attr.name);
        }
      }
    }
    const out = isXml
      ? new XMLSerializer().serializeToString(doc)
      : `<!DOCTYPE html>${doc.documentElement.outerHTML}`;
    return same(out);
  } catch (_) {
    return same(text.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ""));
  }
}

export class EbookReader {
  /**
   * @param {object} options
   * @param {HTMLElement} options.stack  承载 `<foliate-view>` 的容器
   * @param {(loc: {cfi: string, fraction: number, label: string, href: string}) => void} options.onRelocate
   */
  constructor({ stack, onRelocate }) {
    this.stack = stack;
    this.onRelocate = onRelocate;
    this.view = null;
    this.book = null;
    this.path = "";
    this.location = null;
    this.chapters = 0;
  }

  /**
   * 打开一本书。
   *
   * `cfi` 是上次读到的位置；为空则从正文开头开始（`showTextStart` 会跳过封面与版权页）。
   */
  async open(path, { size = 0, cfi = "", name = "" } = {}) {
    this.destroy();
    if (size > MAX_BYTES) {
      throw new Error(t("reader.ebookTooBig", { size: formatBytes(MAX_BYTES) }));
    }

    const { View } = await importFoliate();
    const view = document.createElement("foliate-view");
    view.className = "ebook-view";
    this.stack.append(view);
    this.stack.hidden = false;
    this.view = view;
    this.path = path;

    // 书是本地文件：asset 协议直接读，不必经过 IPC 把几百兆 JS 字符串搬一遍。
    // 文件名必须带上——`makeBook` 按 `name` 后缀区分 CBZ / FB2.ZIP，Blob 没有 name
    const response = await fetch(convertFileSrc(path));
    if (!response.ok) throw new Error(t("reader.ebookReadFailed", { code: response.status }));
    const blob = await response.blob();
    const file = new File([blob], name || path.split(/[\\/]/).pop() || "book.epub");

    await view.open(file);
    this.book = view.book;
    this.chapters = countChapters(this.book?.toc);
    this.guard(view);

    view.addEventListener("relocate", (event) => this.handleRelocate(event.detail));
    view.addEventListener("load", (event) => this.bindContentKeys(event.detail?.doc));
    // 外链交给系统浏览器：留在应用里会把当前阅读页顶掉，而且 WebView 里也没有返回按钮
    view.addEventListener("external-link", (event) => {
      event.preventDefault();
      invoke("open_external", { url: event.detail.href_ }).catch(() => {});
    });

    await view.init({ lastLocation: cfi || null, showTextStart: !cfi });
  }

  /**
   * 挂上资源钩子。两个事件都在库内部（`book.transformTarget`，即 loader 的 eventTarget）：
   *
   * - `load`：允许/拒绝某个清单项。脚本类直接拒掉，连字节都不读。
   * - `data`：资源字节在变成 blob URL 之前的最后一道，用来清洗 HTML/CSS。
   */
  guard(view) {
    const target = this.book?.transformTarget;
    if (!target) return;
    target.addEventListener("load", (event) => {
      if (event.detail?.isScript) event.detail.allow = false;
    });
    target.addEventListener("data", (event) => {
      const type = String(event.detail?.type || "");
      if (!/xhtml|html|svg/i.test(type)) return;
      event.detail.data = Promise.resolve(event.detail.data)
        .then((bytes) => stripActiveContent(bytes, type));
    });
  }

  /**
   * 章节是在 iframe 里渲染的：焦点一旦落进 iframe，键盘事件就不再冒泡到主文档，
   * 全局快捷键会整片失灵。所以每个章节文档都要单独挂一份翻页键。
   */
  bindContentKeys(doc) {
    if (!doc || doc.__yuejianKeys) return;
    doc.__yuejianKeys = true;
    doc.addEventListener("keydown", (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const nextKey = ["ArrowRight", "ArrowDown", "PageDown", " "].includes(event.key);
      const prevKey = ["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(event.key);
      if (!nextKey && !prevKey) return;
      // 空格在正文里默认是滚动一屏，这里必须拦下来，否则会和翻页叠加成两页
      event.preventDefault();
      if (nextKey) this.next();
      else this.prev();
    });
  }

  handleRelocate(detail) {    const href = detail?.tocItem?.href || "";
    const loc = {
      cfi: typeof detail?.cfi === "string" ? detail.cfi : "",
      fraction: clamp(Number(detail?.fraction) || 0, 0, 1),
      label: detail?.tocItem?.label || "",
      href,
    };
    this.location = loc;
    this.onRelocate?.(loc);
  }

  next() {
    return this.view?.next();
  }

  prev() {
    return this.view?.prev();
  }

  /** 跳转：目录项传 href，续读传 CFI，进度条传 0–1 的比例 */
  goTo(target) {
    return this.view?.goTo(target);
  }

  goToFraction(fraction) {
    return this.view?.goToFraction(clamp(fraction, 0, 1));
  }

  destroy() {
    if (!this.view) return;
    try {
      this.view.close();
    } catch (_) {
      // 库内部会 revoke blob URL，重复关闭抛错不影响什么
    }
    this.view.remove();
    this.view = null;
    this.book = null;
    this.location = null;
    this.chapters = 0;
    this.stack.hidden = true;
    this.stack.innerHTML = "";
  }
}

/** 目录项总数（含子项）；`book.toc` 是嵌套结构 */
function countChapters(items, depth = 0) {
  if (!Array.isArray(items) || depth > 8) return 0;
  return items.reduce((sum, item) => sum + 1 + countChapters(item.subitems, depth + 1), 0);
}

/**
 * 把嵌套目录拍平成侧栏能用的列表。
 *
 * 层级用 `level` 带出去而不是嵌套 DOM：缩进、高亮、键盘导航都按一个数组处理，
 * 与 PDF 大纲、Markdown 标题那两套渲染共用同一份样式。
 */
function flattenToc(items, depth = 0, out = []) {
  if (!Array.isArray(items) || depth > 8) return out;
  for (const item of items) {
    if (item?.label && item?.href) out.push({ label: item.label, href: item.href, level: depth });
    if (item?.subitems?.length) flattenToc(item.subitems, depth + 1, out);
  }
  return out;
}

export { flattenToc, stripActiveContent, MAX_BYTES };
