/* 官网中英切换：单页 + data-i18n，首次加载缓存中文原文，切换时直接替换 */
(function () {
  "use strict";

  const STORAGE_KEY = "yuejian-site-lang";

  /* 仅维护英文词条；切回中文时使用首次加载缓存的中文原文 */
  const EN = {
    "meta.title": "YueJian Reader — A free, open-source local reader for PDF and Markdown",
    "meta.description": "YueJian Reader is a free, open-source desktop reader that brings PDF papers and Markdown notes into one quiet reading space: continuous scrolling, outline and full-text search, three themes, adjustable typography, and automatic reading progress. Runs on Windows, macOS, and Linux, fully offline — your files never leave your device.",
    "meta.keywords": "PDF reader,Markdown reader,local reader,open source reader,Tauri,Rust,pdf.js,offline reading,Windows PDF reader,macOS reader,Linux reader",
    "meta.ogTitle": "YueJian Reader — A free, open-source local reader for PDF and Markdown",
    "meta.ogDescription": "One window, one typographic language, one continuous reading flow. PDF and Markdown share themes, progress, and outlines — offline, free, and open source.",
    "meta.ogLocale": "en_US",
    "meta.ogAlt": "YueJian Reader interface preview",
    "meta.twitterTitle": "YueJian Reader — A local reader for PDF and Markdown",
    "meta.twitterDescription": "A free, open-source local reader: continuous PDF scrolling, live Markdown typesetting, three themes, and remembered reading progress. Windows / macOS / Linux.",

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

    "hero.title": "PDF papers and Markdown notes,<br />in one quiet reading space.",
    "hero.lede": "YueJian is a free, open-source local desktop reader. The paper feel of PDF papers and the live typesetting of Markdown notes share the same themes, outline, and reading progress — no sign-in, no uploads, readable with the network off.",
    "hero.download": "Download YueJian",
    "hero.source": "View source",
    "hero.metaOpen": "MIT licensed",
    "hero.metaSize": "~4 MB installer",
    "hero.metaOffline": "Fully offline",
    "hero.window": "YueJian · Library",
    "hero.alt": "YueJian library view: a document list on the left, a continue-reading card and cover grid in the middle, showing PDF and Markdown documents with their reading progress.",
    "hero.caption": "Library: recent reads, favorites, and progress at a glance",

    "features.no": "01 — Features",
    "features.title": "Trade-offs made for long reading sessions",
    "features.sub": "No annotation sync, no bookstore, no social feed. Every decision serves one goal: let you stay inside the document a little longer.",
    "features.c1Title": "Continuous PDF scrolling",
    "features.c1Text": "pdf.js renders to canvas with a transparent text layer on top, and long documents load pages lazily by viewport. Scrolling feels like turning a bound volume rather than clicking through page after page.",
    "features.c2Title": "Outline · Thumbnails · Full-text search",
    "features.c2Text": "One sidebar with three panes: jump by chapter outline, locate by thumbnail, or match keywords across the whole document with hits highlighted.",
    "features.c3Title": "Live Markdown typesetting",
    "features.c3Text": "Rendering happens in Rust, with tables, task lists, footnotes, strikethrough, and autolinks; code blocks get syntax highlighting, and heading levels generate outline anchors automatically.",
    "features.c4Title": "Paper · Night · Sepia",
    "features.c4Text": "Themes change more than a background color: paper texture, text contrast, dividers, and code colors all shift together, so long reads at night stop being harsh.",
    "features.c5Title": "Adjustable typography",
    "features.c5Text": "Body text from 15–21 px, three line heights, and a 620–820 px measure, plus a focus mode that clears away everything but the text.",
    "features.c6Title": "Local-first",
    "features.c6Text": "No account, no cloud sync, no telemetry. Documents and reading history live only in a local folder, and nothing is missing when you go offline.",
    "features.mini1Title": "Progress memory",
    "features.mini1Text": "Page, zoom, and scroll offset are saved automatically — reopen and pick up exactly where you left off",
    "features.mini2Title": "Command palette",
    "features.mini2Text": "Ctrl / Cmd + K to find books, jump to chapters, switch themes, or open settings",
    "features.mini3Title": "Drag to import",
    "features.mini3Text": "Drop a file into the window and it joins the library; the original stays where it is",
    "features.mini4Title": "Cross-platform",
    "features.mini4Text": "One codebase builds installers for Windows, macOS, and Linux",

    "screens.no": "02 — Interface",
    "screens.title": "One typographic language, two document types",
    "screens.sub": "Kai for headings, Song for body text, and cinnabar only to mark “you are here”.",
    "screens.window": "YueJian · PDF reading",
    "screens.alt": "YueJian PDF reading view: a continuously scrolling paper in the middle, an outline panel on the right, and the current page and reading progress at the bottom.",
    "screens.caption": "PDF: continuous scrolling, a collapsible outline, and page numbers with progress in the footer",
    "screens.n1Title": "A library, not a file list",
    "screens.n1Text": "Covers are grouped by paper tone and progress bars sit beneath each spine; the book you read last stays on top and favorites stay pinned.",
    "screens.n2Title": "Just text in the reading area",
    "screens.n2Text": "Headers, page numbers, and toolbars wait at the edges; focus mode folds the sidebar away and the measure adapts to the window.",
    "screens.n3Title": "Settings you can see",
    "screens.n3Text": "Theme, font size, line height, and measure take effect immediately — no confirmation, no restart.",

    "download.no": "03 — Download",
    "download.title": "Choose your platform",
    "download.sub": "Every installer comes from GitHub Actions builds on each of the three platforms, matches the source, and can be verified in Releases.",
    "download.file": "File",
    "download.size": "Size",
    "download.requires": "Needs",
    "download.subWin": "NSIS installer · x64",
    "download.subMac": "Universal DMG",
    "download.sizeWin": "~4.4 MB",
    "download.sizeMac": "~9.7 MB",
    "download.sizeLinux": "~4.9 MB / 83 MB",
    "download.ex": "Download .exe",
    "download.dmg": "Download .dmg",
    "download.deb": "Download .deb",
    "download.appimage": "Download .AppImage",
    "download.note1Title": "Data stays in the app folder",
    "download.note1Text": "Settings, library, and reading progress are written to <code>data/</code> beside the executable (<code>state.json</code> and the WebView cache); the AppImage keeps them in the same directory. Nothing is scattered elsewhere on the system — copy the whole folder and your reading history comes with it.",
    "download.note2Title": "First-launch notes",
    "download.note2Text": "The macOS build is not notarized. If you see “cannot verify the developer”, right-click the app and choose Open. On Linux, the AppImage needs <code>chmod +x</code> before running. Past versions and checksums are on <a href=\"https://github.com/biashz/yuejian/releases\" rel=\"noopener\">GitHub Releases</a>.",
    "download.note3Title": "Install once, update automatically",
    "download.note3Text": "The Windows build silently checks GitHub Releases a few seconds after launch and downloads new versions in the background. Settings → Updates lets you check manually, watch progress, and click “Restart and install”. Upgrading uninstalls the old version first and keeps <code>data/</code> by default.",

    "stack.no": "04 — Stack",
    "stack.title": "Small, few dependencies, no network",
    "stack.p1": "The interface is plain HTML / CSS / ES Modules with no bundler; the shell is Rust with Tauri 2 reusing the system WebView, so installers are only a few megabytes and cold starts usually finish in under two seconds. Markdown parsing runs in Rust, PDF is handled by pdf.js, and neither downloads anything at runtime.",
    "stack.p2": "The project is open source under MIT. The build script keeps every downloaded dependency inside the workspace, and GitHub Actions produces installers on all three platforms.",
    "stack.codeDev": "# Local development",
    "stack.codeBundle": "# Build an installer for this platform",
    "stack.caption": "YueJian technology stack",
    "stack.layer": "Layer",
    "stack.choice": "Choice",
    "stack.shell": "Application shell",
    "stack.frontend": "Frontend",
    "stack.pdf": "PDF rendering",
    "stack.code": "Code highlighting",
    "stack.persistence": "Persistence",
    "stack.icons": "Icons",
    "stack.license": "License",
    "stack.vShell": "Tauri 2 (Rust)",
    "stack.vFrontend": "Native HTML / CSS / ES Modules",
    "stack.vMarkdown": "comrak (GFM)",
    "stack.vPersistence": "serde_json + local files",
    "stack.vIcons": "Lucide (inline SVG)",

    "faq.no": "05 — FAQ",
    "faq.title": "Frequently asked questions",
    "faq.q1": "How do I upgrade to a new version?",
    "faq.a1": "You do not need to download the installer again. On Windows the app checks silently at launch and downloads updates in the background — open Settings → Updates and click “Restart and install”; you can also check manually and watch progress there. Upgrading uninstalls the old version first and keeps your library and progress by default. On macOS and Linux the app points you to Releases for the matching dmg / deb / AppImage.",
    "faq.q2": "Is YueJian free?",
    "faq.a2": "Yes. YueJian is fully open source under MIT, and every desktop feature is free — no membership, subscription, or in-app purchase.",
    "faq.q3": "Are my documents uploaded to a server?",
    "faq.a3": "No. There is no account system, no cloud sync, and no telemetry. PDF and Markdown files stay on your machine and remain readable offline.",
    "faq.q4": "Which document formats are supported?",
    "faq.a4": "PDF and Markdown (<code>.md</code> / <code>.markdown</code>). Markdown renders in GitHub style, including tables, task lists, blockquotes, footnotes, and strikethrough, with syntax-highlighted code blocks.",
    "faq.q5": "Does YueJian support Windows, macOS, and Linux?",
    "faq.a5": "All three have installers. Windows ships an NSIS installer, macOS a universal dmg for Intel and Apple Silicon, and Linux both deb and AppImage. Requirements: Windows 10 1803+, macOS 10.15+, or a modern distro with WebKitGTK 4.1.",
    "faq.q6": "What if macOS says the developer cannot be verified?",
    "faq.a6": "The build is not notarized by Apple. Right-click the app in Finder and choose Open, or run <code>xattr -dr com.apple.quarantine \"/Applications/YueJian Reader.app\"</code> and launch again.",
    "faq.q7": "Where are settings and reading progress stored?",
    "faq.a7": "In the <code>data/</code> folder beside the app (<code>state.json</code> and the WebView cache). Nothing is written elsewhere on the system. Copy the whole app folder to migrate all reading records.",
    "faq.q8": "Can I contribute?",
    "faq.a8": "Yes. Source, build scripts, and design docs live in the <a href=\"https://github.com/biashz/yuejian\" rel=\"noopener\">GitHub repository</a> — issues and pull requests are welcome.",

    "cta.title": "Finish your next paper in peace.",
    "cta.download": "Download YueJian",
    "cta.github": "View on GitHub",

    "footer.aria": "Footer navigation",
    "footer.features": "Features",
    "footer.download": "Download",
    "footer.faq": "FAQ",
    "footer.source": "Source",
    "footer.releases": "Release notes",
    "footer.tagline": "A local reader for PDF and Markdown · MIT License",
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
