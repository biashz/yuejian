# 电子书版式与版式面板 · 规划

> 上游：`docs/ebook-layout-research.md`（可调面、Chromium 能力、六家竞品、中文取值区间）。
> 本文定的是「加什么、不加什么、存哪儿、怎么让它生效」。
>
> 一句话目标：**把「电子书正文长什么样」变成一件用户能自己调、且调完立刻看得见的事。**

---

## 1. 范围

### 做

- 新增一个**独立的版式面板**（右侧栏，参与布局），只服务电子书。
- 版式项从 6 个扩到 **16 个字段 / 14 个控件**，分五组：预设、文字、段落、页面、细节。
- 三套预设 + 自动识别的「自定义」。
- 覆盖拆成「排版覆盖」与「配色覆盖」两个**互相独立**的开关，后者默认开（见 §2 #15）。
- 版式改动**实时生效**，拖动滑杆期间不重排、松手重排一次。

### 不做（明确写下来，避免半成品）

| 不做 | 理由 |
| --- | --- |
| 悬挂标点 | Chromium 不支持 `hanging-punctuation`，无等价实现（见调研 §2） |
| 竖排 | 分页器的分栏、翻页、CFI 全是横向假设 |
| 简繁转换 | 需要完整对照表 + 词组歧义，成本远超收益 |
| 字重 / 词间距 | 中文正文里收益低，控件预算有限 |
| 孤行控制（`orphans`/`widows`） | 浏览器默认已是 2；再收紧会与分页器抢列高 |
| 按书保存 | 数据结构留了口子（§5），本轮只做全局 |
| 固定版面（CBZ / FXL）的排版 | 书页尺寸是出版方定的，面板整体禁用并说明原因 |

---

## 2. 字段总表

存储仍是 `state.settings` 的平铺字段（Rust `Settings` 强类型 + 容器级 `serde(default)`，
追加零成本；改嵌套会让旧 `state.json` 的 `ebookFontSize` 被静默丢弃）。

| # | 字段 | 类型 | 默认 | 范围 | 控件 | 生效路径 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `ebookFamily` | string | `serif` | serif / sans / kai / system | 分段（4） | CSS `font-family` |
| 2 | `ebookFontSize` | int px | 18 | 14–28 步 1 | A- A+ 步进 + 数值 | CSS `font-size` |
| 3 | `ebookLetterSpacing` 🆕 | number px | 0 | ‑0.5–2 步 0.25 | 滑杆 | CSS `letter-spacing` |
| 4 | `ebookLineHeight` | number | 1.8 | 1.3–2.4 步 0.05 | 滑杆 | CSS `line-height` |
| 5 | `ebookIndent` 🆕 | int em | 0 | 0 / 1 / 2 | 分段（3，与 #6 互斥） | CSS `text-indent` |
| 6 | `ebookParaSpacing` 🆕 | number px | 0 | 0–32 步 2 | 滑杆（仅「段间距」模式） | CSS `margin-block` |
| 7 | `ebookAlign` | string | `justify` | left / justify | 分段（2） | CSS `text-align` |
| 8 | `ebookMargin` | int px | 48 | 8–120 步 4 | 滑杆 | 属性 `margin` |
| 9 | `ebookMeasure` 🆕 | int px | 720 | 480–1200 步 20 | 滑杆 | 属性 `max-inline-size` |
| 10 | `ebookGap` 🆕 | number % | 7 | 2–14 步 0.5 | 滑杆 | 属性 `gap` |
| 11 | `ebookSpread` | bool | true | — | 开关 | 属性 `max-column-count` |
| 12 | `ebookHyphenate` 🆕 | bool | false | — | 开关 | CSS `hyphens` |
| 13 | `ebookPunctuate` 🆕 | bool | true | — | 开关 | CSS `text-justify` / `palt` / `text-autospace` |
| 14 | `ebookOverride` | bool | false | — | 开关 | CSS `!important` 分支 |
| 15 | `ebookOverrideColor` 🆕 | bool | `true` | — | 开关（独立于 #14） | CSS 配色分支 |

🆕 = 本轮新增 9 个字段（#3 #5 #6 #9 #10 #12 #13 #15）。

三处要点：

- **#5 / #6 互斥**：这是分段策略的二选一，不是两个独立滑杆。同时开会得到
  「既缩进又拉开」的重复节奏——六家里没有一家处理了这个矛盾（见调研 §4）。
  存储上两个字段都留着，切换模式时把另一个清零、并记住上一次的值
  （`ebookParaSpacing` 由 0 变回上次的 10，而不是从头调）。
