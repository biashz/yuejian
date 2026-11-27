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
import { t } from "./i18n.js";
import { formatBytes } from "./core/format.js";
import { stripActiveContent } from "./reader/ebook-sanitize.js";
import { searchBook } from "./reader/ebook-search.js";
import { resolveFootnote } from "./reader/ebook-note.js";
import { flattenToc, countChapters } from "./reader/ebook-toc.js";
import { detectDrm } from "./reader/ebook-drm.js";
import { hardenBook } from "./reader/ebook-harden.js";
import { ebookFormat } from "./core/constants.js";
import { guardBook } from "./reader/ebook-guard.js";
import { bindAnnotations, paintAnnotations, selectionCfi } from "./reader/ebook-annotations.js";
import { toLocation, stepBook, chapterStep, goToFraction } from "./reader/ebook-nav.js";
import { createPageDecor } from "./reader/ebook-page.js";

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

/**
 * 分页器此刻能不能安全地重排。
 *
 * `render()` 会往**当前章节文档**的 `documentElement` / `body` 上写样式，而切书、
 * 载入章节的空档里 iframe 的文档可能已经有 `<html>` 还没有 `<body>`——这时
 * `setAttribute("max-inline-size")` 触发的内部 `render()` 就会以
 * 「destructure 一个 null」告终。查一下它的 `getContents()` 里有没有能排版的文档。
 */
