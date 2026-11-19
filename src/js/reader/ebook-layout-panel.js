/**
 * 版式面板：电子书正文的字、段、页、细节全在这里调。
 *
 * 为什么独立于通用设置（`#settingsOverlay`）：那里面是「装完机调一次」的东西
 * （主题、语言、更新检查），而版式是看书时反复动的。混在一起，每次都要滚过一半
 * 无关内容；更要紧的是通用设置是个居中弹层，改字号时它正好盖住正文。
 *
 * 这个面板在宽窗口下**参与布局**（挤窄阅读区 332px），正文会真的重排——调的就是
 * 文字的宽窄疏密，盖住正文等于让人闭着眼睛调。窄窗口退回抽屉 + 遮罩。
 *
 * 状态读写都过 `ebook-layout.js`，这里只管 DOM 与交互；生效走
 * `ebook-open.js` 的 `refreshEbookStyles()`，一步到分页器。
 */
import { $, $$ } from "../core/dom.js";
import { t } from "../i18n.js";
import { state } from "../core/session.js";
import { persistSettings } from "../preferences.js";
import { activePane } from "./panes.js";
import { RANGE, readLayout, setBreakMode, applyPreset, activePreset, resetLayout, SIZE_STEP } from "./ebook-layout.js";
import { refreshEbookStyles } from "./ebook-open.js";
import { renderToolbar } from "./toolbar.js";

/** 滑杆配置：范围取自 ebook-layout 的 RANGE，`fmt` 只决定显示，不参与计算 */
const SLIDERS = {
  letter: { key: "ebookLetterSpacing", range: RANGE.letter, step: 0.25, fmt: (v) => (v > 0 ? `+${v}` : String(v)) },
  lineHeight: { key: "ebookLineHeight", range: RANGE.lineHeight, step: 0.05, fmt: (v) => v.toFixed(2) },
  para: { key: "ebookParaSpacing", range: RANGE.paraSpacing, step: 2, fmt: (v) => `${v}` },
  margin: { key: "ebookMargin", range: RANGE.margin, step: 4, fmt: (v) => `${v}` },
  measure: { key: "ebookMeasure", range: RANGE.measure, step: 20, fmt: (v) => `${v}` },
  gap: { key: "ebookGap", range: RANGE.gap, step: 0.5, fmt: (v) => `${v}%` },
};

const SWITCHES = {
  spread: "ebookSpread", hyphenate: "ebookHyphenate", punctuate: "ebookPunctuate",
  // 配色覆盖独立于排版覆盖：夜读主题下不接管字色，书里写死的深色字会读不清
  override: "ebookOverride", overrideColor: "ebookOverrideColor",
};
const FAMILY_LABEL = { serif: "settings.ebookSerif", sans: "settings.ebookSans", kai: "settings.ebookKai" };

let mounted = false;

/** 一行：标签在左、控件在右。`hint` 是标签下面的那行小字 */
const row = (label, control, hint = "", extra = "") => `
  <div class="lp-row"${extra}>
    <span class="lp-label">${t(label)}${hint ? `<small>${t(hint)}</small>` : ""}</span>
    ${control}
  </div>`;

/**
 * 一根滑杆：数值跟标签同一行右对齐，轨道单独占一行（332px 宽里塞不下「标签 + 短轨道」）。
 *
 * min / max / step 必须写出来——`<input type=range>` 不给就是 0–100 步长 1，
 * 设 0.25 这样的值会被夹成 0，界面上表现为「值是对的、滑块却贴在头上」。
 */
const slider = (id, hint = "") => {
  const config = SLIDERS[id];
  const [min, max] = config.range;
  return `
  <div class="lp-row">
    <span class="lp-label">${t(`layout.${id}`)}${hint ? `<small>${t(hint)}</small>` : ""}</span>
    <span class="lp-val" data-val="${id}">0</span>
  </div>
  <input class="lp-range" type="range" data-range="${id}" aria-label="${t(`layout.${id}`)}"
    min="${min}" max="${max}" step="${config.step}" />`;
};

