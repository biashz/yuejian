# YueJian Reader

English · [简体中文](README.md)

> PDF papers, EPUB ebooks, Markdown notes, and stray text files, in one quiet reading space.

A local-first desktop reader: a Rust + Tauri 2 shell, PDF rendering with pdf.js, EPUB pagination with foliate-js, Markdown rendering with comrak, and plain-text decoding via encoding_rs. No account, no cloud sync, no telemetry — every document and reading record stays on your machine.

[![License: MIT](https://img.shields.io/badge/license-MIT-b23a2b.svg)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2.x-24c8db.svg)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-1.77%2B-000000.svg)](https://www.rust-lang.org)
[![Release](https://img.shields.io/github/v/release/biashz/yuejian)](https://github.com/biashz/yuejian/releases)
[![Website](https://img.shields.io/badge/website-yuejian-reader.vercel.app-b23a2b.svg)](https://yuejian-reader.vercel.app)

![YueJian library screen](site/assets/screenshot-library-2.jpg)

## Features

- **PDF reading**: pdf.js renders a continuous scroll with a transparent text layer for selection and copy; long documents load lazily around the viewport.
- **Ebook reading** (EPUB / FB2 / FB2.ZIP / CBZ / MOBI / AZW3): foliate-js unpacks and paginates; the table of contents comes from the book's own NAV/NCX; `←` `→` and Space turn pages, and clicking the left/right half or scrolling works too; **single vs. double page** is a toggle (narrow windows fall back to single automatically); the bottom progress bar is draggable; `Ctrl+←/→` jumps chapters, `Home/End` jumps to the ends, and going past either end says so instead of doing nothing; **bookmarks** (`Ctrl+M`) are saved with the book and listed in the sidebar; **full-book search** matches across chapters, groups results by chapter, and jumps on click; footnote links open in a small popup instead of displacing the page; **highlights** take a colour (five choices) the moment you select text, are drawn on an SVG layer above the page without reflowing the book, are listed newest-first in the sidebar with jump-back and delete, and persist with the book; the selection bar's second row offers copy / note / delete, and **notes** (up to 500 characters) hang off their highlight, are editable in the sidebar, and export with a `**Note:**` line; illustrations and full comic pages open full-screen (wheel to zoom, double-click to reset, `Esc` to close); the **layout panel** (`Aa` in the reading toolbar) adjusts size / line height / margins / typeface / alignment / override book styles and the reading mode, reflows immediately, and stays separate from the PDF and text controls. Position is stored as a **CFI**, so resizing the window or changing type size never loses your place (page numbers are derived from layout and cannot be persisted). Scripts inside books never run — script items and inline handlers are stripped, with the CSP as a second line of defence. Title and author are read from the OPF metadata. Comics (CBZ) render as **fixed layout** full pages and ignore type size and margins; **DRM**-protected books are recognised before opening and reported by scheme (Adobe ADEPT / Kindle) instead of "corrupt file"; scripts stay inert outside EPUB too.
- **Reading modes and aids** (ebooks): **paged ↔ continuous scroll** (`Shift+J`, the toolbar, or the layout panel's Reading group); switching keeps your place by CFI. Scroll mode scrolls natively, flows into the next chapter at the end of one, and `←→` jumps chapters; the **page-turn animation** has slide / fade / none, and none is forced under `prefers-reduced-motion`. **Read aloud** (`Shift+L`) reads sentence by sentence with local system voices, tints the current sentence with a lighter accent than highlights, turns pages to follow, continues at chapter ends and stops at the end of the book; `Space` plays/pauses and `Ctrl+[`/`]` jumps sentences; without a local voice it says so instead of pretending to play. **Auto-scroll** (`Shift+A`) moves at a constant pace in scroll mode and turns pages on a timer in paged mode, speed 1–10, pausing on wheel or key press; it is mutually exclusive with read-aloud and shares one bottom bar. Manual paging, chapter jumps, or dragging the progress bar stop the aid. **Progress ticks**: the progress track marks chapter boundaries by length (thinned out above 40), and hovering or dragging shows a "chapter · percentage" bubble, jumping only on release.
- **Reading typefaces** (ebooks): system Song / Hei / Kai are always available, plus five OFL 1.1 open-source faces — LXGW WenKai GB, Source Han Serif, Source Han Sans, Literata, EB Garamond. **The installer ships no fonts**: the first time you pick one it is downloaded from the official source into `data/fonts/` and works offline afterwards. Downloads show a percentage, can be retried, and auto-select on success; removing the face in use falls back to system Song. Downloads only follow the official domain, keep filenames inside the font directory, and require a TrueType/OpenType file header. See `docs/ebook-fonts.md`.
- **Cross-book search**: the shelf search box matches titles and **document text** alike. Text / Markdown / CSV / code are scanned line by line on the Rust side (no index built); PDFs are extracted page by page with pdf.js and ebooks section by section with foliate, cached under `data/search/` and rebuilt whenever a file's size or mtime changes. Matches get their own section below the grid, with page or chapter labels and the keyword highlighted; clicking one **lands on that very line / page / chapter** (the sidebar marks the matching entry at the same time). A book that cannot be opened is skipped on its own, and the header reports how many were left out.
- **Four sidebar views**: jump by document outline, locate by thumbnail, inspect file info (encoding / line count / line endings / chapters), or search and highlight keywords across the whole document.
- **Excerpt export**: an ebook's highlights and bookmarks can be **copied** or **exported as Markdown** (`<title>-excerpts.md`) in one click. The file carries the title, author, counts and export time; each excerpt is a blockquote with its source on a separate line plus the colour name, with a `**Note:**` line under the quote when the entry has one, ordered by when you highlighted it, with leading `#` / `-` escaped so it pastes into Obsidian / Typora without falling apart. The buttons are absent when there is nothing to export.
- **Print & export**: the `⋯` at the right end of the reading toolbar offers what the format allows — Markdown and text can be **printed** (`Ctrl/Cmd + P`, paper carries the text only, no toolbar or sidebar) or **exported as a standalone HTML file** (styles are inlined and local images are embedded as data URLs, so the file opens on any machine by double-click, and it reproduces the layout you see on screen); PDFs and ebooks only offer **Save a copy**, because their layout comes from the original file and re-rendering can only be worse; very large text files load one window at a time and get the same treatment, with the reason spelled out in the menu.
- **Text reading**: open `txt` / `log` / `csv` plus thirty-odd code and config extensions; prose, monospace, and table views, with line numbers and soft wrap; encoding resolved by BOM plus detection, so GBK files saved by Chinese Notepad do not turn into mojibake — and if detection gets it wrong, the info panel lets you re-open as GB18030 / Big5 / Shift_JIS and remembers the choice; code files are syntax-highlighted by extension, with highlighting switched off (and explained) above 200 KB; CSV / TSV are split per RFC 4180 with a sticky header and row-number column; **files over 8 MB load through a line index and a render window**, so a 100 MB log opens, scrolls to the end, and uses memory independent of file size.
- **Markdown reading**: comrak renders GFM on the Rust side (tables, task lists, footnotes, strikethrough, autolinks); headings get automatic outline anchors and code blocks are syntax-highlighted.
- **Reading typography**: Paper / Night / Sepia themes; body size 15 / 17 / 19 / 21px, line height 1.7 / 1.9 / 2.1, measure 620 / 720 / 820px; Focus mode hides everything but the text.
- **Reading progress**: page, zoom, and scroll position are saved automatically, so the next open returns to where you stopped.
- **Custom categories**: create your own categories, one per document; drag a document onto one, or `Ctrl+click` several and assign them in a batch; rename, recolour, or delete a category (its documents fall back to Uncategorised). Category, type, status, and keyword filters stack.
- **Status and sorting**: the sidebar groups entries by type / status / category, with three-level sticky headers that each collapse and state their current selection; status (reading / unread / finished) is derived from progress and carries counts. Four sort axes (last opened / recently added / title / reading progress) reverse and are remembered; a removed document can be **undone within 6 seconds**, with favourite, category, and progress restored exactly.
- **Command palette**: `Ctrl/Cmd + K` to search books, jump to sections, switch themes, open settings, or import files.
- **Bilingual UI**: switch between Simplified Chinese and English in Settings; the choice is remembered.
- **Automatic updates**: the app quietly checks GitHub Releases on startup and downloads a new version in the background; Settings → Updates shows progress and manual checks, and one click restarts into the installer. Upgrading removes the old version first and keeps `data/`.
- **Local first**: shelf, settings, and progress live in `data/` next to the app. Works offline, and copying that folder migrates everything.

More screens are on the [website](https://yuejian-reader.vercel.app) and in the [user guide](docs/usage.md).

## Download

| Platform | Installer | Requirements |
| --- | --- | --- |
| Windows | `YueJian.Reader_<version>_x64-setup.exe` (NSIS) | Windows 10 1803+ / WebView2 |
| macOS | `YueJian.Reader_<version>_universal.dmg` | macOS 10.15+, universal for Intel and Apple Silicon |
| Linux | `YueJian.Reader_<version>_amd64.deb`, `amd64.AppImage` | Distributions with WebKitGTK 4.1 |

Installers are published on [GitHub Releases](https://github.com/biashz/yuejian/releases) and built on all three platforms by GitHub Actions.

Notes:

- **Data location**: release builds write all data to `data/` next to the executable; the Linux AppImage writes next to the `.AppImage` file. Move or remove that folder along with the app.
- **First launch on macOS**: the installer is not notarized by Apple. If macOS says the developer cannot be verified, right-click the app and choose "Open", or run `xattr -dr com.apple.quarantine "/Applications/YueJian Reader.app"`.
- **Linux AppImage**: run `chmod +x` on the downloaded file before launching.
- **Upgrading**: once installed, you don't need to fetch installers by hand. The Windows build checks and downloads updates at startup — confirm progress in Settings → Updates and click "Restart & install"; macOS and Linux are pointed to the matching dmg / deb / AppImage on the Releases page.

## Tech stack

| Layer | Choice | Notes |
| --- | --- | --- |
| App shell | Tauri 2 | Rust backend + system WebView; small bundle, clear permission model |
| Frontend | Vanilla HTML / CSS / ES Modules | No bundler, no build step; loads as-is at startup |
| PDF rendering | pdf.js | Canvas rendering + text layer + search |
| Ebooks | foliate-js (MIT, pinned commit) | EPUB unpacking, reflowable pagination, CFI, TOC; vendored source, see `docs/ebook-vendor-foliate.md` |
| Markdown | comrak | GFM parsing on the Rust side, sanitized HTML output |
| Text encoding | encoding_rs + chardetng | The implementations Firefox uses; BOM plus detection, GBK / GB18030 safe |
| Text highlighting | highlight.js | Same offline build and palette as Markdown code blocks |
| Table parsing | Hand-written RFC 4180 | Four rules only; not worth a dependency. Delimiter inferred from the header row |
| Line index | memchr | SIMD newline scan: 22.8 MB / 200k lines indexed in 80 ms vs 264 ms for std |
| Persistence | serde_json | Single `state.json`, written to a temp file and renamed |
| Updates | GitHub Releases API + system curl | Silent check of the latest release, background download of the NSIS installer, installed after the app quits |
| Icons | Lucide (inline SVG) | Zero external dependencies |
| Website | Static HTML + CSS | Hosted on Vercel, configured in `vercel.json` |

## Project structure

```
yuejian/
├── src/                     # Frontend (loaded directly as Tauri's frontendDist)
│   ├── index.html
│   ├── styles.css
│   ├── js/
│   │   ├── app.js           # Entry: load data, apply settings, wire events
│   │   ├── api.js           # The only gateway from the frontend to Rust commands
│   │   ├── i18n.js          # Chinese/English dictionaries and language switching
│   │   ├── update.js        # Update bridge: query releases, download, launch installer
│   │   ├── reader-pdf.js    # pdf.js wrapper: rendering, paging, zoom, search
│   │   ├── reader-epub.js   # Ebooks: mount foliate-view, event bridge, CFI, script stripping
│   │   ├── reader-md.js     # Markdown rendering and outline scroll sync
│   │   ├── reader-text.js   # Text rendering: views, line numbers, soft wrap, highlighting
│   │   ├── reader-csv.js    # CSV / TSV: delimiter detection, RFC 4180 parsing, table HTML
│   │   ├── reader-bigtext.js # Large files: line-window rendering (virtual scroll), jump to line
│   │   ├── shelf.js         # Shelf: list / grid / continue reading / stats / four-way filters
│   │   ├── library-index.js # Cross-book text index: PDF per page, ebooks per section, cached
│   │   ├── library-search.js # Cross-book search: both extraction paths, one result shape
│   │   ├── library-hits.js  # Shelf "matches" section rendering
│   │   ├── library-search-ui.js # Search scheduling: debounce, cancellation, progress, jumps
│   │   ├── categories.js    # Category math: ordering, counts, colours, filter predicates
│   │   ├── category-ui.js   # Category area, status group, batch bar, category editor popover
│   │   ├── status.js        # Derived reading status (reading / unread / finished)
│   │   ├── sort.js          # Sort math: four axes, natural direction, tiebreak
│   │   ├── sort-ui.js       # Sort toolbar and menu rendering
│   │   ├── view.js          # View switching, status bar, window title, language switching
│   │   ├── actions.js       # Import / remove / favourite / category CRUD / batch assign
│   │   ├── palette.js       # Command palette
│   │   ├── preferences.js   # Themes and typography, settings panel, persistence
│   │   ├── update-ui.js     # Update state machine and the update card in Settings
│   │   ├── bind/            # Event binding split by domain
│   │   │   ├── index.js     # Aggregate entry, calls the six domains in a fixed order
│   │   │   ├── shelf.js     # Delegated clicks, navigation, shelf search and import
│   │   │   ├── reader.js    # Document bar, outline, toolbar, demo
│   │   │   ├── panels.js    # Command palette, settings, window buttons, drag, context menu
│   │   │   ├── keys.js      # Keyboard shortcuts and flush-on-quit
│   │   │   ├── category.js  # Category filters, editor popover, batch and drag assignment
│   │   │   └── sort.js      # Sort menu open/close, axis flip, keyboard and Esc layering
│   │   ├── core/            # dom / session / constants / format / feedback
│   │   └── reader/          # panes / open / toolbar / ctx-* / present / progress / ebook-* / footnote / bookmarks / highlight / export-marks / marks-tools / marks-export / doc-export / doc-print / doc-menu
│   └── vendor/              # Offline assets generated by npm run vendor
├── src-tauri/
│   ├── src/
│   │   ├── main.rs          # Entry point
│   │   ├── lib.rs           # Window creation and command registration
│   │   ├── commands.rs      # Shelf, import, progress, and settings commands
│   │   ├── markdown.rs      # Markdown → HTML and outline extraction
│   │   ├── text.rs          # Encoding detection, decoding, classification, truncation
│   │   ├── store.rs         # state.json read/write and data structures
│   │   └── paths.rs         # Runtime data directory resolution
│   ├── tauri.conf.json      # Shared configuration
│   ├── tauri.windows.conf.json / .linux / .macos   # Per-platform bundle targets
│   └── capabilities/        # Permission allowlists
├── site/                    # Static marketing site (Vercel source)
├── scripts/
│   ├── dev.mjs              # Unified dev / build / bundle entry
│   ├── check-undefined.mjs  # Static check: called but undeclared/imported functions
│   ├── smoke-reader.mjs     # Real-browser smoke: open / page / zoom / hotkeys
│   ├── e2e-ebook.mjs        # On-device E2E: launch the release build, read an EPUB in WebView2
│   ├── lib/make-epub.mjs    # Generates the EPUB sample on the spot (one byte source for smoke + E2E)
│   └── vendor-assets.mjs    # Extracts pdf.js and friends from node_modules
├── docs/                    # Product, design, development, and usage docs
├── .github/workflows/build.yml   # Three-platform build + release upload
└── vercel.json              # Website hosting configuration
```

## Local development

Prerequisites: Node.js 20+, Rust 1.77+, and the WebView dependencies for your platform (WebView2 on Windows; `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, and friends on Linux).

```bash
npm install      # Install the Tauri CLI and pdf.js
npm run vendor   # First run or after upgrading deps: sync pdf.js assets and highlight.js into src/vendor
npm run dev      # Incremental debug build and launch
```

In debug builds the data directory is `.data/` at the project root, so `src-tauri/target` stays clean.

### Common commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Incremental debug build and launch (the frontend is plain files — just rerun after edits) |
| `npm run build` | Compile a release binary without an installer (`tauri build --no-bundle`) |
| `npm run bundle` | Build an installer for the current platform |
| `npm run vendor` | Sync offline frontend assets into `src/vendor`: pdf.js from `node_modules`, highlight.js from the official browser build, foliate-js fetched file-by-file at a pinned commit |
| `npm run smoke` | Headless real-browser smoke via local Chrome (open Markdown / PDF / EPUB / text / CSV, paging, zoom, three view modes, syntax highlighting, sticky table headers, Ctrl+B, CSP enforced); passes only with zero uncaught exceptions — skipped when Chrome is absent |
| `npm run e2e` | After `npm run build`: launch the release binary and read a freshly generated EPUB in the real WebView2 — checks that CSP does not block Tauri's bootstrap, `asset:` URLs, ACL, TOC and CFI, and that in-book scripts are stripped; Windows only |
| `npm run version:bump` | Bump the version manually (patch by default; supports `--minor` / `--major` / `--set 1.2.3`) |
| `npm run tauri -- <args>` | Pass any arguments through to the Tauri CLI |

Downloaded build dependencies stay inside the project: the Cargo target directory is set by the scripts and the npm cache is pointed at `.cache/npm` by `.npmrc`. On Windows, the bundler temporarily links `%LOCALAPPDATA%\tauri` to `.cache/tauri` and removes only the link afterwards.

## Build and release

[.github/workflows/build.yml](.github/workflows/build.yml) runs three jobs in parallel when a `v*` tag is pushed (or on manual `workflow_dispatch`):

1. `windows-latest` → NSIS installer
2. `ubuntu-22.04` → deb + AppImage
3. `macos-latest` → universal (`--target universal-apple-darwin`) dmg

Each job uploads an artifact and, on tag builds, appends its platform files to the same-named release with `softprops/action-gh-release`. Release notes are generated only by the Windows job to avoid duplication.

Versioning rules:

- The version lives in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `Cargo.lock`; [scripts/bump-version.mjs](scripts/bump-version.mjs) updates all of them at once and fails if any file lacks a version field, so versions never end up half-updated.
- On every push to `main`, [.github/workflows/version.yml](.github/workflows/version.yml) patch-bumps the latest commit (`0.1.0` → `0.1.1`) and commits back as `chore(release): vX.Y.Z [skip version]`. Bumps on the same branch run serially to avoid conflicts.
- As a result, your local copy lags one commit behind CI after a bump — run `git pull --rebase` before pushing again.
- Automatic bumps do not create tags; installers are still triggered by manually pushed `v*` tags. The tag must equal `v` + the current version (version `0.1.10` → tag `v0.1.10`); [build.yml](.github/workflows/build.yml) verifies this and fails on a mismatch.
- The release flow is therefore: `git pull` for the latest version, then tag and push that version. Installers, release notes, and the in-app version stay in sync.
- To skip a bump, put `[skip version]` at the beginning of the commit message (the marker anywhere else in the body does not count).

## Data and migration

```
data/
├── state.json      # Shelf + settings + reading progress
├── search/         # Cross-book text index (one <id>.json per book, removed with the book)
├── fonts/          # On-demand open-source body fonts (re-downloadable from the layout panel)
└── webview2/       # System WebView user data directory (WebView2 on Windows)
```

`state.json` structure (excerpt):

```jsonc
{
  "version": 1,
  "books": [
    {
      "id": "a1b2c3",              // Hashed from the file path; re-importing never duplicates
      "path": "D:\\docs\\paper.pdf",
      "title": "Breath on Paper",
      "author": "",
      "kind": "pdf",               // pdf | markdown | text | ebook
      "size": 2483102,
      "pages": 6,
      "words": 0,
      "addedAt": 1762300000,
      "lastOpenedAt": 1762390000,
      "favorite": false,
      "progress": { "ratio": 0.42, "page": 3, "zoom": 1.0 }
    }
  ],
  "settings": {
    "theme": "paper",              // paper | night | sepia
    "fontSize": 17,
    "lineHeight": 1.9,
    "measure": 720,
    "showCtx": true,
    "zen": false,
    "language": "zh"               // zh | en
  }
}
```

## Website

[site/](site/) is a static site separate from the app. It includes the canonical URL, Open Graph / Twitter cards, `SoftwareApplication` and `FAQPage` structured data, `robots.txt`, and `sitemap.xml`.

[vercel.json](vercel.json) sets `site/` as the output directory and skips install and build, so importing the repository needs no manual configuration. Once Vercel's Git integration is connected, pushing `main` redeploys automatically. If you change the domain, update the canonical / og:url / og:image values in `site/index.html` as well as `site/robots.txt` and `site/sitemap.xml`.

## Documentation

| Document | Contents |
| --- | --- |
| [User guide](docs/usage.md) | Installation, import, reading, shortcuts, data migration, FAQ |
| [Product spec](docs/product-spec.md) | Positioning, scenarios, feature map, non-functional requirements, data model |
| [Design contract](docs/design-contract.md) | Visual tokens, component specs, app shell, and page list |
| [Development plan](docs/dev-plan.md) | Milestones and implementation order |
| [Categories](docs/feature-categories.md) | Category data model, interaction semantics, edge cases, acceptance criteria |
| [Category UI](docs/ui-categories.md) | Category area spec, state matrix, colour tokens, copy |
| [Shelf tools](docs/feature-shelf-tools.md) | Status filters, four-axis sorting, remove-undo research, data model, acceptance |
| [Shelf tools UI](docs/ui-shelf-tools.md) | Three sticky groups, sort menu, undo bar specs and state matrix |
| [Ebook reading](docs/feature-ebook-reading.md) | Reading modes, read-aloud and auto-scroll, highlight and note semantics, acceptance |
| [Ebook reading UI](docs/ui-ebook-reading.md) | Reading toolbar, layout panel, aid bar, and state matrix |
| [Body fonts](docs/ebook-fonts.md) | On-demand font list, verification, storage location, fallback |
| [Excerpt export](docs/feature-export.md) | Where excerpts come from, Markdown output, the two exits and their limits |
| [Cross-book search](docs/feature-search.md) | The two extraction paths, index format and invalidation, hit list, non-goals |
| [Print & export](docs/feature-doc-export.md) | Per-format split, the print stage and platform differences, snapshotting and image inlining |

## Contributing

Issues and pull requests are welcome. Keep the frontend free of build steps; new Rust commands must be registered in `commands.rs` and exposed to the frontend through `js/api.js`.

## License

[MIT](LICENSE) © 2026 bias
