/**
 * 阅读辅助条：朗读与自动滚动共用的一条贴底浮层，同一时刻只活一个。
 *
 * 为什么合在一条：两者都是「让书自己往前走」，互斥是语义本身——朗读时再自动
 * 翻页会互相抢位置。合条之后互斥不需要额外记账，启动一个先停另一个即可。
 *
 * 自动滚动分两套引擎：滚动模式走 rAF 逐帧推像素（速度档 × 16px/s，浮点累加
 * 再取整，否则低档位每帧不足 1px 会被 scrollTop 截断成「不动」）；分页模式
 * 走定时翻页（(16 − 速度×1.2) 秒/页）。用户滚轮 / 按下即暂停，把位置交还给人。
 */
import { state } from "../core/session.js";
import { t } from "../i18n.js";
import { toast } from "../core/feedback.js";
import { persistSettings } from "../preferences.js";
import { escapeHtml } from "../core/dom.js";
import { createTts, cfiSection } from "./ebook-tts.js";
import { isScroll, scrollByPx } from "./ebook-mode.js";
import { updateToolbarPage } from "./toolbar.js";

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const assists = new WeakMap();

const icon = (name) => `<svg class="ic"><use href="#${name}"/></svg>`;

function barHtml() {
  return `<div class="assist-row" data-kind="tts" hidden>
      <button class="assist-btn" data-a="tts-toggle" title="${t("reader.ttsPlay")}">${icon("i-pause")}</button>
      <button class="assist-btn" data-a="tts-prev" title="${t("reader.ttsPrev")}">${icon("i-chevron-left")}</button>
      <button class="assist-btn" data-a="tts-next" title="${t("reader.ttsNext")}">${icon("i-chevron-right")}</button>
      <span class="assist-caption" aria-live="polite"></span>
      <select class="assist-select" data-a="tts-rate" title="${t("reader.ttsRate")}" aria-label="${t("reader.ttsRate")}">
        ${RATES.map((r) => `<option value="${r}">${r}×</option>`).join("")}
      </select>
      <select class="assist-select assist-voice" data-a="tts-voice" title="${t("reader.ttsVoice")}" aria-label="${t("reader.ttsVoice")}"></select>
      <button class="assist-btn" data-a="tts-stop" title="${t("reader.ttsStop")}">${icon("i-x")}</button>
    </div>
    <div class="assist-row" data-kind="auto" hidden>
      <button class="assist-btn" data-a="auto-toggle" title="${t("reader.autoPause")}">${icon("i-pause")}</button>
      <span class="assist-label">${t("reader.autoSpeed")}</span>
      <input class="assist-speed" data-a="auto-speed" type="range" min="1" max="10" step="1"
        aria-label="${t("reader.autoSpeed")}" title="${t("reader.autoSpeed")}" />
      <span class="assist-speed-val"></span>
      <button class="assist-btn" data-a="auto-stop" title="${t("reader.autoStop")}">${icon("i-x")}</button>
    </div>`;
}

function assistOf(pane) {
  return assists.get(pane) || null;
}

