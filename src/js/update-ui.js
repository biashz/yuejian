/**
 * 应用更新的界面侧：状态机、进度、按钮动作。
 * 网络与安装动作由 update.js 负责，这里只做状态与渲染。
 */
import { $, clamp } from "./core/dom.js";
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
  installerPath: "",
  error: "",
  unlisten: null,
};

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
  $("#updateLink").hidden = !(updater.release && updater.phase !== "downloading");
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
    note.textContent = t("settings.updateDownloading", { percent });
    action.textContent = t("settings.updateDownloading", { percent });
    action.disabled = true;
  } else if (updater.phase === "ready") {
    note.textContent = t("settings.updateReady");
    action.textContent = t("settings.updateInstall");
  } else if (updater.phase === "error") {
    note.textContent = t("settings.updateFailed", { error: updater.error });
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
  renderUpdateUI();
  updater.unlisten = onDownloadProgress(({ received, total }) => {
    if (!total) return;
    updater.progress = clamp(received / total, 0, 1);
    renderUpdateUI();
  });
  try {
    updater.installerPath = await downloadInstaller(release.assetUrl, release.assetSize);
    updater.progress = 1;
    updater.phase = "ready";
    toast(t("settings.updateReady"));
  } catch (error) {
    updater.phase = "error";
    updater.error = String(error?.message || error);
  } finally {
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
