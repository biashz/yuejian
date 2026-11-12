/**
 * pdf.js 阅读器：连续滚动 + 懒渲染 + 文本层选择 + 大纲 + 搜索 + 缩略图。
 */
import * as pdfjsLib from "../vendor/pdfjs/pdf.mjs";
import { convertFileSrc, invoke } from "./api.js";

const VENDOR = new URL("../vendor/pdfjs/", import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.mjs", import.meta.url).href;

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;

/// 超过该体积的 PDF 改走 IPC 分块读取：
/// asset 协议收到不带 Range 的请求时会把整个文件读进内存，GB 级文件会直接压垮进程
const RANGE_READ_THRESHOLD = 64 * 1024 * 1024;
/// 同时在渲染的页数上限，避免快速滚动时并发渲染把内存顶爆
const MAX_CONCURRENT_RENDERS = 2;
/// 视口外保留的已渲染页数，超出即卸载释放画布内存
const KEEP_BEHIND = 2;
const KEEP_AHEAD = 3;

/** 把 pdf.js 的按需读取接到 Rust 侧的分块读取命令上 */
class IpcRangeTransport extends pdfjsLib.PDFDataRangeTransport {
  constructor(path, length) {
    super(length, new Uint8Array(0));
    this.path = path;
    this.aborted = false;
  }

  requestDataRange(begin, end) {
    if (this.aborted) return;
    invoke("read_pdf_range", { path: this.path, begin, end })
      .then((bytes) => {
        if (this.aborted) return;
        this.onDataRange(begin, new Uint8Array(bytes));
      })
      .catch(() => {
        // 出错时抛出空块，让 pdf.js 明确失败，而不是一直等数据
        if (!this.aborted) this.onDataRange(begin, new Uint8Array(0));
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

    this.handleScroll = this.handleScroll.bind(this);
    this.handleResize = this.handleResize.bind(this);
  }

  async open(path, { startPage = 1, zoom = 1, size = 0 } = {}) {
    this.destroy();
    const token = ++this.token;
    this.stack.innerHTML = `<div class="pdf-loading"><span>正在解析 PDF…</span></div>`;
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
    try {
      if (size > RANGE_READ_THRESHOLD) {
        // 大文件：完全由我们按需供数，进程内存占用与文件大小脱钩
        const transport = new IpcRangeTransport(path, size);
        this.transport = transport;
        pdf = await pdfjsLib.getDocument({ range: transport, ...options, disableStream: true }).promise;
      } else {
        // 小文件：走 asset 协议（支持 Range 请求），路径更短更快
        pdf = await pdfjsLib.getDocument({ url: convertFileSrc(path), ...options }).promise;
      }
    } catch (primaryError) {
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
    this.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
    this.baseWidth = Math.min(780, Math.max(360, this.scrollArea.clientWidth - 96));

    const first = await pdf.getPage(1);
    const base = first.getViewport({ scale: 1 });
    this.aspect = base.height / base.width;

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
      sheet.innerHTML = `<div class="pdf-placeholder" style="width:100%;height:100%">第 ${i} 页</div>`;
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
    sheet.style.width = `${width}px`;
    sheet.style.height = `${Math.round(width * this.aspect)}px`;
    sheet.innerHTML = `<div class="pdf-placeholder" style="width:100%;height:100%">第 ${pageNo} 页</div>`;
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

    sheet.classList.add("is-ready");
    this.rendered.set(pageNo, this.zoom);
    // 实际页高与占位高度可能有差异，作废滚动位置缓存
    this.tops = null;
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

  setZoom(zoom, anchorPage = this.page) {
    this.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom * 10) / 10));
    const width = this.pageWidth();
    const height = Math.round(width * this.aspect);
    // 缩放后所有画布都失效，先统一取消在途渲染并释放
    for (const task of this.tasks.values()) task.cancel();
    this.tasks.clear();
    this.rendering.clear();
    this.rendered.clear();

    this.sheets.forEach((sheet, index) => {
      sheet.classList.remove("is-ready");
      sheet.style.width = `${width}px`;
      sheet.style.height = `${height}px`;
      sheet.innerHTML = `<div class="pdf-placeholder" style="width:100%;height:100%">第 ${index + 1} 页</div>`;
    });
    this.tops = null;

    this.renderWindow();
    requestAnimationFrame(() => this.goPage(anchorPage, false));
  }

  fitWidth() {
    this.setZoom(1);
  }

  goPage(page, smooth = true) {
    if (!this.sheets.length) return;
    const target = Math.min(this.numPages, Math.max(1, Number(page) || 1));
    this.page = target;
    const sheet = this.sheets[target - 1];
    this.scrollArea.scrollTo({ top: Math.max(0, sheet.offsetTop - 16), behavior: smooth ? "smooth" : "auto" });
    this.emitProgress();
  }

  handleScroll() {
    if (this.scrollTicking) return;
    this.scrollTicking = requestAnimationFrame(() => {
      this.scrollTicking = 0;
      if (!this.sheets.length) return;
      const current = this.pageAtOffset(this.scrollArea.scrollTop + 140);
      if (current !== this.page) this.page = current;
      this.renderWindow();
      this.emitProgress();
    });
  }

  emitProgress() {
    const max = this.scrollArea.scrollHeight - this.scrollArea.clientHeight;
    const ratio = max > 0 ? Math.min(1, Math.max(0, this.scrollArea.scrollTop / max)) : 0;
    this.onPageChange?.({ page: this.page, zoom: this.zoom, ratio, total: this.numPages });
  }

  handleResize() {
    if (!this.pdf) return;
    const width = Math.min(780, Math.max(360, this.scrollArea.clientWidth - 96));
    if (Math.abs(width - this.baseWidth) < 24) return;
    this.baseWidth = width;
    this.setZoom(this.zoom);
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
          text: node.title || "未命名章节",
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
    this.page = 1;
    this.numPages = 0;
  }
}
