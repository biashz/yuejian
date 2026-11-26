# 界面设计 — 电子书版式面板

> 上游：`docs/ebook-layout-research.md`（调研）、`docs/ebook-layout-plan.md`（字段与生效链路）。
> 可交互原型：`prototype/ebook-layout.html`（宽/窄窗口、三主题、禁用态、预设与互斥都跑过）。
>
> 这份文档只回答「长什么样、怎么动、什么状态」，不重复「为什么是这些设置项」。

---

## 1. 设计目标

1. **调的时候看得见字。** 面板不是浮在正文上的一层纸，而是把阅读区真的挤窄——因为
   它调的正是文字的宽窄疏密，盖住正文等于让人闭着眼睛调。
2. **一眼看出「我现在是哪一档」。** 顶部三枚预设 chip 明确标出当前落在哪一套；
   手改任何一项立刻变成「自定义」，不给人「我明明点了紧凑」的错觉。
3. **没有「完成」。** 改一项就生效、就落盘。有「完成」按钮，等于承认前面调的都不算数。
4. **克制。** 面板里没有插图、没有说明段落、没有第二层抽屉。每个设置项一行字一个控件。

与通用设置的关系：**彻底分开**。通用设置（主题 / 语言 / 更新）是装完机调一次的；
版式是看书时反复调的。前者留在 `#settingsOverlay`，后者独立成右侧栏。通用设置里那组
「电子书」下线，换成一行指路：「版式设置已移到阅读工具栏的 Aa」。

---

## 2. 位置与尺寸

| 状态 | 尺寸 | 行为 |
| --- | --- | --- |
| 宽窗口 ≥ 1024px | 宽 `332px`，`border-left: 1px`，参与 `.reader-body` 的 flex | 打开后阅读区宽度减少 332px，正文重排（真·所见即所得） |
| 窄窗口 < 1024px | 宽 `min(332px, calc(100vw - 40px))`，`position: absolute` 贴右、满高、`--shadow-lg` | 叠一层遮罩（`--paper` 40% + 黑 42%，`backdrop-filter: blur(1.5px)`），点击遮罩关闭 |
| 高度 | 始终等于 `.reader-body` 高度 | 头尾固定，中间 `.lp-body` 独立滚动（`min-height: 0` + `overscroll-behavior: contain`） |

右侧已有「目录」侧栏（`#ctxPanel`，268px）。两者**并列共存**，DOM 顺序是
`panes → layout-panel → ctx-panel`，各自独立开合。宽窗口下同时开会把阅读区压得很窄，
这是用户的自由，不做互斥。

层级：`z-index` 与 `#ctxPanel` 同级（都在 `.reader-body` 的正常流里），窄窗口遮罩用 `20`，
抽屉用 `21`。

---

## 3. 结构

```
aside.layout-panel
├── header.layout-panel-head        ← 不滚动
│   ├── p.eyebrow        "LAYOUT"
│   ├── h2               "版式"
│   ├── p.sub            "只作用于电子书，改动即时生效"（固定版面时换成另一句）
│   └── button.close     ×
├── div.layout-panel-body           ← 唯一滚动区
│   ├── p.lp-notice     （仅固定版面时出现）
│   ├── section.lp-group  预设
│   │   └── div.lp-presets → 3 × button.lp-chip + span.lp-chip-custom
│   ├── section.lp-group  文字
│   │   ├── row 字体   → segmented（3）
│   │   ├── row 字号   → stepper（A− / 值 / A+）
│   │   └── row 字间距 → value + 全宽滑杆
│   ├── section.lp-group  段落
│   │   ├── row 行高   → value + 全宽滑杆
│   │   ├── row 分段方式 → segmented（3，块级占满）
│   │   ├── row 段间距 → value（仅「段间距」模式显示）
│   │   ├── 滑杆                      （同上，隐藏）
│   │   └── row 对齐   → segmented（2）
│   ├── section.lp-group  页面
│   │   ├── row 页边距   → value + 滑杆
│   │   ├── row 版心宽度 → value + 滑杆（带副标题「纸的最大宽度」）
│   │   └── row 双页     → switch
│   └── section.lp-group  细节
│       ├── row 连字符   → switch（副标题「西文断词」）
│       ├── row 标点挤压 → switch（副标题「中西文间隙 · 标点半角」）
│       ├── row 覆盖排版 → switch（副标题「让书内字体字号让位」）
│       └── row 覆盖配色 → switch（副标题「字色与底色跟随主题」）
└── footer.layout-panel-foot        ← 不滚动
    ├── button.lp-reset  "恢复默认"
    └── span.lp-saved    "已保存" / "保存中…"
```

