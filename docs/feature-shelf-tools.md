# 功能规划 — 书架工具（阅读状态 · 排序 · 删除撤销）

> 状态：已实现并验证（见 §8 验证记录）
> 前置文档：`docs/product-spec.md`、`docs/design-contract.md`、`docs/feature-categories.md`

## 1. 背景与调研

左侧面板在「目录化重设计」后解决了挤压问题，但功能维度仍然只有两条轴：**类型**（文档自身属性）与**分类**（用户组织意图）。对照成熟阅读器的左侧栏调研，缺的是第三类信息——**阅读状态**，以及两个基础工具——**排序**与**删除撤销**。

### 1.1 调研证据

| 来源 | 观察 | 对本项目的启示 |
| --- | --- | --- |
| [Calibre GUI 手册](https://manual.calibre-ebook.com/gui.html) | Tag browser 纵轴分组 + 计数 + 拖拽赋值；删除的书进回收站暂存数天，可 Restore recently deleted | 目录形态已对齐；撤销是删除的标配安全网 |
| [calibre-web #2449](https://github.com/janeczku/calibre-web/issues/2449) | 社区明确要求侧栏提供 read/unread 状态筛选，标签系统太乱 | 状态轴是真实高频诉求，不是臆想 |
| [Reddit：Calibre 已读标记](https://www.reddit.com/r/Calibre/comments/1xphivj/calibre_library_management_books_i_have_read/) | 手动标记已读要 4–5 次点击，用户嫌贵 | 状态必须零维护成本 |
| [Apple Books 收藏集](https://appletoolbox.com/how-to-use-books-in-ios-12-essential-tips-and-tricks/) | Want to Read / Reading / Finished 手动收藏集让用户困惑「读完的书怎么又回来了」 | 手动状态集合会撒谎；派生状态不会 |
| [Bookarium DECISIONS.md](https://github.com/calin-m/Bookarium/blob/master/docs/DECISIONS.md) | 把状态筛选与默认目录排序写成显式决策 | 排序是书架的一等公民 |
| [Koodo Reader](https://github.com/koodo-reader/koodo-reader) | 分组 / 排序 / 阅读统计 / 库快照均在功能列表 | 排序 + 状态是跨平台阅读器的公约数 |

### 1.2 本项目的独有优势

- `progress.ratio` 是**真实阅读位置**，且 `renderResume` / `renderStats` 已存在阈值事实标准（`> 0.001 && < 0.999` 算在读）。状态可以完全派生，不需要任何新数据。
- `Book.addedAt` 字段已存在但从未用于排序——「最近添加」零后端改动。
- `remove_book` 只删 `state.json` 记录与检索索引，**不碰原文件**；`read_search_index` 对缺失索引返回 `None` 触发按需重建——撤销只需把 Book 快照塞回去。

**目标**：让左侧栏回答三个问题——「我在读什么 / 没读什么 / 读完了什么」（状态轴）、「按什么顺序看书架」（排序）、「删错了怎么办」（撤销）。

**成功判据**（可观测）：

| 指标 | 目标 |
| --- | --- |
| 状态筛选 | 展开状态组 + 点行 ≤ 2 次动作；选完自动收起，目录头自述结果 |
| 排序切换 | 打开菜单 + 点选项 ≤ 2 次动作；再点当前项翻转方向 |
| 撤销 | 删除后 6 秒内 1 次点击恢复，进度 / 收藏 / 分类 / 书签全部回来 |
| 旧数据兼容 | 旧 `state.json` 无 `sort` 字段可直接读取，默认「最近打开 ↓」 |
| 零破坏 | 类型 × 分类 × 搜索 × 拖拽归类 × 批量归类行为完全不变 |

## 2. 范围

### 2.1 本期做

1. **状态轴筛选**：目录第三组「状态」，四行（全部状态 / 在读 / 未读 / 读完），带计数与迷你图形，派生自 `progress.ratio`
2. **排序工具条**：书列表上方一条 28px 工具条，排序按钮 + 弹出菜单（最近打开 / 最近添加 / 书名 / 阅读进度），方向可翻转，**落盘到 settings**
3. **删除撤销**：移除文档后的 toast 带「撤销」动作按钮，6 秒窗口；新增 `restore_book` 命令

### 2.2 本期不做（明确取舍）

| 不做的能力 | 理由 |
| --- | --- |
| 手动标记读完 / 想读 | 派生状态永远诚实；手动标记会让「继续阅读」卡片与进度条撒谎（Apple Books 的困惑正来源于此）。参考手册类「翻过就算读完」的诉求留给将来的显式覆盖字段，本期不猜 |
| 保存筛选组合（虚拟图书馆 /  saved views） | Calibre 的 Virtual libraries 需要一套命名 / 管理 / 搜索语法，复杂度远超收益；三轴组合 + 清除筛选已够用 |
| 持久回收站 | Calibre 式磁盘回收站要管理暂存目录与过期清理；原文件本就不删，会话内 6 秒撤销已覆盖「删错了」的瞬间 |
| 三态点击循环（匹配 → 排除 → 全部） | Calibre Tag browser 的排除语义对单分类模型是过度设计；「全部状态」行已提供复位 |
| 状态筛选落盘 | 与 `state.filter` / `state.categoryId` 一致：筛选是瞬时的，重启回到全部。**排序相反，落盘**——排序是「我每次想怎么看书架」的偏好，筛选是「我现在找什么」的动作 |
| 批量删除 | 现有批量条只做归类；删除是破坏性动作，批量删除 + 撤销的快照管理复杂度高，单删 + 撤销先验证 |
| Shift 范围选择 | 与分类功能同一取舍：排序可变后范围语义不稳定 |

## 3. 数据模型

### 3.1 状态轴：零新数据

状态是纯派生值，阈值与 `renderResume` / `renderStats` 现有口径**逐字一致**：

```js
// src/js/status.js（纯函数，不碰 DOM）
function readingStatus(book) {
  const ratio = book?.progress?.ratio || 0;
  if (ratio >= 0.999) return "finished";
  if (ratio > 0.001) return "reading";
  return "unread";
}
```

`state.status`：`null` = 全部状态 / `"reading"` / `"unread"` / `"finished"`。不落盘。

### 3.2 排序：Settings 追加两个字段

```rust
// src-tauri/src/store.rs · Settings
/// 书架排序轴：recent | added | title | progress
pub sort: String,
/// 排序方向：true = 降序。书名轴自然方向为升序，切换轴时按自然方向重置
pub sort_desc: bool,
```

- `Settings` 已有容器级 `#[serde(default)]`，旧 `state.json` 缺这两个键时由 `Default` 补齐（`"recent"` / `true`），**不写迁移代码**，`version` 保持 `1`。
- 前端 `DEFAULT_SETTINGS` 同步追加 `sort: "recent", sortDesc: true`；`app.js` 的 `{ ...DEFAULT_SETTINGS, ...settings }` 合并已覆盖启动路径。
- 方向语义：`sortDesc` 是统一开关。切换到新轴时重置为该轴自然方向（时间 / 进度 = 降序，书名 = 升序）；点击当前轴翻转。

### 3.3 撤销：Book 快照往返

`remove_book` 返回前的 `state.books` 里就有完整 Book（含 progress / favorite / categoryId / bookmarks / highlights / encoding）。前端持有快照，撤销时原样传回：

```rust
#[tauri::command]
pub fn restore_book(state: State<'_, StoreState>, book: Book) -> Result<Vec<Book>, String>
```

- **幂等**：id 已存在（撤销双击、期间重新导入了同一文件）直接返回当前书架，不产生重复记录。
- 检索索引不随快照恢复：`read_search_index` 缺失返回 `None`，下次检索按需重建——这是现有机制，不是新约定。
- 不自动重新打开文档：撤销恢复的是「书架记录」，阅读位由用户自己点回去。

## 4. 技术方案

### 4.1 后端改动（最小）

| 文件 | 改动 |
| --- | --- |
| `store.rs` | `Settings` + `sort` / `sort_desc`，`Default` 同步 |
| `commands.rs` | 新增 `restore_book`（lock → 幂等 push → persist → 返回快照） |
| `lib.rs` | `generate_handler!` 追加 `restore_book` |

状态轴与排序比较器**完全在前端**：数据都在 `state.books` 里，没有理由往返 Rust。

### 4.2 前端模块划分

| 文件 | 新增/改动 | 职责 |
| --- | --- | --- |
| `src/js/status.js` | 新增 | 纯函数：`readingStatus`、`statusCount`、`STATUS_FILTERS` 定义 |
| `src/js/sort.js` | 新增 | 纯函数：`SORT_AXES`（key / 自然方向 / 标签）、`sortBooks(books, sort, desc)` 比较器 |
| `src/js/sort-ui.js` | 新增 | 工具条按钮文案 + 排序菜单渲染（DOM） |
| `src/js/category-ui.js` | 改动 | 追加 `renderStatusList`（与 `renderTypeList` 同层：目录渲染都在这） |
| `src/js/shelf.js` | 改动 | `scopeBooks` 加状态轴；`visibleBooks` 用 `sortBooks`；`filterSummary` / `emptyStateText` / `renderSectionHead` 接入新轴；工具条计数 |
| `src/js/core/session.js` | 改动 | `status: null`、`statusCollapsed: true` |
| `src/js/core/constants.js` | 改动 | `DEFAULT_SETTINGS` + sort / sortDesc |
| `src/js/core/feedback.js` | 改动 | `toast(message, opts?)`：`{ actionText, onAction, duration }`，默认行为逐字不变 |
| `src/js/actions.js` | 改动 | `removeBook` 挂撤销 toast；新增 `restoreBook(snapshot)` |
| `src/js/bind/shelf.js` | 改动 | `#statusList` 点击委托（选完自动收起，同类型组） |
| `src/js/bind/sort.js` | 新增 | 排序按钮 / 菜单事件：开合、选轴、翻向、Esc / 外点关闭、键盘 |
| `src/js/bind/category.js` | 改动 | `#statusToggle` 折叠；`#shelfIndex` 键盘委托已覆盖 `.idx-row`，无需改 |
| `src/js/bind/index.js` | 改动 | 挂入 `bindSortEvents()` |
| `src/index.html` | 改动 | 状态组骨架、工具条、排序菜单容器、`#i-sort` 图标 |
| `src/styles.css` | 改动 | 第三层吸顶头、状态图形、工具条、排序菜单、toast 动作按钮 |
| `src/js/i18n.js` | 改动 | 中英词条约 16 条 |

依赖方向不变：纯函数（status / sort / categories）← UI 渲染 ← bind；`actions.js` 唯一写入口。

### 4.3 目录布局：三层吸顶

组顺序：**类型（top:0）→ 状态（top:28px）→ 分类（top:56px）**。状态组放中间：阅读工作流（「我在读什么」）比组织工作流（分类）更高频，且状态组只有固定四行，展开代价小。

- 状态组默认收起，目录头自述「状态 · 在读」+ 该状态计数；选完自动收起（与类型组同交互）。
- 分类组仍默认展开。三组全展开时目录内部滚动，`min(344px, 42vh)` 上限不变。
- 状态行图形（12px 宽，全部取自契约 token）：
  - 在读：半满进度线（`--accent` 填充 50%，轨道 `--line-strong`）
  - 未读：空进度线（轨道 `--line-strong`）
  - 读完：`#i-check` 对勾（`--ok`）
  - 全部状态：无图形，名称弱化（同类型组「全部」）
- 状态行**不是拖拽落点**：状态是派生值，拖书上去没有可写的字段。落点仍只认 `.cat-row`。

### 4.4 四轴正交叠加

`scopeBooks()` 过滤链：类型 × 分类 × **状态** × 关键词（`visibleBooks`）。跨书检索（`library-search-ui.js`）用同一个 `scopeBooks`，范围自动一致。

- `filterSummary()` 追加状态部分：「在读 · 论文 · PDF」；
- `#headClear` 一次复位四轴；
- 空态文案沿用三分法：搜索无匹配 / 分类本身为空 / 组合筛空（状态轴加入后第三类提示不变）；
- `renderResume` / `renderStats` **保持全局口径**（与现有约定一致）。

### 4.5 排序工具条与菜单

位置：`shelf-index` 之下、`batch-bar` / `book-list` 之上，高 28px：

```
[ ⇅ 最近打开 ↓ ]                    12 份
```

- 左侧排序按钮：`#i-sort` 图标 + 当前轴标签 + 方向箭头；`aria-haspopup="menu"` / `aria-expanded`。
- 右侧当前可见数（`visibleBooks().length`），mono 字体——组合筛选时给出「筛剩多少」的即时反馈。
- 菜单为锚定弹出层（非模态），四行复用目录行视觉语言（28px / radius 6 / 悬停 surface-2）：当前轴带对勾 + 方向箭头；点其它轴 = 切换并按自然方向重置；点当前轴 = 翻转方向。菜单不关闭于翻转（方便连点调方向），切换轴后关闭。
- Esc / 外点 / 选中其它轴关闭；行 `role="menuitemradio"` + `tabindex`，Enter/Space 激活。
- 每次变更 `persistSettings()`（`save_settings` 整对象落盘，现有通道）。
- `#gridHead .section-sub` 无筛选时从固定「按最近打开排序」改为动态「按{轴标签}排序」。
- 排序比较器：时间轴数值差；书名 `localeCompare(zh, { numeric: true })`；进度 `ratio` 差。**同值兜底 `lastOpenedAt` 降序**，保证排序稳定、不随渲染抖动。

### 4.6 删除撤销

- `toast(message, opts)` 扩展：有 `actionText` 时在 toast 内渲染 `.toast-action` 按钮；点击执行 `onAction()` 并立即收起；`duration` 默认 2200ms 不变，撤销用 6000ms。连续 toast 复用同一元素时重建内容，旧动作随之失效（不会出现「新文案挂旧按钮」）。
- `removeBook` 流程不变（确认框 → `remove_book` → 关栏 → 渲染），末尾 toast 改为带撤销动作，快照即确认前找到的 `book` 对象。
- `restoreBook(snapshot)`：`invoke("restore_book", { book })` → `state.books = 返回` → `renderLibrary()` + `updateStatus()` → toast「已恢复《…》」。失败 toast 错误串并重拉书架（与 `assignCategory` 同一防御）。
- 撤销不恢复检索索引文件（按需重建）、不重开文档、不恢复选中态。

## 5. 边界与异常

| 场景 | 期望行为 |
| --- | --- |
| 旧 `state.json` 无 sort 字段 | 默认「最近打开 ↓」，书架顺序与升级前逐字一致 |
| 进度为 0 的新导入文档 | 状态 = 未读；「未读」计数含全部新书 |
| 进度 ≥ 0.999 | 状态 = 读完；与「继续阅读」卡片口径一致（卡片不再选它） |
| 状态筛选 + 类型 + 分类 + 搜索组合为空 | 「没有匹配的文档 / 试试清除筛选条件」，`#headClear` 可见 |
| 状态组收起时选了非默认状态 | 目录头自述「状态 · 在读」+ 计数，不展开也能看见当前轴 |
| 排序菜单打开时按 Esc | 只关菜单，不清选中态、不关其它弹层（`anyOverlayOpen` 口径） |
| 撤销窗口内重新导入同一文件 | `restore_book` 幂等：id 已存在，不产生重复记录 |
| 撤销双击 | 同上，第二次无副作用 |
| 撤销时原文件已被外部删除 | 记录照常恢复（书架本就允许存在文件已删的记录，打开时报现有错误）；不做存在性校验 |
| 撤销 toast 被新 toast 顶掉 | 动作随内容重建失效；删除确认框仍是第一道防线 |
| 写盘失败（restore / save_settings） | toast 错误串；restore 失败重拉书架；settings 失败静默（现有 `persistSettings` 行为） |
| 书名含数字 / 中英混排 | `localeCompare` numeric 选项：「第2章」排在「第10章」前 |
| 拖拽书到状态行 | 不接收落点（无 `.cat-row`），拖拽视觉与现有分类落点互不干扰 |

## 6. 验收标准

1. **编译与静态检查**：`cargo check` 通过；`npm run check` 无新增告警（含 i18n 中英词条对齐）。
2. **旧数据兼容**：构造无 `sort` / `sortDesc` 的 `state.json`，启动后排序为最近打开降序，顺序与旧版一致。
3. **状态轴**：三状态计数之和 = 书架总数；阈值与 `renderStats` 的「在读」数逐字一致；筛选后跨书检索范围同步。
4. **排序**：四轴 × 两方向共 8 种组合顺序正确且稳定；落盘后重启保持；书名轴中文拼音序 + 数字自然序。
5. **撤销**：删除 → 6 秒内撤销 → 进度 / 收藏 / 分类 / 书签 / 划线 / 编码全部恢复；幂等双击无重复；超窗后按钮消失。
6. **零回归**：`npm run smoke` 与 `npm run e2e`（28 项）全通过；拖拽归类 / 批量归类 / 键盘导航行为不变。
7. **视觉契约**：新组件全部使用契约 token；三主题（纸白 / 夜读 / 护眼）截图核对；304px 与 262px 宽度无横向溢出。
8. **i18n**：English 下状态组 / 排序菜单 / 撤销 toast 无中文残留。

## 7. 实施拆分

| 步骤 | 内容 | 产出 |
| --- | --- | --- |
| S1 | 调研 + 规划（本文档） | 本文定稿 |
| S2 | 可交互原型 | `prototype/shelf-tools/`（状态筛选 / 排序 / 撤销全链路可点） |
| S3 | 界面设计 | `docs/ui-shelf-tools.md`；`design-contract.md` 补组件行 |
| S4 | Rust：Settings 字段 + restore_book | `cargo check` 通过 |
| S5 | 前端纯函数 + 渲染 | 状态组 / 工具条可见，计数与排序正确 |
| S6 | 交互闭环 | 菜单 / 折叠 / 撤销 / 键盘 / 落盘 |
| S7 | 验证 + 文档回填 | probe 截图测量、smoke 扩展断言、product-spec / usage / README 同步 |

## 8. 验证记录（2026-11-20）

| 验收 | 结果 |
| --- | --- |
| 1 编译与静态 | `cargo check` exit 0；`npm run check` 绿（79 模块 / 454 词条中英对齐） |
| 2 旧数据兼容 | smoke 桩 SETTINGS 不带 `sort` / `sortDesc`，启动即最近打开降序、首行与旧版一致；真机 probe 同路径复核 |
| 3 状态轴 | 计数 10/5/3/2 之和 = 总数；阈值边界 .999 / .001 / .0011 三例判定正确；筛选后检索范围同步（smoke statusPick） |
| 4 排序 | 四轴 × 两方向顺序断言全过；中文拼音序实测「加密样本」升序首、`text.rs` 降序首（zh collation 汉字先于拉丁）；落盘经 200ms 防抖后读桩核对 |
| 5 撤销 | 删除 → 撤销 → favorite / categoryId / progress 经 IPC clone 边界原样回来；幂等重发不重复；6000ms 寿命条 |
| 6 零回归 | smoke 197/197（181 旧 + 16 新）、e2e 28/28 |
| 7 视觉契约 | 真机 probe（src + Tauri 桩 + headless Chrome）12/12：三主题截图、262px 窄面板无溢出、菜单不越面板；三层吸顶实测 top 1 / 29 / 57（含 1px 边框） |
| 8 i18n | smoke enShelf：状态四行 / 菜单四轴 / 撤销按钮全英文，无中文残留 |

真机 probe 截图存于会话临时目录（默认 / 状态展开 / 在读筛选 / 排序菜单 / 确认框 / 撤销 toast / 夜读 / 护眼 / 窄面板），逐张目视核对：状态图形（半线 / 空线 / 对勾）、菜单对勾与自然方向、墨色 pill 撤销条与寿命线在三主题下均符合 `docs/ui-shelf-tools.md`。