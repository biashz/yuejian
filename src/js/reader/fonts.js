/**
 * 正文字体：系统字体栈 + 按需下载的开源字体。
 *
 * 安装包里不带字体。用户选了下载项才从官方源拉取，落在安装目录的
 * `data/fonts/`（Rust 侧 `list_fonts` 返回的目录），下次启动直接读盘登记，
 * 不需要再联网。字体文件靠三道闸把关：https + 官方域名白名单 + 文件头必须是
 * TrueType/OpenType（后两道在 Rust 侧，见 `download_font`）。
 *
 * 目录里的 URL 都是官方源：霞鹜文楷取 GitHub Release 资产，其余取
 * Google Fonts 官方仓库（github.com/google/fonts）里的原始文件，均为 OFL 1.1。
 * 升级版本 = 换 URL 与 bytes；`file` 是本地落盘名，与 URL 里的文件名解耦
 * （官方文件带方括号，不能直接当本地名）。
 *
 * 注入用的 family 名统一加 `YJ ` 前缀：书里可能自带同名 family 的定义，
 * 撞名时后加载的那份会赢，前缀把两边隔开。
 */
import { convertFileSrc, invoke } from "../api.js";

const SYSTEM = [
  {
    id: "serif",
    labelKey: "settings.ebookSerif",
    stack: '"Songti SC", "SimSun", "Source Han Serif SC", "Noto Serif CJK SC", Georgia, serif',
  },
  {
    id: "sans",
    labelKey: "settings.ebookSans",
    stack: '"PingFang SC", "Microsoft YaHei", "Source Han Sans SC", "Noto Sans CJK SC", system-ui, sans-serif',
  },
  {
    id: "kai",
    labelKey: "settings.ebookKai",
    stack: '"Kaiti SC", "KaiTi", "STKaiti", "Source Han Serif SC", Georgia, serif',
  },
];

const DOWNLOAD = [
  {
    id: "wenkai-gb",
    labelKey: "font.wenkaiGb",
    url: "https://github.com/lxgw/LxgwWenkaiGB/releases/download/v1.530/LXGWWenKaiGB-Regular.ttf",
    file: "lxgwwenkai-gb-regular.ttf",
    bytes: 26170696,
    stack: '"Kaiti SC", "KaiTi", "STKaiti", serif',
    weight: "400",
  },
  {
    id: "noto-serif-sc",
    labelKey: "font.notoSerif",
    url: "https://raw.githubusercontent.com/google/fonts/main/ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf",
    file: "noto-serif-sc.ttf",
    bytes: 25125512,
    stack: '"Songti SC", "SimSun", Georgia, serif',
    weight: "100 900",
  },
  {
    id: "noto-sans-sc",
    labelKey: "font.notoSans",
    url: "https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf",
    file: "noto-sans-sc.ttf",
    bytes: 17772300,
    stack: '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
    weight: "100 900",
  },
  {
    id: "literata",
    labelKey: "font.literata",
    url: "https://raw.githubusercontent.com/google/fonts/main/ofl/literata/Literata%5Bopsz%2Cwght%5D.ttf",
    file: "literata.ttf",
    bytes: 955132,
    stack: '"Songti SC", "SimSun", Georgia, serif',
    weight: "100 900",
  },
  {
    id: "eb-garamond",
    labelKey: "font.ebGaramond",
    url: "https://raw.githubusercontent.com/google/fonts/main/ofl/ebgaramond/EBGaramond%5Bwght%5D.ttf",
    file: "eb-garamond.ttf",
    bytes: 851176,
    stack: '"Songti SC", "SimSun", Georgia, serif',
    weight: "100 900",
  },
].map((entry) => ({ ...entry, download: true }));

const FONT_IDS = [...SYSTEM, ...DOWNLOAD].map((entry) => entry.id);
const ALL = [...SYSTEM, ...DOWNLOAD];
const BY_ID = new Map(ALL.map((entry) => [entry.id, entry]));
const BY_FILE = new Map(DOWNLOAD.map((entry) => [entry.file, entry]));

