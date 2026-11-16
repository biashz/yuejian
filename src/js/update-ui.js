/**
 * 应用更新的界面侧：状态机、进度、按钮动作。
 * 网络与安装动作由 update.js 负责，这里只做状态与渲染。
 */
import { $, clamp } from "./core/dom.js";
import { formatBytes } from "./core/format.js";
import { t, getLanguage } from "./i18n.js";
import { state } from "./core/session.js";
import { isTauri } from "./api.js";
import { toast } from "./core/feedback.js";
import { compareVersion, downloadInstaller, fetchLatestRelease, getCurrentVersion, isWindows, onDownloadProgress, openReleasePage, runInstaller } from "./update.js";

/* ---------------- 更新 ---------------- */
/** 更新状态机：idle → checking → latest | available → downloading → ready，失败转 error */
const updater = {
  version: "",
  release: null,
  phase: "idle",
  progress: 0,
  /** 已接收字节数：总大小缺失时用它给「已下载 x MB」的反馈 */
  received: 0,
  /** 下载没有字节流动时的提示语：connecting（还在连） / stalled（疑似卡住） */
  stuck: "",
  installerPath: "",
  error: "",
  /** 最近一次失败的来源：check（查版本） | download（下包），决定提示文案 */
  errorKind: "",
  unlisten: null,
  watchdog: null,
};

/** 无字节流动多久开始提示「正在连接」，多久判定为卡住 */
const CONNECT_HINT_MS = 12000;
const STALL_HINT_MS = 45000;

const updateDate = (iso) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(getLanguage() === "en" ? "en-US" : "zh-CN", {
    year: "numeric", month: "short", day: "numeric",
  });
};

/** 版本号 / 状态说明 / 动作按钮 / 进度条统一在这里刷新 */
function renderUpdateUI() {
  const card = $("#updateCard");
  const action = $("#updateAction");
  if (!card) return;
  const target = updater.release?.version || "";
  const percent = Math.round(updater.progress * 100);
  card.dataset.state = updater.phase;
  $("#updateBadge").hidden = !(updater.phase === "available" || updater.phase === "ready");
  $("#updateProgress").hidden = updater.phase !== "downloading";
  $("#updateProgress span").style.transform = `scaleX(${clamp(updater.progress, 0, 1)})`;
  // 卡住时把「查看更新说明」也放出来，让用户至少有一条出路
  $("#updateLink").hidden = !(updater.release && (updater.phase !== "downloading" || updater.stuck === "stalled"));
  $("#updateTitle").textContent = updater.phase === "available" || updater.phase === "ready"
    ? t("settings.updateAvailable", { version: target })
    : t("settings.updateCurrent", { version: updater.version || "—" });

  const note = $("#updateNote");
  action.disabled = false;
  if (updater.phase === "checking") {
    note.textContent = t("settings.updateChecking");
    action.textContent = t("settings.updateChecking");
    action.disabled = true;
  } else if (updater.phase === "latest") {
    note.textContent = t("settings.updateLatest", { version: target || updater.version });
    action.textContent = t("settings.checkUpdate");
  } else if (updater.phase === "available") {
    note.textContent = isWindows && updater.release?.assetUrl
      ? t("settings.updateAvailableNote", { date: updateDate(updater.release?.publishedAt) })
      : t("settings.updateUnsupported");
    action.textContent = isWindows && updater.release?.assetUrl
      ? t("settings.updateDownload")
      : t("settings.updateManual");
  } else if (updater.phase === "downloading") {
    // 0 字节时不要干说「正在下载 0%」——那和卡死没有区别，按等待时长分档给反馈
    let text;
    if (updater.stuck === "stalled") {
      text = t("settings.updateStalled");
    } else if (updater.received > 0) {
      text = updater.progress > 0
        ? t("settings.updateDownloading", { percent })
        : t("settings.updateDownloaded", { size: formatBytes(updater.received) });
    } else if (updater.stuck === "connecting") {
      text = t("settings.updateConnecting");
    } else {
      text = t("settings.updateDownloading", { percent });
    }
    note.textContent = text;
    action.textContent = text;
    action.disabled = true;
  } else if (updater.phase === "ready") {
    note.textContent = t("settings.updateReady");
    action.textContent = t("settings.updateInstall");
  } else if (updater.phase === "error") {
    // 检查失败与下载失败的文案要分开：后者通常是网络/代理问题，提示的处置方式不同
    note.textContent = t(updater.errorKind === "download" ? "settings.updateDownloadFailed" : "settings.updateFailed", { error: updater.error });
    action.textContent = t("settings.updateRetry");
  } else {
    note.textContent = t("settings.updateIdle");
    action.textContent = t("settings.checkUpdate");
  }
}