const toggle = (key, label, hint = "") => `
  <div class="lp-row">
    <span class="lp-label">${t(label)}${hint ? `<small>${t(hint)}</small>` : ""}</span>
    <button class="lp-switch" data-switch="${key}" role="switch" aria-checked="false"
      aria-label="${t(label)}"><i></i></button>
  </div>`;

function panelHtml() {
  return `
  <header class="lp-head">
    <div class="lp-title">
      <p class="eyebrow">— LAYOUT</p>
      <h2>${t("layout.title")}</h2>
      <p class="lp-sub" id="lpSub">${t("layout.sub")}</p>
    </div>
    <button class="icon-btn" id="lpClose" aria-label="${t("layout.close")}" title="${t("layout.close")}">
      <svg class="ic"><use href="#i-x"/></svg>
    </button>
  </header>

  <div class="lp-body" id="lpBody">
    <p class="lp-notice" id="lpNotice" hidden>${t("layout.notice")}</p>

    <section class="lp-group">
      <h3>${t("layout.preset")}</h3>
      <div class="lp-presets" id="lpPresets">
        <button class="lp-chip" data-preset="comfort">${t("layout.preset.comfort")}</button>
        <button class="lp-chip" data-preset="compact">${t("layout.preset.compact")}</button>
        <button class="lp-chip" data-preset="latin">${t("layout.preset.latin")}</button>
        <span class="lp-chip is-custom" id="lpCustom" hidden>${t("layout.preset.custom")}</span>
      </div>
    </section>

    <section class="lp-group">
      <h3>${t("layout.text")}</h3>
      ${row("layout.family", `<div class="lp-seg" id="lpFamily">${
        ["serif", "sans", "kai"].map((value) => `<button data-family="${value}">${t(FAMILY_LABEL[value])}</button>`).join("")
      }</div>`)}
      ${row("layout.size", `<div class="lp-step" id="lpSize">
        <button data-step="-1" aria-label="${t("layout.smaller")}">A−</button>
        <span class="lp-num" data-val="size">0</span>
        <button data-step="1" aria-label="${t("layout.bigger")}">A+</button></div>`)}
      ${slider("letter")}
    </section>

    <section class="lp-group">
      <h3>${t("layout.para")}</h3>
      ${slider("lineHeight")}
      <div class="lp-row"><span class="lp-label">${t("layout.breakMode")}</span></div>
      <div class="lp-seg is-block" id="lpBreak">
        <button data-break="none">${t("layout.break.none")}</button>
        <button data-break="indent">${t("layout.break.indent")}</button>
        <button data-break="space">${t("layout.break.space")}</button>
      </div>
      <div id="lpParaWrap" hidden>
        ${slider("para")}
      </div>
      ${row("layout.align", `<div class="lp-seg" id="lpAlign">
        <button data-align="left">${t("layout.alignLeft")}</button>
        <button data-align="justify">${t("layout.alignJustify")}</button></div>`)}
    </section>

    <section class="lp-group">
      <h3>${t("layout.page")}</h3>
      ${slider("margin")}
      ${slider("measure", "layout.measureHint")}
      ${slider("gap")}
      ${toggle("spread", "layout.spread")}
    </section>

    <section class="lp-group">
      <h3>${t("layout.detail")}</h3>
      ${toggle("hyphenate", "layout.hyphenate", "layout.hyphenateHint")}
      ${toggle("punctuate", "layout.punctuate", "layout.punctuateHint")}
      ${toggle("override", "layout.override", "layout.overrideHint")}
      ${toggle("overrideColor", "layout.overrideColor", "layout.overrideColorHint")}
    </section>
  </div>

  <footer class="lp-foot">
    <button class="lp-reset" id="lpReset">${t("layout.reset")}</button>
    <span class="lp-saved" id="lpSaved">${t("layout.saved")}</span>
  </footer>`;
}

/**
 * 把面板挂到阅读区里，插在目录侧栏**前面**（DOM 顺序 panes → 版式 → 目录），
 * 这样两个侧栏同开时目录仍在最右侧，位置稳定。
 */
