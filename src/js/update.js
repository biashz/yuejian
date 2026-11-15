/**
 * 应用更新：查询 GitHub Release、下载安装包、启动安装器并退出应用。
 * 只依赖 Tauri core 的 invoke，不引入额外前端依赖；下载由 Rust 端完成。
 */
import { invoke, isTauri } from "./api.js";

const REPO = "biashz/yuejian";
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const PAGE_URL = `https://github.com/${REPO}/releases/latest`;
/** CI 会给 Windows 安装包额外产出一份固定文件名的副本，升级时按名字取用 */
const WINDOWS_ASSET = "yuejian-windows-x64-setup.exe";

export const isWindows = /windows/i.test(navigator.userAgent || "");

/** 版本号拆成数字段，忽略前缀 v 与预发布后缀 */
function versionParts(value) {
  return String(value || "")
    .trim()
    .replace(/^v/i, "")
    .split(/[.+-]/)
    .map((part) => Number.parseInt(part, 10) || 0);
}

/** 语义化比较：left 比 right 新返回 1，旧返回 -1，相同返回 0 */
export function compareVersion(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** 当前安装的版本号（取 Cargo 版本，与安装包一致）；非 Tauri 环境返回空串 */
export async function getCurrentVersion() {
  if (!isTauri) return "";
  try {
    return await invoke("app_version");
  } catch {
    return "";
  }
}

/** 拉取最新 Release 信息；网络或数据异常时抛错，由调用方决定是否提示 */
export async function fetchLatestRelease() {
  const response = await fetch(API_URL, { headers: { Accept: "application/vnd.github+json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const release = await response.json();
  const version = String(release.tag_name || "").replace(/^v/i, "");
  if (!version) throw new Error("NO_VERSION");
  const asset = (release.assets || []).find((item) => item.name === WINDOWS_ASSET);
  return {
    version,
    publishedAt: release.published_at || "",
    pageUrl: release.html_url || PAGE_URL,
    assetUrl: asset?.browser_download_url || "",
    assetSize: Number(asset?.size) || 0,
  };
}

/** 下载安装包，返回本地路径；下载期间 Rust 端通过 update-progress 事件汇报进度 */
export function downloadInstaller(assetUrl, assetSize) {
  return invoke("download_update", {
    url: assetUrl,
    fileName: WINDOWS_ASSET,
    size: assetSize || 0,
  });
}

/** 启动安装包并退出应用（安装器会先卸载旧版本、保留用户数据） */
export function runInstaller(path) {
  return invoke("install_update", { path });
}

/** 用系统浏览器打开发布页 */
export function openReleasePage(url) {
  return invoke("open_external", { url: url || PAGE_URL });
}

/** 订阅下载进度；返回取消订阅函数 */
export function onDownloadProgress(callback) {
  const listen = window.__TAURI__?.event?.listen;
  if (!listen) return () => {};
  const pending = listen("update-progress", (event) => callback(event.payload || {}));
  return () => pending.then((off) => off()).catch(() => {});
}