/** silent = 启动时的自动检查：失败不弹提示，有更新才给一条 toast */
async function checkForUpdate({ silent = false } = {}) {
  if (!isTauri || updater.phase === "checking" || updater.phase === "downloading") return;
  updater.phase = "checking";
  updater.error = "";
  renderUpdateUI();
  try {
    const release = await fetchLatestRelease();
    updater.release = release;
    if (compareVersion(release.version, updater.version) > 0) {
      updater.phase = "available";
      // 自动检查：Windows 直接后台下载，完成后再提示；其它平台只提示去发布页
      if (silent && isWindows && release.assetUrl) {
        downloadUpdate();
        return;
      }
      if (silent) toast(t("toast.updateFound", { version: release.version }));
    } else {
      updater.phase = "latest";
    }
  } catch (error) {
    updater.phase = silent ? "idle" : "error";
    updater.errorKind = "check";
    updater.error = String(error?.message || error);
  }
  renderUpdateUI();
}

async function downloadUpdate() {
  const release = updater.release;
  if (!release) return;
  if (!isWindows || !release.assetUrl) {
    openReleasePage(release.pageUrl).catch(() => {});
    return;
  }
  updater.phase = "downloading";
  updater.progress = 0;
  updater.received = 0;
  updater.stuck = "";
  renderUpdateUI();

  // 后端有 40 秒的传输超时，但那是「判定链路死了」；在此之前用户看到的是一动不动的百分比，
  // 分不出是在连接、在下慢速包，还是已经卡死。按「多久没有新字节」给阶梯式提示。
  const startedAt = Date.now();
  let lastReceived = 0;
  let lastChangeAt = startedAt;
  updater.watchdog = setInterval(() => {
    if (updater.phase !== "downloading") return;
    const now = Date.now();
    if (updater.received !== lastReceived) {
      lastReceived = updater.received;
      lastChangeAt = now;
    }
    // 连上了但一个字节都没收到 → 连接中；有进展后又长时间不动 → 卡住
    let next = "";
    if (lastReceived === 0 && now - startedAt >= CONNECT_HINT_MS) next = "connecting";
    if (now - lastChangeAt >= STALL_HINT_MS) next = "stalled";
    if (next !== updater.stuck) {
      updater.stuck = next;
      renderUpdateUI();
    }
  }, 1000);

  updater.unlisten = onDownloadProgress(({ received, total }) => {
    if (typeof received === "number") {
      // 后端每 200ms 都会发一次（数值可能不变），只有真的涨了才清掉「卡住」标记
      if (received > updater.received) updater.stuck = "";
      updater.received = received;
    }
    // 总大小缺失时百分比恒为 0，此时改用「已下载 x MB」表达进展
    if (total > 0) updater.progress = clamp((received || 0) / total, 0, 1);
    renderUpdateUI();
  });
  try {
    updater.installerPath = await downloadInstaller(release.assetUrl, release.assetSize);
    updater.progress = 1;
    updater.phase = "ready";
    toast(t("settings.updateReady"));
  } catch (error) {
    updater.phase = "error";
    updater.errorKind = "download";
    updater.error = String(error?.message || error);
  } finally {
    if (updater.watchdog) clearInterval(updater.watchdog);
    updater.watchdog = null;
    updater.stuck = "";
    updater.unlisten?.();
    updater.unlisten = null;
  }
  renderUpdateUI();
}

async function installUpdate() {
  if (!updater.installerPath) return;
  try {
    // 安装器启动成功后应用会立即退出，这里不需要再更新状态
    await runInstaller(updater.installerPath);
  } catch (error) {
    updater.phase = "error";
    updater.error = String(error?.message || error);
    renderUpdateUI();
  }
}

function handleUpdateAction() {
  if (updater.phase === "available") return downloadUpdate();
  if (updater.phase === "ready") return installUpdate();
  return checkForUpdate();
}

/** 启动时读取版本号，按设置决定是否静默检查一次 */
async function initUpdate() {
  if (!isTauri) return;
  updater.version = await getCurrentVersion();
  renderUpdateUI();
  if (state.settings.autoCheckUpdate === false) return;
  setTimeout(() => checkForUpdate({ silent: true }), 3000);
}

export { updater, renderUpdateUI, checkForUpdate, downloadUpdate, installUpdate, handleUpdateAction, initUpdate };
