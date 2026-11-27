/* 官网中英切换：单页 + data-i18n，首次加载缓存中文原文，切换时直接替换 */
(function () {
  "use strict";

  const STORAGE_KEY = "yuejian-site-lang";

  /* 仅维护英文词条；切回中文时使用首次加载缓存的中文原文 */
  const EN = {
    "meta.title": "YueJian Reader — A free, open-source local reader for PDF, ebooks, and Markdown",
    "meta.description": "YueJian Reader is a free, open-source desktop reader that brings PDF papers, ebooks, and Markdown notes into one quiet reading space: continuous PDF scrolling, paged or scrolling ebooks, local-voice read-aloud, automatic scrolling, five-colour highlights with notes, outline and full-text search, three themes, adjustable typography, and on-demand open-source fonts. Runs on Windows, macOS, and Linux — offline, with files never uploaded.",
    "meta.keywords": "PDF reader,ebook reader,EPUB reader,Markdown reader,local reader,open source reader,Tauri,Rust,pdf.js,offline reading,read aloud,highlights,Windows PDF reader,macOS reader,Linux reader",
    "meta.ogTitle": "YueJian Reader — A free, open-source local reader for PDF, ebooks, and Markdown",
    "meta.ogDescription": "One window, one typographic language, one continuous reading flow. PDF, ebooks, and Markdown share themes, progress, and outlines; ebooks add paged/scrolling modes, read-aloud, and auto-scroll. Offline, free, and open source.",
    "meta.ogLocale": "en_US",
    "meta.ogAlt": "YueJian Reader interface preview",
    "meta.twitterTitle": "YueJian Reader — A local reader for PDF, ebooks, and Markdown",
    "meta.twitterDescription": "A free, open-source local reader: continuous PDF scrolling, paged or scrolling ebooks with read-aloud, five-colour highlights, live Markdown typesetting, three themes, and remembered reading progress. Windows / macOS / Linux.",

    "nav.skip": "Skip to main content",
    "nav.brandAria": "YueJian Reader home",
    "nav.aria": "Site navigation",
    "nav.features": "Features",
    "nav.screens": "Interface",
    "nav.download": "Download",
    "nav.stack": "Stack",
    "nav.faq": "FAQ",
    "nav.cta": "Download free",
    "nav.expand": "Open navigation",
    "nav.collapse": "Close navigation",

    "hero.title": "PDF papers, ebooks, and Markdown notes,<br />in one quiet reading space.",
    "hero.lede": "YueJian is a free, open-source local desktop reader. The paper feel of PDF papers, the typography and read-aloud of ebooks, and the live typesetting of Markdown share the same themes, outline, and reading progress — no sign-in, no uploads, readable with the network off.",
    "hero.download": "Download YueJian",
    "hero.source": "View source",
    "hero.metaOpen": "MIT licensed",
    "hero.metaSize": "~4.8 MB installer",
    "hero.metaOffline": "Fully offline",
    "hero.window": "YueJian · Library",
    "hero.alt": "YueJian library view: a document tree grouped by type, status, and category with a sort bar on the left, a continue-reading card and a cover grid in the middle, showing PDF, ebook, and Markdown documents with their reading progress.",
    "hero.caption": "Library: categories, status, and sorting, with progress at a glance",

    "features.no": "01 — Features",
    "features.title": "Trade-offs made for long reading sessions",
    "features.sub": "No annotation sync, no bookstore, no social feed. Every decision serves one goal: let you stay inside the document a little longer.",
    "features.c1Title": "Continuous PDF scrolling",
    "features.c1Text": "pdf.js renders to canvas with a transparent text layer on top, and long documents load pages lazily by viewport. Scrolling feels like turning a bound volume rather than clicking through page after page.",
    "features.c2Title": "Ebooks: paged or scrolling",
    "features.c2Text": "Open EPUB, FB2, MOBI, AZW3, and CBZ directly, and switch between paged and continuous scrolling at any time; single/double pages, bookmarks, full-book search, and progress ticks come along. Position is stored as a CFI, so changing font size or window size never loses your place.",
    "features.c3Title": "Read aloud and auto-scroll",
    "features.c3Text": "Read sentence by sentence with the system's local voices — the current sentence is gently highlighted and pages turn on their own; auto-scroll advances steadily at the speed you pick. Both share one bottom bar and stop the moment you turn a page or touch the wheel.",
    "features.c4Title": "Highlights · notes · excerpts",
    "features.c4Text": "Select text to highlight it in one of five colours, drawn above the page without reflowing the book; notes up to 500 characters attach to a highlight and can be revisited or edited in the sidebar; export everything as a Markdown excerpt with sources, colours, and notes.",
    "features.c5Title": "Live Markdown typesetting",
    "features.c5Text": "Rendering happens in Rust, with tables, task lists, footnotes, strikethrough, and autolinks; code blocks get syntax highlighting, and heading levels generate outline anchors automatically.",
    "features.c6Title": "Outline · Thumbnails · Full-text search",
    "features.c6Text": "One sidebar with three panes: jump by chapter outline, locate by thumbnail, or match keywords across the document with hits highlighted. The shelf search box also reaches across books and lands on the very line or page.",
    "features.c7Title": "Paper · Night · Sepia",
    "features.c7Text": "Themes change more than a background color: paper texture, text contrast, dividers, and code colors all shift together, so long reads at night stop being harsh.",
    "features.c8Title": "Adjustable typography and fonts",
    "features.c8Text": "Type size, line height, and measure take effect as you drag; ebooks add a layout panel with the system Song / Hei / Kai faces plus five OFL open-source fonts downloaded on demand — no fonts in the installer, and once fetched they work offline.",
    "features.c9Title": "Local-first",
    "features.c9Text": "No account, no cloud sync, no telemetry. Documents, highlights, and reading history live only in a local folder; apart from the optional font download and update check, nothing needs the network at runtime.",
    "features.mini1Title": "Progress memory",
    "features.mini1Text": "Page, zoom, and scroll offset are saved automatically — reopen and pick up exactly where you left off",
    "features.mini2Title": "Command palette",
    "features.mini2Text": "Ctrl / Cmd + K to find books, jump to chapters, switch themes, or open settings",
    "features.mini3Title": "Categories · status · sorting",
    "features.mini3Text": "Create your own categories; reading / unread / finished group automatically; four sort axes are remembered",
    "features.mini4Title": "Cross-book search",
    "features.mini4Text": "The shelf search box also scans document text and lands on the matching line, page, or chapter",
    "features.mini5Title": "Print & export",
    "features.mini5Text": "Text documents print or export as standalone HTML; PDFs and ebooks save an untouched copy",
    "features.mini6Title": "Drag to import",
    "features.mini6Text": "Drop a file into the window and it joins the library; the original stays where it is",

    "screens.no": "02 — Interface",
    "screens.title": "One typographic language, four document types",
    "screens.sub": "Kai for headings, Song for body text, and cinnabar only to mark “you are here”; ebooks add a “fore-edge” bar that grows from the bottom edge.",
    "screens.window": "YueJian · PDF reading",
    "screens.alt": "YueJian PDF reading view: a continuously scrolling paper in the middle, an outline panel on the right, and the current page and reading progress at the bottom.",
    "screens.caption": "PDF: continuous scrolling, a collapsible outline, and page numbers with progress in the footer",
    "screens.n1Title": "A library, not a file list",
    "screens.n1Text": "Covers are grouped by paper tone and progress bars sit beneath each spine; sort by recent, title, or progress, let reading / unread / finished group automatically, and undo a removal for six seconds.",
    "screens.n2Title": "Just text in the reading area",
    "screens.n2Text": "Headers, page numbers, and toolbars wait at the edges; an ebook's chapter name and progress rail grow from the bottom, and focus mode folds the sidebar away.",
    "screens.n3Title": "Settings you can see",
    "screens.n3Text": "Theme, font size, line height, and measure take effect immediately; ebooks add a layout panel for paged/scrolling mode and on-demand fonts — no confirmation, no restart.",

    "download.no": "03 — Download",
    "download.title": "Choose your platform",
    "download.sub": "Every installer comes from GitHub Actions builds on each of the three platforms, matches the source, and can be verified in Releases.",
    "download.file": "File",
    "download.size": "Size",
    "download.requires": "Needs",
    "download.subWin": "NSIS installer · x64",
    "download.subMac": "Universal DMG",
    "download.sizeWin": "~4.8 MB",
    "download.sizeMac": "~10.4 MB",
    "download.sizeLinux": "~5.3 MB / 80 MB",
    "download.ex": "Download .exe",
    "download.dmg": "Download .dmg",
    "download.deb": "Download .deb",
    "download.appimage": "Download .AppImage",
    "download.note1Title": "Data stays in the app folder",
    "download.note1Text": "Settings, library, highlights, and reading progress are written to <code>data/</code> beside the executable (<code>state.json</code>); the cross-book search index and downloaded fonts sit in <code>search/</code> and <code>fonts/</code> alongside, and the AppImage keeps them in the same directory. Nothing is scattered elsewhere on the system — copy the whole folder and your reading history comes with it.",
    "download.note2Title": "First-launch notes",
    "download.note2Text": "The macOS build is not notarized. If you see “cannot verify the developer”, right-click the app and choose Open. On Linux, the AppImage needs <code>chmod +x</code> before running. Past versions and checksums are on <a href=\"https://github.com/biashz/yuejian/releases\" rel=\"noopener\">GitHub Releases</a>.",
    "download.note3Title": "Install once, update automatically",
    "download.note3Text": "The Windows build silently checks GitHub Releases a few seconds after launch and downloads new versions in the background. Settings → Updates lets you check manually, watch progress, and click “Restart and install”. Upgrading uninstalls the old version first and keeps <code>data/</code> by default. This is one of only two network actions the app ever takes; the other is the optional open-source font download, and neither is required for offline reading.",

    "stack.no": "04 — Stack",
    "stack.title": "Small, few dependencies, offline by default",
    "stack.p1": "The interface is plain HTML / CSS / ES Modules with no bundler; the shell is Rust with Tauri 2 reusing the system WebView, so installers are only a few megabytes and cold starts usually finish in under two seconds. Markdown parsing and text decoding run in Rust, PDF is handled by pdf.js, and ebooks are paginated by foliate-js; apart from the optional font download and update check, nothing touches the network at runtime.",
    "stack.p2": "The project is open source under MIT. The build script keeps every downloaded dependency inside the workspace, and GitHub Actions produces installers on all three platforms.",
    "stack.codeDev": "# Local development",
    "stack.codeBundle": "# Build an installer for this platform",
    "stack.caption": "YueJian technology stack",
    "stack.layer": "Layer",
    "stack.choice": "Choice",
    "stack.shell": "Application shell",
    "stack.frontend": "Frontend",
    "stack.pdf": "PDF rendering",
    "stack.ebooks": "Ebook pagination",
    "stack.text": "Text decoding",
    "stack.code": "Code highlighting",
    "stack.persistence": "Persistence",
    "stack.icons": "Icons",
    "stack.license": "License",
    "stack.vShell": "Tauri 2 (Rust)",
    "stack.vFrontend": "Native HTML / CSS / ES Modules",
    "stack.vEbooks": "foliate-js (CFI · pagination · TOC)",
    "stack.vMarkdown": "comrak (GFM)",
    "stack.vText": "encoding_rs + chardetng",
    "stack.vPersistence": "serde_json + local files",
    "stack.vIcons": "Lucide (inline SVG)",

    "faq.no": "05 — FAQ",
    "faq.title": "Frequently asked questions",
    "faq.q1": "How do I upgrade to a new version?",
    "faq.a1": "You do not need to download the installer again. On Windows the app checks silently at launch and downloads updates in the background — open Settings → Updates and click “Restart and install”; you can also check manually and watch progress there. Upgrading uninstalls the old version first and keeps your library and progress by default. On macOS and Linux the app points you to Releases for the matching dmg / deb / AppImage.",
    "faq.q2": "Is YueJian free?",
    "faq.a2": "Yes. YueJian is fully open source under MIT, and every desktop feature is free — no membership, subscription, or in-app purchase.",
    "faq.q3": "Are my documents uploaded to a server?",
    "faq.a3": "No. There is no account system, no cloud sync, and no telemetry. Documents and reading history stay on your machine and remain readable offline; the only network actions are the optional open-source font download and the update check, and neither carries any document content.",
    "faq.q4": "Which document formats are supported?",
    "faq.a4": "PDF, ebooks (<code>EPUB</code> / <code>FB2</code> / <code>FB2.ZIP</code> / <code>MOBI</code> / <code>AZW3</code> / <code>CBZ</code>), Markdown (<code>.md</code> / <code>.markdown</code>), and plain text (<code>txt</code> / <code>log</code> / <code>csv</code> plus thirty-odd code and config extensions). Ebooks support single/double pages, paged or scrolling mode, bookmarks, full-book search, read-aloud, auto-scroll, and highlights with notes; Markdown renders in GitHub style; plain text detects its encoding, and logs over 8 MB load through a line index and a render window.",
    "faq.q5": "Does YueJian support Windows, macOS, and Linux?",
    "faq.a5": "All three have installers. Windows ships an NSIS installer, macOS a universal dmg for Intel and Apple Silicon, and Linux both deb and AppImage. Requirements: Windows 10 1803+, macOS 10.15+, or a modern distro with WebKitGTK 4.1.",
    "faq.q6": "What if macOS says the developer cannot be verified?",
    "faq.a6": "The build is not notarized by Apple. Right-click the app in Finder and choose Open, or run <code>xattr -dr com.apple.quarantine \"/Applications/YueJian Reader.app\"</code> and launch again.",
    "faq.q7": "Where are settings and reading progress stored?",
    "faq.a7": "In the <code>data/</code> folder beside the app: <code>state.json</code> (library, settings, progress, highlights, and notes), <code>search/</code> (cross-book search index), and <code>fonts/</code> (downloaded fonts), plus the WebView cache. Nothing is written elsewhere on the system. Copy the whole app folder to migrate all reading records.",
    "faq.q9": "Do I need the network on first launch?",
    "faq.a9": "No. Opening, reading, searching, highlighting, notes, and exports all work offline. Only two optional actions go online: downloading open-source fonts from their official sources (once fetched, they work offline), and the update check on Windows at startup; you can skip both entirely.",
    "faq.q8": "Can I contribute?",
    "faq.a8": "Yes. Source, build scripts, and design docs live in the <a href=\"https://github.com/biashz/yuejian\" rel=\"noopener\">GitHub repository</a> — issues and pull requests are welcome.",

    "cta.title": "Finish your next read in peace.",
    "cta.download": "Download YueJian",
    "cta.github": "View on GitHub",

    "footer.aria": "Footer navigation",
    "footer.features": "Features",
    "footer.download": "Download",
    "footer.faq": "FAQ",
    "footer.source": "Source",
    "footer.releases": "Release notes",
    "footer.tagline": "A local reader for PDF, ebooks, and Markdown · MIT License",
    "footer.legal": "Documents and reading history always stay on your device"
  };

  const storage = {
    read() {
      try {
        return window.localStorage.getItem(STORAGE_KEY);
      } catch {
        return null;
      }
    },
    write(value) {
      try {
        window.localStorage.setItem(STORAGE_KEY, value);
      } catch {
        /* 隐私模式下 localStorage 不可用，忽略即可 */
      }
    }
  };

  /* 收集待翻译节点，原文用于切回中文 */
  const textNodes = Array.from(document.querySelectorAll("[data-i18n]")).map((el) => ({
    el,
    key: el.dataset.i18n,
    original: el.innerHTML
  }));

  const attrNodes = Array.from(document.querySelectorAll("[data-i18n-attr]")).map((el) => ({
    el,
    specs: el.dataset.i18nAttr
      .split(",")
      .map((pair) => pair.split(":").map((part) => part.trim()))
      .filter((parts) => parts.length === 2 && parts[0] && parts[1])
      .map(([attr, key]) => ({ attr, key, original: el.getAttribute(attr) || "" }))
  }));

  const metaEntries = [
    ["meta.description", 'meta[name="description"]'],
    ["meta.keywords", 'meta[name="keywords"]'],
    ["meta.ogTitle", 'meta[property="og:title"]'],
    ["meta.ogDescription", 'meta[property="og:description"]'],
    ["meta.ogLocale", 'meta[property="og:locale"]'],
    ["meta.ogAlt", 'meta[property="og:image:alt"]'],
    ["meta.twitterTitle", 'meta[name="twitter:title"]'],
    ["meta.twitterDescription", 'meta[name="twitter:description"]']
  ]
    .map(([key, selector]) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      return {
        key,
        original: el.getAttribute("content") || "",
        apply: (value) => el.setAttribute("content", value)
      };
    })
    .filter(Boolean);

  const headEntries = [
    {
      key: "meta.title",
      original: document.title,
      apply: (value) => {
        document.title = value;
      }
    },
    ...metaEntries
  ];

  let currentLang = "zh";

  function applyLang(lang) {
    const useEnglish = lang === "en";
    const pick = (key, fallback) =>
      useEnglish && typeof EN[key] === "string" ? EN[key] : fallback;

    textNodes.forEach(({ el, key, original }) => {
      el.innerHTML = pick(key, original);
    });

    attrNodes.forEach(({ el, specs }) => {
      specs.forEach(({ attr, key, original }) => {
        el.setAttribute(attr, pick(key, original));
      });
    });

    headEntries.forEach(({ key, original, apply }) => {
      apply(pick(key, original));
    });

    document.documentElement.lang = useEnglish ? "en" : "zh-CN";
  }

  function updateToggle(lang) {
    const toggle = document.getElementById("langToggle");
    if (!toggle) return;
    const english = lang === "en";
    toggle.textContent = english ? "中文" : "EN";
    toggle.setAttribute("aria-label", english ? "Switch to Chinese" : "Switch to English");
    toggle.setAttribute("title", english ? "Switch to Chinese" : "Switch to English");
  }

  function setLang(lang, options) {
    currentLang = lang === "en" ? "en" : "zh";
    applyLang(currentLang);
    updateToggle(currentLang);
    if (!options || options.persist !== false) storage.write(currentLang);
    document.dispatchEvent(new CustomEvent("site:langchange", { detail: { lang: currentLang } }));
  }

  function detectLang() {
    const stored = storage.read();
    if (stored === "zh" || stored === "en") return stored;
    // 浏览器语言以中文开头时默认中文，其余默认英文
    return (navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en";
  }

  window.siteI18n = {
    get lang() {
      return currentLang;
    },
    /* 供 main.js 等脚本读取当前语言的词条 */
    t(key) {
      return typeof EN[key] === "string" ? EN[key] : null;
    },
    setLang
  };

  const toggle = document.getElementById("langToggle");
  if (toggle) {
    toggle.addEventListener("click", () => {
      setLang(currentLang === "en" ? "zh" : "en");
    });
  }

  setLang(detectLang(), { persist: false });
})();
