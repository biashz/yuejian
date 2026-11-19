/**
 * 侧栏「缩略图」页：只对 PDF 有，按需渲染（滚动到视口附近才画）。
 *
 * 一本书几百页，全部画出来要几百次 canvas 渲染；`IntersectionObserver`
 * 提前 200px 预取，滚到哪儿画到哪儿。
 */
import { $, $$ } from "../core/dom.js";
import { t } from "../i18n.js";
import { activePane } from "./panes.js";

let observer = null;

function renderThumbs() {
  const body = $("#ctxBody");
  const pane = activePane();
  const total = pane?.total || pane?.book?.pages || 0;
  if (!total) {
    body.innerHTML = `<div class="ctx-empty">${t("reader.thumbsLoading")}</div>`;
    return;
  }
  body.innerHTML = Array.from({ length: total }, (_, index) => `
    <button class="thumb-item ${index + 1 === pane.page ? "is-active" : ""}" data-goto="${index + 1}" data-kind="pdf">
      <div class="thumb-page"><canvas data-thumb="${index + 1}"></canvas></div>
      <span class="thumb-no">${t("reader.pageN", { page: index + 1 })}</span>
    </button>`).join("");

  observer?.disconnect();
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const canvas = entry.target;
      observer.unobserve(canvas);
      if (canvas.dataset.done) continue;
      canvas.dataset.done = "1";
      pane.reader?.renderThumb(Number(canvas.dataset.thumb), canvas).catch(() => {});
    }
  }, { root: body, rootMargin: "200px" });
  $$("canvas[data-thumb]", body).forEach((canvas) => observer.observe(canvas));

  body.querySelector(".thumb-item.is-active")?.scrollIntoView({ block: "nearest" });
}

function markThumbActive() {
  const pane = activePane();
  $$("#ctxBody .thumb-item").forEach((item) => {
    item.classList.toggle("is-active", Number(item.dataset.goto) === pane?.page);
  });
}

export { renderThumbs, markThumbActive };