- **#11 就是「列数」**：`setSpread()` 已经在写 `max-column-count = 2|1` 并 `render()`，
  不再新增「列数」字段——两个控件表达同一件事，用户只会困惑该动哪个。
- **#15 独立且默认开**：配色（字色 / 底色）跟着应用主题走，与「是否接管排版」无关。
  这一条是改动前没想清楚、被真机截图推翻的：夜读主题下不接管字色，书里写死的
  `#333` 就压在深色底上，几乎读不清（见 §7 的取舍记录）。旧 `state.json` 没有这个键，
  读出来是 `null` / 缺失，一律按「开」处理，所以老用户升级后夜读立刻正常。
  Rust 侧保留 `Option<bool>` 只是容错——万一哪份数据里存的是 `null`，不会让整份设置
  反序列化失败。

---

## 3. 面板结构

五组，自上而下。每条控件都是「标签 + 控件 + 当前值」一行，不是只有标签。

```
┌─ 版式 ─────────────────────────── × ─┐
│ ── PRESET                           │
│ [舒适中文] [紧凑] [西文衬线]  ← 当前预设高亮 │
│  · 用户改任何一项 → 高亮消失，显示「自定义」  │
│                                      │
│ ── 文字 ───────────────────────────  │
│ 字体     [宋体][黑体][楷体][系统]      │
│ 字号     A-  18  A+                  │
│ 字间距   ─────●──────  0              │
│                                      │
│ ── 段落 ───────────────────────────  │
│ 行高     ──────●─────  1.80           │
│ 分段     [无][首行缩进][段间距]         │
│          └ 段间距模式下展开一条滑杆      │
│ 对齐     [左对齐][两端对齐]            │
│                                      │
│ ── 页面 ───────────────────────────  │
│ 页边距   ────●───────  48             │
│ 版心宽度 ──────●─────  720            │
│ 列间距   ───●────────  7%             │
│ 双页     [开关]                       │
│                                      │
│ ── 细节 ───────────────────────────  │
│ 连字符   [开关]  西文断词              │
│ 标点挤压 [开关]  中西文间隙 · 标点半角   │
│ 覆盖排版 [开关]  让书内字体字号让位      │
│ 覆盖配色 [开关]  字色与底色跟随主题       │
│                                      │
│ [恢复默认]              （无「完成」）   │
└──────────────────────────────────────┘
```

- **没有「完成」按钮**：所有改动即时生效并自动落盘（200ms 防抖，复用 `persistSettings`）。
  有「完成」会让人以为不点就白调了。
- **「恢复默认」** 回的是「出厂默认」，不是「打开面板时的状态」。要撤销单项改动，
  用户点预设更快。
- 分组可折叠，默认全展开；折叠状态不持久化（记一次就够，下次还是想从头看）。

### 位置与形态

| 条件 | 形态 |
| --- | --- |
| 宽 ≥ 1024px | 右侧栏，332px，**参与 flex 布局**（阅读区真的变窄、文字真的重排） |
| 窄 < 1024px | 覆盖式抽屉 + 半透明遮罩，320px 或 `calc(100vw - 48px)` |
| 未打开电子书 | 入口按钮禁用（面板可以开，但控件整体禁用并提示「先打开一本电子书」） |
| 固定版面（CBZ / FXL） | 面板可开，控件整体禁用，顶部一条说明条 |

参与布局而不是浮在上面，是因为它调的就是**文字本身的宽度和密度**——浮层会把要看的
那几行盖住，用户只能靠想象判断，那就失去「实时预览」的意义了。

右侧已经有一个「目录」侧栏（`#ctxPanel`）。两者并列：`.reader-body` 变成
`panes | layout-panel | ctx-panel`，各自独立开合。

### 入口

阅读工具栏右下角新增一枚「Aa」按钮（`data-act="ebook-layout"`），只在
`kind === "ebook"` 时出现，永远可点（不随 `dead` / `fixed` 隐藏，否则用户不知道
为什么没有版式设置）。用新图标 `#i-type`。

---

## 4. 预设

三套 + 隐式「自定义」。**不存预设 id**——每次都从当前字段反推：与某一套逐项相等
就是那套，否则是自定义。这样不可能出现「标记说是紧凑、值却是别的」。