分组标题用等宽小字（9.5px / `letter-spacing: .2em` / `--ink-3`），与分组之间用
`1px solid var(--line)` 分隔；组内最后一行不留额外空白。

---

## 4. 控件规格

五类，全站统一，不新增第六种。

| 类型 | 尺寸 | 选中态 | 禁用态 |
| --- | --- | --- | --- |
| **分段（segmented）** | 半高 26px，内边距 `5px 9px`，`--r-sm`，相邻按钮共用 1px 分隔线 | 底 `--ink`、字 `--paper` | 整组 `opacity: .42`，`pointer-events: none` |
| **步进（stepper）** | 26×26 按钮 + 中间 30px 数值（等宽、tabular-nums） | — | 到上限/下限的那个按钮 `opacity: .35` 且 `disabled`，不是整组禁用 |
| **滑杆（range）** | 轨道 2px，滑块 12px 圆点（`--surface` 填充 + 1.5px `--ink` 描边），滑过部分用 `--ink` 实色 | — | `opacity: .4` |
| **开关（switch）** | 34×19，`--r-pill`，滑块 15px 白点 | 开：底 `--accent`，点右移 | `opacity: .4` |
| **chip（预设）** | `--r-pill`，内边距 `6px 11px` | 选中：底 `--ink`、字 `--paper`；「自定义」用虚线边框、`--ink-3`、不可点 | — |

布局约定：

- **一行 = 标签（左，flex:1）+ 控件（右，flex:none）**，行高 `min-height: 30px`，
  行间距 `12px`。
- **带副标题的行**：`label > small` 占第二行，10.5px / `--ink-3` / `line-height: 1.45`。
- **滑杆类不挤在标签右边**：数值跟标签同一行右对齐（等宽 11px / `--ink-3` / 最小宽 38px），
  滑杆单独占一整行（`.lp-field`），下边距 14px。理由：332px 宽里再塞一根 120px 的滑杆，
  精度不够，一拖就跨好几档。
- **块级分段**（分段方式、对齐以外的那种）用 `.is-block` 占满整行，三个按钮等分。
  「分段方式」三个词较长（无 / 首行缩进 / 段间距），必须占满一行才排得下。

---

## 5. 状态矩阵

### 5.1 预设 chip

| 状态 | 表现 |
| --- | --- |
| 当前值 === 某预设 | 该 chip 选中（底 `--ink`），其余描边，`自定义` 隐藏 |
| 当前值 ≠ 任何预设 | 三枚都不选中，`自定义` chip 出现（虚线、不可点） |
| 悬浮（未选中） | 描边从 `--line-strong` 变 `--ink-3`，文字变 `--ink` |
| 点击 | 整组字段一次性写入，`保存中…` → `已保存` |

预设判定是**逐项相等**，不存 id。字段清单见 plan §4。

### 5.2 面板整体

| 状态 | 表现 |
| --- | --- |
| 打开一本回流电子书 | 全部可用 |
| 打开 CBZ / FXL | `.layout-panel.is-disabled`：正文整体 `opacity: .42` + `pointer-events: none`；顶部 `.lp-notice` 出现（`--accent-weak` 底、`--accent-ink` 字）；副标题改成「固定版面：排版由出版方决定」；footer 保留（恢复默认仍可点，但只影响以后打开的其它书） |
| 没打开任何电子书 | 入口按钮不出现在工具栏（不是禁用），面板不可打开 |
| 未打开电子书但面板已开（切换文档导致） | 同「没打开」，面板自动收起 |

### 5.3 单个控件的依赖态

| 控件 | 依赖 |
| --- | --- |
| 段间距（数值 + 滑杆） | 仅「分段方式 = 段间距」时显示；其它模式 `hidden` |
| 覆盖配色 | 无依赖：与排版覆盖互相独立，默认开 |
| 字号 A− / A+ | 到 14 / 28 时对应按钮 `disabled` |
| 版心宽度滑杆 | 窄窗口（< 720px 可用宽度）时不禁用，但值小于可视宽度的时候不再有视觉效果——不改值、不加提示 |

