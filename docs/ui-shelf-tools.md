# 界面设计 — 书架工具（阅读状态 · 排序 · 删除撤销）

> 状态：设计定稿（阶段三）· 依赖 `docs/design-contract.md`（视觉 token 唯一来源）
> 交互依据：`docs/feature-shelf-tools.md`；可运行原型：`prototype/shelf-tools/index.html`（44/44 断言通过）

## 1. 设计目标

三个新能力共用一条原则：**不新增视觉模块，只延长现有语言**。

- **状态轴**是目录里的第三组，与类型 / 分类同一种行语言（28px / radius 6 / 2px 朱砂竖条）。它的个性只体现在 12px 迷你图形上：半满线 = 在读、空线 = 未读、对勾 = 读完。图形比色点更安静——除对勾用 `--ok`、半满填充用 `--accent` 外全是中性轨道色，扫一眼是「进度」而不是「标签」。
- **排序工具条**是一条 28px 的功能线，不是卡片：上边界一根发丝线把它与目录分开，左按钮右计数，没有底色、没有阴影。它回答「现在按什么顺序、筛剩多少」，两个信息都不抢书列表的注意力。
- **撤销**长在现有 toast 里：一枚朱砂描边胶囊按钮 + 底边 2px 生命周期条。toast 的其余部分（位置 / 圆角 / 阴影 / 入场）逐字不变，用户不需要学「另一种提示」。

派生状态不配彩色徽章：状态会随阅读自己变化，给它强色彩等于给一个会自己变的东西发固定身份证。

## 2. 位置与尺寸

```
┌─ 文档库 10 ──────────────── ＋ ┐  panel-head   42
├─ ⌕ 搜索书名、作者 ─────────────┤  search-box   30 + 10 下边距
├────────────────────────────────┤  ← 1px --line（索引上边界）
│ › 类型                      10 │  idx-head        28（sticky top:0，z3，默认收起）
│ › 状态 · 在读                5 │  idx-head-status 28（sticky top:28，z2，默认收起）
│ ⌄ 分类 2                   ＋ │  idx-head-cat    28（sticky top:56，z1，默认展开）
│   全部分类                 10 │  cat-row         28
│ ● 论文                      3 │  cat-row         28
├────────────────────────────────┤  ← 1px --line（工具条上边界）
│ ⇅ 最近打开 ↓            10 份 │  list-tools      28（排序菜单锚点）
├─ 已选 2 项 [归类到…] 取消 ──────┤  batch-bar       28（有选中时出现）
│ ▣ 深度学习论文合集          🗑 │  book-row        ~52
└────────────────────────────────┘
```

| 元素 | 尺寸 |
| --- | --- |
| 索引 `.shelf-index` | 最大高 `min(344px, 42vh)` 不变；三组全展开时内部滚动 |
| 目录头三层吸顶 | 类型 `top:0 / z:3` → 状态 `top:28px / z:2` → 分类 `top:56px / z:1`；实测吸顶落点 1 / 29 / 57（含索引 1px 上边界） |
| 状态行 `.idx-row` | 与类型行完全同规格：高 28、radius 6、左内边距 10、间距 8 |
| 状态图形 `.status-glyph` | 12×12 容器；进度线 12×3、radius 2、轨道 `--line-strong`；在读填充 `i` 宽 50%、`--accent`；读完 `#i-check` 12×12、`--ok`；「全部状态」无图形 |
| 工具条 `.list-tools` | 高 28、`flex:none`、`position:relative`（菜单锚点）、上边界 1px `--line`、内边距 0 12 0 8、两端对齐 |
| 排序按钮 `.sort-btn` | 高 22、radius 4、内边距 0 7、间距 5、字号 11、`--ink-2`；图标 `#i-sort` 12×12 `--ink-3` |
| 方向箭头 `.sort-dir` | 等宽 10、`--accent`（↑ / ↓ 单字符） |
| 可见计数 `.shown-count` | 等宽 10、`--ink-3`、右对齐 |
| 排序菜单 `.sort-menu` | 锚定 `top:26px / left:8px`、z 30、宽 196、内边距 4、`--surface` 底、1px `--line`、radius 8、`--shadow-md` |
| 菜单行 `.sort-item` | 高 28、radius 6、内边距 0 8、间距 7、字号 12、`--ink-2`；对勾 12×12 `--accent`（非当前项 `visibility:hidden` 占位） |
| 菜单方向 `.dir` | `margin-left:auto`、等宽 10、`--ink-3`；当前项 `--accent` |
| 菜单提示 `.sort-hint` | 字号 10、`--ink-3`、上边界 1px `--line`、外边距上 4、内边距 5 8 3 |
| 撤销按钮 `.toast-action` | 胶囊 radius 999、内边距 3 10、字号 11.5、字色继承 toast、1px 描边 `color-mix(currentColor 45%, transparent)` |
| 生命周期条 `.toast-life` | 绝对定位底边、高 2、`currentColor`、opacity .4、宽度 100% → 0 线性 |