/** 已下载字体：id → { path, bytes }；由 `initFonts` 从磁盘登记 */
const installed = new Map();
let ready = false;

const fontEntry = (id) => BY_ID.get(id) || null;
const isInstalled = (id) => installed.has(id);
const labelKeyOf = (entry) => entry.labelKey;

/** 「OFL 1.1 · 25 MB」这类小字元信息 */
function fontNote(entry) {
  if (!entry.download) return "";
  const mb = entry.bytes / 1048576;
  return `OFL 1.1 · ${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
}

/**
 * 选中的 family 折成 CSS 字体栈。
 *
 * 下载项没装（或文件被手动删掉）就回落到系统宋体：设置里留着的 id 不急着改，
 * 用户把文件补回来就恢复，不必去猜他「其实想用哪个」。
 */
function fontStack(id) {
  const entry = BY_ID.get(id);
  if (!entry) return SYSTEM[0].stack;
  if (!entry.download) return entry.stack;
  if (!installed.has(entry.id)) return SYSTEM[0].stack;
  return `"YJ ${entry.id}", ${entry.stack}`;
}

function faceRule(entry) {
  const info = installed.get(entry.id);
  if (!info) return "";
  return "@font-face {"
    + ` font-family: "YJ ${entry.id}";`
    + ` src: url("${convertFileSrc(info.path)}") format("truetype");`
    + ` font-weight: ${entry.weight}; font-display: swap; }`;
}

/** 给章节样式表用的 @font-face 段；没装任何字体时是空串 */
function fontFaceCss() {
  return DOWNLOAD.map(faceRule).filter(Boolean).join("\n");
}

/** 主文档里也挂一份，让版式面板的字体样例直接用真字体预览 */
function syncFontFaces() {
  let style = document.getElementById("fontFaceStyle");
  if (!style) {
    style = document.createElement("style");
    style.id = "fontFaceStyle";
    document.head.appendChild(style);
  }
  style.textContent = fontFaceCss();
}

/** 启动时登记磁盘上已有的字体；非 Tauri 环境或目录还不存在都按「没有」处理 */
async function initFonts() {
  if (ready) return installed;
  try {
    const store = await invoke("list_fonts");
    installed.clear();
    for (const file of store?.files || []) {
      const entry = BY_FILE.get(file.name);
      // 目录里多出来的文件不是我们下载的：不登记，也不删
      if (!entry || !file.path) continue;
      installed.set(entry.id, { path: file.path, bytes: file.bytes });
    }
    ready = true;
    syncFontFaces();
  } catch {
    // 目录还没建 / 不在 Tauri：当作没有下载字体
  }
  return installed;
}

/** 订阅下载进度；返回取消订阅函数 */
function onFontProgress(callback) {
  const listen = window.__TAURI__?.event?.listen;
  if (!listen) return () => {};
  const pending = listen("font-progress", (event) => callback(event.payload || {}));
  return () => pending.then((off) => off()).catch(() => {});
}

/** 下载一款字体并登记；失败时抛错，由界面决定提示方式 */
async function downloadFont(id, onProgress) {
  const entry = BY_ID.get(id);
  if (!entry?.download) throw new Error("NOT_DOWNLOADABLE");
  const off = onProgress
    ? onFontProgress((payload) => {
      if (payload.id === id) onProgress(payload);
    })
    : () => {};
  try {
    const path = await invoke("download_font", {
      id,
      url: entry.url,
      fileName: entry.file,
      bytes: entry.bytes,
    });
    installed.set(id, { path, bytes: entry.bytes });
    syncFontFaces();
    return installed.get(id);
  } finally {
    off();
  }
}

async function removeFont(id) {
  const entry = BY_ID.get(id);
  if (!entry?.download) return;
  try {
    await invoke("remove_font", { fileName: entry.file });
  } finally {
    installed.delete(id);
    syncFontFaces();
  }
}

export {
  SYSTEM,
  DOWNLOAD,
  FONT_IDS,
  fontEntry,
  fontNote,
  labelKeyOf,
  fontStack,
  fontFaceCss,
  syncFontFaces,
  initFonts,
  downloadFont,
  removeFont,
  isInstalled,
};
