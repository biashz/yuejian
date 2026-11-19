/**
 * 侧栏「搜索」页：输入框与结果列表，PDF / 文本 / Markdown / 电子书四套检索路径。
 *
 * 四条路径的共同约束是「结果要能作废」：输入框每 320ms 防抖触发一次，慢的那次
 * 可能后到。用递增的 `token` 判断结果是否过期，过期就整段丢掉，不写进任何地方。
 */
import { $, $$, escapeHtml } from "../core/dom.js";
import { invoke } from "../api.js";
import { t } from "../i18n.js";
import { state } from "../core/session.js";
import { activePane } from "./panes.js";

let timer = 0;
let token = 0;
/* 电子书搜索的取消开关：库的异步生成器没法从外面中断，只能每轮看它一眼 */
let abort = { cancelled: true };

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
    clearTimeout(timer);
    timer = setTimeout(runFind, 320);
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
    abort.cancelled = true;
    // 清空关键词时把正文里的高亮一并撤掉：留着上一次的黄色标记会让人以为还搜着
    activePane()?.ebook?.clearSearch?.();
    summary.textContent = t("reader.findHint");
    hitsWrap.innerHTML = "";
    return;
  }

  const mine = ++token;
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
    if (mine !== token || activePane() !== pane) return;
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
    abort.cancelled = true;
    const marker = { cancelled: false };
    abort = marker;
    let groups = [];
    try {
      groups = await reader.search(query, {
        token: marker,
        onProgress: (fraction) => {
          if (abort !== marker || mine !== token) return;
          summary.textContent = t("reader.findEbookProgress", { percent: Math.round(fraction * 100) });
        },
      });
    } catch (error) {
      if (abort !== marker || mine !== token) return;
      summary.textContent = String(error);
      return;
    }
    if (abort !== marker || mine !== token || activePane() !== pane) return;
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
    let lines = [];
    try {
      lines = await invoke("search_text", { path: pane.book?.path || "", query, limit: 60 });
    } catch (error) {
      if (mine !== token || activePane() !== pane) return;
      summary.textContent = String(error);
      return;
    }
    if (mine !== token || activePane() !== pane) return;
    pane.hits = lines;
    summary.textContent = lines.length
      ? `${t("reader.findMatches", { count: lines.length })}${lines.length >= 60 ? t("reader.findMatchesTrunc") : ""}`
      : t("reader.findNone");
    hitsWrap.innerHTML = lines.map((hit, index) => `
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

export { renderFind, runFind };