| 项 | 舒适中文 | 紧凑 | 西文衬线 |
| --- | --- | --- | --- |
| 字体 | 宋体 | 黑体 | 宋体 |
| 字号 | 19 | 17 | 17 |
| 字间距 | 0.25 | 0 | 0 |
| 行高 | 1.85 | 1.65 | 1.7 |
| 首行缩进 | 2em | 0 | 0 |
| 段间距 | 0 | 8 | 12 |
| 对齐 | 两端 | 两端 | 左对齐 |
| 页边距 | 56 | 40 | 48 |
| 版心宽度 | 660 | 780 | 640 |
| 列间距 | 8 | 6 | 8 |
| 连字符 | 关 | 关 | 开 |
| 标点挤压 | 开 | 开 | 关 |

- **舒适中文** = 出厂默认的候选，也是「纸质书感」的那一档：缩进 + 大行高 + 窄版心。
- **紧凑** = 信息密度优先：无缩进、段间距小、版心宽。
- **西文衬线** = 给英文书和双语书：左对齐（避免西文两端对齐的疏排丑）、开连字符、
  关标点挤压（那是中文规则）。

出厂默认（`DEFAULT_SETTINGS`）对齐到「紧凑」那套的字号/行高（17 / 1.8），其余取上表？
不——**出厂默认就是「舒适中文」**，只是字号用 18（现有默认，不动，避免用户升级后
打开书发现字号变了）。即：默认值 = 舒适中文，但 `ebookFontSize: 18` 而不是 19。
这会让「默认状态」在面板上显示为「自定义」，很难看。

处理办法：预设比较时**只比与预设相关的 12 个字段，字号单独容忍 ±1**。取巧但不诚实。
更干净的办法：把 `DEFAULT_SETTINGS.ebookFontSize` 改成 19 —— 用户升级后字号从 18 变 19，
一像素，几乎不可感知，但换来「默认即预设」。**采用后者**，并在发版说明里写一句。

---

## 5. 生效链路

两半，分得很清楚：

| 去向 | 管什么 | 为什么 |
| --- | --- | --- |
| `Paginator` 属性（`margin` / `max-inline-size` / `gap` / `max-column-count`） | 版心、栏宽、栏距、单双页 | 分页器自己用这些算每栏宽度与翻页偏移；注入 CSS 去改 `max-width` 会和它的分栏计算打架 |
| `setStyles()` 注入 CSS | 字号、行高、字体、字间距、缩进、段距、对齐、连字符、标点 | 分页器不管这些，只能写进章节文档 |

`EbookReader` 现有的 `applyTypography(css, margin)` 扩成
`applyLayout({ css, margin, measure, gap, columns })`，多写三个属性；
`setSpread()` 保持独立（工具栏那枚按钮仍然直接调它，两边写同一个字段）。

### 重排节流

- 拖滑杆（`input` 事件）：只更新 CSS 文本 / CSS 变量，**不调 `render()`**。
  浏览器会自己把当前页的文字重排一遍，视觉上就是实时的。
- `pointerup` / `change`：调一次 `render()`，让翻页偏移和页数重新算准。
- 滑杆类控件统一走这一个节流口（一个 40ms 的 `requestAnimationFrame` 合并）。

改 `max-inline-size` 本身会触发分页器的 `render()`（源码里 `attributeChangedCallback`
对它显式调了 render），所以版心宽度这条不用额外处理，但要靠上面的合并避免连续 render。

### 注入 CSS 的样子

```css
html { font-size: 19px; }
body { font-family: …; font-size: 19px; line-height: 1.85;
       text-align: justify; letter-spacing: 0.25px; hyphens: auto; }
body p, body li, body dd, body dt, body blockquote, body div { text-align: justify; }
/* 缩进模式 */
body p { text-indent: 2em; margin-block: 0; }
/* 或 段间距模式 */
body p { text-indent: 0; margin-block: 12px; }
/* 标点挤压 */
body { text-justify: inter-character; font-feature-settings: "palt"; text-autospace: normal; line-break: strict; }
```

三条硬约束：

1. **注入里禁止出现 `max-width` / `column-width` / `column-count`**——那三条归分页器。
2. **不要用 `vh`**：分页器加载时会把它换算成落笔那一刻的视口高度。
3. **不要写 `-epub-` 前缀**：分页器会统一剥掉。

---

## 6. 代码结构

新增两个模块，都放在 `src/js/reader/`：

| 文件 | 职责 | 预算 |
| --- | --- | --- |
| `ebook-layout.js` | 版式视图对象：`readLayout(settings)` / 字段范围与选项 / 预设定义与反推 / `matchesPreset` / `applyPreset` | ≤ 140 行 |
| `ebook-layout-panel.js` | 面板：DOM 生成、控件绑定、开合、禁用态、同步值、拖拽节流 | ≤ 280 行 |