function mountLayoutPanel() {
  if (mounted) return;
  const host = $(".reader-body");
  if (!host) return;
  const panel = document.createElement("aside");
  panel.className = "layout-panel";
  panel.id = "layoutPanel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", t("layout.title"));
  panel.classList.add("is-hidden");
  panel.innerHTML = panelHtml();
  // 遮罩只在窄窗口有意义（宽窗口面板在流里，不盖任何东西），CSS 里用媒体查询控制显示
  const scrim = document.createElement("div");
  scrim.className = "layout-scrim";
  scrim.id = "layoutScrim";
  const ctx = $("#ctxPanel");
  host.insertBefore(scrim, ctx || null);
  host.insertBefore(panel, ctx || null);
  scrim.addEventListener("click", () => setLayoutPanel(false));
  bindPanel(panel);
  mounted = true;
}

/** 版式改动落盘 + 重排。`live` 期间不碰版心宽度，见 `refreshEbookStyles` 的注释 */
function commit({ live = false } = {}) {
  persistSettings();
  if (!live) {
    refreshEbookStyles();
    return;
  }
  refreshEbookStyles({ render: false, live: true });
}

/** 把 settings 的当前值铺回面板：所有控件状态只有这一个来源 */
function syncLayoutPanel() {
  const panel = $("#layoutPanel");
  if (!panel) return;
  const layout = readLayout(state.settings);
  const fixed = Boolean(activePane()?.ebook?.fixed);

  panel.classList.toggle("is-fixed", fixed);
  $("#lpNotice").hidden = !fixed;
  $("#lpSub").textContent = t(fixed ? "layout.fixedSub" : "layout.sub");

  // 预设
  const preset = activePreset(layout);
  $$("[data-preset]", panel).forEach((btn) => btn.classList.toggle("is-on", btn.dataset.preset === preset));
  $("#lpCustom").hidden = Boolean(preset);

  // 分段控件
  $$("[data-family]", panel).forEach((btn) => btn.classList.toggle("is-on", btn.dataset.family === layout.family));
  $$("[data-align]", panel).forEach((btn) => btn.classList.toggle("is-on", btn.dataset.align === layout.align));
  $$("[data-break]", panel).forEach((btn) => btn.classList.toggle("is-on", btn.dataset.break === layout.breakMode));

  // 字号：到头就禁掉那一侧，不整组禁用
  $("[data-val='size']", panel).textContent = String(layout.size);
  $$("[data-step]", panel).forEach((btn) => {
    const next = layout.size + Number(btn.dataset.step) * SIZE_STEP;
    btn.disabled = next < RANGE.size[0] || next > RANGE.size[1];
  });

  // 滑杆
  for (const [id, config] of Object.entries(SLIDERS)) {
    const input = $(`[data-range="${id}"]`, panel);
    const field = id === "para" ? "paraSpacing" : id;
    const value = layout[field];
    input.value = String(value);
    input.disabled = fixed;
    const [min, max] = config.range;
    input.style.setProperty("--_fill", `${((value - min) / (max - min)) * 100}%`);
    const label = $(`[data-val="${id}"]`, panel);
    if (label) label.textContent = config.fmt(value);
  }
  // 段距只在「段间距」模式下露出：它是分段策略的下级，不是独立旋钮
  $("#lpParaWrap").hidden = layout.breakMode !== "space";

  // 开关。配色覆盖读 layout 而不是原始字段：旧数据里它是 null，
  // 直接 Boolean(null) 会把「默认开」显示成关
  for (const [key, field] of Object.entries(SWITCHES)) {
    const on = key === "overrideColor" ? layout.overrideColor : Boolean(state.settings[field]);
    const btn = $(`[data-switch="${key}"]`, panel);
    btn.classList.toggle("is-on", on);
    btn.setAttribute("aria-checked", String(on));
    btn.disabled = fixed;
  }
  // 禁用态下让整块正文不可点（CSS 做视觉，这里补语义）
  $("#lpBody").setAttribute("aria-disabled", String(fixed));
}

