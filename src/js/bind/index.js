/**
 * 事件绑定的聚合入口：按原有顺序调用六个事件域。
 * 顺序会影响行为——委托点击先于关闭缩放菜单，键盘处理在拦截右键之后；
 * 分类事件排在最后，它的 Esc 处理要让全局快捷键先做判断。
 */
import { bindShelfEvents } from "./shelf.js";
import { bindReaderEvents } from "./reader.js";
import { bindPanelEvents } from "./panels.js";
import { bindKeyEvents } from "./keys.js";
import { bindCategoryEvents } from "./category.js";
import { bindSortEvents } from "./sort.js";
import { bindBookDrag } from "./book-drag.js";
import { mountLayoutPanel } from "../reader/ebook-layout-panel.js";
import { $ } from "../core/dom.js";

export function bind() {
  // 先把版式面板挂进阅读区（只建 DOM，不显示）：它的事件绑在自己身上，
  // 不依赖下面的委托，放最前面省得漏
  mountLayoutPanel();
  // 工具栏搬进阅读区里：`.read-toolbar` 是 `left: 50%` 居中的，留在整行里的话，
  // 右侧面板一开就会有一部分压在面板底栏上（「恢复默认」直接被盖住点不到）
  $(".reader-panes").append($("#readToolbar"));
  bindShelfEvents();
  bindReaderEvents();
  bindPanelEvents();
  bindKeyEvents();
  bindCategoryEvents();
  bindSortEvents();
  // 拖拽归类要排在最后：它靠捕获阶段吃掉拖完那一次 click，别抢在别人前面
  bindBookDrag();
}
