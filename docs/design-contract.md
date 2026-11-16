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
| 标签 | 高 20、radius 4、11px、`--surface-2` 底 | — | — | — |
| 弹层 | `--surface` + `shadow.lg` + 1px `--line` + 顶边朱砂 2px | — | — | — |
| 空状态 | 居中等宽提示 + 虚线上传区 | 虚线变朱砂 | — | — |
| 分类行 | 高 28、radius 6、透明底、色点 7px | `--surface-2` | 左 2px 朱砂竖条 + `--surface-2` | — |
| 分类落点 | 同分类行 | 同分类行 | `--accent-weak` 底 + `inset 0 0 0 1px --accent` | — |
| 分类色点 | 7px 圆、`--cat-*` | — | — | 未分类用 `--ink-3` + 50% 不透明 |
| 批量条 | 高 28、radius 8、`--surface` 底、1px `--line-strong`、`shadow.sm` | — | — | — |

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
