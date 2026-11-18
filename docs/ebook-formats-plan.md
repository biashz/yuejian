# 电子书支持 · 功能规划

> 调研见 `docs/ebook-formats-research.md`。选型：vendoring foliate-js（MIT）。
>
> 一句话目标：打开一本 EPUB，能像正经阅读器那样**翻页、看目录、调字号、记位置**；
> MOBI / AZW3 / FB2 / CBZ 在同一个界面里也能打开。

## 1. 范围

**做**：EPUB 2 / EPUB 3、FB2（含 `.fb2.zip`）、MOBI、AZW3（KF8）、CBZ。
**不做**：任何带 DRM 的文件（识别并明确告知）、CBR / RAR、DJVU / CHM、TTS、OPDS / Calibre 书库、批注导出。

理由：前五项覆盖了实际能拿到的电子书的绝大多数；后几项要么需要破解（不该做），
要么是需要独立一期的产品方向（在线书库、语音朗读）。**划线批注**单列为可选项，
排在功能完成之后，因为它依赖 foliate 的 overlayer，工作量另算。

## 2. 格式与角标

| 扩展名 | 角标 | 渲染器 |
| --- | --- | --- |
| `epub` | EPUB | 可重排（paginator） |
| `fb2` `fbz` | FB2 | 可重排 |
| `mobi` `azw` `azw3` | MOBI / AZW3 | 可重排（KF8 可能慢） |
| `cbz` | CBZ | 固定版面（一图一页） |

`Book.kind` 统一为 `"ebook"`，角标文案按扩展名派生——与文本类「kind 一个、角标多种」的做法一致
（`core/constants.js` 的 `kindLabel`，新增一个分支）。

## 3. 分期

| 期 | 内容 | 交付判定 | 状态 |
| --- | --- | --- | --- |
| **P1 EPUB 打通** | vendoring、CSP、类型判定与导入、打开与渲染、目录、CFI 进度、状态栏 | 一本中文 EPUB3 能打开、翻页、目录跳转、关掉重开回到原位 | 已完成（v0.1.32） |
| **P2 阅读交互** | 单/双页、点击与键盘与滚轮翻页、进度条可拖、书签、全书搜索、脚注弹层 | 键盘翻完一本不掉位置；搜索命中能跳过去 | 已完成（v0.1.33） |
| **P3 阅读设置** | 字号 / 行高 / 页边距 / 字体 / 对齐 / 主题 / 强制覆盖书内样式 | 六个设置项都即时生效，且每本书记住 | 已完成（v0.1.34） |
| **P4 其余格式** | FB2、CBZ 固定版面、MOBI / AZW3、DRM 识别与提示、加密字体 | 五种格式各打开一本，DRM 文件给出人话提示 | 待开始 |
| **P5 收口** | 性能与空态、i18n、文档、冒烟断言、（可选）划线批注 | `npm run check` + `smoke` 全绿 | 待开始 |

每期独立可发布，P1 就能解决「打不开 epub」。

### 3.1 每期的具体改动面

**P1**
- `src/vendor/foliate/`：整包拷贝（含库自带的 `vendor/zip.js`、`vendor/fflate.js`），
  在 `scripts/vendor-assets.mjs` 里加一步（从固定 commit 拉取），目录下留 LICENSE
- `src-tauri/tauri.conf.json`：新增 CSP（见调研 §5.1），**先单独验证一轮再继续**
- `src-tauri/src/commands.rs`：`detect_kind` 加 `ebook`；`PICK_EXTS` 加扩展名；
  `open_book` 的 ebook 分支只回路径与体积（正文由前端解析）
- `src/js/reader-epub.js`（新）：`foliate-view` 的挂载、打开、事件桥接、CFI 存取、
  主题 CSS 注入、脚本清洗
- `src/js/reader/open.js`：`openEbook()` 分派
- `src/js/reader/panes.js`：pane 增加 `ebookView` 槽位与卸载逻辑
- `src/store`（Rust）：`Book.progress.cfi`（`#[serde(default)]`）
- `src/js/view.js`：状态栏「第 3 章 · 27%」
- 侧栏 `TABS_BY_KIND`：`ebook: ["toc", "find"]`，目录用书本 TOC（不是标题扫描）

**P2**（完成于 v0.1.33）
- `src/js/reader/ebook-gesture.js`（新）：点击左右 35% 半屏、滚轮 / 触控板、翻页键、`Ctrl+←/→`、`Home/End`。
  同一份逻辑要挂两处——外层容器与**每个章节文档**（iframe 内的键盘与点击不会冒泡到主文档）。
