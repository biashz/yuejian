/**
 * pdf.js 阅读器：连续滚动 + 懒渲染 + 文本层选择 + 大纲 + 搜索 + 缩略图。
 */
import * as pdfjsLib from "../vendor/pdfjs/pdf.mjs";
import { convertFileSrc, invoke } from "./api.js";

const VENDOR = new URL("../vendor/pdfjs/", import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.mjs", import.meta.url).href;

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;

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
    this.observer = null;
    this.token = 0;
    this.baseWidth = 720;
    this.aspect = 1.414;
    // 每页滚动位置的缓存，避免逐帧对所有页做 offsetTop 读取（大文档会明显卡顿）
    this.tops = null;

    this.handleScroll = this.handleScroll.bind(this);
    this.handleResize = this.handleResize.bind(this);
  }

  async open(path, { startPage = 1, zoom = 1 } = {}) {
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
      // 优先走 asset 协议（支持 Range 请求，大文件友好）
      pdf = await pdfjsLib.getDocument({ url: convertFileSrc(path), ...options }).promise;
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

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) this.renderPage(Number(entry.target.dataset.page));
        }
      },
      { root: this.scrollArea, rootMargin: "700px 0px" }
    );
    this.sheets.forEach((sheet) => this.observer.observe(sheet));
  }

  async renderPage(pageNo) {
    if (!this.pdf) return;
    const sheet = this.sheets[pageNo - 1];
    if (!sheet || this.rendered.get(pageNo) === this.zoom) return;

    const token = this.token;
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

    await page.render({
      canvasContext: canvas.getContext("2d", { alpha: false }),
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    }).promise;
    if (token !== this.token) return;

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

  renderVisible() {
    if (!this.sheets.length) return;
    const top = this.scrollArea.scrollTop;
    const first = Math.max(1, this.pageAtOffset(top - 700) - 1);
    const last = Math.min(this.numPages, this.pageAtOffset(top + this.scrollArea.clientHeight + 700) + 1);
    for (let page = first; page <= last; page++) this.renderPage(page);
  }

  setZoom(zoom, anchorPage = this.page) {
    this.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom * 10) / 10));
    const width = this.pageWidth();
    const height = Math.round(width * this.aspect);
    this.rendered.clear();

    this.sheets.forEach((sheet, index) => {
      sheet.classList.remove("is-ready");
      sheet.style.width = `${width}px`;
      sheet.style.height = `${height}px`;
      sheet.innerHTML = `<div class="pdf-placeholder" style="width:100%;height:100%">第 ${index + 1} 页</div>`;
    });
    this.tops = null;

    this.renderVisible();
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
    this.observer?.disconnect();
    this.observer = null;
    this.scrollArea.removeEventListener("scroll", this.handleScroll);
    window.removeEventListener("resize", this.handleResize);
    if (this.pdf) {
      this.pdf.destroy();
      this.pdf = null;
    }
    this.sheets = [];
    this.rendered.clear();
    this.textCache.clear();
    this.tops = null;
    this.page = 1;
    this.numPages = 0;
  }
}
