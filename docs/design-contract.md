# Design Contract — 阅笺 YueJian Reader

> 唯一视觉事实来源。原型与最终应用的所有页面只允许引用本文件中的 token，不得自行发明颜色/字号/圆角。

## 1. 风格层与美学方向

- style tier: `editorial-light`（编辑设计 / 纸感阅读器）
- aesthetic: 安静的档案馆与排版工作室。纸纤维底色、墨色正文、朱砂色单一强调、细如发丝的分隔线、大留白 + 可控信息密度。
- tone keywords: 安静 / 克制 / 有纸感 / 高密度但不拥挤
- 记忆点: 书脊式封面 + 朱砂色进度线 + 楷体标题与宋体正文的排版语言

## 2. Design Tokens

```
/* 纸白主题（默认） */
--paper:        #F3EDE1   /* 应用底色，带纸感 */
--surface:      #FBF7EE   /* 面板 / 纸张 */
--surface-2:    #EDE4D3   /* 次级面板、悬浮 */
--ink:          #241F1A   /* 正文墨色（非纯黑） */
--ink-2:        #5E5548   /* 次级文字 */
--ink-3:        #8C8272   /* 弱化文字 / 占位 */
--line:         #DFD4C0   /* 发丝线 */
--line-strong:  #C9BBA2
--accent:       #B23A2B   /* 朱砂 */
--accent-weak:  #EBD9D3
--ok:           #4F7355
--warn:         #A8792C

/* 夜读主题 */
--paper:#12100E  --surface:#1A1715  --surface-2:#221E1A
--ink:#EDE5D8    --ink-2:#B7AB98    --ink-3:#7E7466
--line:#2E2924   --line-strong:#3D362F  --accent:#E0705C  --accent-weak:#3A2620

/* 护眼主题 */
--paper:#E9E1CE  --surface:#F2EAD8  --surface-2:#E0D5BE
--ink:#2A2419   --ink-2:#5C5342    --ink-3:#8A7F69
--line:#D3C6AC  --accent:#A0622D
```

### 分类色板（用户自定义分类的色点）

6 色，跟随主题切换，命名与取值的完整依据见 `docs/ui-categories.md` §5。分类颜色是**用户数据**，
与主题主色 `--accent` 分开命名，避免切主题时改变用户已选的颜色。

```
/* 纸白 */  --cat-clay:#B23A2B  --cat-indigo:#4A5C7A  --cat-olive:#5F7350
            --cat-amber:#A8792C --cat-plum:#7A4A63    --cat-slate:#55606B
/* 夜读 */  --cat-clay:#E0705C  --cat-indigo:#8FA3C4  --cat-olive:#96AC84
            --cat-amber:#D6AA5A --cat-plum:#C087A6    --cat-slate:#9AA6B2
/* 护眼 */  --cat-clay:#9C4A33  --cat-indigo:#4C5A72  --cat-olive:#5C6B46
            --cat-amber:#8F6524 --cat-plum:#6F4459    --cat-slate:#515A62
```

### 2.1 划线笔色（字面量，不随主题）

划线画在章节 iframe 内的 overlayer SVG 上，读不到主文档 CSS 变量，故笔色是字面量；
取值依据「纸白底上能看清、不盖字」，与分类色板同名不同值。完整理由见 `src/js/reader/highlight.js` 头注。

```
amber #d8a13a   olive #7f9463   indigo #6a7bb8   plum #a5698b   ink #6b6155
```

- `font.display`: `'KaiTi', 'STKaiti', 'Kaiti SC', 'Songti SC', serif`（标题、书名）
- `font.ui`: `'Segoe UI Variable Text', 'Microsoft YaHei UI', 'PingFang SC', sans-serif`
- `font.read`: `'Songti SC', 'Source Han Serif SC', 'Noto Serif CJK SC', 'SimSun', Georgia, serif`
- `font.mono`: `'Cascadia Code', 'JetBrains Mono', Consolas, monospace`
- `font.scale`: 11 / 12 / 13 / 15 / 18 / 22 / 28 / 40（px）
- `radius`: sm 4 / md 8 / lg 14 / pill 999
- `shadow`: `sm 0 1px 2px rgba(40,32,20,.06)` / `md 0 8px 24px -12px rgba(40,32,20,.24)` / `page 0 18px 48px -24px rgba(40,32,20,.38), 0 2px 6px rgba(40,32,20,.06)`
- `spacing`: 4 基数，常用 4/8/12/16/24/32/48/64
- `layout`: 标题栏 36px / 图标栏 56px / 书架面板 304px / 目录面板 268px / 版心 720px
- `icon`: Lucide 内联 SVG，16 / 18 / 20，`stroke-width: 1.6`，`currentColor`
- `motion`: 载入 stagger 40ms 递增，`cubic-bezier(.22,.8,.24,1)`，时长 180 / 260 / 420ms
- `bg-texture`: SVG `feTurbulence` 噪点叠加（opacity .035）+ 主画布极淡的横向纸纹