- `src/js/reader/ebook-note.js`（新）＋`footnote.js`（新）：脚注按 `book.resolveHref` 定位，
  `epub:type` / `fn1` 这类 id / 类名三重判定；判成「注」才弹小窗，其余照常跳转。
  卡片位置锚在注号上方，注号不在当前页时退回阅读区底部并让开浮动工具栏。
- `src/js/reader/ebook-search.js`（新）：把 `view.search()` 的异步生成器收敛成按章分组的结果，
  进度回调给侧栏；`excerpt` 是 `{pre, match, post}` 三段，`<mark>` 直接按它渲染。
- `src/js/reader/bookmarks.js`（新）：加 / 删书签，就地合并回 `state.books` 与 `state.current`。
- `src/js/reader/ebook-open.js`（新）：从 `open.js` 拆出的电子书打开与动作（打开、续读、翻页、跳章、版式）。
- `src/js/reader/ebook-sanitize.js`（新）：从 `reader-epub.js` 拆出的章节清洗。
- `src-tauri/src/store.rs`：`Bookmark { cfi, label, created_at }`、`Book.bookmarks`、`Settings.ebook_spread`。
- `src-tauri/src/commands.rs`：`set_bookmark(id, cfi, label, on)`，幂等，一本书上限 200 条。
- 进度条：`change` 才跳（拖动中连续 `goToFraction` 会让分页器反复重排），拖动时只更新数字。

**P3**（完成于 v0.1.34）
- `Settings` 增加六个电子书专属字段：`ebook_font_size` / `ebook_line_height` / `ebook_margin` /
  `ebook_family` / `ebook_align` / `ebook_override`。容器级 `serde(default)` 已有，
  前端 `app.js` 还会与 `DEFAULT_SETTINGS` 合并一道，旧 `state.json` 缺字段也不会把 `undefined` 写进样式。
- `src/js/reader/ebook-style.js`（新）：把偏好折成一段 CSS。注入点只有一个——
  分页器在 `afterLoad` 里往 `doc.head` **末尾**追加的空 `<style>`（`renderer.setStyles`），
  它排在书自己的样式表之后，同权重下后者胜。字号/行高/字体/对齐不加 `!important`；
  「强制覆盖」才加，并把书内字色与底色压成主题色（色值从 `--ink` / `--paper` 读，不写第二份）。
- 页边距不走 CSS：它只参与算版心，走分页器自己的 `--_margin` 变量，改完要 `render()` 重排。
- 章节文档的样式表是首帧才建的，所以 `applyTypography` 必须在 `init()` 或 `open()` 之后调，
  与 `setSpread` 同一个约束；版式记在实例上，换书后由 `open()` 原样贴回。
- 主题切换要重贴一次（覆盖模式的颜色来自主题变量），用动态 `import()` 通知阅读器，
  避免偏好模块与阅读器静态互相依赖。
- `src/js/reader/ebook-toc.js`（新）：`flattenToc` / `countChapters` 从 `reader-epub.js` 迁出，
  顺手把那个文件收回到 300 行以内。
- 设置面板 `.sheet` 的高度从 `100%` 改成 `100vh`：网格项目里百分比高度会退化成 `auto`，
  加到第六组时面板会长到 1431px、把「完成」按钮顶出窗口。冒烟里补了一条断言盯着这件事。
- 样本 EPUB 新增 `OEBPS/style.css`（serif / `#fff` 底 / 左对齐 / 行高 1.5）：
  书里没有样式规则，「设置压过书内样式」就无从验证。

**P4**
- 格式分派交给 `makeBook` 的魔术字节判断，我们只负责「扩展名 → 是否允许导入」
- DRM 识别：EPUB 读 `META-INF/encryption.xml`；MOBI 读 PalmDOC 头 encryption 字段
- 加密字体：确认 Tauri 自定义协议是否 secure context，否则注入纯 JS SHA-1

**P5**
- 空态与错误态：文件损坏、ZIP 不完整、章节加载失败、超大文件
- 冒烟：桩一个 foliate-view（与 pdf.js 的桩同一手法），断言挂载/翻页/设置注入/CFI 存取
- 文档：usage 新增「阅读电子书」一章，README 中英同步

## 4. 交互清单

电子书阅读器的「常用交互」，逐项列出并标出本期是否做：

### 4.1 翻页与导航

| 交互 | 触发 | 期 |
| --- | --- | --- |
| 下一页 / 上一页 | `→` `↓` `PageDown` `空格`、点击左右半屏、滚轮下/上、触控板双指 | P2 |
| 章节跳转 | 目录点击、`Ctrl+←/→`（上一章 / 下一章） | P1/P2 |
| 首尾 | `Home` / `End` | P2 |
| 拖动跳转 | 底部进度条 | P2 |
| 单页 ↔ 双页 | 工具栏按钮；窗口过窄时自动单页 | P2 |
| 翻到书外（第一章前一页） | 提示「已是开头」而不是静默 | P2 |