function bindPanel(panel) {
  panel.addEventListener("click", (event) => {
    const target = event.target;

    const preset = target.closest("[data-preset]");
    if (preset) {
      applyPreset(state.settings, preset.dataset.preset);
      commit();
      syncLayoutPanel();
      return;
    }

    const family = target.closest("[data-family]");
    if (family) {
      state.settings.ebookFamily = family.dataset.family;
      commit();
      syncLayoutPanel();
      return;
    }

    const align = target.closest("[data-align]");
    if (align) {
      state.settings.ebookAlign = align.dataset.align;
      commit();
      syncLayoutPanel();
      return;
    }

    const brk = target.closest("[data-break]");
    if (brk) {
      setBreakMode(state.settings, brk.dataset.break);
      commit();
      syncLayoutPanel();
      return;
    }

    const step = target.closest("[data-step]");
    if (step) {
      const next = readLayout(state.settings).size + Number(step.dataset.step) * SIZE_STEP;
      state.settings.ebookFontSize = Math.min(RANGE.size[1], Math.max(RANGE.size[0], next));
      commit();
      syncLayoutPanel();
      return;
    }

    const sw = target.closest("[data-switch]");
    if (sw) {
      const field = SWITCHES[sw.dataset.switch];
      // 一律写成明确的布尔值：`null` 是旧数据的容错态，不该再产生
      state.settings[field] = sw.dataset.switch === "overrideColor"
        ? !readLayout(state.settings).overrideColor
        : !state.settings[field];
      commit();
      syncLayoutPanel();
      return;
    }

    if (target.closest("#lpReset")) {
      resetLayout(state.settings);
      commit();
      syncLayoutPanel();
      return;
    }

    if (target.closest("#lpClose")) setLayoutPanel(false);
  });

  // 拖动中只改样式（浏览器自己会把当前页的文字重排一遍），松手再重排一次让页码算准
  panel.addEventListener("input", (event) => {
    const input = event.target.closest("[data-range]");
    if (!input) return;
    const config = SLIDERS[input.dataset.range];
    if (!config) return;
    state.settings[config.key] = Number(input.value);
    commit({ live: true });
    // 只回写这一根的数值与填充，别整块 sync：整块 sync 会把 value 又写回去，打断拖动
    const id = input.dataset.range;
    const label = $(`[data-val="${id}"]`, panel);
    if (label) label.textContent = config.fmt(Number(input.value));
    const [min, max] = config.range;
    input.style.setProperty("--_fill", `${((Number(input.value) - min) / (max - min)) * 100}%`);
  });

  panel.addEventListener("change", (event) => {
    if (!event.target.closest("[data-range]")) return;
    commit();
    syncLayoutPanel();
  });
}

/** 开合面板；`force` 省略时是切换。工具栏按钮、Esc、遮罩都走这里 */
function setLayoutPanel(open) {
  mountLayoutPanel();
  const panel = $("#layoutPanel");
  if (!panel) return;
  // 没有电子书可读时不开：里面每一项都不会有效果
  const next = Boolean(open) && Boolean(activePane()?.ebook);
  state.layoutOpen = next;
  // 用 class 而不是 hidden：收合要有 240ms 的宽度过渡，display:none 做不出来
  panel.classList.toggle("is-hidden", !next);
  $("#layoutScrim")?.classList.toggle("is-on", next);
  document.body.classList.toggle("layout-open", next);
  if (next) syncLayoutPanel();
  renderToolbar();
}

const toggleLayoutPanel = () => setLayoutPanel(!state.layoutOpen);

/** 下载入时若面板开着但没有书了（切文档），收起；否则按新书的形态重铺一遍 */
function refreshLayoutPanel() {
  if (!state.layoutOpen) return;
  if (!activePane()?.ebook) {
    setLayoutPanel(false);
    return;
  }
  syncLayoutPanel();
}

export { mountLayoutPanel, setLayoutPanel, toggleLayoutPanel, syncLayoutPanel, refreshLayoutPanel };