## 3. 组件规范

| 组件 | 默认 | hover | active | disabled |
| --- | --- | --- | --- | --- |
| 主按钮 | 朱砂底、纸白字、radius 999、高 32 | 亮度 -6%（`--accent-ink`） | 内阴影 1px | opacity .45 |
| 次按钮 | 透明底、1px `--line` 描边、`--ink-2` 字 | 底色 `--surface-2` | 底色加深 | 文字 `--ink-3` |
| 图标按钮 | 32×32、radius 8、透明 | `--surface-2` | `--accent-weak` + 朱砂图标 | opacity .4 |
| 输入框 | `--surface` 底、1px `--line`、radius 8、高 32 | 边框 `--line-strong` | 边框朱砂 + 2px 光晕 | — |
| 卡片 | `--surface` 底、1px `--line`、radius 14、无重阴影 | 上浮 2px + `shadow.md` | 边框朱砂 30% | — |
| 侧栏项 | 高 30、radius 6、左内边距 12 | `--surface-2` | 左侧 2px 朱砂竖条 + `--surface-2` | — |
| 目录头（书架索引） | 高 28、`--paper` 底、字号 10 字距 .12em、`--ink-3`；三层吸顶 top 0 / 28 / 56（z 3 / 2 / 1）；计数右对齐成列 | 文字 `--ink-2` | 收起时箭头 rotate(0)，自述当前选择（「类型 · PDF」「状态 · 在读」） | — |
| 目录行（类型 / 分类共用） | 高 28、radius 6、左内边距 10；类型行 4px 类型色点 / 收藏 12px 朱砂星，分类行 7px 用户色点 | `--surface-2` | 左侧 2px 朱砂竖条 + `--surface-2` | — |
| 标签 | 高 20、radius 4、11px、`--surface-2` 底 | — | — | — |
| 弹层 | `--surface` + `shadow.lg` + 1px `--line` + 顶边朱砂 2px | — | — | — |
| 空状态 | 居中等宽提示 + 虚线上传区 | 虚线变朱砂 | — | — |
| 分类行 | 高 28、radius 6、透明底、色点 7px | `--surface-2` | 左 2px 朱砂竖条 + `--surface-2` | — |
| 分类落点 | 同分类行 | 同分类行 | `--accent-weak` 底 + `inset 0 0 0 1px --accent` | — |
| 分类色点 | 7px 圆、`--cat-*` | — | — | 未分类用 `--ink-3` + 50% 不透明 |
| 批量条 | 高 28、radius 8、`--surface` 底、1px `--line-strong`、`shadow.sm` | — | — | — |
| 状态行图形 | 12×12：进度线 12×3 radius 2、轨道 `--line-strong`；在读填充 50% `--accent`；读完 `#i-check` 12 `--ok`；全部状态无图形 | 不变 | 不变（行选中态同目录行） | — |
| 排序工具条 | 高 28、上边界 1px `--line`、无底色；左排序按钮高 22 radius 4 字号 11 `--ink-2` + `#i-sort` 12 `--ink-3` + 方向箭头等宽 10 `--accent`；右可见计数等宽 10 `--ink-3` | 按钮 `--surface-2` 底 + `--ink` 字 | 展开态同悬停 | — |
| 排序菜单 | 锚定工具条 top 26 / left 8、z 30、宽 196、内边距 4、`--surface` + 1px `--line` + radius 8 + `shadow.md`；行高 28 radius 6 字号 12，对勾 12 `--accent` 占位隐藏，方向等宽 10；底部提示字号 10 `--ink-3` + 1px `--line` 分隔 | 行 `--surface-2` 底 + `--ink` 字 | 当前行对勾可见 + 方向 `--accent` | — |
| 撤销提示条 | 现有墨底胶囊 toast 内追加：胶囊按钮 radius 999、内边距 3 10、字号 11.5、字色继承 + 45% `currentColor` 描边；底边 2px 生命周期条 `currentColor` opacity .4 线性收宽 | 按钮 14% `currentColor` 底 | 点击即执行并收起 | 窗口结束随 toast 退场 |
| 阅读辅助条 | 高 38、内边距 8 12、间距 8、radius 14、`--surface` 底、1px `--line`、顶边 2px `--accent`、`--shadow-md`；阅读区 bottom 48 居中（书口带高 46，气泡底边与带顶平齐、顶边在其上约 23px，48 让辅助条始终压在气泡上方），max `min(680px,92%)`、z 30；仅运行时出现 | — | — | 无本地嗓音时主按钮 opacity .45 + 12px `--warn` 说明替代字幕 |
| 电子书工具带（书口） | 高 46、通栏停靠在阅读区底边（不浮、无圆角、无阴影），内边距 0 12、间距 10；`color-mix(--surface-2 62%, --surface)` 底 + 顶边 1px `--line`；三段：左章节名 / 中进度轨道 / 右开关组 | 按钮 `--surface-2` 底 | 按钮 `--accent-weak` 底 + 朱砂 | 打不开的书只留「版式 / 目录 / 栏级动作」，无轨道与翻页 |
| 书口章节名 | 12.5px `--font-read`、`--ink-2`、单行省略、`flex:0 1 168px`；前置 14×1px 朱砂引线，间隔 8、下移 3 | — | — | 无章节名时留空，不写占位 |
| 书口分组按钮 | 高 26、min-width 26、内边距 0 6、radius 4、`--ink-2`；图标 14；分组间距 2；组间 1px `--line` 竖线高 16、左右 6；百分比 10.5px 等宽 `--ink-2`、min-width 38 | `--surface-2` 底 + `--ink` | `.is-on`：`--accent-weak` 底 + 朱砂 | 固定版面：姿势禁用、朗读 / 自动 / 单双页 `hidden`（`display:none` 真的不占位） |
| 电子书阅读区（桌面 + 书页） | 阅读区底：`color-mix(--surface-2 58%, --paper)` + 顶部径向 5% 墨色渐晕（桌面）；书页宽按版式算：双页 = 版心×2 + 留白×2，单页 = 版心 + 留白×2，滚动档再 +12 滚动条，上限 `可用宽 - 32` 后居中；`.ebook-stack` 绝对定位 inset `14px 0 0`、`--surface` 底、1px `--line` 边（去底边）、radius 4 4 0 0、`--shadow-md`；固定版面撑满宽高；底部与书口带相接 | — | — | 同一套书页三种形态：`is-spread` / `is-single` / `is-scroll`，固定版面 `is-fixed` 不叠纸 |
| 书页叠纸 | 书页下一张纸：左右各宽出 6、顶偏 7、底齐平，`color-mix(--surface-2 76%, --surface)` 底、1px `--line` 三边（去底）、radius 6 6 0 0；滚动 / 固定版面隐藏 | — | — | 只露一道纸边；`pointer-events:none` 不接交互 |
| 书页中缝 | 仅双页：居中竖带，宽 `min(72px, max(14px, 列间距×1%))`，上下让出 `--ebook-margin`；5% 墨色对称渐隐 + 两端 14px mask 渐隐，中线 1px `--line-strong` 82% | — | — | 单页 / 滚动 / 固定版面不画；`pointer-events:none` |
| 书页页码 | 下白边中线，高 = 版式留白（默认 56）；等宽 10.5px / 0.08em / tabular、`--ink-3`、opacity .85，格式 `— N —`；双页左右各一（右页 N+1），单页居中只留一个 | — | — | 留白 < 26px、滚动或固定版面时整层隐藏；页码为按本册字数估算的册内页序，不写回文件 |
| 连续滚动条 | 10px 透明轨道 + 4px 墨线滑块（`color-mix(--ink-3 30%)`、radius 999、`background-clip:content-box`）；自定义滚动条模式，不渲染上下箭头按钮 | 滑块 `--ink-3` 58% | — | 只在滚动档生效；颜色由宿主 `--ebook-sb-thumb` / `-hover` 递进 closed shadow，不写死色值 |
| 翻页掠影 | 38% 宽的纸影带从翻页来向扫向去向，opacity 0→.85→0、320ms `cubic-bezier(.22,.8,.24,1)` | — | — | 只在「滑动」档的翻页与跨节时出现（`.is-paged.is-turning`）；渐隐档 / 减少动效档不出现，不挡交互 |
| 辅助条控件 | 主按钮 26×26 radius 8 `--accent` 底 `--paper` 图标；次按钮 26 高 radius 8 `--ink-2`；字幕 12px `--ink-2` 单行省略；select 12px 高 24 `--surface` 底 1px `--line` radius 8 max 110；速度滑杆宽 90 accent 朱砂 + 等宽 12 数字 | 次按钮 `--accent-weak` 底 + 朱砂 | 主按钮内阴影 1px | select/滑杆随主按钮禁用态 |
| 选区动作行 | 选区条第二行：上边界 1px `--line`、上内边距 7、间距 4；文字按钮 11px、内边距 4 8、radius 4、`--ink-2`（复制 / 笔记 / 删除） | `--accent-weak` 底 + 朱砂字 | 同悬停 | — |
| 笔记 popover | 宽 260、内边距 8、radius 8、`--surface` + 1px `--line` + 顶边 2px `--accent` + `--shadow-md`；textarea 84 高 13px/1.6 `--surface` 底 1px `--line` radius 8；计数 11px `--ink-3`；保存为主按钮规格缩至高 24 | 边框 `--line-strong` | 保存内阴影 1px | 超 500 字：计数 `--accent` + 保存 opacity .45 |
| 进度刻度 | 轨道中线 2×10px、radius 1、`--line-strong`；章边界处、≤40 个、`pointer-events:none` | 不变 | 不变 | 固定版面按节均布 |
| 进度预览气泡 | 拖拽时轨道上方 32px、`translateX(-50%)`、11px、内边距 6 9、radius 8、`--ink` 底 `--paper` 字、opacity 180ms | 不变 | 松手即退场 | — |
| 朗读句高亮 | overlayer 矩形：填充 `--accent-weak` + 2px 同色外扩、radius 2、opacity 0.3（比划线笔迹 0.42 更淡一档，字须透出来，不得实心盖字）；瞬移无过渡；不入书架不导出 | — | — | 暂停时保留 |
| 侧栏笔记行 | 划线条目引文下：12px `--ink-2`、左缩进 14、上边距 5、单行省略（title 全文） | 条目 hover 不变 | — | 无笔记不渲染该行 |
| 版式面板字体列表 | 组标题 10px 字距 .08em `--ink-3`（「系统字体」「开源字体 · 按需下载」两组）；行内边距 4 6、行距 2、radius 4；行内四段：24×24 样例字格 / 12.5px 名称（单行省略）/ 10px 元信息（等宽数字，`OFL 1.1 · 25 MB`）/ 10.5px 状态字（min-width 30、右对齐：下载 / 百分比 / ✓ / 使用中 / 重试）；删除按钮 18×18，默认 opacity 0 | 行 `--surface-2` 底；删除按钮浮现，图标转 `--accent` | 行 `--accent-weak` 62% 底；样例字格描边朱砂 40%、字 `--accent-ink`；状态字 `--accent-ink` | 下载中整组 opacity .45 + `pointer-events:none`；固定版面随整面板禁用；重试状态字 `--accent` |
| 字体样例字格 | 24×24、radius 4、`--surface` 底 + 1px `--line`、15px；未安装项用系统字渲染（不给假预览），已装项用该字体自己渲染 | — | 选中项描边同「版式面板字体列表」 | — |

