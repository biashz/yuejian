/**
 * 侧栏视图：文档大纲、页面缩略图、文本信息、全文搜索。全部针对「当前活动栏」渲染。
 */
import { $, $$, escapeHtml } from "../core/dom.js";
import { invoke } from "../api.js";
import { t } from "../i18n.js";
import { state } from "../core/session.js";
import { kindLabel } from "../core/constants.js";
import { formatBytes } from "../core/format.js";
import { activePane } from "./panes.js";
import { canHighlight, willHighlight } from "../reader-text.js";
import { delimiterLabel } from "../reader-csv.js";

/* 每种文档能用的侧栏视图：PDF 有缩略图，文本类没有大纲但有文件信息，
   电子书的目录来自书本身的 NAV/NCX（不是扫描标题），所以只有目录与信息 */
const TABS_BY_KIND = {
  pdf: ["toc", "thumbs", "find"],
  text: ["info", "find"],
  ebook: ["toc", "marks", "find", "info"],
};

/**
 * 可手动指定的编码。`value` 直接作为标签传给 Rust（`encoding_rs` 认识这些别名），
 * 空串表示交回自动检测。
 *
 * 不必列全部几百种编码：会来切换的场景几乎只有「中文老文件被当成西文解」，
 * 按语种给出最常见的几种即可，列一屏反而不知道选哪个。GB18030 是 GBK / GB2312
 * 的超集，中文三项合并成一条，用户不必再区分自己那份是哪一年的标准。
 */
const ENCODINGS = [
  { value: "", key: "reader.encAuto" },
  { value: "utf-8", key: "reader.encUtf8" },
  { value: "gb18030", key: "reader.encGb" },
  { value: "big5", key: "reader.encBig5" },
  { value: "shift_jis", key: "reader.encSjis" },
  { value: "euc-kr", key: "reader.encKr" },
  { value: "windows-1252", key: "reader.encLatin" },
  { value: "utf-16le", key: "reader.encUtf16le" },
  { value: "utf-16be", key: "reader.encUtf16be" },
];


/* 本模块自有的可变句柄，不对外暴露 */
let findTimer = 0;
let findToken = 0;
/* 电子书搜索的取消开关：库的异步生成器没法从外面中断，只能每轮看它一眼 */
let findAbort = { cancelled: true };
let thumbObserver = null;
/* ---------------- 目录 / 缩略图 / 搜索 ---------------- */
function setCtxOpen(open) {
  state.ctxOpen = open;
  $("#ctxPanel").classList.toggle("is-hidden", !open);
  $("#ctxBtn").classList.toggle("is-on", open);
  const button = $('[data-act="ctx"]');
  if (button) button.classList.toggle("is-on", open);
}

function setCtxTabActive(tab) {
  state.ctxTab = tab;
  $$("#ctxTabs .ctx-tab").forEach((item) => item.classList.toggle("is-on", item.dataset.ctx === tab));
}

function switchCtxTab(tab) {
  setCtxTabActive(tab);
  renderCtx();
}

/**
 * 按文档类型显示/隐藏侧栏标签。
 * 文本类没有 PDF 大纲，也没有缩略图，硬留着两个空 tab 只会让人多点两次。
 */
function syncCtxTabs(book) {
  const allowed = TABS_BY_KIND[book.kind] || ["toc", "thumbs", "find"];
  if (!allowed.includes(state.ctxTab)) state.ctxTab = allowed[0];
  $$("#ctxTabs .ctx-tab").forEach((tab) => {
    tab.hidden = !allowed.includes(tab.dataset.ctx);
    tab.classList.toggle("is-on", tab.dataset.ctx === state.ctxTab);
  });
}

function renderCtx() {
  const book = state.current;
  if (!book) return;
  syncCtxTabs(book);
  if (state.ctxTab === "info") return renderInfo();
  if (state.ctxTab === "toc") return renderToc();
  if (state.ctxTab === "marks") return renderMarks();
  if (state.ctxTab === "thumbs") return renderThumbs();
  return renderFind();
}

/**
 * 信息面板里「高亮」这一行只回答「开没开」，不写语言名。
 * 语言是哪个，上面「类型」徽标（RS / JSON / YAML）已经说了；而且 hljs 的
 * 语言名是给内部用的，`ini` 会显示成「TOML, also INI」，直接放出来更糊涂。
 */
function highlightLabel(doc) {
  if (!doc.lang) return t("reader.infoLangNone");
  if (!canHighlight(doc)) return t("reader.infoLangOff");
  return willHighlight(doc) ? t("reader.infoLangOn") : t("reader.infoLangUnsupported");
}

