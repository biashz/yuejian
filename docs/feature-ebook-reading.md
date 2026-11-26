# 功能规划 — 电子书阅读体验重做（双模式 · 翻页动效 · 朗读 · 自动滚动 · 选区动作 · 进度刻度）

> 状态：S1–S7 完成，已实现并通过验证（见 §9）
> 前置文档：`docs/ebook-layout-plan.md`（版式面板）、`docs/ebook-formats-plan.md`（格式链路）、`docs/design-contract.md`
> 引擎事实均以本仓库 vendored foliate（`src/vendor/foliate/`）源码为准，不照搬竞品实现。

## 1. 背景与调研

版式面板解决了「正文长什么样」，但「怎么读」这一层仍只有一种姿势：横向分页 +  instant 翻页。
选中文字只有五色划线，没有复制与笔记；没有朗读；没有免手操作；进度条是一根光杆。
对照成熟阅读器，缺的不是排版参数，而是**阅读姿势与阅读辅助**。

### 1.1 调研证据

| 来源 | 观察 | 对本项目的启示 |
| --- | --- | --- |
| [Readest · Reading](https://readest.com/docs/reading) | 双布局：Paginated / Scrolled，`Shift+J` 切换；Scrolled 适合移动与匀速阅读；进度条可开「每章边界一个刻度」，拖滑杆时旁边预览落点页 | 双模式是姿势问题不是排版问题；刻度与预览让长书跳转敢下手 |
| [Readest · Advanced](https://readest.com/docs/advanced) | `Shift+A` Auto Scroll = 免手提词器，浮动控件调速度；TTS：`T` 开关、播放中 `Space` 暂停、`Ctrl+]`/`Ctrl+[` 跳句、`Shift+M` 高亮正在读的句子 | 自动滚动与朗读是两条独立的辅助轨；朗读要有句级同步与跳句，不能整章糊读 |
| [Readest · Reading（选区与动效）](https://readest.com/docs/reading) | 选区条：Copy / Highlight / Annotate(划线+笔记) / Translate / Dictionary / Read aloud；翻页动效 Push / Slide / Page Curl / Page Flip 可选 | 选区条缺复制与笔记是最疼的两格；动效可选但别做翻页仿真（成本与收益不成比例） |
| [Readest GitHub](https://github.com/readest/readest) | Scroll/Page 双模、全书搜索、TTS、划线笔记列为核心功能清单 | 双模 + 朗读 + 笔记是「现代阅读器」的及格线 |
| [Readest #1745](https://github.com/readest/readest/issues/1745) | 旧 foliate.js 只有 fixed-layout 与 paginator，无原生连续滚动 | **核对本地 vendored 源码后推翻该前提**：本仓库 paginator 已带 `flow="scrolled"`（见 §2），滚动模式不需要自研渲染器 |
| [NN/g · Infinite Scrolling](https://www.nngroup.com/articles/infinite-scrolling-tips/) | 连续滚动降低交互成本但必须保留「回到原处」与位置感 | 滚动模式的位置仍记 CFI；切回分页要落在同一段文字 |
| [MDN · Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API/Using_the_Web_Speech_API) / [Readium · Speech](https://readium.org/speech/docs/WebSpeech.html) | `speechSynthesis` 可用系统本地嗓音；部分平台嗓音需联网、质量参差 | 朗读只承诺「系统有什么嗓音就用什么」，无嗓音时明确降级而不是假播放 |
| [LogRocket · Pagination vs infinite scroll](https://blog.logrocket.com/ux-design/pagination-vs-infinite-scroll-ux/) | 分页给「读完一页」的完成感，滚动给连续感；两者应共存而非互替 | 模式是用户偏好，持久化；不劝退任何一种 |

### 1.2 引擎事实（vendored foliate 源码核对）

| 事实 | 出处 | 用途 |
| --- | --- | --- |
| `flow` 是 observed attribute，改它即 `render()`；`flow="scrolled"` 时纵向单栏连续滚动 | `paginator.js` observedAttributes / `scrolled()` | 滚动模式 = 一个属性，不造渲染器 |
| 滚动模式下 `next()` 到节末自动接下一节（`#turnPage` 的 `shouldGo`），`prev()` 对称 | `paginator.js` `#scrollNext/#scrollPrev/#turnPage` | 章间连接只需在滚到边时调 `next()/prev()` |
| `animated` 属性存在时，`snap`/smooth 位移走 300ms easeOutQuad 动画 | `paginator.js` `#scrollTo` | 「滑动」翻页动效 = 挂/摘这个属性 |
| `relocate` 明细带 `range`（当前可见 Range）；paginator 层 fraction 是节内比例，view 层经 `SectionProgress` 折成全书比例 | `paginator.js` `#afterScroll`、`view.js` | 朗读句可见性判定用 `range`；进度条全书口径不变 |
| `sections[i].size` 存在（`getSize`），`SectionProgress(sections, 1500, 1600)` 用累计尺寸折比例 | `epub.js` sections、`view.js` open | 章节刻度与拖拽预览用同一套累计算法，与 `goToFraction` 口径一致 |
| 每节有 overlayer（`create-overlayer`），划线已用它画矩形 | `view.js`、`ebook-annotations.js` | 朗读句高亮复用 overlayer，临时标记不入书架 |

## 2. 范围

### 做（六簇）

| 簇 | 内容 | 持久化 |
| --- | --- | --- |
| A 双模式 | 分页 ↔ 连续滚动；工具条按钮 + `Shift+J`；版式面板「阅读」组同步 | `ebookFlow` |
| B 翻页动效 | 滑动 / 淡入 / 无 三档；`prefers-reduced-motion` 强制无 | `ebookTurn` |
| C 朗读 | 系统嗓读音句级朗读：播放/暂停/停止/跳句/语速/嗓音/当前句字幕与句高亮；自动翻页跟随 | `ebookTtsRate` `ebookTtsVoice` |
| D 自动滚动 | 滚动模式匀速滚 / 分页模式定时翻；辅助条调速度、暂停、停止；与朗读互斥 | `ebookAutoSpeed` |
| E 选区动作 | 选区条加「复制」「笔记」；笔记挂在划线上（`note` 字段），侧栏可看可改，导出带笔记 | 随书 `highlights[].note` |
| F 进度刻度 | 进度条章边界刻度 + 拖拽时预览落点章名 | 无（派生） |

### 不做

| 不做 | 理由 |
| --- | --- |
| 竖排 / 速读 RSVP / 词典翻译 / 云同步 / 手绘 / 摘录卡片 / 阅读统计 | 前者引擎横向假设；后六者各自是一整个项目，本轮不摊薄 |
| 固定版面（CBZ/FXL）的滚动模式 | 书页尺寸出版方定；滚动条模式对整页图无意义，按钮禁用并说明 |
| 翻页仿真（Page Curl / Flip） | 需要自绘页面纹理与 3D 变换，与分页器抢渲染；三档动效已覆盖「要动 / 要轻 / 要静」 |
| 朗读的云嗓音 / AI 嗓音 | 本地优先：只列 `localService` 嗓音；无本地嗓音时降级提示 |
| 笔记独立于划线存在 | 笔记是划线的附注（Readest 同模型）；无划线先自动补一条默认色划线，避免出现两种锚点 |
| 按书记忆模式/动效 | 与版式一致先做全局；数据结构不预留假口子 |

## 3. 数据模型

`settings` 平铺追加 5 字段（Rust `Settings` 强类型 + 容器级 `serde(default)`，旧文件零迁移）：

| 字段 | 类型 | 默认 | 范围 |
| --- | --- | --- | --- |
| `ebookFlow` | string | `paged` | paged / scroll |
| `ebookTurn` | string | `slide` | slide / fade / none |
| `ebookTtsRate` | number | 1 | 0.5–2 步 0.25 |
| `ebookTtsVoice` | string | `""` | 系统嗓音 name；空 = 按界面语言挑 |
| `ebookAutoSpeed` | int | 5 | 1–10 |

`Highlight` 追加 `#[serde(default)] pub note: String`（旧数据读入为空串 = 无笔记）。
会话级不持久化：朗读/自动滚动的运行态、当前句下标、暂停态、进度预览气泡。

## 4. 各簇语义

### A 双模式
- 切换 = `renderer.setAttribute("flow", …)` + 重排；**位置不丢**：切换前记 `location.cfi`，切换后 `goTo(cfi)`（CFI 与排版无关）。
- 滚动模式：滚轮/触控/拖动原生滚动（手势层不再 `preventDefault`）；点半屏不翻页；`↑↓/Space/PgUp/PgDn` 原生滚；`←→` 跳章（与 `Ctrl+←→` 同义）。
- 章间连接：听 renderer 的 `scroll` 事件，滚到节末（`viewSize - end <= 2` 的等价判定用容器 scrollTop/scrollHeight）调 `next()`，节首向上同理 `prev()`；冷却 400ms 防惯性连跳。
- 双页按钮在滚动模式隐藏（单栏是滚动的定义）；版式面板「双页」开关禁用并说明。
- 固定版面：模式按钮禁用，title 说明「固定版面保持翻页」。

### B 翻页动效
- slide = 挂 `animated`（引擎 300ms easeOutQuad）；none = 摘掉；fade = 摘掉 + 宿主在 `relocate(reason=page)` 时做一次 260ms 淡入（契约 motion 档）。
- 淡入只动画 opacity，不位移——位移会和分页器的列偏移打架。
- `prefers-reduced-motion: reduce` 时三档一律表现为 none（设置值照存）。
- 滚动模式不受动效档影响（原生滚动自带惯性）。

### C 朗读
- 句源：当前节 live doc 的文本节点 walk，按 `。！？.!?…` + 换行切句，过滤空白与纯标点；每句记 Range 与 CFI（复用 `selectionCfi` 的 epubcfi 路径）。
- 播放循环：句 i 可见（与 `reader.visibleRange` 有交集）则直接读；不可见先 `goTo(cfi)` 再读；读完进下一句；节末自动 `next()` 重建句表续读；书末停止并提示。
- 句高亮：overlayer 临时矩形（accent-weak 底），读下一句即移除；不入书架、不参与导出。
- 控件条（阅读区底部居中浮条）：播放/暂停、停止、上一句/下一句、语速 select、嗓音 select、当前句字幕（单行省略）。
- `Space` 在朗读运行态 = 播放/暂停（不翻页）；`Ctrl+]`/`Ctrl+[` 跳句；`Shift+L` 开停朗读。
- 手动翻页/跳章/拖进度条 = 停止朗读（用户夺回方向盘）；朗读自己的 `goTo` 不算手动（内部标志位）。
- 无本地嗓音：条仍开，播放禁用 + 一行说明「系统没有可用的本地嗓音」；不假播放。
- 固定版面：按钮隐藏（无字符流）。

### D 自动滚动
- 滚动模式：rAF 驱动 `scrollTop += speed*16 px/s`（帧间隔折算，掉帧不跳变）；用户 wheel/pointerdown 暂停（条上「继续」恢复）；到节末接章同 A。
- 分页模式：每 `16 - speed*1.2` 秒 `next()`（speed 5 → 10s）；到书末停止并提示。
- 辅助条：速度滑杆 1–10 + 暂停/继续 + 停止；与朗读互斥（开一个停另一个）。
- `Shift+A` 开停；运行态不持久化，速度持久化。

### E 选区动作
- 选区条第二行：复制 / 笔记 / （点已有划线时）删除。第一行五色不变。
- 复制：`navigator.clipboard.writeText`，失败回退 execCommand；toast「已复制」。
- 笔记：小 popover（textarea + 保存/取消，最多 500 字）；新选区先落一条默认色（amber）划线再挂笔记；已有划线直接编辑其 note。
- 侧栏划线页：有 note 的条目在引文下多一行笔记摘要（ink-2），点条目跳转不变，条目上「编辑笔记」入口重开 popover。
- 导出 Markdown：引文块下加粗笔记行（`**笔记：** …`），与现有颜色名行并列；无笔记不变。

### F 进度刻度
- 刻度位置：`await sections[i].size` 累计 / 总尺寸（与 `SectionProgress` 同口径，缺失尺寸按 1500/1600 兜底同库）；TOC 项经 `resolveHref` 落到节下标取累计比例；最多 40 个刻度，过密抽稀。
- 刻度画在滑杆轨道上（2px 竖线，line-strong）；拖拽时轨道上方气泡显示落点章名（最后一个 fraction ≤ 目标 的 TOC 项）；松手才跳（现有 change 语义不变）。
- 固定版面：按节数均布刻度（与 `goToFraction` 的取整口径一致）。

## 5. 模块表

| 文件 | 职责 | 预算 |
| --- | --- | --- |
| `reader/ebook-mode.js` 🆕 | applyFlow / applyTurn / 滚动章间连接 / fade 脉冲 / isScroll | ≤ 130 行 |
| `reader/ebook-tts.js` 🆕 | 句表、可见性、播放循环、跳句、嗓音语速、句高亮、字幕回调 | ≤ 210 行 |
| `reader/ebook-assist.js` 🆕 | 辅助条 DOM（朗读态/自动态）、自动滚动 rAF/定时、互斥、自绑定 | ≤ 240 行 |
| `reader/ebook-seek.js` 🆕 | 刻度计算与渲染、拖拽预览气泡 | ≤ 120 行 |
| `reader-epub.js` | 记 `visibleRange`；open 后按设置挂 flow/turn；setSpread 滚动守卫 | +30 行 |
| `reader/ebook-gesture.js` | 模式感知：滚动模式不拦 wheel/click/纵向键 | +25 行 |
| `reader/ebook-open.js` | 手势传模式；设置变更时刷新 flow/turn；切换模式保位置 | +40 行 |
| `reader/toolbar-ebook.js` | 模式/朗读/自动三按钮；滚动隐藏双页；刻度容器 | +30 行 |
| `reader/highlight-menu.js` | 动作行 + 笔记 popover | +70 行 |
| `reader/highlight-actions.js` / `highlight.js` | 复制/笔记回调；note 字段与 setNote | +60 行 |
| `reader/ctx-marks.js` / `marks-export.js` | 笔记摘要行 / 导出笔记行 | +30 行 |
| `reader/ebook-layout-panel.js` | 「阅读」组：模式 + 动效分段 | +40 行 |
| `bind/keys.js` | Shift+J / Shift+A / Shift+L / Space 朗读态 / Ctrl+[ ] / Esc 停辅助 | +35 行 |
| `store.rs` / `constants.js` / `i18n.js` / `index.html` / `styles.css` | 5 设置字段 + note；图标 #i-scroll #i-speech #i-auto；词条；样式 | 常规 |

## 6. 边界与降级

| 场景 | 行为 |
| --- | --- |
| 固定版面（CBZ/FXL） | 模式/朗读按钮禁用或隐藏；自动滚动保留（整页图定时翻有意义）；刻度按节均布 |
| 双栏两本书 | 辅助条只服务活动栏；切活动栏即停辅助（方向盘归属变了） |
| 无本地嗓音 | 朗读条开、播放禁用 + 说明；自动滚动不受影响 |
| 朗读中换书/关书 | destroy 链路 stop()，cancel 所有 utterance，移除句高亮 |
| 滚动模式切回分页 | goTo(切换前 cfi)；双页偏好恢复生效 |
| 笔记超 500 字 | 保存按钮禁用 + 计数提示（前端校验，Rust 不另设限——note 是字符串字段） |
| 复制权限被拒 | 回退 execCommand；再失败 toast 错误串 |
| reduce-motion | 动效三档表现均为 none；自动滚动保留（它是功能不是装饰） |

## 7. 验收标准

1. `cargo check`、`npm run check`（i18n 中英对齐）绿。
2. 旧 `state.json`（无 5 新字段、highlights 无 note）启动行为与旧版逐字一致。
3. 模式切换前后 CFI 不变（同一段文字）；滚动模式滚轮原生、点半屏不翻、节末接章。
4. 动效三档：slide 有引擎动画、fade 有宿主淡入、none 两者皆无；reduce-motion 全 none。
5. 朗读：句表非空、跳句/暂停/恢复/停止状态机正确；不可见句先 goTo；节末续读；无嗓音降级；手动导航停止。
6. 自动滚动：速度改即生效；用户输入暂停；与朗读互斥；书末停止。
7. 选区：复制落 clipboard；笔记保存后侧栏/导出可见；旧划线无 note 不报错。
8. 刻度：数量 ≤ 40、位置与 goToFraction 口径一致；拖拽预览章名正确；松手才跳。
9. 零回归：smoke 226、e2e 28 全过；三主题截图核对新组件（实测记录见 §9）。
10. i18n：English 下辅助条/选区条/面板新组无中文残留。

## 8. 实施拆分

| 步骤 | 内容 |
| --- | --- |
| S1 | 调研 + 规划（本文） |
| S2 | 可交互原型 `prototype/ebook-reading/` + 探针 |
| S3 | 界面设计 `docs/ui-ebook-reading.md` + 契约补行 |
| S4 | 数据层（store.rs / constants / i18n）+ ebook-mode + 手势适配 |
| S5 | 朗读 + 辅助条 + 自动滚动 |
| S6 | 选区动作 + 笔记链路 + 进度刻度 |
| S7 | 验证（smoke 扩展 / 真机探针）+ 文档回填 |

## 9. 验证记录（实测）

### 9.1 门禁

| 门禁 | 结果 |
| --- | --- |
| `npm run check` | 83 个模块 0 问题；i18n 493 键中英对齐 |
| `npm run smoke` | 226/226（真无头 Chrome + CDP；含本轮新增的朗读/自动/选区/刻度/ Esc 优先级/气泡-辅助条不相交/句高亮半透明等断言） |
| `npm run e2e` | 28/28（release 程序 + 真实 WebView2） |
| `cargo check` | 通过 |

### 9.2 三主题视觉核对

方法：smoke 内置 `SMOKE_SHOT` 门控的留档 pass——纸白 / 夜读 / 护眼各拍三张（朗读条 + 句高亮、进度悬停气泡、版式面板），共 9 张 PNG，逐张人眼核对。平时 `npm run smoke` 不带该环境变量，零开销、不影响 226 断言。

核对结论：三套主题下辅助条底色/字色/控件均取自主题变量、可读；句高亮填充随 `--accent-weak` 变色（纸白淡朱 / 夜读暖褐 / 护眼弱陶）；预览气泡「章名 · 百分比」在三主题下均完整露出；版式面板「阅读」组（模式 / 翻页动效分段）与其余组在三主题下选中态对比清晰。

### 9.3 核对中发现并修复的两处缺陷

| 缺陷 | 机制 | 修复 | 回归锁 |
| --- | --- | --- | --- |
| 句高亮实心盖字 | `ebook-tts.js` 把 overlayer group 的 opacity 覆写成 `1`（不透明），盖住正在读的那句；契约要求「比划线更淡一档」 | opacity 改 `0.3`（划线笔迹为 0.42），字透出 | smoke 断言句高亮 `0 < opacity < 0.42` |
| 预览气泡被辅助条拦腰截断 | 气泡 z6 处在工具栏堆叠上下文内，辅助条 z30 在其上；辅助条 bottom 70 与气泡带（轨道上 26px）竖直相交约 13px | 辅助条 bottom 70 → 92，与气泡留出约 9px 间隙；书口带改版（带高 46、气泡 32）后重算为 48 | smoke 断言朗读运行时悬停进度，辅助条底 ≤ 气泡顶、矩形不相交 |

两处均为「截图观察到 → 源码/几何证实机制 → 修根因 → 加断言锁住」，未以放宽容差或遮罩掩盖。

### 9.4 文档回填

- `docs/usage.md`：§10.1 补刻度与预览气泡；新增 §10.10 双模式与动效、§10.11 朗读与自动滚动、§10.12 复制与笔记；§10.4 交叉引用；§14 快捷键补 `Shift+J/L/A`、`Space`、`Ctrl+[ ]`、`Esc` 停辅助。
- `README.md`：电子书条目更正版式面板入口；新增「阅读姿势与辅助」条目；摘录导出补笔记行。
- `docs/product-spec.md`：功能地图补电子书阅读行；新增 §4.12；定位句纳入电子书。
- `docs/design-contract.md` / `docs/ui-ebook-reading.md`：辅助条 bottom 48（书口带改版后）、句高亮 opacity 0.3 两处契约更新；另补工具带「书口」与「桌面 + 书页」四行。

## 10. 追加：正文字体（系统栈 + 按需下载）

> 目录与官方源见 `docs/ebook-fonts.md`；界面规格见 `docs/ui-ebook-reading.md` §2 / `docs/design-contract.md` §3。

### 做

| 项 | 内容 | 持久化 |
| --- | --- | --- |
| 系统字体 | 宋体 / 黑体 / 楷体三档，各带完整回退栈，离线永远可用 | `ebookFamily` |
| 开源字体 | 霞鹜文楷 GB、思源宋体、思源黑体、Literata、EB Garamond（均 OFL 1.1）；**安装包不带**，点选时从官方源下载到安装目录 `data/fonts/` | `ebookFamily` |
| 下载交互 | 未装写「下载」；点了转百分比（`font-progress` 事件）；成功自动选中并 toast；失败转「重试」+ 原因 toast；已装行状态「✓」，样例字用真字体渲染 | 无（运行态） |
| 移除 | 行 hover 浮现删除键；删文件；正在用就退回系统宋体，不留空指向 | `ebookFamily` 回落 `serif` |

### 不做

| 不做 | 理由 |
| --- | --- |
| 字体进安装包 | 5 款合计约 70 MB；多数用户只用系统字，按需下载对包体和首次启动都更划算 |
| 应用内字体管理器（导入任意 TTF / 预览卸载） | 本轮只服务「选一款正文气质」；任意文件导入需要命名、去重与许可提示，是另一个功能 |
| zip / 压缩包字体源 | 下载链路不做解压；霞鹜文楷取 Release 里的单文件 Regular |

### 数据与安全

- 落盘：`data/fonts/<本地文件名>`（与书架、设置同根，随安装目录走）。
- 三道闸：https + 官方域名白名单；文件名收敛在 `data/fonts/` 内（拒绝路径、非 `.ttf/.otf`、点开头、超长）；文件头必须是 TrueType/OpenType。
- 注入：`@font-face` family 统一 `"YJ <id>"` 前缀避免与书内同名定义相撞；`src` 走 asset 协议，CSP `font-src` 已放行。

### 模块

| 文件 | 职责 |
| --- | --- |
| `reader/fonts.js` 🆕 | 目录（系统 3 + 下载 5）、磁盘登记、字体栈、`@font-face` 生成、下载/移除、进度订阅 |
| `reader/ebook-layout-panel.js` | 字体列表行、下载状态机、选中/移除、样例字 |
| `reader/ebook-style.js` | `@font-face` 段置于注入样式最前、family 折成字体栈 |
| `reader/ebook-layout.js` | `ebookFamily` 校验进版式对象 |
| `commands.rs` / `lib.rs` | `list_fonts` / `download_font` / `remove_font` 与三条校验的单测 |

### 验证

- `cargo test`：23 项（含字体三项：域名白名单 / 路径收敛 / 文件头）。
- `npm run smoke`：234 项；字体段断言列表 8 行、下载（带进度）后自动选中并落盘、`@font-face` 进章节样式、移除退回宋体；另有一条「文档尚无 body 时滚动不抛异常」的竞态回归。
- `npm run e2e`：33 项；真机预置 TTF → `list_fonts` 认领 → 选中落盘 → WebView2 里 `document.fonts.load` 成功 → 移除后磁盘文件消失。
- 顺带修掉一条真竞态：换章空档里分页器 `render()` 会在文档还没有 `body` 时走到 `createTreeWalker(doc.body)`，抛未捕获拒绝；守卫放在 `#getVisibleRange` / `#afterScroll`，并用「把章节 iframe 换成 SVG 文档」的冒烟断言锁住（删守卫即 FAIL）。朗读的句表构建同样加了 body 守卫。