## 4. App Shell 与固定导航（强制）

```
<div class="app">
  <header class="titlebar">  ← 36px，含应用名 / 当前文档名 / 窗口按钮占位
  <div class="workspace">
    <nav class="rail">      ← 56px 图标栏（固定）
    <aside class="library"> ← 304px 书架面板（可折叠）
    <main class="stage">    ← 主内容槽（书架视图 / 阅读视图）
    <aside class="context"> ← 268px 目录面板（可折叠）
  </div>
  <footer class="statusbar"> ← 26px 状态条
</div>
```

- 导航项（固定顺序，不可增删改序）：
  1. `library` 书架 — `library`
  2. `reading` 阅读 — `book-open`
  3. `search` 搜索 — `search`
  4. `settings` 设置 — `settings`
- 激活规则：唯一机制 —— `data-nav` 与 `body[data-view]` 匹配时加 `.is-active`（朱砂色 + 左侧竖条）。
- 图标栏在所有视图保持完全一致的位置与结构，页面切换只替换 `.stage` 内容。

## 5. 页面清单

| 视图 | 职责 | 关键组件 | 去向 |
| --- | --- | --- | --- |
| 书架 `library` | 书库总览、导入、收藏、最近阅读 | 封面网格、继续阅读条、空状态 | 点击书 → 阅读 |
| 阅读 `reading` | 承接 PDF / Markdown 渲染 | 顶部文档条、阅读工具栏、目录面板 | 返回书架 |
| 设置 `settings` | 主题、排版、更新、数据说明 | 设置弹层 / 面板 | 关闭回原视图 |
| 搜索 `palette` | 命令面板（Ctrl+K） | 模糊筛选列表 | 跳转书/章节/动作 |

## 6. Mock Schema

```js
Book = { id, title, author, kind: 'pdf'|'md', pages?, words?, progress: 0..1,
         favorite: bool, lastOpened: '2 小时前', tint: 'clay'|'indigo'|'olive'|'sand',
         coverTitle, coverSub }
TocItem = { level: 1|2|3, id, text }
Category = { id, name, color: 'clay'|'indigo'|'olive'|'amber'|'plum'|'slate' }
```

Mock 里的 `Book.tint` 是**封面**取色（由书 id 哈希决定，不可由用户修改）；
`Category.color` 是**分类色点**取色（用户选择）。两者共用色相族但互不影响。
