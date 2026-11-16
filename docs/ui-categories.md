# 界面设计 — 文档分类

> 状态：设计定稿（阶段三）· 依赖 `docs/design-contract.md`（视觉 token 唯一来源）
> 交互依据：`docs/feature-categories.md`；可运行原型：`prototype/categories/index.html`

## 1. 设计目标

分类区是书架面板里的**第三个组织层**，但它必须比上面两层（搜索、类型筛选）更安静——它承载的是用户自己的命名，不是系统能力。因此：

- **不发明白色底块、不加卡片阴影**：只用发丝线与行高划分，让分类看起来像「目录里的一节」，不是「一个新功能模块」。
- **靠颜色建立记忆点**：7px 色点是唯一的彩色元素，用户扫一眼就能定位分类，比读文字快。
- **选中态只用一个信号**：左侧 2px 朱砂竖条。与图标栏、侧栏项完全同一套语言，不新增视觉规则。

## 2. 位置与尺寸

```
┌─ 文档库 10 ──────────────── ＋ ─┐  panel-head   42
├─ ⌕ 搜索书名、作者 ──── Ctrl K ──┤  search-box   30 + 10 下边距
├─ 全部 PDF MARKDOWN 收藏 ────────┤  filter-row   22 + 10 下边距
├────────────────────────────────┤  ← 1px --line（分类区上边界）
│ ⌄ 分类 3                    ＋ │  cat-head     28
│   全部分类                 10 │  cat-row      28
│ ● 论文                      3 │  cat-row      28
│ ● 技术手册                  3 │  cat-row      28
│ ● 待读清单                  1 │  cat-row      28
│ ○ 未分类                    3 │  cat-row      28
├─ 已选 2 项 [归类到…] 取消 ──────┤  batch-bar    28（有选中时出现）
│ ▣ 数据库系统概念            🗑 │  book-row     ~52
└────────────────────────────────┘
```

| 元素 | 尺寸 |
| --- | --- |
| 分类区分隔线 | 1px `--line`，全宽 |
| 头部 `.cat-head` | 高 28，左内边距 8 / 右 12 |
| 折叠按钮 `.cat-toggle` | 高 24，字号 10.5，字距 .08em，`--ink-3`，文本大写 |
| 折叠箭头 | 12×12，展开时 `rotate(90deg)`，收起 `rotate(0)` |
| 新建按钮 `.cat-add` | 22×22，圆角 4，图标 13 |
| 列表 `.cat-list` | 最大高 **168**（≈5 行又露一行边），超出内部滚动；左右内边距 8 |
| 分类行 `.cat-row` | 高 28，圆角 6，左内边距 10，元素间距 8 |
| 色点 `.cat-dot` | 7×7 圆形 |
| 计数 `.cat-num` | 等宽 10，`--ink-3`，右对齐 |
| 编辑按钮 `.cat-more` | 18×18，圆角 4，**仅悬停时出现** |
| 批量条 `.batch-bar` | 左右外边距 12 / 下 8，内边距 6×8，圆角 8 |

**为什么列表最大高 168**：面板高 860 − 标题 36 − 头部 42 − 搜索 40 − 筛选 32 ≈ 710 可用；书列表至少要保住 300px（≈6 行）才不至于「只能看见一份文档」。5 行分类 + 部分露出第 6 行，既是提示「还有更多」的经典 affordance，也把滚动条出现的门槛压在 5 个分类以上。

## 3. 状态矩阵

### 3.1 分类行

| 状态 | 背景 | 文字 | 色点 | 竖条 |
| --- | --- | --- | --- | --- |
| 默认 | 透明 | `--ink` 12px | 分类色 | 无 |
| 悬停 | `--surface-2` | `--ink` | 分类色 | 无 |
| 选中 | `--surface-2` | `--ink` | 分类色 | 左 2px 朱砂，上下各内缩 6 |
| 拖拽落点 | `--accent-weak` | `--accent`（仅名称） | 分类色 | 无，改用 `inset 0 0 0 1px --accent` 描边 |
| 「全部分类」/「未分类」 | 同左默认 | `--ink-2` | 「未分类」用 `--ink-3` + 50% 不透明 | 同左 |

「全部分类」行没有色点，也没有编辑按钮——它不是一条分类记录，是「退出分类筛选」的口子。用文字「全部分类」而不是「全部」，是为了不与上方 chip 的「全部」混淆（两个「全部」并列时用户无法判断哪个管什么）。