**为什么状态组夹在类型与分类中间**：阅读工作流（「我在读什么」）比组织工作流（分类）更高频；状态组固定四行，展开代价小，放在第二层吸顶不会把分类头推出首屏。三组头的 z 序递减保证滚动时上层头压住下层头，而不是互相穿插。

**为什么菜单宽 196 而不是撑满面板**：菜单是锚定弹层，不是面板的一部分；196px 容纳「对勾 + 四字轴名 + 方向箭头」后仍留呼吸位，且窄面板（262px）下不会贴边。`left:8px` 与工具条按钮左缘对齐，视线从按钮垂直落到菜单。

**为什么计数放工具条而不是目录头**：目录头计数是「该组有多少」（全局口径），工具条计数是「四轴叠加后剩多少」（瞬时口径）。两者语义不同，放一起会互相撒谎；工具条紧贴书列表，「筛剩多少」与「看到什么」相邻。

## 3. 状态矩阵

### 3.1 状态行

| 状态 | 背景 | 文字 | 图形 | 竖条 |
| --- | --- | --- | --- | --- |
| 默认 | 透明 | `--ink` 12px | 见 §2 图形规格 | 无 |
| 悬停 | `--surface-2` | `--ink` | 不变 | 无 |
| 选中 | `--surface-2` | `--ink` | 不变 | 左 2px 朱砂，上下各内缩 6 |
| 「全部状态」 | 同默认 | `--ink-2` | 无图形 | 同左 |
| 拖拽经过 | **无落点态** | — | — | — |

状态行不是拖拽落点：状态派生自进度，没有可写字段。落点高亮（`--accent-weak` + 内描边）仍只属于 `.cat-row`，拖拽视觉零改动。

收起时目录头自述：`状态 · 在读` + 该状态计数（`.idx-current` 前置 `·`，超长省略）；选「全部状态」时自述区为空，头只显示「状态」+ 总数。与类型组同一套自述机制。

### 3.2 排序按钮与菜单

| 元素 / 状态 | 表现 |
| --- | --- |
| 按钮默认 | 透明底、`--ink-2` 字、图标 `--ink-3` |
| 按钮悬停 / 展开 | `--surface-2` 底、`--ink` 字（展开态与悬停同视觉，靠 `aria-expanded` 语义区分） |
| 按钮聚焦 | 全局 `:focus-visible`：2px 朱砂外描边、offset 2 |
| 菜单行默认 | `--ink-2` 字、对勾占位隐藏 |
| 菜单行悬停 | `--surface-2` 底、`--ink` 字 |
| 菜单行当前 | `--ink` 字 + 对勾可见（`--accent`）+ 方向箭头 `--accent` |
| 菜单行聚焦 | 全局 `:focus-visible` 描边；打开菜单时焦点落到第一行，翻向后焦点留在被点行 |
| 菜单提示行 | 不可点、无悬停态；文案「再点当前项翻转方向 · 排序会记住」 |

方向箭头语义：菜单内**每行都显示该轴当前的方向箭头**（非当前行显示其自然方向），当前行箭头即实际方向——用户不用切换就能预览「切过去会是什么顺序」。按钮上的箭头只反映当前实际方向。

### 3.3 撤销 toast

现有 toast 是**墨底胶囊**（`--ink` 底 / `--paper` 字 / radius 999 / `--shadow-lg` / 底边 74px；夜读主题反转为 `--surface-2` 底 / `--ink` 字），不是纸色卡片。撤销组件必须长在这套反色语言里，因此一律取 `currentColor`：三套主题的 toast 底色都是深色、字色都是浅色，描边与生命周期条随字色自动成立，不需要逐主题写值。

