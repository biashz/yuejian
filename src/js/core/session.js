/**
 * 跨模块共享的界面状态。只做属性写入（state.books = …），整体不做重新赋值，
 * 因此可以安全地以 const 形式导出给所有模块共用。
 */
import { DEFAULT_SETTINGS } from "./constants.js";

const state = {
  books: [],
  categories: [],
  settings: { ...DEFAULT_SETTINGS },
  view: "library",
  filter: "all",
  /* 分类轴筛选：null = 全部分类，"" = 未分类，其它为分类 id */
  categoryId: null,
  catCollapsed: false,
  /* 类型组默认收起：目录头自述当前选择，展开是瞬时的 */
  typeCollapsed: true,
  /* 状态轴筛选：null = 全部状态，其它为 reading / unread / finished；派生值，不落盘 */
  status: null,
  statusCollapsed: true,
  /* 批量归类的选中集合；不落盘，切视图时清空 */
  selected: new Set(),
  query: "",
  ctxTab: "toc",
  ctxOpen: true,
  currentId: null,
  current: null,
  doc: null,
  pdfPage: 1,
  pdfZoom: 1,
  pdfTotal: 0,
  pdfOutline: null,
  /* 电子书：当前章节名、全书百分比、CFI。三者都来自 foliate 的 relocate 事件 */
  ebookLabel: "",
  ebookHref: "",
  ebookFraction: 0,
  /* 当前页是否已加书签：工具栏按钮的亮灭读它，写入只发生在 bookmarks.js 与 relocate */
  ebookMarked: false,
  /* 版式面板是否展开。放这里而不是面板模块内部，是为了让工具栏直接读，
     不必反向 import 面板（面板要 import 阅读器，阅读器又要 import 工具栏，会成环） */
  layoutOpen: false,
  findQuery: "",
  paletteIndex: 0,
};

export { state };
