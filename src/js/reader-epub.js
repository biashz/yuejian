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
import { stripActiveContent } from "./reader/ebook-sanitize.js";
import { searchBook } from "./reader/ebook-search.js";
import { resolveFootnote } from "./reader/ebook-note.js";

/** 超过这个体积就不读了：整份进内存，再大只会把进程拖死 */
const MAX_BYTES = 512 * 1024 * 1024;
/** 章节文档缓存条数：脚注可能来回翻，但没必要把整本书的 DOM 都留着 */
const DOC_CACHE_LIMIT = 3;

/** 动态 import 只做一次；`view.js` 在被求值时注册 `foliate-view` 自定义元素 */
let foliate = null;
function importFoliate() {
  if (!foliate) foliate = import("../vendor/foliate/view.js");
  return foliate;
}

export class EbookReader {
  /**
   * @param {object} options
   * @param {HTMLElement} options.stack  承载 `<foliate-view>` 的容器
   * @param {(loc: {cfi: string, fraction: number, label: string, href: string}) => void} options.onRelocate
   * @param {(doc: Document) => void} [options.onContent]  每章渲染完成时调用，手势层在这里挂键盘/点击/滚轮
   * @param {(edge: "start"|"end") => void} [options.onEdge]  翻到书外时调用，用于给用户一句提示
   * @param {(detail: {a: HTMLElement, href: string}) => void} [options.onLink]  书内链接交给调用方处理
   * @param {boolean} [options.spread]  是否双页（窗口变窄时由分页器自己降为单页）
   */
  constructor({ stack, onRelocate, onContent, onEdge, onLink, spread = true }) {
    this.stack = stack;
    this.onRelocate = onRelocate;
    this.onContent = onContent;
    this.onEdge = onEdge;
    this.onLink = onLink;
    /* 用户选的版式；真正的列数写在 renderer 的 max-column-count 上 */
    this.spread = spread;
    this.view = null;
    this.book = null;
    this.path = "";
    this.location = null;
    this.chapters = 0;
    /* 拍平后的目录：章跳转与「当前在第几章」都按它算 */
    this.toc = [];
    /* 章节文档缓存（脚注解析用）——key 是 spine 下标 */
    this.docs = new Map();
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
    this.toc = flattenToc(this.book?.toc);
    this.guard(view);

    view.addEventListener("relocate", (event) => this.handleRelocate(event.detail));
    view.addEventListener("load", (event) => this.onContent?.(event.detail?.doc));
    // 外链交给系统浏览器：留在应用里会把当前阅读页顶掉，而且 WebView 里也没有返回按钮
    view.addEventListener("external-link", (event) => {
      event.preventDefault();
      invoke("open_external", { url: event.detail.href_ }).catch(() => {});
    });
    // 书内链接一律先拦下：`link` 事件是可取消的，库里看 `dispatchEvent` 的返回值
    // 决定要不要自己 `goTo`。脚注要读另一章才能判断是不是注，是异步的，
    // 没法同步给答案——所以先拦，再由回调决定跳转还是弹窗
    view.addEventListener("link", (event) => {
      if (!this.onLink) return;
      event.preventDefault();
      this.onLink(event.detail);
    });

    await view.init({ lastLocation: cfi || null, showTextStart: !cfi });
    // 列数只能在首帧之后再改：`attributeChangedCallback` 会去写 `#top` 的样式变量，
    // 而 `#top` 是第一次 render 才建出来的，早设一步就是空引用
    this.setSpread(this.spread);
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
   * 单页 / 双页。分页器的列数是 CSS 变量驱动的，改完必须显式 `render()`
   * 才会重新分栏——属性回调只更新变量，不触发重排。
   *
   * 窄窗口不必在这里判断：分页器自带 `@container (orientation: portrait)`
   * 规则，竖长的时候自己就降成一页了。
   */
  setSpread(spread) {
    this.spread = Boolean(spread);
    const renderer = this.view?.renderer;
    if (!renderer) return;
    renderer.setAttribute("max-column-count", this.spread ? "2" : "1");
    renderer.render?.();
  }

  handleRelocate(detail) {
    const href = detail?.tocItem?.href || "";
    const loc = {
      cfi: typeof detail?.cfi === "string" ? detail.cfi : "",
      fraction: clamp(Number(detail?.fraction) || 0, 0, 1),
      label: detail?.tocItem?.label || "",
      href,
    };
    this.location = loc;
    this.onRelocate?.(loc);
  }

  /**
   * 翻页并判断是不是已经到头。
   *
   * 库在首尾处是静默 no-op（`prev()` 直接 resolve，什么也不发生），用户按了没反应
   * 只会以为卡了。这里比前后 CFI：没变就是没动，回一句提示。
   * 留一帧再比——`relocate` 是在渲染完成后才派发的，紧跟着读可能还没更新。
   */
  async step(direction) {
    const before = this.location?.cfi || "";
    if (direction > 0) await this.view?.next();
    else await this.view?.prev();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const after = this.location?.cfi || "";
    if (before && after && before === after) this.onEdge?.(direction > 0 ? "end" : "start");
  }

  next() {
    return this.step(1);
  }

  prev() {
    return this.step(-1);
  }

  /**
   * 上一章 / 下一章。按目录顺序走，不按 spine——读者心里的「章」是目录里的那一条，
   * 而 spine 里的分节可能只是排版切分。
   */
  chapterStep(direction) {
    const items = this.toc;
    if (!items.length) return;
    const href = this.location?.href || "";
    const file = href.split("#")[0];
    let index = -1;
    items.forEach((item, i) => {
      if (item.href === href) index = i;
      else if (index < 0 && item.href.split("#")[0] === file) index = i;
    });
    if (index < 0) return;
    const target = items[index + direction];
    if (!target) {
      this.onEdge?.(direction > 0 ? "end" : "start");
      return;
    }
    return this.view?.goTo(target.href);
  }

  /**
   * 全书搜索。收敛生成器的事在 `ebook-search.js`，这里只留一个入口，
   * 免得调用方（侧栏）得知道 foliate 的事件形状。
   */
  search(query, options) {
    return searchBook(this, query, options);
  }

  clearSearch() {
    this.view?.clearSearch?.();
  }

  /** 脚注解析；不是「注」就回 null，调用方照常走 `goTo` */
  footnote(href) {
    return resolveFootnote(this, href);
  }

  /** 章节文档按需加载并缓存少量：脚注常常来回点同一章 */
  sectionDoc(index) {
    const cached = this.docs.get(index);
    if (cached) return cached;
    const section = this.book?.sections?.[index];
    if (!section?.createDocument) return Promise.resolve(null);
    const promise = Promise.resolve(section.createDocument()).catch(() => null);
    this.docs.set(index, promise);
    if (this.docs.size > DOC_CACHE_LIMIT) {
      // Map 保持插入顺序，最早的先出
      this.docs.delete(this.docs.keys().next().value);
    }
    return promise;
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
    this.toc = [];
    this.docs.clear();
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