最后一条是有意的：不因为窗口窄就把滑杆灰掉，否则用户切换窗口后面板会莫名其妙变灰。

### 5.4 保存态

`.lp-saved` 三态：`已保存`（`--ink-3`）／`保存中…`（同色，改文案即可）／不显示错误。
落盘失败静默——阅读偏好丢了不是需要打断阅读的事，与现有 `persistSettings` 的行为一致。

---

## 6. 交互

### 开合

| 动作 | 结果 |
| --- | --- |
| 工具栏「Aa」按钮 | 开 / 关切换 |
| 面板 × | 关闭 |
| `Esc` | 关闭（焦点回到「Aa」按钮） |
| 窄窗口点遮罩 | 关闭 |
| 切换文档到非电子书 | 自动关闭 |
| 窗口从宽变窄（跨 1024px） | 形态就地切换，**不改开合状态** |

### 键盘

- `Tab` 顺序：× → 预设 3 枚 → 组内控件自上而下 → 恢复默认。用原生 `button` /
  `input[type=range]`，不接管 Tab。
- 滑杆：`←/→` 步进（`step` 决定），`Home/End` 到两端。原生行为，不拦。
- 分段控件：`←/→` 在同组内移动焦点并选中（`role="radiogroup"` + `role="radio"`）。
- 开关：`Space` / `Enter` 切换。
- 焦点环：`outline: 2px solid var(--accent); outline-offset: 2px`，只在 `:focus-visible` 出现。

### 拖动与重排

- `input` 事件：只更新 CSS（`setStyles` 重写样式文本 / 写 CSS 变量），**不调 `render()`**。
- `pointerup` / `change`：「松手」再 `render()` 一次，让翻页偏移与总页数重算准。
- 合并窗口 40ms（`requestAnimationFrame`），连续拖动不会排队几十次 `render()`。
- 改「版心宽度」会由分页器自身触发 `render()`，不额外叠一次。

### 手势不冲突

面板内的滑杆与开关必须 `stopPropagation`（或直接不落在 `.ebook-stack` 上），
避免被电子书的滚轮翻页手势吃掉。面板本身在 iframe 之外，天然不受书内手势影响；
但要确认 `bindEbookGestures` 挂的是 `pane.ebookStack` 而不是 `document`。

---

## 7. 动效

| 元素 | 变化 | 时长 / 缓动 |
| --- | --- | --- |
| 面板宽窗口开合 | `width 0 ↔ 332px` + `opacity` | `240ms var(--ease)`；正文重排由浏览器接管，不加过渡 |
| 面板窄窗口开合 | `transform: translateX(100% → 0)` | `240ms var(--ease)` |
| 遮罩 | `opacity 0 ↔ 1` | `200ms var(--ease)` |
| 分段选中 | 底色 / 字色 | `140ms var(--ease)`，不做位移 |
| 开关 | 底色 + 滑块位移 | `180ms var(--ease)` |
| 滑杆滑块 | `scale(1.12)` on hover | `120ms var(--ease)` |
| 保存态文案 | 直接换文本，不淡入淡出 | — |

**不加**：面板内容逐项入场动画、数值滚动动画、滑杆轨道的弹性回弹。这三样在
「反复微调」的场景里只会让人等。

`prefers-reduced-motion: reduce` 时把上面所有 `transition` 归零。

---

## 8. 无障碍

- `aside[role="dialog"][aria-label="版式"]`；窄窗口遮罩出现时给 `aria-modal="true"`。
- 开关用 `button[aria-checked]`（`role="switch"`），实测 `aria-checked` 与 `.is-on` 同步。
- 滑杆 `aria-label` 用中文名（「字间距」），`aria-valuetext` 用带单位的可读值（「0.25 像素」）。
- 对比度：`--ink-3` 在 `--surface` 上约 3.4:1，只用于副标题与数值，不用于主标签
  （主标签用 `--ink-2`，约 6.8:1）。
- 禁用态不只靠透明度：同时 `disabled`（真实属性），读屏能报出不可用。

---

## 9. 文案（i18n 键）

