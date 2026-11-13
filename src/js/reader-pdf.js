/**
 * pdf.js 阅读器：连续滚动 + 懒渲染 + 文本层选择 + 大纲 + 搜索 + 缩略图。
 */
import * as pdfjsLib from "../vendor/pdfjs/pdf.mjs";
import { convertFileSrc, invoke } from "./api.js";
import { t } from "./i18n.js";

const VENDOR = new URL("../vendor/pdfjs/", import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.mjs", import.meta.url).href;

// 下限放到 25%：窗口较小时「适合页面」需要把整页缩到 50% 以下才能看全
export const ZOOM_MIN = 0.25;
/// 上限与常见阅读器一致（400%）
export const ZOOM_MAX = 4;

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

/* ---------------- 目录页识别 ---------------- */
/// 目录页标题：中英文常见写法
const TOC_TITLE_RE = /^(目\s*录|contents?|table\s+of\s+contents)$/i;
/// 目录条目：「标题 + 分隔符 + 页码」，页脚页码允许阿拉伯数字或罗马数字
const TOC_ENTRY_RE = /^(.*?)[\s.·…]{1,}(\d{1,4}|[ivxlcdm]{1,7})$/i;

/** 把文本项按纵坐标聚成行（自上而下），行内再按横坐标排好 */
function groupTextLines(items) {
  const rows = [];
  for (const item of items) {
    if (!item.str || !item.str.trim()) continue;
    const y = item.transform[5];
    const gap = Math.max(3, (Math.abs(item.height) || 10) * 0.4);
    let row = rows.find((candidate) => Math.abs(candidate.y - y) <= gap);
    if (!row) {
      row = { y, items: [] };
      rows.push(row);
    }
    row.items.push(item);
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((row) => {
    row.items.sort((a, b) => a.transform[4] - b.transform[4]);
    return { y: row.y, items: row.items, text: lineText(row.items) };
  });
}

/** 拼接一行文本：横向间距明显时补空格，避免「标题」和右侧页码粘在一起 */
function lineText(items) {
  let text = "";
  let prevRight = null;
  for (const item of items) {
    const left = item.transform[4];
    if (prevRight != null && left - prevRight > (Math.abs(item.height) || 10) * 0.5) text += " ";
    text += item.str;
    prevRight = left + (item.width || 0);
  }
  return text.replace(/\s+/g, " ").trim();
}

/** 解析一行目录条目；不像条目时返回 null */
function parseTocEntry(raw) {
  const text = String(raw || "").replace(/\s+/g, " ").trim();
  const matched = text.match(TOC_ENTRY_RE);
  if (!matched) return null;
  const title = matched[1].replace(/[.·…\s]+$/, "").trim();
  // 纯数字的「标题」多半是页码行或图表编号，跳过
  if (!title || /^\d+$/.test(title)) return null;
  return { title, printed: matched[2].toLowerCase() };
}

/** 行在页面上的实际像素矩形：用与文本层相同的变换把 PDF 坐标换算过来 */
function lineDeviceRect(line, viewport) {
  if (!line?.items.length) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const item of line.items) {
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontHeight = Math.hypot(tx[2], tx[3]) || 10;
    left = Math.min(left, tx[4]);
    top = Math.min(top, tx[5] - fontHeight);
    right = Math.max(right, tx[4] + (item.width || 0) * viewport.scale);
    bottom = Math.max(bottom, tx[5] + fontHeight * 0.25);
  }
  if (!Number.isFinite(left) || right <= left) return null;
  return { left, top, width: right - left, height: Math.max(10, bottom - top) };
}

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
  constructor({ stack, scrollArea, onPageChange, onReady, onError, onZoom }) {
    this.stack = stack;
    this.scrollArea = scrollArea;
    this.onPageChange = onPageChange;
    this.onReady = onReady;
    this.onError = onError;
    this.onZoom = onZoom;

    this.pdf = null;
    this.zoom = 1;
    // 适配模式："page" 适合页面、"width" 适合宽度、null 固定比例；
    // 前两者在窗口或分栏尺寸变化时按可视区重新计算
    this.fitMode = null;
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
    // 识别出的目录页：页码 -> 条目（行号、标题、目标页），用于生成可点击区域
    this.tocPages = null;
    this.tocEntries = [];

    this.handleScroll = this.handleScroll.bind(this);
    this.handleResize = this.handleResize.bind(this);
    this.handleStackClick = this.handleStackClick.bind(this);
    // 目录页的点击区域是动态插入的，用事件委托挂在栈上
    this.stack.addEventListener("click", this.handleStackClick);
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

    this.fitMode = zoom == null ? "page" : null;
    this.zoom = this.fitMode ? this.fitPageZoom() : this.clampZoom(zoom);
    this.lastHeight = this.scrollArea.clientHeight;

    this.buildPlaceholders();
    this.scrollArea.addEventListener("scroll", this.handleScroll, { passive: true });
    window.addEventListener("resize", this.handleResize);

    this.onReady?.({ pages: this.numPages });
    this.goPage(startPage, false);
    // 目录页识别放后台跑：不拖慢打开速度，识别完成后给已渲染的目录页补上跳转区域
    this.detectTocPages().catch(() => {});
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
    // 目录页：把识别出的条目盖成可点击区域（异步，不阻塞绘制）
    this.buildTocHits(sheet, pageNo, page, viewport);
    // 实际页高与占位高度可能有差异，作废滚动位置缓存
    this.tops = null;
    // 若正按联动锚点落位，这一页的真实高度会改变布局，需要重新校正一次
    this.alignToAnchor();
  }

  /* ---------------- 目录页识别与跳转 ---------------- */

  /** 点击目录页条目：跳到识别出的目标页 */
  handleStackClick(event) {
    const hit = event.target.closest?.(".pdf-toc-hit");
    if (!hit) return;
    const target = Number(hit.dataset.tocTarget);
    if (target) this.goPage(target, false);
  }

  /** 取一页的文本行；pdf.js 会缓存文本内容，重复调用开销很小 */
  async pageLines(pageNo) {
    if (!this.pdf) return null;
    try {
      const page = await this.pdf.getPage(pageNo);
      const content = await page.getTextContent();
      return groupTextLines(content.items);
    } catch (_) {
      return null; // 文档已切换或该页无法解析
    }
  }

  /**
   * 识别目录页：扫描开头若干页，找带「目录 / Contents」标题
   * （或条目足够密集）的页，并解析出「标题 + 页码」条目。
   */
  async detectTocPages() {
    if (!this.pdf || !this.numPages) return;
    const token = this.token;
    const scanCount = Math.min(this.numPages, 15);
    const pages = [];
    for (let pageNo = 1; pageNo <= scanCount; pageNo++) {
      const lines = await this.pageLines(pageNo);
      if (token !== this.token) return;
      if (!lines?.length) continue;
      const hasTitle = lines.slice(0, 8).some((line) => TOC_TITLE_RE.test(line.text));
      const items = [];
      lines.forEach((line, index) => {
        const entry = parseTocEntry(line.text);
        if (entry) items.push({ line: index, ...entry });
      });
      // 没有标题时要求条目足够多，避免把索引页、参考文献当成目录
      if (!items.length || (!hasTitle && items.length < 8)) continue;
      pages.push({ pageNo, items });
    }
    if (!pages.length || token !== this.token) return;

    // 印刷页码 -> 实际页码：优先用 PDF 自带的页码标签，缺失时按页脚数字推算偏移
    const labels = await this.pageLabels();
    let offset;
    const resolveTarget = async (printed) => {
      const key = printed.toLowerCase();
      if (labels?.has(key)) return labels.get(key);
      if (!/^\d{1,4}$/.test(key)) return null;
      if (offset === undefined) offset = await this.estimatePageOffset(pages[pages.length - 1].pageNo, token);
      if (offset == null) return null;
      const target = Number(key) + offset;
      return target >= 1 && target <= this.numPages ? target : null;
    };

    const tocPages = new Map();
    const entries = [];
    for (const page of pages) {
      const resolved = [];
      for (const item of page.items) {
        const targetPage = await resolveTarget(item.printed);
        // 指向自身或无法定位的条目不生成点击区域，避免点了没反应
        if (!targetPage || targetPage === page.pageNo) continue;
        resolved.push({ line: item.line, title: item.title, targetPage });
      }
      if (!resolved.length) continue;
      tocPages.set(page.pageNo, resolved);
      resolved.forEach((entry) => entries.push({ page: page.pageNo, ...entry }));
    }
    if (token !== this.token || !tocPages.size) return;

    this.tocPages = tocPages;
    this.tocEntries = entries;
    // 识别是后台完成的：已经渲染好的目录页需要补一次点击区域
    for (const pageNo of tocPages.keys()) this.refreshTocOverlay(pageNo);
  }

  /** PDF 自带的页码标签（如封面无标签、前言 i/ii、正文 1、2…） */
  async pageLabels() {
    try {
      const labels = await this.pdf.getPageLabels();
      if (!Array.isArray(labels) || !labels.length) return null;
      const map = new Map();
      labels.forEach((label, index) => {
        const key = String(label || "").trim().toLowerCase();
        if (key) map.set(key, index + 1);
      });
      return map.size ? map : null;
    } catch (_) {
      return null;
    }
  }

  /** 用目录之后的页脚数字推算「印刷页码 -> 实际页码」的偏移 */
  async estimatePageOffset(afterPage, token) {
    const offsets = [];
    const last = Math.min(this.numPages, afterPage + 4);
    for (let pageNo = afterPage + 1; pageNo <= last; pageNo++) {
      const lines = await this.pageLines(pageNo);
      if (token !== this.token) return null;
      if (!lines?.length) continue;
      // 页脚/页眉里单独成行的纯数字最可能是印刷页码，优先取最靠下的
      const numberLine = [...lines].reverse().find((line) => /^\d{1,4}$/.test(line.text));
      if (!numberLine) continue;
      const printed = Number(numberLine.text);
      if (printed > this.numPages) continue;
      offsets.push(pageNo - printed);
    }
    if (!offsets.length) return null;
    // 采样里可能混进非页码的数字，取出现次数最多的偏移
    const counts = new Map();
    offsets.forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }

  /** 给已渲染的目录页补上点击区域 */
  async refreshTocOverlay(pageNo) {
    const sheet = this.sheets[pageNo - 1];
    if (!sheet?.classList.contains("is-ready") || !this.pdf) return;
    try {
      const page = await this.pdf.getPage(pageNo);
      const base = page.getViewport({ scale: 1 });
      const width = parseFloat(sheet.style.width) || this.pageWidth();
      this.buildTocHits(sheet, pageNo, page, page.getViewport({ scale: width / base.width }));
    } catch (_) {
      /* 文档已切换 */
    }
  }

  /** 在目录页上按行生成透明按钮，点击即跳到对应页 */
  async buildTocHits(sheet, pageNo, page, viewport) {
    const entries = this.tocPages?.get(pageNo);
    if (!entries?.length || sheet.querySelector(".pdf-toc-layer")) return;
    let content;
    try {
      content = await page.getTextContent();
    } catch (_) {
      return;
    }
    // 等待期间可能已缩放或换文档，此时坐标与当前尺寸不再匹配
    if (!sheet.isConnected || Math.abs((parseFloat(sheet.style.width) || 0) - viewport.width) > 1.5) return;
    const lines = groupTextLines(content.items);
    const layer = document.createElement("div");
    layer.className = "pdf-toc-layer";
    for (const entry of entries) {
      const rect = lineDeviceRect(lines[entry.line], viewport);
      if (!rect) continue;
      const hit = document.createElement("button");
      hit.type = "button";
      hit.className = "pdf-toc-hit";
      hit.dataset.tocTarget = String(entry.targetPage);
      hit.title = `${entry.title} · ${t("reader.pageN", { page: entry.targetPage })}`;
      hit.style.left = `${rect.left}px`;
      hit.style.top = `${rect.top}px`;
      hit.style.width = `${rect.width}px`;
      hit.style.height = `${rect.height}px`;
      layer.appendChild(hit);
    }
    if (layer.childElementCount) sheet.appendChild(layer);
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

  /** 「适合宽度」的比例：页宽刚好撑满可视区，页面高度可超出，需上下滚动 */
  fitWidthZoom() {
    // .pdf-stack 左右各留白 32px，扣掉后即为可用宽度
    const availableWidth = Math.max(240, this.scrollArea.clientWidth - 64);
    return Math.floor((availableWidth / this.baseWidth) * 100) / 100;
  }

  /** 适合页面：完整展示一页 */
  fitPage() {
    if (!this.pdf || !this.sheets.length) return;
    this.setZoom(this.fitPageZoom(), null, "page");
  }

  /** 适合宽度：页宽撑满显示区域 */
  fitWidth() {
    if (!this.pdf || !this.sheets.length) return;
    this.setZoom(this.fitWidthZoom(), null, "width");
  }

  /**
   * 设置缩放比例。
   * anchorPage 为 null 时以当前阅读位置（页码 + 页内相对位置）为锚点，
   * 缩放后视线不跳动——这是常见阅读器的行为；显式传页码则回到该页顶部。
   */
  setZoom(zoom, anchorPage = null, fitMode = null) {
    const anchor = anchorPage == null ? this.currentPosition() : null;
    this.fitMode = fitMode;
    this.zoom = this.clampZoom(zoom);
    // 窗口变化导致的适配缩放也要刷新工具栏百分比
    this.onZoom?.(this.zoom);
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
      // 目录页点击区域是按旧比例算的坐标，先移除，重绘后再按新尺寸生成
      sheet.querySelector(".pdf-toc-layer")?.remove();
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
    requestAnimationFrame(() => {
      if (anchor) this.goPosition(anchor.page, anchor.fraction);
      else this.goPage(anchorPage, false);
    });
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
    // 「适合页面」时高度变化同样影响整页能否看全；「适合宽度」只与宽度有关
    const heightChanged = this.fitMode === "page" && Math.abs(height - this.lastHeight) >= 24;
    if (!widthChanged && !heightChanged) return;
    this.baseWidth = width;
    this.lastHeight = height;
    const fitZoom = this.fitMode === "page" ? this.fitPageZoom()
      : this.fitMode === "width" ? this.fitWidthZoom()
      : this.zoom;
    this.setZoom(fitZoom, null, this.fitMode);
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
    this.tocPages = null;
    this.tocEntries = [];
    this.page = 1;
    this.numPages = 0;
  }
}