### 3.2 文档行 / 卡片

| 状态 | 表现 |
| --- | --- |
| 悬停 | 行：`--surface-2`；卡片：封面 `translateY(-2px)` + `--shadow-md` |
| 被选中 | 行：`--accent-weak` 底 + 右上 5px 朱砂圆点；卡片：封面 `0 0 0 2px --accent` 外描边 |
| 拖拽中 | `opacity: .4` |
| 有分类 | 行元信息尾部追加 5px 分类色点；卡片在标题下的元信息行首部显示 5px 分类色点（`title` 带分类名） |

**为什么分类色点放在元信息行、不做封面角标**：封面右上角被收藏星标占用（星标 24×24 绝对定位，悬停出现），底部被页数与体积行占住；胶囊角标必然与其之一碰撞。把色点放进元信息行，既避开了冲突，又与列表视图共用同一套表达——「色点 + 类型 + 时间」三段式在两处一致，用户不需要学两套语言。

未分类不显示占位色点。用户数据里没有分类时，元信息行就是原来的「类型 · 时间」，与升级前逐像素一致。

## 4. 分类弹层

| 属性 | 值 |
| --- | --- |
| 面板宽 | 300 |
| 圆角 | 14 |
| 背景 / 描边 | `--surface` / 1px `--line` |
| 阴影 | `--shadow-lg` |
| 顶部标识 | 2px 朱砂实线（与全局弹层语言一致） |
| 内边距 | body 18×18×14，foot 12×18 |
| 名称输入 | 高 32，`--paper` 底，1px `--line`，聚焦时边框朱砂 + 2px `--accent-weak` 光晕 |
| 色板 | 6 个 22px 圆点，间距 8；选中项外圈 2px `--surface` 内描边 + 2px 同色外环 |
| 确认按钮 | 主按钮（朱砂底/纸白字/radius 999/高 28），禁用时 opacity .45 |
| 删除按钮 | 文文字按钮，`--accent`，左对齐，**仅编辑模式显示** |
| 入场 | 220ms 淡入（`--ease`），不做位移 |

字段顺序是「名称 → 配色 → 错误行 → 操作」，错误信息紧贴输入区下方，不放在底部——错误与导致它的字段必须相邻。

## 5. 分类色板（新增 token）

6 色，三套主题各一组。全部为**低饱和的暖灰系**，与纸感底色同族，只在色相上区分；不允许引入高饱和品牌色。

| key | 纸白 | 夜读 | 护眼 | 语义倾向 |
| --- | --- | --- | --- | --- |
| `clay` | `#B23A2B` | `#E0705C` | `#9C4A33` | 主色，与朱砂同源 |
| `indigo` | `#4A5C7A` | `#8FA3C4` | `#4C5A72` | 冷色，用于「资料 / 待读」 |
| `olive` | `#5F7350` | `#96AC84` | `#5C6B46` | 中性偏绿，用于「手册 / 工具」 |
| `amber` | `#A8792C` | `#D6AA5A` | `#8F6524` | 暖黄，用于「笔记 / 摘录」 |
| `plum` | `#7A4A63` | `#C087A6` | `#6F4459` | 紫红，用于「创作 / 草稿」 |
| `slate` | `#55606B` | `#9AA6B2` | `#515A62` | 冷灰，用于「归档」 |

夜读主题不是简单提亮，而是把明度推到 65–75% 区间：色点在深底上必须能自发光，否则 7px 的圆点会被底色吞掉。

`clay` 与主色 `--accent` 同色相但不共用变量：分类颜色是**数据**（存在 `state.json` 里），主色是**主题**（可整体切换），两者生命周期不同，共用变量会导致改主题时用户的分类颜色被动改变。

## 6. 动效

| 场景 | 时长 / 曲线 | 说明 |
| --- | --- | --- |
| 分类区折叠 | 180ms `--ease` | 箭头旋转；列表 `display:none` 直接切换（不做高度动画，避免 5 行以上时抖动） |
| 行悬停 / 选中 | 160ms `--ease` | 仅背景色过渡 |
| 拖拽落点高亮 | 120ms `--ease` | 背景 + 内描边同时进入，给「这里可以放」的即时反馈 |
| 弹层 | 220ms `--ease` | 透明度 0 → 1 |
| Toast | 220ms `--ease` | 自下 6px 淡入 |

