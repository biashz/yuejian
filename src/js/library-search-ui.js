/**
 * 跨书检索的调度层：防抖、作废、进度文案、点命中的跳转。
 *
 * 单独一个模块，是因为触发点不止一处——关键词输入、类型筛选、分类筛选都会改变
 * 「搜哪些书」或「搜什么」，它们分属 `bind/shelf.js` 与 `bind/category.js`。
 * 把调度放在其中任何一个 bind 文件里，另一个就得反过来 import 它。
 */
import { t } from "./i18n.js";
import { state } from "./core/session.js";
import { scopeBooks, visibleBooks, renderLibrary } from "./shelf.js";
import { activePane } from "./reader/panes.js";
import { openBook } from "./reader/open.js";
import { goPage } from "./reader/toolbar.js";
import { scrollToLine } from "./reader-bigtext.js";
import { setCtxOpen, switchCtxTab } from "./reader/ctx.js";
import { searchLibrary, MIN_QUERY } from "./library-search.js";
import { clearHits, setStatus, renderHits } from "./library-hits.js";

/* 两次防抖：输入停下 320ms 才搜；上一轮的 token 立刻作废，慢的那轮不会
   把新关键词的结果盖掉 */
let timer = 0;
let token = { cancelled: true };

/** 关键词或筛选范围变了就调它；少于两个字直接收起结果区 */
function scheduleLibrarySearch() {
  clearTimeout(timer);
  token.cancelled = true;
  const query = state.query;
  if (query.length < MIN_QUERY) {
    clearHits();
    // 空态文案依赖「有没有命中」，收起之后要重画一次，否则会留着「正文命中见下方」
    if (!visibleBooks().length) renderLibrary();
    return;
  }
  // 先占一行字：PDF 建索引可能要几秒，主区一声不响会让人以为搜索坏了
  setStatus(t("library.searching"));
  timer = setTimeout(() => runLibrarySearch(query), 320);
}

async function runLibrarySearch(query) {
  const mine = { cancelled: false };
  token = mine;
  try {
    const result = await searchLibrary({
      query,
      books: scopeBooks(),
      token: mine,
      onProgress: ({ done, total, title, building }) => {
        if (mine.cancelled) return;
        setStatus(building != null
          ? t("library.searchIndexing", { percent: Math.round(building * 100), title })
          : t("library.searchProgress", { done: Math.min(done + 1, total), total, title }));
      },
    });
    // 关键词已经变了就丢弃：这轮结果属于上一个词
    if (mine.cancelled || state.query !== query) return;
    renderHits(result);
    // 书名一条都没匹配上、正文却搜到了：空态那句「没有匹配的文档」要换成
    // 「书名没匹配，正文命中见下方」。只在网格确实空的时候重画，避免白重建列表
    if (result.groups.length && !visibleBooks().length) renderLibrary();
  } catch (error) {
    if (mine.cancelled) return;
    setStatus(String(error?.message ?? error));
  }
}

/**
 * 点一条命中：打开这本书 → 落到那一处 → 把关键词填进侧栏搜索。
 *
 * 三件事分开做，是因为它们的可靠性不同：
 * ① **定位**用当前位置标识（PDF 页码 / 文本行号 / 电子书章节 href），有就跳；
 * ② **高亮**靠侧栏搜索，它会把这本里所有命中标出来，还能继续找下一处；
 * ③ **聚焦**把侧栏里对应的那一条标出来，用户才知道「我点的就是这个」。
 *
 * Markdown 只有 ②：检索拿到的是**源码行号**，而渲染后的 DOM 与源码行没有对应
 * 关系（表格、脚注、代码块都会改变行数），按行号滚过去必然错位。
 */
function openHit(bookId, hit = {}) {
  const query = state.query;
  openBook(bookId).then(() => {
    const pane = activePane();
    if (!pane) return;
    jumpToHit(pane, hit);
    if (!query) return;
    pane.query = query;
    state.findQuery = query;
    // 留给 ctx-find：命中列表渲染出来后，把对应的那一条标出来并滚到视野中间
    pane.findFocus = { line: Number(hit.line) || 0, page: Number(hit.page) || 0 };
    setCtxOpen(true);
    switchCtxTab("find");
  }).catch(() => {});
}

/**
 * 按书的类型挑一个位置标识用；没有可用标识就停在打开时的位置。
 *
 * **延后两帧再定位**不是保险起见：`openText` 在打开末尾用 `requestAnimationFrame`
 * 把滚动位置恢复成上次进度，那一帧晚于打开动作完成——过早设的滚动位置会被它冲掉，
 * 表现为「点了命中，书开了，却停在第一行」。PDF 恢复页码同理。两帧足够让这些收尾
 * 跑完，用户也感知不到这几十毫秒。
 */
function jumpToHit(pane, hit) {
  const kind = pane.book?.kind;
  const page = Number(hit.page) || 0;
  const line = Number(hit.line) || 0;
  const href = hit.href || "";

  requestAnimationFrame(() => requestAnimationFrame(() => {
    // 这两帧里用户可能已经切走：那时不能再动当前文档的位置
    if (activePane() !== pane) return;
    if (kind === "pdf" && page > 0) {
      goPage(page);
      return;
    }
    if (kind === "ebook" && href) {
      // goTo 接受章节 href：落到那一节即可，不必先算出 CFI
      pane.ebook?.goTo(href);
      return;
    }
    // 只有窗口化的文本才有「按行滚动」这回事：整篇里的行号要换算成滚动位置，
    // 普通文本没有这层映射，交给侧栏搜索去滚到第一处命中
    if (kind === "text" && line > 0 && pane.win) scrollToLine(pane, line);
  }));
}

/** 界面语言切换后，已渲染的命中区文案会停在旧语言：直接重跑一次 */
function refreshLibrarySearch() {
  if (state.query.length >= MIN_QUERY) scheduleLibrarySearch();
}

export { scheduleLibrarySearch, openHit, refreshLibrarySearch };