改动：

| 文件 | 改动 |
| --- | --- |
| `core/constants.js` | `DEFAULT_SETTINGS` 加 9 个字段；`EBOOK_FONTS` 加 `system`；字号默认 18→19 |
| `reader/ebook-style.js` | `buildEbookStyles` 消费新字段；拆出 `TEXT_OVERRIDE` 与 `COLOR_OVERRIDE` 两段 |
| `reader/ebook-open.js` | `typography()` → `layout()`，回传四个值；`refreshEbookStyles` 一并下发改版式 |
| `reader-epub.js` | `applyTypography` → `applyLayout`；`setSpread` 不变 |
| `reader/toolbar-ebook.js` | 加「Aa」按钮（`ebook-layout`） |
| `reader/toolbar.js` | 派发 `ebook-layout` → 开合面板 |
| `bind/index.js` | `bindLayoutPanel()` |
| `preferences.js` | 删掉 `syncSettingsUI()` 里那 6 行电子书同步；面板自己同步 |
| `index.html` | 通用设置里的「电子书」一组删掉，换成一行「版式设置已移到阅读工具栏的 Aa」；新增 `#i-type` 图标与 `.layout-panel` 骨架 |
| `styles.css` | `.layout-panel` 及其内部控件的样式 |
| `src-tauri/src/store.rs` | `Settings` 加 9 个字段 + 默认值 |
| `scripts/smoke-reader.mjs` | 新增断言（§8） |
| `docs/usage.md` | §11 之后新增「版式」一节 |

---

## 7. 降级矩阵

| 场景 | 面板 | 行为 |
| --- | --- | --- |
| EPUB 回流 | 全可用 | — |
| FB2 / FB2.ZIP | 全可用 | 与 EPUB 同路（都是回流 + 注入 CSS） |
| MOBI / AZW3 | 全可用 | 同上，排版由我们接管 |
| CBZ / FXL 杂志 | 全禁用 | 顶部说明条：「这本书是固定版面，排版由出版方决定」；值照样存 |
| 双栏（左右各一本书） | 全可用 | 版式是全局的，两栏同时刷新 |
| 窄窗口 < 1024px | 抽屉式 | 遮罩 + `Esc` 关闭 |
| 没打开书 | 控件禁用 | 提示「先打开一本电子书」 |

---

## 8. 验收

### 冒烟（`scripts/smoke-reader.mjs`）

1. **默认即预设**：初始状态面板上「舒适中文」高亮。
2. **改一项就变自定义**：点「字号 +」后，所有预设 chip 都取消高亮。
3. **预设能整组回填**：点「西文衬线」后，`settings.ebookAlign === "left"`、
   `ebookHyphenate === true`、`ebookPunctuate === false`。
4. **缩进与段距互斥**：选「首行缩进」后 `ebookIndent > 0 && ebookParaSpacing === 0`；
   再选「段间距」后反过来，且段距恢复到上次的值。
5. **注入 CSS 真的带上了**：改字号后读 `foliate-view` 里注入样式表的 `textContent`，
   含 `font-size: 22px`。
6. **属性真的写上了**：改版心宽度后 `renderer.getAttribute("max-inline-size")` 变。
7. **配色覆盖依赖排版覆盖**：`ebookOverride === false` 时开关呈禁用态。
8. **面板不挡路**：打开面板后阅读区宽度减少 = 面板宽度（±1px），没被盖住。
9. **窄窗口变抽屉**：视口压到 900px，面板呈 overlay 且带遮罩。

### 真机

- 三主题（纸白 / 夜读 / 护眼）下逐组过一遍，确认没有「看不见的字」。
- 拖字号滑杆时页面不闪、不卡顿、松手后页码正确。
- 关掉面板再打开，值都在（落盘成功）。
- 双击窗口最大化 / 还原，版心宽度与栏数自适应正常。
- CBZ 打开时面板禁用并显示说明条。

---

## 9. 交付顺序

1. 数据结构（`constants.js` + `store.rs`）+ `ebook-layout.js` 视图对象。
2. `ebook-style.js` 产出新 CSS + `applyLayout` 接通属性 → 先用控制台改值验证四类效果。
3. 面板 DOM + 样式 + 交互（`ebook-layout-panel.js` + `styles.css`）。
4. 工具栏入口 + 通用设置里的旧一组下线。
5. 冒烟 + 真机 + 文档。
