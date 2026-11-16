/**
 * 跨模块共享的界面状态。只做属性写入（state.books = …），整体不做重新赋值，
 * 因此可以安全地以 const 形式导出给所有模块共用。
 */
import { DEFAULT_SETTINGS } from "./constants.js";

const state = {
  books: [],
  settings: { ...DEFAULT_SETTINGS },
  view: "library",
  filter: "all",
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
  findQuery: "",
  paletteIndex: 0,
};

export { state };
