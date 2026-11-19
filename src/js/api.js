/**
 * Tauri 桥接层：所有后端调用只从这里出去，便于替换或测试。
 * 依赖 tauri.conf.json 中的 app.withGlobalTauri = true。
 */
const tauri = window.__TAURI__;

export const isTauri = Boolean(tauri?.core?.invoke);

export function invoke(command, args = {}) {
  if (!isTauri) {
    return Promise.reject(new Error("当前不在 Tauri 环境中运行"));
  }
  return tauri.core.invoke(command, args);
}

/** 把本地绝对路径转成 asset 协议可访问的 URL */
export function convertFileSrc(path) {
  if (!tauri?.core?.convertFileSrc) return path;
  return tauri.core.convertFileSrc(path);
}

/**
 * 弹系统保存框写入一段文本，返回落盘路径。
 * 用户取消时返回空串——取消不是错误，调用方据此不必弹提示。
 *
 * `ext` 决定对话框的标题与类型过滤器（`md` / `txt` / `html`），省略即 Markdown。
 */
export function saveTextFile(defaultName, content, ext) {
  return invoke("save_text_file", { defaultName, content, ext });
}

/** 另存一份原文件副本，返回落盘路径；取消时空串 */
export function saveFileCopy(path, defaultName) {
  return invoke("save_file_copy", { path, defaultName });
}

/** 读一张本地图片并编码成 data URL（导出 HTML 时内联用） */
export function readImageDataUrl(path) {
  return invoke("read_image_data_url", { path });
}

/**
 * 打印当前窗口内容。
 *
 * 平台差异在后端抹平（macOS 走原生打印，其余走 `window.print()`），
 * 前端只认这一个命令——判断平台这件事不该散落在界面代码里。
 */
export function printWebview() {
  return invoke("print_webview");
}

export const currentWindow = tauri?.window?.getCurrentWindow?.() ?? null;
