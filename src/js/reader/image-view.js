/**
 * 图片放大：点书里的插图或漫画页，铺满窗口看。
 *
 * 只做三件事：整页铺开（默认按窗口缩放到完整可见）、滚轮缩放、点一下或 Esc 关掉。
 * 不做缩放条、不做旋转、不做翻页——那些属于图像查看器，这里只需要「看清图上那行字」。
 *
 * 图片是章节 iframe 里的 `blob:` URL，同源且未失效，直接放进主文档的 `<img>`
 * 就能显示；把整个 iframe 放大反而会把它重新排版一次。
 */
import { t } from "../i18n.js";
import { clamp } from "../core/dom.js";

let box = null;
let img = null;
let scale = 1;
let base = 0;

function ensureBox() {
  if (box) return box;
  box = document.createElement("div");
  box.className = "img-view";
  box.id = "imgView";
  box.hidden = true;
  box.innerHTML = `
    <figure class="img-view-stage"><img alt="" /></figure>
    <p class="img-view-hint"></p>`;
  document.body.append(box);
  img = box.querySelector("img");
  box.addEventListener("click", closeImage);
  box.addEventListener("wheel", onWheel, { passive: false });
  box.querySelector(".img-view-stage").addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    resetZoom();
  });
  return box;
}

function onWheel(event) {
  if (!img) return;
  event.preventDefault();
  const step = event.deltaY < 0 ? 1.12 : 1 / 1.12;
  setScale(scale * step);
}

/** 缩放：以「当前适应窗口的宽度」为 1，超过 1 之后容器出现滚动条 */
function setScale(next) {
  if (!img) return;
  scale = clamp(next, 0.5, 6);
  if (scale <= 1.001) {
    resetZoom();
    return;
  }
  // 第一次放大时量一次基准宽度，之后都按它乘——量在 `max-width` 生效的状态下才准
  if (!base) base = img.getBoundingClientRect().width || 0;
  img.classList.remove("is-fit");
  img.style.width = `${Math.round(base * scale)}px`;
  img.style.maxWidth = "none";
  img.style.maxHeight = "none";
}

function resetZoom() {
  scale = 1;
  base = 0;
  if (!img) return;
  img.classList.add("is-fit");
  img.style.width = "";
  img.style.maxWidth = "";
  img.style.maxHeight = "";
  box.scrollTop = 0;
  box.scrollLeft = 0;
}

/**
 * @param {string} src 图片地址（`blob:` 直接可用）
 * @param {string} [alt] 替代文字，同时用作小窗底部的说明
 */
function openImage(src, alt = "") {
  if (!src) return;
  const shell = ensureBox();
  resetZoom();
  img.src = src;
  img.alt = alt;
  shell.querySelector(".img-view-hint").textContent = alt
    ? `${alt} · ${t("reader.imageHint")}`
    : t("reader.imageHint");
  shell.hidden = false;
  document.documentElement.classList.add("is-img-view");
  document.addEventListener("keydown", onKey, true);
}

function onKey(event) {
  if (event.key !== "Escape") return;
  // 让行内翻页键不再收到这一次：Esc 是「关掉正在看的东西」
  event.stopPropagation();
  closeImage();
}

function closeImage() {
  if (!box || box.hidden) return;
  box.hidden = true;
  img.removeAttribute("src");
  document.documentElement.classList.remove("is-img-view");
  document.removeEventListener("keydown", onKey, true);
}

function imageViewOpen() {
  return Boolean(box && !box.hidden);
}

export { openImage, closeImage, imageViewOpen };
