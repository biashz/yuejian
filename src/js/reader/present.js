/**
 * 演示模式：全屏单页放映，仅对 PDF 生效。
 * 离屏串行渲染 + 快照顶上首帧，避免全屏切换时闪黑或掉帧。
 */
import { $ } from "../core/dom.js";
import { clamp } from "../core/dom.js";
import { t } from "../i18n.js";
import { state } from "../core/session.js";
import { toast } from "../core/feedback.js";
import { panes, activePane, activeReader } from "./panes.js";

/* ---------------- 演示模式（全屏单页放映，仅 PDF） ---------------- */
let presenting = false;
let presentPage = 1;
/// 每次翻页自增，用于丢弃过期的渲染结果
let presentRun = 0;
/// 串行队列：同一块离屏画布不能被两次 render 同时写入
let presentChain = Promise.resolve();
let presentBuffer = null;
let presentHintTimer = 0;
/// 首帧/尺寸变化的防抖：全屏过渡会连续触发 resize，等尺寸稳定后只画一次
let presentPaintTimer = 0;
/// 已画好的「页码 + 尺寸」，用于跳过重复渲染
let presentPaintedKey = "";
/// 全屏请求尚未落地：这段时间不重新渲染，避免和全屏动画抢帧
let presentEntering = false;
/// 滚轮翻页：先累积触控板的小增量，再用冷却避免一次滑动连翻多页
let presentWheelDelta = 0;
let presentWheelTimer = 0;
let presentWheelLock = 0;

function canPresent() {
  const pane = activePane();
  return Boolean(pane?.book && pane.book.kind === "pdf" && pane.reader?.pdf);
}

function enterPresent() {
  if (presenting) return;
  if (!canPresent()) {
    toast(t("reader.presentPdfOnly"));
    return;
  }
  presenting = true;
  presentPage = state.pdfPage || 1;
  presentPaintedKey = "";

  // 放映期间挂起背后阅读器的尺寸自适应与页渲染：全屏会改变窗口尺寸，
  // 若阅读器跟着重排重绘，会和首帧渲染抢主线程，切换时就会卡
  panes.forEach((pane) => pane.reader?.suspend());

  // 放映层先不显示：等首帧画好再和画布一起出现，中途不会露出纯黑底
  const canvas = $("#presentCanvas");
  canvas.style.visibility = "hidden";
  $("#presentStage").classList.remove("is-leaving");

  // 全屏请求必须紧跟用户手势，所以先发出去；过渡期间不做整页渲染，
  // 等尺寸稳定后再补一次（与首帧尺寸一致时会被去重，不会重复画）
  presentEntering = true;
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    presentEntering = false;
    // 全屏动画刚结束时主线程仍忙，稍等一拍再做整页渲染，切换更顺
    schedulePresentPaint(80);
  };
  const request = document.documentElement.requestFullscreen?.();
  if (request?.then) request.then(settle, settle);
  else settle();
  // 兜底：个别环境 fullscreen 的 promise 不落地，超时后照常放映
  setTimeout(settle, 600);

  // 先用屏幕上已经画好的那一页顶上：进入瞬间就有画面，
  // 整页高清渲染留到全屏动画结束之后，不和过渡抢主线程
  if (!showPresentSnapshot()) presentPaint();
}

/** 进入演示时复用阅读器已渲染的页面做首帧：不必等整页重绘，切换没有空窗 */
function showPresentSnapshot() {
  if (!$("#presentStage").hidden) return false;
  const reader = activeReader();
  const source = reader?.pageSnapshot(presentPage);
  if (!source) return false;
  const sourceWidth = source.width;
  const sourceHeight = source.height;
  if (!sourceWidth || !sourceHeight) return false;

  const viewWidth = window.innerWidth;
  const viewHeight = window.innerHeight;
  // 等比放进放映区（留 12px 边），与高清渲染使用同一套尺寸口径
  const scale = Math.min((viewWidth - 24) / sourceWidth, (viewHeight - 24) / sourceHeight);
  const cssWidth = Math.max(1, Math.floor(sourceWidth * scale));
  const cssHeight = Math.max(1, Math.floor(sourceHeight * scale));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const canvas = $("#presentCanvas");
  canvas.width = Math.floor(cssWidth * dpr);
  canvas.height = Math.floor(cssHeight * dpr);
  // 显示尺寸交给 CSS 按视口约束，不写死像素：切换/替换位图都不会跳尺寸
  canvas.style.width = "";
  canvas.style.height = "";
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  canvas.style.visibility = "visible";
  showPresentStage();
  $("#presentPage").textContent = `${presentPage} / ${reader.numPages || state.pdfTotal || 0}`;
  return true;
}

/** 首帧就绪后再放出放映层：避免「先黑屏、再出现页面」的闪烁 */
function showPresentStage() {
  const stage = $("#presentStage");
  if (!stage.hidden) return;
  stage.hidden = false;
  const hint = $("#presentHint");
  hint.classList.remove("is-hidden");
  clearTimeout(presentHintTimer);
  presentHintTimer = setTimeout(() => hint.classList.add("is-hidden"), 2800);
}

/** 排一次放映页渲染；延迟期间有新的调用（如 resize）会重新计时 */
function schedulePresentPaint(delay = 120) {
  clearTimeout(presentPaintTimer);
  presentPaintTimer = setTimeout(() => {
    presentPaintTimer = 0;
    presentPaint();
  }, delay);
}