function ensureAssist(pane) {
  const existing = assists.get(pane);
  if (existing) return existing;
  const reader = pane.ebook;
  const bar = document.createElement("div");
  bar.className = "ebook-assist";
  bar.hidden = true;
  bar.innerHTML = barHtml();
  pane.ebookStack.append(bar);

  const auto = { on: false, paused: false, raf: 0, timer: 0, acc: 0, last: 0, stall: 0 };
  const assist = { kind: null, bar, auto, tts: null, viewHook: null, noVoice: false };

  const sync = () => {
    assist.kind = assist.tts?.on ? "tts" : auto.on ? "auto" : assist.noVoice ? "tts" : null;
    bar.hidden = !assist.kind;
    bar.classList.toggle("is-dead", Boolean(assist.noVoice));
    for (const row of bar.querySelectorAll(".assist-row")) {
      row.hidden = row.dataset.kind !== assist.kind;
    }
    if (assist.kind === "tts") {
      const st = assist.ttsState || {};
      const toggle = bar.querySelector('[data-a="tts-toggle"]');
      toggle.innerHTML = icon(assist.noVoice ? "i-speech" : st.paused ? "i-play" : "i-pause");
      toggle.title = t("reader.ttsPlay");
      const caption = bar.querySelector(".assist-caption");
      caption.textContent = assist.noVoice ? t("reader.ttsNoVoice") : st.caption || "";
      caption.title = caption.textContent;
      caption.classList.toggle("is-warn", Boolean(assist.noVoice));
      bar.querySelector('[data-a="tts-rate"]').value = String(state.settings.ebookTtsRate || 1);
      fillVoices(assist);
      // 无嗓音：除「停止」外全部禁用，摆着能点的按钮比不摆更糟
      for (const el of bar.querySelectorAll('[data-kind="tts"] [data-a]')) {
        el.disabled = Boolean(assist.noVoice) && el.dataset.a !== "tts-stop";
      }
    } else if (assist.kind === "auto") {
      const toggle = bar.querySelector('[data-a="auto-toggle"]');
      toggle.innerHTML = icon(auto.paused ? "i-play" : "i-pause");
      toggle.title = t(auto.paused ? "reader.autoResume" : "reader.autoPause");
      const speed = state.settings.ebookAutoSpeed || 5;
      bar.querySelector('[data-a="auto-speed"]').value = String(speed);
      bar.querySelector(".assist-speed-val").textContent = String(speed);
    }
    updateToolbarPage();
  };
  assist.sync = sync;

  assist.tts = createTts(reader, {
    getSettings: () => state.settings,
    onChange: (st) => {
      assist.ttsState = st;
      sync();
    },
    onDone: () => toast(t("reader.ttsDone")),
  });

  const stopAuto = () => {
    auto.on = false;
    auto.paused = false;
    cancelAnimationFrame(auto.raf);
    clearInterval(auto.timer);
    auto.raf = 0;
    auto.timer = 0;
  };
  assist.stopAuto = stopAuto;

  const finishAuto = () => {
    stopAuto();
    sync();
    toast(t("reader.ebookAtEnd"));
  };

  const pagedInterval = () => (16 - (state.settings.ebookAutoSpeed || 5) * 1.2) * 1000;

  const startPaged = () => {
    clearInterval(auto.timer);
    auto.timer = setInterval(() => {
      if (auto.paused || !auto.on) return;
      if (reader.view?.renderer?.atEnd) return finishAuto();
      reader.next();
    }, pagedInterval());
  };
  assist.restartPaged = () => {
    if (auto.on && !isScroll(reader)) startPaged();
  };

  const startAuto = () => {
    assist.noVoice = false;
    assist.tts.stop();
    stopAuto();
    auto.on = true;
    auto.acc = 0;
    auto.stall = 0;
    auto.last = performance.now();
    if (isScroll(reader)) {
      const loop = (ts) => {
        if (!auto.on) return;
        const dt = Math.min(64, ts - auto.last);
        auto.last = ts;
        if (!auto.paused) {
          auto.acc += ((state.settings.ebookAutoSpeed || 5) * 16 * dt) / 1000;
          const px = Math.floor(auto.acc);
          if (px > 0) {
            auto.acc -= px;
            const before = reader.view?.renderer?.start;
            scrollByPx(reader, px);
            // 推了像素却纹丝不动 = 全书到底；章末换章由模式层的边缘钩子接管
            if (reader.view?.renderer?.start === before) {
              auto.stall += dt;
              if (auto.stall > 1200) return finishAuto();
            } else {
              auto.stall = 0;
            }
          }
        }
        auto.raf = requestAnimationFrame(loop);
      };
      auto.raf = requestAnimationFrame(loop);
    } else {
      startPaged();
    }
    sync();
  };
  assist.startAuto = startAuto;

  // 用户伸手（滚轮 / 按下）即暂停自动，位置交还给人；点在辅助条自己身上不算
  const yieldToUser = (event) => {
    if (!auto.on || auto.paused) return;
    if (event.target?.closest?.(".ebook-assist")) return;
    auto.paused = true;
    sync();
  };
  pane.ebookStack.addEventListener("wheel", yieldToUser, { passive: true, capture: true });
  pane.ebookStack.addEventListener("pointerdown", yieldToUser, { capture: true });
  assist.yieldToUser = yieldToUser;

  bar.addEventListener("click", (event) => {
    const act = event.target.closest("[data-a]")?.dataset.a;
    if (!act) return;
    if (act === "tts-toggle") assist.tts.paused ? assist.tts.resume() : assist.tts.pause();
    else if (act === "tts-prev") assist.tts.prev();
    else if (act === "tts-next") assist.tts.next();
    else if (act === "tts-stop" || act === "auto-stop") stopAssist(pane);
    else if (act === "auto-toggle") {
      auto.paused = !auto.paused;
      auto.last = performance.now();
      sync();
    }
  });
  bar.addEventListener("change", (event) => {
    const el = event.target.closest("[data-a]");
    if (!el) return;
    if (el.dataset.a === "tts-rate") {
      state.settings.ebookTtsRate = Number(el.value) || 1;
      persistSettings();
    } else if (el.dataset.a === "tts-voice") {
      state.settings.ebookTtsVoice = el.value;
      persistSettings();
    }
  });
  bar.addEventListener("input", (event) => {
    const el = event.target.closest('[data-a="auto-speed"]');
    if (!el) return;
    state.settings.ebookAutoSpeed = Number(el.value) || 5;
    bar.querySelector(".assist-speed-val").textContent = el.value;
    assist.restartPaged();
    persistSettings();
  });

  assists.set(pane, assist);
  return assist;
}

