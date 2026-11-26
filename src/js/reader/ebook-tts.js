/**
 * 电子书朗读：把当前节的文字切成句，逐句交给系统嗓音。
 *
 * 句源是渲染器里活着的文档（文本节点逐节点切句），每句记下 Range 与 CFI：
 * Range 用来画「正在读」的临时高亮，CFI 用来在句子不在眼前时先跳过去。
 * 高亮走 overlayer 直画（key 固定 `tts-now`），不进划线存储——它是朗读的
 * 影子，不是用户的笔迹，停止即撤，换章重建 overlayer 后由 load 事件补画。
 */
import { Overlayer } from "../../vendor/foliate/overlayer.js";

const MARK_KEY = "tts-now";
const SPLIT = /(?<=[。！？…!?])|\n+/;

/** spine 下标藏在 CFI 第一段：epubcfi(/6/<2*(index+1)>!/…) */
function cfiSection(cfi) {
  const m = /epubcfi\(\/6\/(\d+)/.exec(cfi || "");
  return m ? Number(m[1]) / 2 - 1 : -1;
}

function sentencesOf(doc) {
  const out = [];
  // 换章的空档里 doc 可能已经有 <html> 还没有 <body>：`createTreeWalker(null)` 会抛，
  // 而 `build()` 是在 `speak()` 的异步链里调的，异常会变成一条未捕获拒绝
  if (!doc?.body) return out;
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const tag = node.parentElement?.tagName;
      if (tag === "SCRIPT" || tag === "STYLE") return NodeFilter.FILTER_REJECT;
      return node.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    let offset = 0;
    for (const piece of node.textContent.split(SPLIT)) {
      const text = piece.trim();
      if (text) {
        const start = node.textContent.indexOf(piece, offset);
        const range = doc.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + piece.length);
        out.push({ text, range });
      }
      offset += piece.length;
    }
  }
  return out;
}

function visible(reader, range) {
  const vis = reader.visibleRange;
  if (!vis) return true;
  try {
    return (
      range.compareBoundaryPoints(Range.END_TO_START, vis) < 0 &&
      range.compareBoundaryPoints(Range.START_TO_END, vis) > 0
    );
  } catch (_) {
    return true;
  }
}

function weakColor() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--accent-weak").trim();
  return raw || "#ebd9d3";
}