/**
 * 编码下拉。当前生效的是「书架里记的手动值」，不是 `doc.encoding`——
 * 后者是解码后回填的结果，自动检测时它也有值，分不出「用户选的」还是「猜的」。
 */
function encodingMenu(current) {
  const items = ENCODINGS.map((item) => `
    <button class="enc-item ${item.value === current ? "is-on" : ""}"
      role="menuitemradio" aria-checked="${item.value === current}" data-enc="${item.value}">
      ${t(item.key)}
    </button>`).join("");
  return `<div class="enc-menu" id="encMenu" role="menu" hidden>${items}</div>`;
}

/** 文本类的文件信息：编码、行数、字符数、换行符。编码是重点——探测可能不准 */
function renderInfo() {
  const body = $("#ctxBody");
  const pane = activePane();
  const doc = pane?.doc;
  if (doc?.kind === "ebook") return renderEbookInfo(pane);
  if (!doc || doc.kind !== "text") {
    body.innerHTML = `<div class="ctx-empty">${t("reader.infoEmpty")}</div>`;
    return;
  }
  const row = (key, value) => `<div class="info-row"><dt>${key}</dt><dd>${escapeHtml(value)}</dd></div>`;
  // 编码一行可点开：探测错了就在这里当场换一个重开，不必去翻设置
  const manual = pane.book?.encoding || "";
  const encodingRow = `
    <div class="info-row is-action">
      <dt>${t("reader.infoEncoding")}</dt>
      <dd><button class="info-enc" data-enc-toggle aria-haspopup="true" aria-expanded="false"
        aria-controls="encMenu">${escapeHtml(doc.encoding)}<span class="info-enc-tag">${
          manual ? t("reader.encManual") : t("reader.encAutoTag")
        }</span><span class="info-caret" aria-hidden="true">▾</span></button></dd>
    </div>`;

  const rows = [row(t("reader.infoKind"), kindLabel("text", pane.book)), encodingRow, encodingMenu(manual), row(t("reader.infoLines"), String(doc.lines))];
  // 大文件不整篇解码，字符数根本统计不出来——这一行宁可不显示，也不写 0 骗人
  if (!doc.windowed) rows.push(row(t("reader.infoChars"), String(doc.chars)));
  rows.push(
    row(t("reader.infoEol"), doc.eol),
    row(t("reader.infoSize"), formatBytes(pane.book?.size || 0)),
    row(t("reader.infoLang"), highlightLabel(doc)),
  );
  // 分隔符只在表格类文档上有意义：它决定了列是怎么拆的，拆错了要能看出来
  if (doc.mode === "table" && !doc.windowed) {
    const delimiter = pane.table?.delimiter || ",";
    rows.push(row(t("reader.infoDelimiter"), t(`reader.infoDelimiter.${delimiterLabel(delimiter)}`)));
  }
  body.innerHTML = `
    <dl class="info-list">${rows.join("")}</dl>
    ${doc.windowed ? `<p class="info-note">${t("reader.infoWindowed")}</p>` : ""}
    ${doc.clipped ? `<p class="info-note">${t("reader.infoClipped")}</p>` : ""}
    ${doc.truncated ? `<p class="info-note">${t("reader.infoTruncated")}</p>` : ""}
    ${pane.table?.clipped ? `<p class="info-note">${t("reader.infoTableClipped")}</p>` : ""}
    <p class="info-note">${t("reader.infoEncodingHint")}</p>`;
}

/**
 * 电子书信息：出版元数据来自书本身（OPF），比书架当初从文件名猜的可靠。
 * 这里只读不写——书名与作者在打开时已经回填到书架条目上了。
 */
function renderEbookInfo(pane) {
  const body = $("#ctxBody");
  const book = pane?.book;
  const meta = pane?.ebook?.book?.metadata || {};
  const row = (key, value) => `<div class="info-row"><dt>${key}</dt><dd>${escapeHtml(value)}</dd></div>`;
  const rows = [
    row(t("reader.infoKind"), kindLabel("ebook", book)),
    row(t("reader.infoChapters"), String(pane?.ebook?.chapters || pane?.ebookToc?.length || 0)),
    row(t("reader.infoSize"), formatBytes(book?.size || 0)),
  ];
  if (meta.title) rows.push(row(t("reader.infoTitle"), String(meta.title)));
  if (meta.author) rows.push(row(t("reader.infoAuthor"), String(meta.author)));
  if (meta.publisher) rows.push(row(t("reader.infoPublisher"), String(meta.publisher)));
  if (meta.language) rows.push(row(t("reader.infoLanguage"), String(meta.language)));
  body.innerHTML = `<dl class="info-list">${rows.join("")}</dl>
    <p class="info-note">${t("reader.infoEbookHint")}</p>`;
}

