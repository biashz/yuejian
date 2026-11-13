/**
 * pdf.js 阅读器：连续滚动 + 懒渲染 + 文本层选择 + 大纲 + 搜索 + 缩略图。
 */
import * as pdfjsLib from "../vendor/pdfjs/pdf.mjs";
import { convertFileSrc, invoke } from "./api.js";
import { t } from "./i18n.js";

const VENDOR = new URL("../vendor/pdfjs/", import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.mjs", import.meta.url).href;

// 下限放到 25%：窗口较小时「适合页面」需要把整页缩到 50% 以下才能看全
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2.5;

/// 超过该体积的 PDF 改走 IPC 分块读取：
/// asset 协议收到不带 Range 的请求时会把整个文件读进内存，GB 级文件会直接压垮进程
const RANGE_READ_THRESHOLD = 64 * 1024 * 1024;
/// 同时在渲染的页数上限，避免快速滚动时并发渲染把内存顶爆
const MAX_CONCURRENT_RENDERS = 2;
/// 视口外保留的已渲染页数，超出即卸载释放画布内存
const KEEP_BEHIND = 2;
const KEEP_AHEAD = 3;
/// 判定「当前页」的探针位置（距视口顶部像素）；联动对齐也以此为准
const READ_POINT = 140;

const clamp01 = (value) => Math.min(1, Math.max(0, Number(value) || 0));

/** 把 pdf.js 的按需读取接到 Rust 侧的分块读取命令上 */
class IpcRangeTransport extends pdfjsLib.PDFDataRangeTransport {
  constructor(path, length, onFailure) {
    super(length, new Uint8Array(0));
    this.path = path;
    this.aborted = false;
    this.onFailure = onFailure;
  }

  requestDataRange(begin, end) {
    if (this.aborted) return;
    invoke("read_pdf_range", { path: this.path, begin, end })
      .then((bytes) => {
        if (this.aborted) return;
        this.onDataRange(begin, new Uint8Array(bytes));
      })
      .catch((error) => {
        // 供数失败时必须让整次打开失败：回一个空块会让 pdf.js 永远等待这个数据块，
        // 界面就会一直停在“正在解析”
        if (this.aborted) return;
        this.aborted = true;
        const detail = error?.message || error;
        this.onFailure?.(new Error(`${detail}（字节 ${begin}-${end}）`));
      });
  }

  abort() {
    this.aborted = true;
  }
}

export class PdfReader {
  constructor({ stack, scrollArea, onPageChange, onReady, onError }) {
    this.stack = stack;
    this.scrollArea = scrollArea;
    this.onPageChange = onPageChange;
    this.onReady = onReady;
    this.onError = onError;

    this.pdf = null;
    this.zoom = 1;
    // 是否处于「适合页面」模式：窗口或分栏尺寸变化时按可视区重新适配
    this.fitMode = false;
    this.lastHeight = 0;
    // 演示模式放映期间挂起尺寸自适应：全屏改变窗口大小不应让背后的阅读视图重排重绘
    this.suspended = false;
    // 演示页的在途渲染任务，快速翻页时用于取消旧页
    this.fitTask = null;
    this.page = 1;
    this.numPages = 0;
    this.sheets = [];
    this.rendered = new Map();
    this.textCache = new Map();
    // 正在渲染的页码与对应任务，用于限制并发和在卸载时取消
    this.rendering = new Set();
    this.tasks = new Map();
    this.transport = null;
    this.token = 0;
    this.baseWidth = 720;
    this.aspect = 1.414;
    // 每页滚动位置的缓存，避免逐帧对所有页做 offsetTop 读取（大文档会明显卡顿）
    this.tops = null;
    // 联动落位时目标页可能还没渲染：占位页高度是估算值，等真实高度出来后再校正一次
    this.pendingAnchor = null;

    this.handleScroll = this.handleScroll.bind(this);
    this.handleResize = this.handleResize.bind(this);
  }

  /** 打开文档；不传 zoom 时默认「适合页面」，即打开就完整看到一页 */
  async open(path, { startPage = 1, zoom = null, size = 0 } = {}) {
    this.destroy();
    const token = ++this.token;
    // 末尾的空占位把滚动条先撑出来：栈为空时 clientWidth 仍包含滚动条宽度，
    // 会导致分栏时两栏算出的页宽相差一个滚动条，联动位置看起来对不上
    this.stack.innerHTML = `<div class="pdf-loading"><span>${t("pdf.parsing")}</span></div><div style="height:200vh"></div>`;
    this.scrollArea.scrollTop = 0;

    const options = {
      cMapUrl: `${VENDOR}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${VENDOR}standard_fonts/`,
      wasmUrl: `${VENDOR}wasm/`,
      // 大文件关键：关闭后台预取，改为按需分块（1 MB）读取，
      // 否则 pdf.js 会把整个文件逐步拉进内存，几个 GB 的文件会直接把界面卡死
      disableAutoFetch: true,
      disableStream: false,
      rangeChunkSize: 1024 * 1024,
    };

    let pdf;
    let task = null;
    try {
      if (size > RANGE_READ_THRESHOLD) {
        // 大文件：完全由我们按需供数，进程内存占用与文件大小脱钩
        let rejectTransport;
        const transportFailed = new Promise((_, reject) => {
          rejectTransport = reject;
        });
        const transport = new IpcRangeTransport(path, size, rejectTransport);
        this.transport = transport;
        task = pdfjsLib.getDocument({ range: transport, ...options, disableStream: true });
        // 供数失败时立即终止，否则会永远停在解析中
        pdf = await Promise.race([task.promise, transportFailed]);
      } else {
        // 小文件：走 asset 协议（支持 Range 请求），路径更短更快
        task = pdfjsLib.getDocument({ url: convertFileSrc(path), ...options });
        pdf = await task.promise;
      }
    } catch (primaryError) {
      if (this.transport) {
        this.transport.abort();
        this.transport = null;
      }
      if (task) await task.destroy().catch(() => {});
      // 大文件不再回退整文件读取：GB 级文件必然读不进来，也会掩盖真实原因
      if (size > RANGE_READ_THRESHOLD) throw primaryError;
      // 兜底：通过 IPC 读取字节（Rust 侧走二进制通道，且有体积上限）
      const bytes = await invoke("read_pdf_bytes", { path });
      pdf = await pdfjsLib.getDocument({ data: new Uint8Array(bytes), ...options }).promise;
    }
    if (token !== this.token) {
      pdf.destroy();
      return;
    }

    this.pdf = pdf;
    this.numPages = pdf.numPages;
    this.baseWidth = Math.min(780, Math.max(360, this.scrollArea.clientWidth - 96));

    const first = await pdf.getPage(1);
    const base = first.getViewport({ scale: 1 });
    this.aspect = base.height / base.width;

    this.fitMode = zoom == null;
    this.zoom = this.fitMode ? this.fitPageZoom() : this.clampZoom(zoom);
    this.lastHeight = this.scrollArea.clientHeight;

    this.buildPlaceholders();
    this.scrollArea.addEventListener("scroll", this.handleScroll, { passive: true });
    window.addEventListener("resize", this.handleResize);

    this.onReady?.({ pages: this.numPages });
    this.goPage(startPage, false);
  }

  pageWidth() {
    return Math.round(this.baseWidth * this.zoom);
  }

  buildPlaceholders() {
    this.stack.innerHTML = "";
    this.sheets = [];
    this.rendered.clear();
    this.tops = null;
    const width = this.pageWidth();
    const height = Math.round(width * this.aspect);
    // 一次性插入：逐页 appendChild 会让浏览器反复布局，页数多时明显卡住
    const fragment = document.createDocumentFragment();

    for (let i = 1; i <= this.numPages; i++) {
      const sheet = document.createElement("div");
      sheet.className = "pdf-sheet";
      sheet.dataset.page = String(i);
      sheet.style.width = `${width}px`;
      sheet.style.height = `${height}px`;
      sheet.innerHTML = `<div class="pdf-placeholder" style="width:100%;height:100%">${t("pdf.pageN", { page: i })}</div>`;
      fragment.appendChild(sheet);
      this.sheets.push(sheet);
    }

    this.stack.appendChild(fragment);

    // 不再用 IntersectionObserver 观察每一页：几千页时回调与观察目标本身就是负担，
    // 改为滚动位置二分查找决定渲染窗口
    this.renderWindow();
  }

  /** 占位层：把指定页恢复成未渲染状态 */
  restorePlaceholder(pageNo) {
    const sheet = this.sheets[pageNo - 1];
    if (!sheet) return;
    const width = this.pageWidth();
    sheet.classList.remove("is-ready");
    sheet.classList.remove("is-scaling");
    sheet.style.width = `${width}px`;
    sheet.style.height = `${Math.round(width * this.aspect)}px`;
    sheet.innerHTML = `<div class="pdf-placeholder" style="width:100%;height:100%">${t("pdf.pageN", { page: pageNo })}</div>`;
  }

  /** 卸载视口外的页：画布与文本层很占内存，滚动过大文档时必须释放 */
  unloadPage(pageNo) {
    if (!this.rendered.has(pageNo)) return;
    this.rendered.delete(pageNo);
    this.tasks.get(pageNo)?.cancel();
    this.tasks.delete(pageNo);
    this.restorePlaceholder(pageNo);
    // 让 pdf.js 释放该页的算子列表等缓存
    this.pdf?.getPage(pageNo).then((page) => page.cleanup()).catch(() => {});
    this.tops = null;
  }

  async renderPage(pageNo) {
    if (!this.pdf) return;
    // 演示模式放映中不渲染背后的页：任何滚动/回调触发的重绘都先搁置，退出后统一补上
    if (this.suspended) return;
    const sheet = this.sheets[pageNo - 1];
    if (!sheet || this.rendered.get(pageNo) === this.zoom) return;
    if (this.rendering.has(pageNo)) return;
    // 并发上限：超出的页等下一次滚动/渲染完成后重试
    if (this.rendering.size >= MAX_CONCURRENT_RENDERS) return;

    this.rendering.add(pageNo);
    const token = this.token;
    try {
      await this.paintPage(pageNo, sheet, token);
    } finally {
      this.rendering.delete(pageNo);
      if (token === this.token) requestAnimationFrame(() => this.renderWindow());
    }
  }

  async paintPage(pageNo, sheet, token) {
    const page = await this.pdf.getPage(pageNo);
    if (token !== this.token) return;

    const width = parseFloat(sheet.style.width) || this.pageWidth();
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = width / baseViewport.width;
    const viewport = page.getViewport({ scale });
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;

    const task = page.render({
      canvasContext: canvas.getContext("2d", { alpha: false }),
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    });
    this.tasks.set(pageNo, task);
    try {
      await task.promise;
    } catch (_) {
      return; // 被取消（切文档 / 缩放 / 卸载）
    } finally {
      this.tasks.delete(pageNo);
    }
    if (token !== this.token || this.rendered.get(pageNo) === this.zoom) return;

    sheet.innerHTML = "";
    sheet.style.width = `${Math.floor(viewport.width)}px`;
    sheet.style.height = `${Math.floor(viewport.height)}px`;
    sheet.style.setProperty("--total-scale-factor", String(viewport.scale));
    sheet.appendChild(canvas);

    // 文本层：支持选中与复制
    const textLayerDiv = document.createElement("div");
    textLayerDiv.className = "textLayer";
    textLayerDiv.style.setProperty("--total-scale-factor", String(viewport.scale));
    sheet.appendChild(textLayerDiv);
    try {
      const textLayer = new pdfjsLib.TextLayer({
        textContentSource: page.streamTextContent(),
        container: textLayerDiv,
        viewport,
      });
      await textLayer.render();
    } catch (_) {
      /* 文本层失败不影响图像阅读 */
    }

    sheet.classList.remove("is-scaling");
    sheet.classList.add("is-ready");
    this.rendered.set(pageNo, this.zoom);
    // 实际页高与占位高度可能有差异，作废滚动位置缓存
    this.tops = null;
    // 若正按联动锚点落位，这一页的真实高度会改变布局，需要重新校正一次
    this.alignToAnchor();
  }

  /** 重建每页顶部滚动位置缓存（一次布局读取，之后滚动只做二分查找） */
  rebuildTops() {
    this.tops = this.sheets.map((sheet) => sheet.offsetTop);
  }

  /** 根据滚动偏移量反查页码（1 基） */
  pageAtOffset(offset) {
    if (!this.tops) this.rebuildTops();
    let low = 0;
    let high = this.tops.length - 1;
    let page = 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (this.tops[mid] <= offset) {
        page = mid + 1;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return page;
  }

  /** 渲染当前窗口内的页，并卸载离视口太远的已渲染页 */
  renderWindow() {
    if (!this.sheets.length || !this.pdf) return;
    const top = this.scrollArea.scrollTop;
    const height = this.scrollArea.clientHeight;
    const first = Math.max(1, this.pageAtOffset(top - 400) - 1);
    const last = Math.min(this.numPages, this.pageAtOffset(top + height + 400) + 1);

    for (let page = first; page <= last; page++) this.renderPage(page);

    const keepFrom = first - KEEP_BEHIND;
    const keepTo = last + KEEP_AHEAD;
    for (const pageNo of [...this.rendered.keys()]) {
      if (pageNo < keepFrom || pageNo > keepTo) this.unloadPage(pageNo);
    }
  }

  /** 夹在允许范围内，并保留 1% 精度：75% / 125% 这类常用比例不会被舍入成 80% / 130% */
  clampZoom(zoom) {
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom * 100) / 100));
  }

  /** 「适合页面」的比例：整页宽高都落在可视区内，并为顶部留白与底部工具栏让位 */
  fitPageZoom() {
    const availableWidth = Math.max(240, this.scrollArea.clientWidth - 96);
    // .pdf-stack 顶部留白 32px；底部再让出 60px 的悬浮工具栏和 12px 间距
    const availableHeight = Math.max(240, this.scrollArea.clientHeight - 32 - 60 - 12);
    const byWidth = availableWidth / this.baseWidth;
    const byHeight = availableHeight / (this.baseWidth * this.aspect);
    // 向下取到 1%：宁可略小一点，也要保证整页不会超出一屏
    return Math.floor(Math.min(byWidth, byHeight) * 100) / 100;
  }

  /** 适合页面：完整展示一页 */
  fitPage() {
    if (!this.pdf || !this.sheets.length) return;
    this.setZoom(this.fitPageZoom(), this.page, true);
  }

  setZoom(zoom, anchorPage = this.page, fitMode = false) {
    this.fitMode = fitMode;
    this.zoom = this.clampZoom(zoom);
    const width = this.pageWidth();
    const height = Math.round(width * this.aspect);
    // 缩放后所有画布都失效，先统一取消在途渲染并释放
    for (const task of this.tasks.values()) task.cancel();
    this.tasks.clear();
    this.rendering.clear();
    this.rendered.clear();

    this.sheets.forEach((sheet, index) => {
      sheet.style.width = `${width}px`;
      sheet.style.height = `${height}px`;
      const canvas = sheet.querySelector("canvas");
      if (canvas && sheet.classList.contains("is-ready")) {
        // 已渲染的页：先把旧画布拉伸到新尺寸顶着，等新画布画好再替换，
        // 这样缩放过程中始终有内容，不会先闪出一片空白占位。
        // 同时登记为「过期」，远处页面仍能照常被卸载回收内存
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        sheet.classList.add("is-scaling");
        this.rendered.set(index + 1, null);
        return;
      }
      sheet.classList.remove("is-ready");
      sheet.innerHTML = `<div class="pdf-placeholder" style="width:100%;height:100%">${t("pdf.pageN", { page: index + 1 })}</div>`;
    });
    this.tops = null;

    this.renderWindow();
    requestAnimationFrame(() => this.goPage(anchorPage, false));
  }

  goPage(page, smooth = true) {
    if (!this.sheets.length) return;
    const target = Math.min(this.numPages, Math.max(1, Number(page) || 1));
    this.page = target;
    const sheet = this.sheets[target - 1];
    const top = Math.max(0, sheet.offsetTop - 16);
    if (smooth) this.scrollArea.scrollTo({ top, behavior: "smooth" });
    else this.setScrollTop(top);
    this.emitProgress();
  }

  /** 直接落位：容器的 CSS scroll-behavior 是 smooth，同步时必须跳过动画否则两栏会一直追赶 */
  setScrollTop(top) {
    const area = this.scrollArea;
    const previous = area.style.scrollBehavior;
    area.style.scrollBehavior = "auto";
    area.scrollTop = Math.max(0, top);
    area.style.scrollBehavior = previous;
  }

  /** 当前阅读位置：所在页码 + 该页内的相对位置（0-1，按探针所在位置计算） */
  currentPosition() {
    if (!this.sheets.length) return { page: this.page, fraction: 0 };
    const point = this.scrollArea.scrollTop + READ_POINT;
    const page = Math.min(this.numPages, Math.max(1, this.pageAtOffset(point)));
    const sheet = this.sheets[page - 1];
    if (!sheet) return { page, fraction: 0 };
    const height = sheet.offsetHeight || 1;
    return { page, fraction: clamp01((point - sheet.offsetTop) / height) };
  }

  /** 跳到「某页的某个相对位置」：用于同文档联动，保证两栏页内位置也一致 */
  goPosition(page, fraction = 0) {
    if (!this.sheets.length) return;
    const target = Math.min(this.numPages, Math.max(1, Number(page) || 1));
    if (!this.sheets[target - 1]) return;
    // 占位页高度是按第 1 页比例估算的，与真实页高可能相差很多（横版页尤甚）；
    // 记下锚点，等周边页面渲染、布局稳定后反复校正，直到页内比例吻合
    this.pendingAnchor = { page: target, fraction: clamp01(fraction) };
    this.alignToAnchor(true);
  }

  /**
   * 按锚点落位；周边页面渲染导致高度变化后会再次调用，直到落位误差小于 1px。
   * first 为 true 表示这是联动刚下发的落位指令，必须直接执行（可能跨多页跳转）。
   */
  alignToAnchor(first = false) {
    const anchor = this.pendingAnchor;
    if (!anchor || !this.sheets.length) return;
    const sheet = this.sheets[anchor.page - 1];
    if (!sheet) {
      this.pendingAnchor = null;
      return;
    }
    // 后续校正时若发现已远离锚点，说明用户自己滚走了（或换了文档），不要再拉回来
    if (!first && Math.abs(this.pageAtOffset(this.scrollArea.scrollTop + READ_POINT) - anchor.page) > 2) {
      this.pendingAnchor = null;
      return;
    }
    const height = sheet.offsetHeight || 1;
    const wanted = sheet.offsetTop + anchor.fraction * height - READ_POINT;
    if (!first && Math.abs(wanted - this.scrollArea.scrollTop) < 1) {
      this.pendingAnchor = null;
      return;
    }
    this.page = anchor.page;
    this.setScrollTop(wanted);
    // 布局刚变过，滚动位置缓存失效
    this.tops = null;
    this.emitProgress();
  }

  /** 用户接管阅读位置时放弃未完成的联动校正，避免后续渲染把位置拉回旧锚点 */
  clearAnchor() {
    this.pendingAnchor = null;
  }

  handleScroll() {
    if (this.scrollTicking) return;
    this.scrollTicking = requestAnimationFrame(() => {
      this.scrollTicking = 0;
      if (!this.sheets.length) return;
      this.renderWindow();
      this.emitProgress();
    });
  }

  emitProgress() {
    const max = this.scrollArea.scrollHeight - this.scrollArea.clientHeight;
    const ratio = max > 0 ? Math.min(1, Math.max(0, this.scrollArea.scrollTop / max)) : 0;
    const { page, fraction } = this.currentPosition();
    this.page = page;
    this.onPageChange?.({ page, zoom: this.zoom, ratio, total: this.numPages, pageOffset: fraction });
  }

  handleResize() {
    if (!this.pdf) return;
    // 演示模式放映中：窗口变化由放映层处理，阅读视图保持原样，退出后再统一适配
    if (this.suspended) return;
    const area = this.scrollArea;
    // 分栏被隐藏时容器宽度为 0，若继续重算会把基准宽度压到最小值并触发整篇重排
    if (!area.clientWidth) return;
    const width = Math.min(780, Math.max(360, area.clientWidth - 96));
    const height = area.clientHeight;
    const widthChanged = Math.abs(width - this.baseWidth) >= 24;
    // 适合页面模式下高度变化同样影响整页能否看全，需要重新适配
    const heightChanged = this.fitMode && Math.abs(height - this.lastHeight) >= 24;
    if (!widthChanged && !heightChanged) return;
    this.baseWidth = width;
    this.lastHeight = height;
    this.setZoom(this.fitMode ? this.fitPageZoom() : this.zoom, this.page, this.fitMode);
  }

  /** 解析大纲为扁平目录 */
  async outline() {
    if (!this.pdf) return [];
    let raw = [];
    try {
      raw = (await this.pdf.getOutline()) || [];
    } catch (_) {
      return [];
    }
    const items = [];
    const walk = async (list, level) => {
      for (const node of list) {
        const page = await this.destPage(node.dest);
        items.push({
          level: Math.min(4, level),
          id: String(page),
          text: node.title || t("pdf.untitledSection"),
          page,
        });
        if (node.items?.length) await walk(node.items, level + 1);
      }
    };
    await walk(raw, 1);
    return items;
  }

  async destPage(dest) {
    try {
      let target = dest;
      if (typeof target === "string") target = await this.pdf.getDestination(target);
      if (Array.isArray(target) && target.length) {
        return (await this.pdf.getPageIndex(target[0])) + 1;
      }
    } catch (_) {
      /* 忽略无法解析的跳转目标 */
    }
    return 1;
  }

  async textOf(pageNo) {
    if (!this.textCache.has(pageNo)) {
      const page = await this.pdf.getPage(pageNo);
      const content = await page.getTextContent();
      this.textCache.set(pageNo, content.items.map((item) => item.str).join(" "));
    }
    return this.textCache.get(pageNo);
  }

  async search(query, onProgress) {
    const q = query.trim().toLowerCase();
    if (!q || !this.pdf) return [];
    const hits = [];
    for (let i = 1; i <= this.numPages; i++) {
      const text = await this.textOf(i);
      const index = text.toLowerCase().indexOf(q);
      if (index >= 0) {
        hits.push({
          page: i,
          text: text.slice(Math.max(0, index - 26), index + 74),
          query,
        });
        if (hits.length >= 60) break;
      }
      onProgress?.(i, this.numPages);
    }
    return hits;
  }

  /** 取某一页已渲染好的画布：进入演示时直接复用，省掉一次整页渲染 */
  pageSnapshot(pageNo) {
    const sheet = this.sheets[pageNo - 1];
    const canvas = sheet?.querySelector("canvas");
    return canvas && canvas.width > 0 ? canvas : null;
  }

  /** 演示模式：把某页等比缩放到给定画布上（不超出 box，也不做超采样） */
  async paintFit(pageNo, canvas, box, isStale) {
    if (!this.pdf) return false;
    const total = this.numPages || 1;
    const target = Math.min(total, Math.max(1, Math.round(pageNo)));
    const page = await this.pdf.getPage(target);
    // getPage 期间可能又翻页了，先问一下调用方是否已过期，省下一次整页渲染
    if (isStale?.()) return false;
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(box.width / base.width, box.height / base.height);
    const viewport = page.getViewport({ scale });
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
    canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;

    // 保留任务句柄：翻页时可以先取消旧页渲染，避免排队等待
    const task = page.render({
      canvasContext: canvas.getContext("2d", { alpha: false }),
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    });
    this.fitTask = task;
    try {
      await task.promise;
      return true;
    } catch (_) {
      return false; // 被取消（翻页 / 退出演示）
    } finally {
      if (this.fitTask === task) this.fitTask = null;
    }
  }

  /** 取消演示页的在途渲染：翻页/退出时立即让出主线程，不必等旧页画完 */
  cancelPaintFit() {
    this.fitTask?.cancel();
    this.fitTask = null;
  }

  /** 演示模式开始：挂起尺寸自适应，并取消在途页渲染，把主线程让给放映首帧 */
  suspend() {
    this.suspended = true;
    for (const task of this.tasks.values()) task.cancel();
    this.tasks.clear();
    this.rendering.clear();
  }

  /** 演示模式结束：恢复渲染与尺寸自适应 */
  resume() {
    this.suspended = false;
  }

  async renderThumb(pageNo, canvas, width = 108) {
    if (!this.pdf) return;
    const page = await this.pdf.getPage(pageNo);
    const baseViewport = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / baseViewport.width });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    await page.render({
      canvasContext: canvas.getContext("2d", { alpha: false }),
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    }).promise;
  }

  destroy() {
    this.token += 1;
    for (const task of this.tasks.values()) task.cancel();
    this.tasks.clear();
    this.rendering.clear();
    this.transport?.abort();
    this.transport = null;
    this.scrollArea.removeEventListener("scroll", this.handleScroll);
    window.removeEventListener("resize", this.handleResize);
    if (this.pdf) {
      this.pdf.destroy();
      this.pdf = null;
    }
    this.stack.innerHTML = "";
    this.sheets = [];
    this.rendered.clear();
    this.textCache.clear();
    this.tops = null;
    this.pendingAnchor = null;
    this.page = 1;
    this.numPages = 0;
  }
}
