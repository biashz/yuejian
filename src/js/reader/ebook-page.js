/**
 * 书页装饰：中缝、叠纸、页码、翻页掠影，以及书页本体的宽度。
 *
 * 正文画在 `<foliate-view>` 的 closed shadow root 里——宿主既进不去，也碰不到
 * 它内部的滚动条。所以这里只做两件合法的事：
 *
 * 1. **在外层画**：中缝阴影、页码、掠影都是绝对定位、`pointer-events:none`
 *    的兄弟层，不参与命中测试，也不进划线与朗读的坐标系。
 * 2. **改宿主宽度**：分页器的每栏宽度由容器宽度算出（`size / divisor - gap`），
 *    收窄书页就收窄了正文行宽——「单页居中一叶」「滚动长卷」都不用动库。
 *
 * 页码不落盘：版式一变，每页装多少字就变，存下来的页码必然骗人。全书页码用
 * 章节字节数折算——量到第一个够长的章节后就把「一页多少字」定下来，换版式
 * （样式表、页边距、列距任一变）再重测。没量到之前先显示节内页码，宁可粗，
 * 不给假精确。
 */

const FOLIO_MIN_MARGIN = 26;
const SWEEP_MS = 320;
const SWEEP_EASE = "cubic-bezier(.22,.8,.24,1)";
/** 两次掠影的最小间隔：一次翻页的 scroll 事件是一串，不能每帧都闪 */
const SWEEP_QUIET = 260;
/** 开书时的落位滚动不算翻页，先安静一会儿 */
const SWEEP_WARMUP = 600;

const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

const el = (tag, className) => {
  const node = document.createElement(tag);
  node.className = className;
  node.setAttribute("aria-hidden", "true");
  return node;
};

class PageDecor {
  constructor(reader) {
    this.reader = reader;
    this.stack = reader.stack;
    this.turn = "slide";
    /* 全书页码的换算样本：key 变（版式变）就作废 */
    this.sample = { key: "", chars: 0 };
    this.lastIndex = -1;
    this.lastPage = 0;
    this.lastAbs = Math.abs(reader.view?.renderer?.start || 0);
    this.lastSweep = 0;
    this.born = performance.now();

    this.gutter = el("div", "ebook-gutter");
    this.folio = el("div", "ebook-folio");
    this.folioL = el("span", "folio-l");
    this.folioR = el("span", "folio-r");
    this.folio.append(this.folioL, this.folioR);
    this.folio.hidden = true;
    this.sweep = el("div", "ebook-sweep");
    this.band = el("div", "ebook-sweep-band");
    this.sweep.append(this.band);
    this.stack.append(this.gutter, this.folio, this.sweep);

    this.under = this.#ensureUnder();

    const renderer = reader.view?.renderer;
    this.onRelocate = (event) => this.#relocate(event.detail);
    this.onScroll = () => this.#onScroll();
    renderer?.addEventListener("relocate", this.onRelocate);
    renderer?.addEventListener("scroll", this.onScroll);

    this.ro = new ResizeObserver(() => this.sync());
    if (this.stack.parentElement) this.ro.observe(this.stack.parentElement);
    this.sync();
  }