async function renderToc() {
  const body = $("#ctxBody");
  const pane = activePane();
  const book = pane?.book;
  if (!book) return;

  if (book.kind === "pdf") {
    if (!pane.outline) {
      // PDF 尚未解析完成时先占位，等 onReady 再取大纲
      if (!pane.reader?.pdf) {
        body.innerHTML = `<div class="ctx-empty">${t("reader.tocLoading")}</div>`;
        return;
      }
      let outline = [];
      try {
        outline = await pane.reader.outline() || [];
      } catch (_) {
        outline = [];
      }
      if (state.ctxTab !== "toc" || activePane() !== pane || pane.book?.id !== book.id) return;
      pane.outline = outline;
      state.pdfOutline = outline;
    }
    if (!pane.outline.length) {
      body.innerHTML = `<div class="ctx-empty">${t("reader.tocPdfEmpty")}</div>`;
      return;
    }
    body.innerHTML = pane.outline.map((item) => `
      <button class="toc-item ${item.page === pane.page ? "is-active" : ""}"
        data-level="${item.level}" data-goto="${item.page}" data-kind="pdf">
        ${escapeHtml(item.text)}<span class="toc-page">${item.page}</span>
      </button>`).join("");
    return;
  }

  // 电子书的目录是书自带的 NAV/NCX，可能是空的一本（只有正文没有目录）
  if (book.kind === "ebook") {
    const items = pane.ebookToc || [];
    if (!items.length) {
      body.innerHTML = `<div class="ctx-empty">${t("reader.tocEbookEmpty")}</div>`;
      return;
    }
    body.innerHTML = items.map((item) => `
      <button class="toc-item" data-level="${item.level}" data-goto="${escapeHtml(item.href)}" data-kind="ebook">
        ${escapeHtml(item.label)}
      </button>`).join("");
    markTocActive();
    return;
  }

  const toc = pane.doc?.toc || [];
  if (!toc.length) {
    body.innerHTML = `<div class="ctx-empty">${t("reader.tocMdEmpty")}</div>`;
    return;
  }
  body.innerHTML = toc.map((item) => `
    <button class="toc-item" data-level="${item.level}" data-goto="${escapeHtml(item.id)}" data-kind="md">
      ${escapeHtml(item.text)}
    </button>`).join("");
  markTocActive();
}

function markTocActive(id) {
  const items = $$("#ctxBody .toc-item");
  if (!items.length) return;
  if (typeof id === "string" && id) {
    items.forEach((item) => item.classList.toggle("is-active", item.dataset.goto === id));
    return;
  }
  const pane = activePane();
  // 电子书：目录项的 href 可能带锚点，当前定位也可能是同一文件的另一处，
  // 所以先找完全相同的，再退化成「同一个文件」的最后一项
  if (pane?.book?.kind === "ebook") {
    const href = state.ebookHref || pane.ebook?.location?.href || "";
    if (!href) return;
    const file = href.split("#")[0];
    let activeIndex = -1;
    items.forEach((item, index) => {
      const target = item.dataset.goto || "";
      if (target === href) activeIndex = index;
      else if (activeIndex < 0 && target.split("#")[0] === file) activeIndex = index;
    });
    items.forEach((item, index) => item.classList.toggle("is-active", index === activeIndex));
    return;
  }
  if (!pane?.outline?.length) return;
  // PDF：取最后一个页码不超过当前页的条目
  let activeIndex = 0;
  pane.outline.forEach((item, index) => {
    if (item.page <= pane.page) activeIndex = index;
  });
  items.forEach((item, index) => item.classList.toggle("is-active", index === activeIndex));
}

/**
 * 书签列表。
 *
 * 顺序按加入时间，不按阅读位置：CFI 的先后关系要解析才能比，而书签本来就少，
 * 「最近加的在哪」比「在书里哪一处」更有用。
 *
 * 每条右侧带删除按钮——书签是随手加的，删不掉的话很快就变成一堆没用的定位点。
 */