function createTts(reader, { getSettings, onChange, onDone }) {
  const synth = window.speechSynthesis;
  const settings = () => getSettings?.() || {};
  let sentences = [];
  let idx = -1;
  let token = 0;
  let paused = false;
  let on = false;
  let markContent = null;
  let advancing = false;
  let spokenSection = -1;

  const sectionIndex = () => cfiSection(reader.view?.lastLocation?.cfi);

  const waitSectionChange = (before, ms) =>
    new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (sectionIndex() !== before) return resolve(true);
        if (Date.now() - t0 > ms) return resolve(false);
        setTimeout(tick, 60);
      };
      tick();
    });

  const emit = () =>
    onChange?.({
      on,
      paused,
      idx,
      count: sentences.length,
      caption: idx >= 0 ? sentences[idx]?.text || "" : "",
    });

  const clearMark = () => {
    markContent?.overlayer?.remove(MARK_KEY);
    markContent = null;
  };

  const paintMark = () => {
    clearMark();
    if (!on || idx < 0) return;
    const range = sentences[idx]?.range;
    if (!range) return;
    const contents = reader.view?.renderer?.getContents?.() || [];
    const hit = contents.find((item) => item.doc === range.startContainer?.ownerDocument);
    if (!hit?.overlayer) return;
    markContent = hit;
    hit.overlayer.add(MARK_KEY, range, (rects) => {
      // 契约：同色外扩 2px + radius 2；透明度比划线笔迹(0.42)更淡一档，
      // 是「正在读」的 transient  tint 而非盖住字的实心块
      const padded = Array.from(rects, (r) => ({
        left: r.left - 2,
        top: r.top - 2,
        width: r.width + 4,
        height: r.height + 4,
      }));
      const group = Overlayer.highlight(padded, { color: weakColor() });
      group.style.opacity = "0.3";
      for (const rect of group.querySelectorAll("rect")) rect.setAttribute("rx", "2");
      return group;
    });
  };

  const cfiOf = (range) => {
    const contents = reader.view?.renderer?.getContents?.() || [];
    const hit = contents.find((item) => item.doc === range.startContainer?.ownerDocument);
    if (!hit) return "";
    try {
      return reader.view.getCFI(hit.index, range);
    } catch (_) {
      return "";
    }
  };

  const build = () => {
    const contents = reader.view?.renderer?.getContents?.() || [];
    const doc =
      reader.visibleRange?.startContainer?.ownerDocument || contents[0]?.doc || null;
    sentences = doc ? sentencesOf(doc) : [];
    idx = -1;
    spokenSection = sectionIndex();
  };

  const stop = () => {
    token += 1;
    on = false;
    paused = false;
    idx = -1;
    try {
      synth?.cancel();
    } catch (_) {}
    clearMark();
    emit();
  };

  const speak = async (i) => {
    if (!on) return;
    const mine = ++token;
    if (i >= sentences.length) {
      // 节末：翻到下一节重建句表；引擎说到底了就是书末
      if (reader.view?.renderer?.atEnd) {
        stop();
        onDone?.();
        return;
      }
      const before = sectionIndex();
      advancing = true;
      try {
        await reader.view.next();
      } catch (_) {}
      const changed = await waitSectionChange(before, 900);
      advancing = false;
      if (mine !== token || !on) return;
      if (!changed) {
        stop();
        onDone?.();
        return;
      }
      build();
      return speak(0);
    }
    idx = Math.max(0, i);
    const item = sentences[idx];
    if (!item) return stop();
    if (!visible(reader, item.range)) {
      const cfi = cfiOf(item.range);
      if (cfi) {
        try {
          await reader.view.goTo(cfi);
        } catch (_) {}
      }
      if (mine !== token || !on) return;
    }
    paintMark();
    emit();
    const utter = new SpeechSynthesisUtterance(item.text);
    utter.rate = settings().ebookTtsRate || 1;
    const voice = pickVoice();
    if (voice) utter.voice = voice;
    utter.onend = () => {
      if (mine === token && on) speak(idx + 1);
    };
    utter.onerror = () => {
      if (mine === token && on) stop();
    };
    try {
      synth.cancel();
      synth.speak(utter);
    } catch (_) {
      stop();
    }
  };

  const voices = () => {
    try {
      return (synth?.getVoices() || []).filter((v) => v.localService);
    } catch (_) {
      return [];
    }
  };

  const pickVoice = () => {
    const list = voices();
    const named = settings().ebookTtsVoice;
    if (named) {
      const hit = list.find((v) => v.name === named);
      if (hit) return hit;
    }
    const lang = settings().language === "en" ? "en" : "zh";
    return list.find((v) => v.lang?.toLowerCase().startsWith(lang)) || list[0] || null;
  };

  const start = () => {
    if (!synth || typeof SpeechSynthesisUtterance === "undefined") return false;
    if (!voices().length) return false;
    stop();
    on = true;
    build();
    if (!sentences.length) {
      stop();
      return false;
    }
    // 从眼前这一句读起：第一句与可见范围有交集的；都不可见则从头
    const first = sentences.findIndex((item) => visible(reader, item.range));
    speak(first >= 0 ? first : 0);
    return true;
  };

  // 手动换章由 relocate 驱动：预加载相邻章不会 relocate，不会误触发；
  // 自动续读时 advancing 为真，由 speak 的节末分支负责
  const onRelocate = (index) => {
    if (!on || advancing || index === spokenSection) return;
    build();
    speak(0);
  };

  return {
    start,
    stop,
    pause() {
      if (!on || paused) return;
      paused = true;
      try {
        synth.pause();
      } catch (_) {}
      emit();
    },
    resume() {
      if (!on || !paused) return;
      paused = false;
      try {
        synth.resume();
      } catch (_) {}
      emit();
    },
    prev() {
      if (on) speak(Math.max(0, idx - 1));
    },
    next() {
      if (on) speak(idx + 1);
    },
    voices,
    get on() {
      return on;
    },
    get paused() {
      return paused;
    },
    onRelocate,
    dispose() {
      stop();
    },
  };
}

export { createTts, cfiSection };