| 元素 / 状态 | 表现 |
| --- | --- |
| toast 本体 | 与现有逐字一致：墨底胶囊、14px `--accent` 对勾、自下 10px 淡入 240ms |
| 撤销按钮默认 | 字色继承 toast、45% `currentColor` 描边胶囊；`pointer-events:auto`（wrap 为 none，普通 toast 不挡点击） |
| 撤销按钮悬停 | 14% `currentColor` 底 |
| 生命周期条 | 仅带动作的 toast 出现；`currentColor` opacity .4，6000ms 线性收宽，收完 toast 按现有 200ms 退场 |
| 被新 toast 顶掉 | 内容整体重建，旧动作按钮随之消失（不存在「新文案挂旧按钮」） |

生命周期条是**窗口可见化**：6 秒不是隐藏规则，用户看着条收完就知道「现在删就是真删了」。普通 toast（2200ms）不画条——短窗口不需要倒计时焦虑。

## 4. 动效

| 场景 | 时长 / 曲线 | 说明 |
| --- | --- | --- |
| 状态组折叠 | 180ms `--ease` | 箭头旋转；行列表 `display:none` 直切（与类型 / 分类同规则，不做高度动画） |
| 状态行 / 菜单行悬停 | 150ms `--ease` | 仅背景色过渡 |
| 排序菜单开合 | 180ms `--ease` | 透明度 0→1 + `translateY(-2px)→0`；关闭直切 `hidden`（退场不做动画，避免与下一次打开叠影） |
| 翻向 | 无动画 | 箭头字符直换 + 列表重排；排序结果不做位移动画（书列表可能整屏换序，位移只会晕） |
| 撤销按钮悬停 | 150ms `--ease` | 背景进入 14% `currentColor` |
| 生命周期条 | 6000ms linear | `width:100%→0`，`animation-duration` 由 toast 的 `duration` 注入 |
| toast 入场 / 退场 | 240ms / 200ms `--ease` | 现有值不变 |

## 5. 文案（i18n 键）

中文为基准，英文同键位。`confirm.removed`（已移除《{title}》）复用现有键，不新增。

| key | 中文 | 英文 |
| --- | --- | --- |
| `status.section` | 状态 | Status |
| `status.all` | 全部状态 | All statuses |
| `status.reading` | 在读 | Reading |
| `status.unread` | 未读 | Unread |
| `status.finished` | 读完 | Finished |
| `sort.recent` | 最近打开 | Recently opened |
| `sort.added` | 最近添加 | Recently added |
| `sort.title` | 书名 | Title |
| `sort.progress` | 阅读进度 | Reading progress |
| `sort.desc` | 降序 | descending |
| `sort.asc` | 升序 | ascending |
| `sort.hint` | 再点当前项翻转方向 · 排序会记住 | Click the current item again to flip direction — sort is remembered |
| `sort.menuLabel` | 排序方式 | Sort order |
| `library.sortSub` | 按{axis}{dir} | Sorted by {axis}, {dir} |
| `library.shownCount` | {count} 份 | {count} shown |
| `undo.action` | 撤销 | Undo |
| `undo.restored` | 已恢复《{title}》 | Restored "{title}" |

`library.sortSub` 替换现有 `library.sortRecent` 的无筛选分支（有筛选分支仍用 `category.filteredSub`）；`sort.desc` / `sort.asc` 同时供工具条 `title` 与菜单行 `aria-label` 使用。状态筛选进入 `filterSummary` 时直接用 `status.*` 标签拼接（「在读 · 论文 · PDF」），不另设组合键。

## 6. 设计自查清单

- [x] 所有颜色取自 `design-contract.md`：图形轨道 `--line-strong`、填充 `--accent`、对勾 `--ok`、菜单 `--surface` / `--line` / `--shadow-md`；撤销组件取 `currentColor` 随 toast 反色，无契约外 hex
- [x] 字号只用 10 / 11 / 11.5 / 12 现有档位（11.5 为 toast 动作按钮，原型实测可读）
- [x] 圆角只用 2（图形线）/ 4 / 6 / 8 / 999；2px 仅用于 3px 高进度线端头，属图形而非容器
- [x] 图标复用现有 sprite：`#i-check` / `#i-chevron`；仅新增 `#i-sort` 一枚（Lucide arrow-up-down，16 网格 stroke 1.6）
- [x] 三主题核对：夜读下轨道色 `--line-strong` 提亮后图形仍可见；护眼主题对勾 `--ok` 继承纸白组值
- [x] 选中态 / 悬停态 / 聚焦态与既有目录行同一套语言，未新增规则
- [x] 304px 与 262px 面板宽度实测无横向溢出（菜单 196px < 262 − 16）
- [x] 三层吸顶实测落点 1 / 29 / 57，滚动 400px 后三头仍依次压叠
- [x] 无 emoji、无渐变、无新增阴影层级