function renderMarks() {
  const body = $("#ctxBody");
  const pane = activePane();
  const marks = pane?.book?.bookmarks || [];
  if (!marks.length) {
    body.innerHTML = `<div class="ctx-empty">${t("reader.marksEmpty")}</div>`;
    return;
  }
  body.innerHTML = `
    <div class="mark-count">${t("reader.markCount", { count: marks.length })}</div>
    ${marks.map((mark, index) => `
      <div class="mark-row">
        <button class="find-hit mark-main" data-mark-hit="${index}">
          <span class="hit-page">${escapeHtml(mark.label || t("reader.ebookNoChapter"))}</span>
          ${escapeHtml(markAt(mark))}
        </button>
        <button class="mark-del" data-unmark="${index}" title="${t("reader.markRemove")}" aria-label="${t("reader.markRemove")}">×</button>
      </div>`).join("")}`;
}

/** 书签的时刻：只到分钟，够区分「今天读的两段」 */
function markAt(mark) {
  const date = new Date(Number(mark.createdAt) || 0);
  if (Number.isNaN(date.getTime()) || !mark.createdAt) return "";
  return date.toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function renderThumbs() {
  const body = $("#ctxBody");
  const pane = activePane();
  const total = pane?.total || pane?.book?.pages || 0;
  if (!total) {
    body.innerHTML = `<div class="ctx-empty">${t("reader.thumbsLoading")}</div>`;
    return;
  }
  body.innerHTML = Array.from({ length: total }, (_, index) => `
    <button class="thumb-item ${index + 1 === pane.page ? "is-active" : ""}" data-goto="${index + 1}" data-kind="pdf">
      <div class="thumb-page"><canvas data-thumb="${index + 1}"></canvas></div>
      <span class="thumb-no">${t("reader.pageN", { page: index + 1 })}</span>
    </button>`).join("");

  thumbObserver?.disconnect();
  thumbObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const canvas = entry.target;
      thumbObserver.unobserve(canvas);
      if (canvas.dataset.done) continue;
      canvas.dataset.done = "1";
      pane.reader?.renderThumb(Number(canvas.dataset.thumb), canvas).catch(() => {});
    }
  }, { root: body, rootMargin: "200px" });
  $$("canvas[data-thumb]", body).forEach((canvas) => thumbObserver.observe(canvas));

  body.querySelector(".thumb-item.is-active")?.scrollIntoView({ block: "nearest" });
}

function markThumbActive() {
  const pane = activePane();
  $$("#ctxBody .thumb-item").forEach((item) => {
    item.classList.toggle("is-active", Number(item.dataset.goto) === pane?.page);
  });
}

function renderFind() {
  const body = $("#ctxBody");
  const pane = activePane();
  const query = pane?.query || "";
  body.innerHTML = `
    <div class="find-box">
      <input id="findInput" type="text" placeholder="${t("reader.findPlaceholder")}" value="${escapeHtml(query)}" />
    </div>
    <div class="find-summary" id="findSummary">${t("reader.findHint")}</div>
    <div id="findHits"></div>`;

  const input = $("#findInput");
  input.addEventListener("input", () => {
    const current = activePane();
    if (!current) return;
    current.query = input.value.trim();
    state.findQuery = current.query;
    clearTimeout(findTimer);
    findTimer = setTimeout(runFind, 320);
  });
  if (query) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    runFind();
  }
}