### 4.2 阅读辅助

| 交互 | 说明 | 期 |
| --- | --- | --- |
| 目录 | 侧栏树形，当前章高亮，滚动跟随 | P1（高亮 P2） |
| 进度 | 状态栏「第 3 章 · 27%」，书架进度条沿用 `ratio` | P1 |
| 书签 | 加/删/列表，点书签回到原位 | P2 |
| 全书搜索 | 侧栏输入，结果带章节名与上下文，点击跳转并高亮 | P2 |
| 脚注 | 点击书内脚注链接弹小窗，不整页跳走 | P2（可延后） |
| 图片放大 | 点击图片全屏查看 | P3 |
| 划线批注 | foliate `overlayer`，选中文字出菜单 | 可选（P5 之后） |

### 4.3 视图与版式

| 交互 | 取值 | 期 |
| --- | --- | --- |
| 字号 | 四档（16 / 18 / 20 / 22） | P3 |
| 行高 | 1.6 / 1.8 / 2.1 | P3 |
| 页边距 | 窄 / 标准 / 宽（24 / 48 / 72px，落到分页器 `--_margin`） | P3 |
| 字体 | 宋体（衬线）/ 黑体（无衬线）/ 楷体 | P3 |
| 对齐 | 左对齐 / 两端对齐 | P3 |
| 主题 | 跟随应用（纸白 / 夜读 / 护眼）；配色只在「强制覆盖」时接管书页 | P3 |
| 强制覆盖书内样式 | 开 / 关（默认关）：字体、行高、对齐加 `!important`，书页底色与字色一并改 | P3 |

### 4.4 已有的全局能力，电子书自动继承

- 分栏双开（联动翻页对电子书按 CFI 同步）
- 禅模式、演示模式（演示模式下电子书按「一页一屏」）
- 「信息」面板：格式、体积、章节数、出版信息（title / author / publisher / language）
- 书架筛选新增「电子书」chip

## 5. 数据结构变更

```rust
// store.rs
pub struct Book {
    // …既有字段
    /// 电子书：EPUB CFI，精确恢复阅读位置；非电子书为空串
    #[serde(default)]
    pub cfi: String,
    /// 电子书书签（P2 再加）
    #[serde(default)]
    pub bookmarks: Vec<Bookmark>,
}
```

`Book.progress.ratio` 继续表示整书百分比，书架的进度条与排序不动。

## 6. 与现有实现的边界

- **不碰** pdf.js、markdown、文本三条渲染链路；电子书是第四条，独立模块 `reader-epub.js`。
- **不改** `Book.kind` 的既有值，只新增 `"ebook"`；所有 `kind === "pdf"` 的分支都要检查
  是否需要为 ebook 补一条（`open.js` 的 `pdfStack` / `mdDoc` 显隐、`view.js` 的状态栏、
  `ctx.js` 的 `TABS_BY_KIND`）。
- **CSP 是全局改动**，会影响现有四条链路，必须单独一步验证，不和电子书功能混在一个提交里。

## 7. 验收

| 层 | 手段 |
| --- | --- |
| 冒烟 | 桩 `foliate-view`，断言：挂载、打开参数、翻页事件、设置 CSS 注入内容、CFI 存取、目录渲染、错误态文案 |
| 静态 | `npm run check`（含 i18n 一致性） |
| 真机 | `.playground/ebooks/` 下六种素材逐个打开；重点看中文排版、图片、脚注、竖排（已知限制） |
| 性能 | 一本 20MB / 500 章的 EPUB：打开耗时、翻页帧率、内存；AZW3 首次打开耗时（预期偏慢） |

## 8. 原型

`prototype/ebook-reader.html`，单文件、无依赖、复用 `text-reader.html` 的同一套 token
（`--font-read` / `--accent` / `--paper`），只为确认界面，不是实现。

已覆盖的状态：双页跨页、单页、目录（当前章高亮 + 页码）、书签、搜索（命中计数 + `<mark>`
高亮）、设置浮层（字号 / 行高 / 页边距 / 字体 / 对齐 / 主题 / 覆盖书内样式）、夜读主题、
顶部信息条、底部状态栏、左右半屏点击热区。

布局上用「面板开着时阅读区收窄」（`body.ctx-open .stage{padding-right}`）而不是让面板盖住
正文——后者在窄屏上会把当页右半边吃掉。原型里两页高度固定、文本是《长物志》卷三的手写摘录，
所以单页模式下文字不会重新流式填充（真实实现由引擎按视口重排，不存在这个问题）。