折叠不做高度动画是刻意的：`max-height` 过渡需要写死目标高度，分类增删后动画终点会错；`grid-template-rows: 0fr → 1fr` 又会在收起瞬间丢失滚动位置。直接切换虽不华丽，但每次都是对的。

## 7. 文案（i18n 键）

中文为基准，英文同键位；缺失英文时回退中文（现有 `t()` 行为）。

| key | 中文 | 英文 |
| --- | --- | --- |
| `category.section` | 分类 | Categories |
| `category.all` | 全部分类 | All categories |
| `category.none` | 未分类 | Uncategorized |
| `category.new` | 新建分类 | New category |
| `category.edit` | 编辑分类 | Edit category |
| `category.more` | 编辑分类 | Edit category |
| `category.nameLabel` | 名称 | Name |
| `category.colorLabel` | 配色 | Color |
| `category.namePlaceholder` | 例如：论文 / 技术手册 / 待读 | e.g. Papers / Manuals / To read |
| `category.createSub` | 给这一类文档起个名字，选一个颜色方便辨认。 | Name this group and pick a color to recognize it. |
| `category.editSub` | 改名或换配色，不会影响其中的文档。 | Rename or recolor — documents are unaffected. |
| `category.save` | 保存 | Save |
| `category.cancel` | 取消 | Cancel |
| `category.delete` | 删除分类 | Delete category |
| `category.errEmpty` | 名称不能为空 | Name cannot be empty |
| `category.errTooLong` | 名称最多 20 个字符 | Name must be 20 characters or fewer |
| `category.errDup` | 已存在同名分类 | A category with this name already exists |
| `category.errLimit` | 分类数量已达上限（40） | Category limit reached (40) |
| `category.emptyHint` | 还没有分类，点右上角 ＋ 新建一个 | No categories yet — use ＋ to create one |
| `category.emptyCategory` | 这个分类下还没有文档 | No documents in this category yet |
| `category.emptyCategoryHint` | 把左侧的文档拖到分类行，或 Ctrl+点击 多选后批量归类 | Drag a document onto the category, or Ctrl+click to select several |
| `category.created` | 已创建「{name}」 | Created "{name}" |
| `category.updated` | 已更新「{name}」 | Updated "{name}" |
| `category.deleted` | 已删除「{name}」 | Deleted "{name}" |
| `category.deletedWithDocs` | 已删除「{name}」，{count} 份文档转为未分类 | Deleted "{name}" — {count} documents moved to Uncategorized |
| `category.assigned` | 已归到「{name}」 | Moved to "{name}" |
| `category.assignedMany` | {count} 份文档已归到「{name}」 | {count} documents moved to "{name}" |
| `category.deleteTitle` | 删除分类 | Delete category |
| `category.deleteNote` | 删除「{name}」后，其中的 {count} 份文档会变成「未分类」，文档本身不会被移除。 | Deleting "{name}" will move its {count} documents to Uncategorized. The documents themselves are not removed. |
| `category.filteredSub` | 筛选结果 | Filtered |
| `category.clearFilter` | 清除筛选 | Clear filters |
| `category.hint` | 拖动书到分类行即可归类；Ctrl+点击可多选 | Drag a document onto a category; Ctrl+click to multi-select |
| `batch.selected` | 已选 {count} 项 | {count} selected |
| `batch.assignTo` | 归类到… | Move to… |
| `batch.cancel` | 取消 | Cancel |

「未分类」在提示语里作为 `name` 参数传入，因此 `category.assigned` 会渲染成「已归到「未分类」」——语法成立，不需要单独一套 key。

## 8. 设计自查清单

- [x] 所有颜色取自已更新的 `design-contract.md`，无契约外 hex（分类色板已登记为 `--cat-*`）
- [x] 字号只用 10 / 10.5 / 11 / 12 / 12.5 / 13 六档，未引入新档位
- [x] 圆角只用 4 / 6 / 8 / 14 / 999
- [x] 图标全部来自现有 sprite（`i-plus` / `i-more` / `i-chevron` / `i-trash`），未新增图标
- [x] 三套主题下色点均可见（夜读主题已单独提亮）
- [x] 选中态与既有侧栏语言一致（2px 朱砂竖条）
- [x] 无 emoji、无渐变、无 AI 模板味装饰
- [x] 折叠 / 拖拽 / 弹层三个动效都有明确时长与曲线
