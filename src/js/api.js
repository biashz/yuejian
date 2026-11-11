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

export const currentWindow = tauri?.window?.getCurrentWindow?.() ?? null;