  /** 叠纸：书页下面那张露出一点边的纸。放在书页前面，靠 DOM 顺序压在下层 */
  #ensureUnder() {
    const parent = this.stack.parentElement;
    if (!parent) return null;
    let under = parent.querySelector(":scope > .ebook-under");
    if (!under) {
      under = el("div", "ebook-under");
      under.hidden = true;
      parent.insertBefore(under, this.stack);
    }
    return under;
  }

  setTurn(turn) {
    this.turn = turn === "fade" || turn === "none" ? turn : "slide";
    this.sync();
  }

  /**
   * 把当前姿势 / 版式的结论写到 class 与宽度上。
   * 翻页、缩放、换版式、窗口拉伸都会走到这里，必须幂等。
   */
  sync() {
    const reader = this.reader;
    const renderer = reader.view?.renderer;
    const stack = this.stack;
    if (!stack || !renderer) return;

    const scrolled = Boolean(renderer.scrolled);
    const fixed = Boolean(reader.fixed);
    const layout = reader.layout || {};
    const measure = num(layout.measure, 660);
    const margin = num(layout.margin, 56);
    const gap = num(layout.gap, 8);
    const parent = stack.parentElement;
    const avail = parent?.clientWidth || 0;
    const portrait = (parent?.clientHeight || 0) > avail;
    // 与分页器的 divisor 同一口径：容器够宽才有第二栏
    const spread = !fixed && !scrolled && Boolean(reader.spread)
      && !portrait && avail - 32 > measure;

    const sbw = scrolled ? 12 : 0;
    const cap = Math.round(measure * (spread ? 2 : 1) + margin * 2 + sbw);
    const width = fixed
      ? Math.max(0, avail - 32)
      : Math.max(0, Math.min(avail - 32, cap));
    if (width > 0) stack.style.width = `${width}px`;

    stack.style.setProperty("--ebook-margin", `${margin}px`);
    stack.style.setProperty("--ebook-gap", String(gap));

    stack.classList.toggle("is-scroll", scrolled);
    stack.classList.toggle("is-paged", !scrolled);
    stack.classList.toggle("is-fixed", fixed);
    stack.classList.toggle("is-spread", spread);
    stack.classList.toggle("is-single", !spread);
    stack.classList.toggle("is-turning", !scrolled && !fixed && this.turn === "slide");

    if (this.under) {
      this.under.hidden = scrolled || fixed || width <= 0;
      if (!this.under.hidden) this.under.style.width = `${Math.min(avail - 8, width + 12)}px`;
    }

    // 页脚塞不下一行小字就不画，宁可没有，也不压在正文上
    this.folio.hidden = scrolled || fixed || margin < FOLIO_MIN_MARGIN || this.lastPage <= 0;
  }

  #relocate(detail) {
    if (!detail) return;
    const reader = this.reader;
    const renderer = reader.view?.renderer;
    if (!renderer || renderer.scrolled || reader.fixed) return;

    const info = this.#pageInfo(detail);
    if (info) {
      this.lastPage = info.page;
      this.folioL.textContent = `— ${info.page} —`;
      this.folioR.textContent = info.next ? `— ${info.page + 1} —` : "";
    }

    const previous = this.lastIndex;
    const index = Math.max(0, Math.round(num(detail.index, previous < 0 ? 0 : previous)));
    const jumped = previous >= 0 && index !== previous
      && (detail.reason === "page" || detail.reason === "snap");
    this.lastIndex = index;
    this.sync();
    // 跨节的翻页由这里补一次掠影：跨节时容器换了文档，scroll 事件的位移不可信
    if (jumped) this.#sweep(index > previous);
  }

  /**
   * 当前该写第几页。
   *
   * `detail.fraction / size` 是节内进度，节内的页数直接可数；全书页码再按章节
   * 字节数折算。样本只取「页数 ≥ 3」的章节——封面、版权页只有一页，用它们
   * 折算出来的「一页多少字」会把全书页码算飞。
   */
  #pageInfo(detail) {
    const reader = this.reader;
    const index = Math.max(0, Math.round(num(detail?.index, 0)));
    const local = Math.min(1, Math.max(0, num(detail?.fraction, 0)));
    const step = num(detail?.size, 0);
    const pages = step > 0 ? Math.max(1, Math.round(1 / step)) : 0;
    const localPage = pages > 0
      ? Math.min(pages, Math.round(local * (pages - 1)) + 1)
      : 0;

    const sections = reader.book?.sections;
    const sizes = Array.isArray(sections)
      ? sections.map((section) => Math.max(0, num(section?.size, 0)))
      : [];
    const total = sizes.reduce((sum, size) => sum + size, 0);
    const sectionSize = sizes[index] || 0;
    if (!(total > 0) || !(sectionSize > 0)) {
      return localPage > 0 ? { page: localPage, next: localPage < pages } : null;
    }

    const key = `${reader.css}|${reader.layout?.measure}|${reader.layout?.margin}|${reader.layout?.gap}`;
    if (this.sample.key !== key) this.sample = { key, chars: 0 };
    if (!this.sample.chars && pages >= 3) this.sample.chars = sectionSize / pages;
    if (!this.sample.chars) {
      return localPage > 0 ? { page: localPage, next: localPage < pages } : null;
    }

    const before = sizes.slice(0, index).reduce((sum, size) => sum + size, 0);
    const chars = before + local * sectionSize;
    const totalPages = Math.max(1, Math.round(total / this.sample.chars));
    const page = Math.min(totalPages, Math.floor(chars / this.sample.chars) + 1);
    return { page, next: page < totalPages };
  }

  /** 翻页掠影。方向只影响起止点：正向从左扫到右，回翻反过来 */
  #onScroll() {
    if (this.turn !== "slide") return;
    const renderer = this.reader.view?.renderer;
    if (!renderer || renderer.scrolled || this.reader.fixed) return;
    const now = performance.now();
    if (now - this.born < SWEEP_WARMUP || now - this.lastSweep < SWEEP_QUIET) return;
    const abs = Math.abs(renderer.start);
    if (Math.abs(abs - this.lastAbs) < 1) return;
    const forward = abs > this.lastAbs;
    this.lastAbs = abs;
    this.lastSweep = now;
    this.#sweep(forward);
  }

  #sweep(forward) {
    if (!this.band || this.turn !== "slide") return;
    const renderer = this.reader.view?.renderer;
    if (!renderer || renderer.scrolled || this.reader.fixed) return;
    this.band.getAnimations?.().forEach((animation) => animation.cancel());
    this.band.animate([
      { transform: `translateX(${forward ? -110 : 260}%)`, opacity: 0 },
      { opacity: 0.85, offset: 0.18 },
      { opacity: 0.85, offset: 0.82 },
      { transform: `translateX(${forward ? 260 : -110}%)`, opacity: 0 },
    ], { duration: SWEEP_MS, easing: SWEEP_EASE });
  }

  dispose() {
    const renderer = this.reader.view?.renderer;
    renderer?.removeEventListener("relocate", this.onRelocate);
    renderer?.removeEventListener("scroll", this.onScroll);
    this.ro?.disconnect();
    this.band?.getAnimations?.().forEach((animation) => animation.cancel());
    this.stack.classList.remove(
      "is-scroll", "is-paged", "is-fixed", "is-spread", "is-single", "is-turning",
    );
    this.stack.style.removeProperty("width");
    this.gutter.remove();
    this.folio.remove();
    this.sweep.remove();
    if (this.under) this.under.hidden = true;
  }
}

function createPageDecor(reader) {
  return new PageDecor(reader);
}

export { createPageDecor };
