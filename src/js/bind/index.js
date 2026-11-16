/**
 * 事件绑定的聚合入口：按原有顺序调用五个事件域。
 * 顺序会影响行为——委托点击先于关闭缩放菜单，键盘处理在拦截右键之后；
 * 分类事件排在最后，它的 Esc 处理要让全局快捷键先做判断。
 */
import { bindShelfEvents } from "./shelf.js";
import { bindReaderEvents } from "./reader.js";
import { bindPanelEvents } from "./panels.js";
import { bindKeyEvents } from "./keys.js";
import { bindCategoryEvents } from "./category.js";

export function bind() {
  bindShelfEvents();
  bindReaderEvents();
  bindPanelEvents();
  bindKeyEvents();
  bindCategoryEvents();
}