const paginatorReady = (renderer) => Boolean(renderer?.getContents?.()?.[0]?.doc?.body);

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
  constructor({ stack, onRelocate, onContent, onEdge, onLink, onAnnotation, spread = true }) {
    this.stack = stack;
    this.onRelocate = onRelocate;
    this.onContent = onContent;
    this.onEdge = onEdge;
    this.onLink = onLink;
    /* 点中已有划线时回调；与 onLink 同一层，都是「库里判定命中、界面决定怎么做」 */
    this.onAnnotation = onAnnotation;
    /* 用户选的版式；真正的列数写在 renderer 的 max-column-count 上 */
    this.spread = spread;
    /* 注入给章节文档的版式 CSS 与页面参数（页边距/版心/列距），换书后由 `open()` 再贴一次 */
    this.css = "";
    this.layout = {};
    this.view = null;
    this.book = null;
    /* 书页装饰（中缝 / 页码 / 掠影）与书页宽度，跟着每个 view 重建 */
    this.decor = null;
    this.path = "";
    this.location = null;
    /* 当前可见 Range：朗读判「这句在不在屏幕上」用它，relocate 每次带过来 */
    this.visibleRange = null;
    this.chapters = 0;
    /* 真实格式（epub / fb2 / fbz / cbz / mobi / azw3）：角标与副标题按它显示 */
    this.format = "epub";
    /* 固定版面（漫画、杂志）：分页器不分栏、不吃字号与页边距，相关能力全部关掉 */
    this.fixed = false;
    /* 拍平后的目录：章跳转与「当前在第几章」都按它算 */
    this.toc = [];
    /* 章节文档缓存（脚注解析用）——key 是 spine 下标 */
    this.docs = new Map();
    /* 这本书的划线；真正画在 overlayer 上的是 `painted` 里那几个 */
    this.highlights = [];
    this.painted = new Set();
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

    const mod = await importFoliate();
    const { View } = mod;
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
    this.format = ebookFormat(file.name) || "epub";

    // 加密的书一律不打开：库会以「解析失败」告终，用户只会以为文件坏了
    const drm = await detectDrm(file, this.format);
    if (drm) throw new Error(t("reader.ebookDrm", { scheme: drm }));

    // 自己调 `makeBook` 而不是交给 `view.open(file)`：中间要包一层 `hardenBook`，
    // 把 FB2 / MOBI 现拼出来的章节 HTML 也洗一遍（EPUB 走 transformTarget，不需要）
    const book = await mod.makeBook(file);
    this.fixed = book.rendition?.layout === "pre-paginated";
    // 漫画一张图就是一页。`makeComicBook` 没有声明 `rendition.spread`，而固定版面
    // 渲染器会把「没说」当成「可以左右对开」——结果是每屏只看到右半边一张图、
    // 左边空着，还得横向翻。这里补一句「一页一屏」，杂志类 EPUB 会自己声明，不动。
    if (this.fixed && this.format === "cbz" && book.rendition) book.rendition.spread = "none";
    await view.open(hardenBook(book));
    this.book = view.book;
    this.chapters = countChapters(this.book?.toc);
    this.toc = flattenToc(this.book?.toc);
    guardBook(this.book);
    // 装饰层要在首帧之前挂上：init() 触发的第一次 relocate 就是页码的来源
    this.decor = createPageDecor(this);

    view.addEventListener("relocate", (event) => this.handleRelocate(event.detail));
    view.addEventListener("load", (event) => {
      // 换章的空档里 `applyLayout` 可能整段跳过（文档还没 body），这里补一次：
      // 只写属性不重排，紧接着分页器自己就会 render
      if (this.css) this.applyLayout(this.css, this.layout, { render: false });
      this.onContent?.(event.detail?.doc);
    });
    // 外链交给系统浏览器：留在应用里会把当前阅读页顶掉，而且 WebView 里也没有返回按钮
    view.addEventListener("external-link", (event) => {
      event.preventDefault();
      invoke("open_external", { url: event.detail.href_ }).catch(() => {});
    });
    // 书内链接一律先拦下：`link` 事件是可取消的，库里看 `dispatchEvent` 的返回值
    // 决定要不要自己 `goTo`。脚注要读另一章才能判断是不是注，是异步的，
    // 没法同步给答案——所以先拦，再由回调决定跳转还是弹窗
    // 划线：重建 overlayer 时重贴、按颜色画、点中时回调（细节在 ebook-annotations.js）
    bindAnnotations(this, view);
    view.addEventListener("link", (event) => {
      if (!this.onLink) return;
      event.preventDefault();
      this.onLink(event.detail);
    });

    await view.init({ lastLocation: cfi || null, showTextStart: !cfi });
    // 列数只能在首帧之后再改：`attributeChangedCallback` 会去写 `#top` 的样式变量，
    // 而 `#top` 是第一次 render 才建出来的，早设一步就是空引用
    this.setSpread(this.spread);
    // 版式同理：`setStyles` 要写当前文档的 `<style>`，而那张表是 `afterLoad` 才建的
    if (this.css) this.applyLayout(this.css, this.layout);
  }

  /**
   * 单页 / 双页。分页器的列数是 CSS 变量驱动的，改完必须显式 `render()`
   * 才会重新分栏——属性回调只更新变量，不触发重排。
   *
   * 窄窗口不必在这里判断：分页器自带 `@container (orientation: portrait)`
   * 规则，竖长的时候自己就降成一页了。
   *
   * 固定版面（CBZ）没有「栏数」这回事：它是整页缩放，左右页由书里的
   * `page-spread` 属性决定，去动 `foliate-fxl` 上的 `max-column-count` 只会白设一个属性。
   */
  setSpread(spread) {
    this.spread = Boolean(spread);
    if (this.fixed) return;
    const renderer = this.view?.renderer;
    if (!renderer) return;
    // 滚动模式是单栏的定义：列数属性在那儿没有意义，设了也只是白设
    if (renderer.scrolled) return;
    // 没就绪就别设：列数属性会连带触发一次 render()，空档里调会崩（见 paginatorReady）
    if (!paginatorReady(renderer)) return;
    renderer.setAttribute("max-column-count", this.spread ? "2" : "1");
    renderer.render?.();
    this.decor?.sync();
  }

  /**
   * 版式设置：字号 / 行高 / 字体 / 对齐 / 缩进 / 段距 / 标点走章节文档里追加的那张样式表，
   * 页边距 / 版心宽度 / 列间距走分页器自己的属性——它们参与「每栏多宽、每页几栏」的计算，
   * 不下发给书里的 DOM。
   *
   * 为什么用 `setAttribute` 而不是 `style.setProperty("--_margin")`：那几个 CSS 变量
   * 是写在分页器 `#top` 元素自己的规则里的，宿主元素上的同名内联变量只会**被继承**，
   * 输给 `#top` 自己那份声明。属性回调才是写进 `#top.style` 的正路。
   *
   * 两样都记在实例上：换书会重建 `<foliate-view>`，重开之后要能原样贴回去。
   * 改动会改变每页容下多少字，所以最后必须重排一次，否则页码还按旧版式算。
   *
   * 固定版面不吃这套：书页尺寸与排版是出版方定的，改字号只会把图放大，
   * 所以照存不照做（换成回流体裁的书再贴上去）。
   */
  applyLayout(css, layout = {}, { render = true } = {}) {
    this.css = css;
    this.layout = { ...this.layout, ...layout };
    // 页面宽度 / 中缝 / 页码都吃这份版式，先让装饰层跟上再重排
    this.decor?.sync();
    if (this.fixed) return;
    const renderer = this.view?.renderer;
    if (!renderer) return;
    // 样式表可以先贴：分页器把它存起来，下次 `afterLoad` 会自己写进去
    if (css) renderer.setStyles?.(css);
    // 页面参数与重排必须等文档就绪：`max-inline-size` 会由分页器内部触发一次
    // `render()`，绕不过外面这层判断（值已经记在 `this.layout` 上，下一章载入时补）
    if (!paginatorReady(renderer)) return;
    const { margin, measure, gap } = this.layout;
    if (Number.isFinite(margin)) renderer.setAttribute("margin", `${margin}px`);
    if (Number.isFinite(measure)) renderer.setAttribute("max-inline-size", `${measure}px`);
    if (Number.isFinite(gap)) renderer.setAttribute("gap", `${gap}%`);
    if (render) renderer.render?.();
  }

  /** 贴一份划线列表（增删都由 `highlight.js` 整份重贴，这里只存下来再画一遍） */
  setHighlights(list) {
    this.highlights = Array.isArray(list) ? list : [];
    paintAnnotations(this);
  }

  /**
   * 跳到某条划线，并让库把这次命中派发出去（侧栏点条目时用）。
   *
   * 走的不是 `goTo` + 自己算位置：`showAnnotation` 会先导航到 CFI 再补一次
   * `show-annotation`，这里的小窗正好挂在那一个回调上，两件事就都不用重写。
   */
  showAnnotation(annotation) {
    if (!annotation?.cfi) return undefined;
    return this.view?.showAnnotation({ value: annotation.cfi });
  }

  /** 选中文字的 CFI；固定版面没有字符流，返回空串 */
  selectionCfi(range) {
    return selectionCfi(this, range);
  }

  handleRelocate(detail) {
    this.location = toLocation(detail);
    this.visibleRange = detail?.range || null;
    this.onRelocate?.(this.location);
  }

  next() {
    return stepBook(this, 1);
  }

  prev() {
    return stepBook(this, -1);
  }

  chapterStep(direction) {
    return chapterStep(this, direction);
  }

  /**
   * 全书搜索。收敛生成器的事在 `ebook-search.js`，这里只留一个入口，
   * 免得调用方（侧栏）得知道 foliate 的事件形状。
   */
  search(query, options) {
    // 固定版面的书（漫画）只有图没有字，搜也没得搜——直接回空表，别让侧栏一直转
    if (this.fixed) return Promise.resolve([]);
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

  /** 按比例跳转（0–1）；固定版面按节数取整，回流的书交给库 */
  goToFraction(fraction) {
    return goToFraction(this, fraction);
  }

  destroy() {
    if (!this.view) return;
    this.decor?.dispose();
    this.decor = null;
    this.__modeDispose?.();
    this.__modeDispose = null;
    try {
      this.view.close();
    } catch (_) {
      // 库内部会 revoke blob URL，重复关闭抛错不影响什么
    }
    this.view.remove();
    this.view = null;
    this.book = null;
    this.location = null;
    this.visibleRange = null;
    this.chapters = 0;
    this.toc = [];
    this.format = "epub";
    this.fixed = false;
    this.docs.clear();
    this.painted.clear();
    this.stack.hidden = true;
    this.stack.innerHTML = "";
  }
}

export { stripActiveContent, MAX_BYTES };