async function runFind() {
  const pane = activePane();
  const query = pane?.query || "";
  const summary = $("#findSummary");
  const hitsWrap = $("#findHits");
  if (!summary || !hitsWrap) return;
  if (!query) {
    findAbort.cancelled = true;
    // 清空关键词时把正文里的高亮一并撤掉：留着上一次的黄色标记会让人以为还搜着
    activePane()?.ebook?.clearSearch?.();
    summary.textContent = t("reader.findHint");
    hitsWrap.innerHTML = "";
    return;
  }

  const token = ++findToken;
  const book = pane?.book;
  summary.textContent = book?.kind === "pdf" ? t("reader.findFullText") : t("reader.findSearching");

  const mark = (text) => {
    const safe = escapeHtml(text);
    const pattern = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    return safe.replace(pattern, "<mark>$1</mark>");
  };

  let hits = [];
  if (book?.kind === "pdf") {
    hits = await pane.reader?.search(query) || [];
    if (token !== findToken || activePane() !== pane) return;
    summary.textContent = hits.length
      ? `${t("reader.findMatches", { count: hits.length })}${hits.length >= 60 ? t("reader.findMatchesTrunc") : ""}`
      : t("reader.findNone");
    hitsWrap.innerHTML = hits.map((hit, index) => `
      <button class="find-hit" data-hit="${index}" data-page="${hit.page}" data-kind="pdf">
        <span class="hit-page">${t("reader.pageN", { page: hit.page })}</span>${mark(hit.text)}
      </button>`).join("");
    pane.hits = [];
    return;
  }

  // 电子书：交给 foliate 跨章扫，命中带章节名与上下文片段。
  // 搜完库会自己给命中处加一层高亮（overlayer），所以不必在正文里再画一遍
  if (book?.kind === "ebook") {
    const reader = pane.ebook;
    if (!reader) {
      summary.textContent = t("reader.findNone");
      hitsWrap.innerHTML = "";
      return;
    }
    // 上一次还没跑完的先叫停：生成器只能靠这个开关退出
    findAbort.cancelled = true;
    const abort = { cancelled: false };
    findAbort = abort;
    let groups = [];
    try {
      groups = await reader.search(query, {
        token: abort,
        onProgress: (fraction) => {
          if (findAbort !== abort || token !== findToken) return;
          summary.textContent = t("reader.findEbookProgress", { percent: Math.round(fraction * 100) });
        },
      });
    } catch (error) {
      if (findAbort !== abort || token !== findToken) return;
      summary.textContent = String(error);
      return;
    }
    if (findAbort !== abort || token !== findToken || activePane() !== pane) return;
    const flat = groups.flatMap((group) => group.hits.map((hit) => ({ ...hit, label: group.label })));
    pane.hits = flat;
    summary.textContent = flat.length
      ? `${t("reader.findMatches", { count: flat.length })}${flat.length >= 300 ? t("reader.findMatchesTrunc") : ""}`
      : t("reader.findNone");
    // 按章节分组显示：一本书里同一个词往往集中在几章，平铺一长串看不出结构。
    // 序号按 groups 顺序连续递增，与上面 flatMap 出来的 pane.hits 一一对应
    let offset = 0;
    hitsWrap.innerHTML = groups.map((group) => `
      <div class="find-group">
        <div class="find-group-head">${escapeHtml(group.label || t("reader.ebookNoChapter"))}</div>
        ${group.hits.map((hit) => {
          const index = offset;
          offset += 1;
          // 命中词单独包 <mark>：上下文是库切好的三段，不必再用正则找一遍
          return `<button class="find-hit" data-hit="${index}" data-kind="ebook">${
            escapeHtml(hit.pre)}<mark>${escapeHtml(hit.match)}</mark>${escapeHtml(hit.post)}</button>`;
        }).join("")}
      </div>`).join("");
    return;
  }

  // 大文件只在 DOM 里放了一两千行，遍历 DOM 等于只搜了当前屏——搜索必须下沉到
  // Rust，按行窗口扫全篇，返回行号，点一下跳到那一行
  if (pane?.doc?.windowed) {
    let hits = [];
    try {
      hits = await invoke("search_text", { path: pane.book?.path || "", query, limit: 60 });
    } catch (error) {
      if (token !== findToken || activePane() !== pane) return;
      summary.textContent = String(error);
      return;
    }
    if (token !== findToken || activePane() !== pane) return;
    pane.hits = hits;
    summary.textContent = hits.length
      ? `${t("reader.findMatches", { count: hits.length })}${hits.length >= 60 ? t("reader.findMatchesTrunc") : ""}`
      : t("reader.findNone");
    hitsWrap.innerHTML = hits.map((hit, index) => `
      <button class="find-hit" data-hit="${index}" data-kind="line">
        <span class="hit-page">${t("reader.findLine", { line: hit.line })}</span>${mark(hit.text)}
      </button>`).join("");
    return;
  }

  const nodes = $$("h1, h2, h3, p, li, td, blockquote", pane.mdDoc);
  pane.hits = nodes.filter((node) => node.textContent.includes(query)).slice(0, 40);
  summary.textContent = pane.hits.length ? t("reader.findMatches", { count: pane.hits.length }) : t("reader.findNone");
  hitsWrap.innerHTML = pane.hits.map((node, index) => {
    const text = node.textContent.trim();
    const at = text.indexOf(query);
    const snippet = text.length > 70 ? `${text.slice(Math.max(0, at - 24), at + 46)}…` : text;
    const label = /^H[123]$/.test(node.tagName) ? t("reader.findHeading", { level: node.tagName.slice(1) }) : t("reader.findBody");
    return `<button class="find-hit" data-hit="${index}" data-kind="md">
      <span class="hit-page">${label}</span>${mark(snippet)}
    </button>`;
  }).join("");
}

export { setCtxOpen, setCtxTabActive, switchCtxTab, renderCtx, renderToc, renderMarks, markTocActive, renderThumbs, markThumbActive, renderFind, runFind };
