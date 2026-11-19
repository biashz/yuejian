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
 * 点一条命中：打开这本书，并把关键词填进侧栏搜索。
 *
 * 不按命中位置直接跳，是因为「正文里的第 N 个字符」对三种格式各有各的映射：
 * PDF 有页码、文本有行号、电子书要 CFI（索引里没有）。填进侧栏搜索则三种
 * 格式都落得准，用户还能顺着命中高亮继续看上下文。
 */
function openHit(id, page) {
  const query = state.query;
  openBook(id).then(() => {
    if (!query) return;
    const pane = activePane();
    if (!pane) return;
    pane.query = query;
    state.findQuery = query;
    // PDF 有页码就顺手跳过去；其余格式交给侧栏搜索自己定位
    if (page > 0 && pane.book?.kind === "pdf") goPage(page);
    setCtxOpen(true);
    switchCtxTab("find");
  }).catch(() => {});
}

/** 界面语言切换后，已渲染的命中区文案会停在旧语言：直接重跑一次 */
function refreshLibrarySearch() {
  if (state.query.length >= MIN_QUERY) scheduleLibrarySearch();
}

export { scheduleLibrarySearch, openHit, refreshLibrarySearch };