function exitPresent() {
  if (!presenting) return;
  presenting = false;
  presentEntering = false;
  presentRun += 1;
  clearTimeout(presentPaintTimer);
  presentPaintTimer = 0;
  clearTimeout(presentWheelTimer);
  presentWheelTimer = 0;
  presentWheelDelta = 0;
  presentPaintedKey = "";
  activeReader()?.cancelPaintFit();

  // 退出时先不收起放映层：全屏收回的动画期间屏幕上保持放映页，
  // 等系统真正退出全屏后再淡出、恢复阅读视图，中间不会闪出底下的阅读页
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    document.removeEventListener("fullscreenchange", release);
    const stage = $("#presentStage");
    const restore = () => {
      stage.hidden = true;
      stage.classList.remove("is-leaving");
      panes.forEach((pane) => pane.reader?.resume());
      const reader = activeReader();
      // 回到放映时停留的页，阅读位置与演示保持一致
      reader?.goPage(presentPage, false);
      // 全屏期间尺寸被挂起，退出后补一次适配（rAF 等布局稳定）
      requestAnimationFrame(() => reader?.handleResize());
    };
    // 放映层从未显示过（首帧还没画完就退出）：直接恢复
    if (stage.hidden) {
      restore();
      return;
    }
    // 150ms 淡出，与进入时的淡入对称，切换不会「啪」地硬切
    stage.classList.add("is-leaving");
    setTimeout(restore, 150);
  };

  // 先复位状态再退出全屏，避免 fullscreenchange 再次进来
  if (document.fullscreenElement) {
    document.addEventListener("fullscreenchange", release);
    document.exitFullscreen?.().catch(release);
    // 兜底：个别环境不派发 fullscreenchange，避免阅读器一直处于挂起状态
    setTimeout(release, 600);
  } else {
    release();
  }
}

function presentStep(delta) {
  if (!presenting) return;
  const total = activeReader()?.numPages || state.pdfTotal || 0;
  if (!total) return;
  const next = clamp(presentPage + delta, 1, total);
  if (next === presentPage) return;
  presentPage = next;
  state.pdfPage = next;
  presentPaint();
}

/** 滚轮翻页：向下下一页、向上上一页；触控板的小增量先累积，再用冷却避免连翻多页 */
function handlePresentWheel(event) {
  if (!presenting) return;
  event.preventDefault();
  const now = performance.now();
  if (now < presentWheelLock) return;
  presentWheelDelta += event.deltaY;
  clearTimeout(presentWheelTimer);
  presentWheelTimer = setTimeout(() => {
    presentWheelDelta = 0;
  }, 160);
  if (Math.abs(presentWheelDelta) < 40) return;
  const direction = presentWheelDelta > 0 ? 1 : -1;
  presentWheelDelta = 0;
  presentWheelLock = now + 400;
  presentStep(direction);
}

function presentPaint() {
  const reader = activeReader();
  if (!presenting || !reader) return;
  const pageNo = presentPage;
  // 尺寸统一取当前可视区：全屏后 innerWidth 就是屏幕尺寸，
  // 不必用 screen 预估，也避免刚进入时页面被放大出可视区
  const box = { width: window.innerWidth - 24, height: window.innerHeight - 24 };
  const key = `${pageNo}:${box.width}x${box.height}`;
  // 同一页、同一尺寸已经画好：重复的 resize 事件不必再渲染
  if (key === presentPaintedKey) {
    showPresentStage();
    return;
  }

  const run = ++presentRun;
  // 旧页还在渲染时先取消，翻页/全屏切换不用排队等它画完
  reader.cancelPaintFit();

  presentChain = presentChain.then(async () => {
    // 队列里已有更新的翻页请求，这一帧直接跳过
    if (!presenting || run !== presentRun) return;
    presentBuffer ??= document.createElement("canvas");
    // 传一个失效判断：getPage 等待期间若又翻页，就不必再启动这一页的渲染
    const painted = await reader.paintFit(pageNo, presentBuffer, box, () => !presenting || run !== presentRun);
    if (!presenting || run !== presentRun) return;
    // 渲染失败也要把放映层放出来，否则看起来像点击没反应
    if (!painted) {
      showPresentStage();
      return;
    }

    // 离屏画好后一次性贴到可见画布，翻页不会闪白
    const canvas = $("#presentCanvas");
    canvas.width = presentBuffer.width;
    canvas.height = presentBuffer.height;
    // 清掉内联尺寸，继续由 CSS 按视口约束显示，避免替换时尺寸跳变
    canvas.style.width = "";
    canvas.style.height = "";
    canvas.getContext("2d").drawImage(presentBuffer, 0, 0);
    canvas.style.visibility = "visible";
    // 首帧与放映层同一帧出现，不会先露黑底
    showPresentStage();
    presentPaintedKey = key;
    $("#presentPage").textContent = `${pageNo} / ${reader.numPages || state.pdfTotal || 0}`;
  }).catch(() => {
    // 单帧失败不能污染队列，否则后续翻页都会停在 rejected 状态
  });
}

export { presenting, presentEntering, canPresent, enterPresent, showPresentSnapshot, showPresentStage, schedulePresentPaint, exitPresent, presentStep, handlePresentWheel, presentPaint };