| 键 | 中文 | 英文 |
| --- | --- | --- |
| `layout.title` | 版式 | Layout |
| `layout.sub` | 只作用于电子书，改动即时生效 | Applies to ebooks only; changes are live |
| `layout.fixedSub` | 固定版面：排版由出版方决定 | Fixed layout: typography comes from the publisher |
| `layout.notice` | 这本书是固定版面，排版由出版方决定，版式设置对它无效。 | This book uses a fixed layout… |
| `layout.preset` | 预设 | Preset |
| `layout.preset.comfort` | 舒适中文 | Comfort (Chinese) |
| `layout.preset.compact` | 紧凑 | Compact |
| `layout.preset.latin` | 西文衬线 | Latin serif |
| `layout.preset.custom` | 自定义 | Custom |
| `layout.text` | 文字 | Text |
| `layout.family` | 字体 | Typeface |
| `layout.size` | 字号 | Size |
| `layout.letter` | 字间距 | Letter spacing |
| `layout.para` | 段落 | Paragraph |
| `layout.lineHeight` | 行高 | Line height |
| `layout.breakMode` | 分段方式 | Paragraph break |
| `layout.break.none` | 无 | None |
| `layout.break.indent` | 首行缩进 | First-line indent |
| `layout.break.space` | 段间距 | Spacing |
| `layout.paraSpacing` | 段间距 | Space between |
| `layout.align` | 对齐 | Alignment |
| `layout.alignLeft` | 左对齐 | Left |
| `layout.alignJustify` | 两端 | Justify |
| `layout.page` | 页面 | Page |
| `layout.margin` | 页边距 | Margins |
| `layout.measure` | 版心宽度 | Text width |
| `layout.measureHint` | 纸的最大宽度 | Max page width |
| `layout.spread` | 双页 | Two pages |
| `layout.detail` | 细节 | Details |
| `layout.hyphenate` | 连字符 | Hyphenation |
| `layout.hyphenateHint` | 西文断词 | Break Latin words |
| `layout.punctuate` | 标点挤压 | Punctuation squeeze |
| `layout.punctuateHint` | 中西文间隙 · 标点半角 | CJK/Latin gap · half-width marks |
| `layout.override` | 覆盖排版 | Override typography |
| `layout.overrideHint` | 让书内字体字号让位 | Ignore the book's own fonts |
| `layout.overrideColor` | 覆盖配色 | Override colors |
| `layout.overrideColorHint` | 字色与底色跟随主题 | Colours follow the theme |
| `layout.reset` | 恢复默认 | Reset |
| `layout.saved` | 已保存 | Saved |
| `layout.saving` | 保存中… | Saving… |
| `reader.layout` | 版式（按钮 title） | Layout |

预设名不译成「Comfort」这种空词——英文界面里就叫 `Comfort / Compact / Latin serif`，
但中文界面必须写「舒适中文」，因为这套预设的前提是中文字体与标点规则。

---

## 10. 设计自查清单

- [x] 没有 emoji、没有紫粉渐变、没有玻璃拟态（遮罩的 `blur(1.5px)` 只用于压暗背景）。
- [x] 所有颜色走 token，没有硬编码 hex（滑杆轨道、遮罩的 mix 都用 `color-mix` + token）。
- [x] 半径只用 `--r-sm` / `--r-pill`；面板本身不带圆角（贴边侧栏）。
- [x] 字号只用 11 / 11.5 / 12 / 12.5 / 15 / 9.5（分组标题）六档，不出现 13、14。
- [x] 图标只新增一枚 `#i-type`，其余复用现有 sprite（`#i-x`）。
- [x] 三主题下逐项检查过对比度，`--ink-3` 不承担主信息。
- [x] 窄窗口有遮罩、`Esc` 可退、焦点不被困在面板外。
- [x] 每个控件的默认值都等于「舒适中文」预设，打开面板第一眼是「已选中一套」而不是「自定义」。
- [x] 面板不吃掉工具栏：「Aa」按钮与工具栏都还在（电子书书口带改版后为底部带，PDF / 文本仍是浮动条），居中基准是阅读区而不是整行。
- [x] 关掉全部设置项后仍能读：最小 14px / 行高 1.3 / 缩进 0 / 段距 0 / 边距 8px 的极端组合不塌。