function fillVoices(assist) {
  const select = assist.bar.querySelector('[data-a="tts-voice"]');
  const voices = assist.tts.voices();
  // 嗓音列表没变就不重建：每句字幕都 sync 一次，重建会把正开着的下拉打断
  const sig = voices.map((v) => v.name).join("|");
  if (assist.voiceSig === sig && select.options.length) return;
  assist.voiceSig = sig;
  const current = state.settings.ebookTtsVoice || "";
  select.innerHTML = `<option value="">${t("reader.ttsVoiceDefault")}</option>` +
    voices.map((v) => `<option value="${escapeHtml(v.name)}">${escapeHtml(v.name)}</option>`).join("");
  select.value = voices.some((v) => v.name === current) ? current : "";
}

/** 打开书之后把 relocate 接给朗读：手动换章时句表跟着重建 */
function bindAssistView(pane) {
  const assist = assists.get(pane);
  const view = pane.ebook?.view;
  if (!assist || !view || assist.viewHook) return;
  assist.viewHook = (event) => assist.tts.onRelocate(cfiSection(event.detail?.cfi));
  view.addEventListener("relocate", assist.viewHook);
}

function toggleTts(pane) {
  if (!pane?.ebook?.book || pane.ebook.fixed) return;
  const assist = ensureAssist(pane);
  if (assist.tts.on || assist.noVoice) return stopAssist(pane);
  assist.stopAuto();
  if (!assist.tts.start()) {
    // 契约：无嗓音时条仍出现，主按钮置灰 + 警告文案替代字幕
    assist.noVoice = true;
    assist.sync();
    return;
  }
  bindAssistView(pane);
}

function toggleAuto(pane) {
  if (!pane?.ebook?.book || pane.ebook.fixed) return;
  const assist = ensureAssist(pane);
  if (assist.auto.on) return stopAssist(pane);
  assist.startAuto();
  bindAssistView(pane);
}

/** Space：辅助运行中时播放 / 暂停；没在运行返回 false，交还给翻页 */
function pauseResumeAssist(pane) {
  const assist = assists.get(pane);
  if (!assist?.kind) return false;
  if (assist.kind === "tts") {
    if (assist.tts.paused) assist.tts.resume();
    else assist.tts.pause();
  } else {
    assist.auto.paused = !assist.auto.paused;
    assist.auto.last = performance.now();
    assist.sync();
  }
  return true;
}

/** Ctrl+[ / ]：朗读的前一句 / 后一句；不在朗读返回 false */
function stepAssist(pane, direction) {
  const assist = assists.get(pane);
  if (assist?.kind !== "tts") return false;
  if (direction > 0) assist.tts.next();
  else assist.tts.prev();
  return true;
}

/** 手动翻页 / 跳章 / 关书都走这里：辅助让位 */
function stopAssist(pane) {
  const assist = assists.get(pane);
  if (!assist) return;
  assist.noVoice = false;
  assist.tts.dispose();
  assist.stopAuto();
  assist.sync();
}

/** 换文档 / 合栏：连条带监听一起撤 */
function disposeAssist(pane) {
  const assist = assists.get(pane);
  if (!assist) return;
  stopAssist(pane);
  if (assist.viewHook) pane.ebook?.view?.removeEventListener("relocate", assist.viewHook);
  pane.ebookStack.removeEventListener("wheel", assist.yieldToUser, { capture: true });
  pane.ebookStack.removeEventListener("pointerdown", assist.yieldToUser, { capture: true });
  assist.bar.remove();
  assists.delete(pane);
}

export { assistOf, ensureAssist, bindAssistView, toggleTts, toggleAuto, stopAssist, disposeAssist, pauseResumeAssist, stepAssist };