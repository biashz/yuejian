# 开发任务规划 — 阅笺 YueJian Reader

> 依据 [product-spec.md](product-spec.md) 与 [design-contract.md](design-contract.md)，把原型落地为可运行的 Tauri 2 桌面应用。

## 1. 架构

```
前端 src/（原生 ES Module，零构建，按职责分模块）
├ app.js            入口：读取数据、应用设置、绑定事件
├ core/             dom 工具 / session 共享状态 / constants / format / feedback
├ reader/           panes 双栏 / open 打开文档 / toolbar / ctx 侧栏 / present 演示 / progress
├ shelf.js          书架：列表、网格、继续阅读、统计、分类/类型/关键词三重筛选
├ categories.js     分类纯计算：排序、计数、下一个配色、筛选判定（不碰 DOM）
├ category-ui.js    分类区与批量条渲染 + 分类编辑弹层状态机
├ view.js           视图切换、状态栏、窗口标题、语言切换
├ actions.js        导入 / 移出 / 收藏 / 分类增删改 / 批量归类
├ palette.js        命令面板
├ preferences.js    主题与排版、设置面板、设置持久化
├ update-ui.js      更新状态机与设置页更新卡片
├ bind/             事件绑定：index 聚合 + shelf / reader / panels / keys / category
├ reader-pdf.js     pdf.js 封装：渲染、缩放、搜索
├ reader-md.js      Markdown HTML 注入、目录高亮
├ api.js            Tauri invoke 封装（唯一后端出入口）
└ i18n.js           中英文案与语言切换
                    │ invoke / asset 协议 / 原生拖拽事件
src-tauri/（Rust）
├ main.rs / lib.rs  窗口与命令注册
├ store.rs          书架 + 分类 + 设置持久化（程序目录内 data/state.json）
├ markdown.rs       comrak 解析 → HTML + 标题目录
└ commands.rs       导入、打开、收藏、进度、分类、设置、更新、PDF 字节兜底读取
```

依赖（全部开源）：
`tauri 2` / `comrak`（Markdown）/ `rfd`（系统文件对话框）/ `serde` + `serde_json`（持久化）
前端：`pdfjs-dist`（PDF 渲染）/ `highlight.js`（代码高亮，ESM 按需注册）。

## 2. 目录结构

```
yuejian/
├─ docs/                 产品规划、设计契约、开发任务
├─ prototype/            高保真交互原型（纯静态，可直接双击打开）
├─ src/                  前端（Tauri frontendDist）
│  ├─ index.html
│  ├─ styles.css
│  ├─ js/                前端脚本（按职责分模块，入口是 app.js）
│  │  ├─ core/           dom / session / constants / format / feedback
│  │  ├─ reader/         panes / open / toolbar / ctx / present / progress
│  │  ├─ shelf.js        书架渲染
│  │  ├─ categories.js   分类纯计算
│  │  ├─ category-ui.js  分类区 / 批量条 / 编辑弹层
│  │  ├─ view.js         视图切换、状态栏、语言切换
│  │  ├─ actions.js      导入 / 移出 / 收藏 / 分类
│  │  ├─ palette.js      命令面板
│  │  ├─ preferences.js  主题与排版、设置面板
│  │  ├─ update-ui.js    更新状态机与更新卡片
│  │  ├─ bind/           事件绑定（index 聚合 + 五个事件域）
│  │  ├─ api.js / i18n.js / update.js
│  │  └─ reader-pdf.js / reader-md.js
│  └─ vendor/{pdfjs,highlight}/   离线第三方资源
├─ src-tauri/
│  ├─ Cargo.toml
│  ├─ tauri.conf.json
│  ├─ capabilities/default.json
│  ├─ icons/
│  └─ src/{main,lib,store,markdown,commands}.rs
├─ scripts/vendor-assets.mjs      把 npm 依赖拷进 src/vendor
└─ package.json
```

## 3. 任务分解

| ID | 任务 | 依赖 | 验收标准 |
| --- | --- | --- | --- |
| T1 | 工程骨架：package.json、tauri.conf、capabilities、图标 | — | `npm run dev` 能启动空窗口 |
| T2 | 持久化层 `store.rs`：state.json 读写、Book/Settings 结构 | T1 | 重启后书架与设置不丢失 |
| T3 | Markdown 解析 `markdown.rs`：GFM、标题 id、TOC 抽取、标题回填 | T1 | 输入 .md，返回 HTML + 目录数组 |
| T4 | 命令层 `commands.rs`：导入、打开、收藏、进度、设置、PDF 兜底字节 | T2,T3 | 前端 invoke 全部返回预期结构 |
| T5 | 书架界面：列表、网格、继续阅读、筛选、空状态、拖拽导入 | T1 | 导入后立即出现在书架，可删除 |
| T6 | PDF 阅读：pdf.js 渲染、懒加载、缩放、页码、目录、搜索 | T4 | 打开真实 PDF 可翻页、缩放、选字 |
| T7 | Markdown 阅读：HTML 注入、代码高亮、图片相对路径、目录滚动高亮 | T4 | 打开真实 .md 排版正确、目录可跳转 |
| T8 | 阅读设置：主题、字号、行高、版心、专注模式、持久化 | T5 | 重启后保持；三主题全部可读 |
| T9 | 命令面板与快捷键、状态栏、Toast、窗口按钮 | T5 | Ctrl+K 可用，↑↓/Enter 生效 |
| T10 | 构建验证：`cargo check`、`npm run build`（--no-bundle） | T5-T9 | 生成可执行文件并冒烟启动 |
| T11 | 前端模块拆分：把单体 app.js 按职责拆为 core / reader / 领域模块 | T5-T10 | 业务代码零改动；模块图可链接且 `boot()` 无异常 |
| T12 | 文档分类：Rust `Category` 模型与 5 个命令、分类区 UI、拖拽 / 批量归类、配色 | T4,T5,T11 | 创建→归类→筛选→批量→改名改色→删除全链路可走通；旧 `state.json` 免迁移；见 [feature-categories.md](feature-categories.md) |

## 4. 关键实现决策

1. **PDF 文件访问**：优先 `convertFileSrc` + asset 协议（支持 Range 请求）；若加载失败，回退到 `read_pdf_bytes` 命令按字节传给 pdf.js。
2. **Markdown 安全**：comrak 保持 `unsafe_ = false`，原始 HTML 转义，避免本地文档注入脚本。
3. **图片相对路径**：Rust 返回文档所在目录，前端用 `convertFileSrc(dir + "/" + src)` 重写 `img.src`。
4. **进度保存**：滚动节流 300ms，写回 Rust（整库 JSON 写入，条目级更新）。
5. **无打包器**：前端保持原生 ES Module，`vendor/` 放 pdf.js 与 highlight.js，保证离线可运行、启动快。
6. **窗口**：`decorations: false` + `data-tauri-drag-region`，用 Tauri window API 实现最小化/最大化/关闭。
7. **前端模块边界**：`core/` 只放不依赖业务的工具与共享状态；双栏可变状态（`splitMode` / `linkSync` / `activePaneIndex`）只允许 `reader/panes.js` 写入，其余模块以 ESM live binding 只读引用，避免跨模块赋值。跨模块调用一律走 import，不使用全局对象或事件总线。
8. **分类的三层分工**：`categories.js` 只做纯计算（排序/计数/筛选判定），`category-ui.js` 只把 state 画成 DOM 并收集输入，`actions.js` 是唯一写入口（调用命令 + 刷新书架）。弹层只返回 `{action, name, color}`，不自己发请求，避免 UI 模块直接持有后端调用。
9. **选中态不重绘**：`Ctrl+点击` 只切 class 并刷新批量条，不重建列表。整表 `innerHTML` 重建会把滚动位置打回顶部，长书架下体验很差。
10. **分类删改的引用完整性**：`delete_category` 在**同一把锁**内删除分类并把其下文档 `categoryId` 清空，否则会留下指向已删分类的悬挂引用；前端额外用 `pruneSelection()` 丢弃指向已移除文档的选中项。
11. **「漏 import」用脚本兜住**：模块拆分后函数被调用却没 import，链接期不报错（标识符当全局查），只有执行到那一行才抛 `XXX is not defined`。项目无打包器也无 linter，因此用 `npm run check`（`scripts/check-undefined.mjs`）兜底：挖空注释与字符串后，比对「调用式标识符」与「本文件已声明的名字」，未声明即报错并以退出码 1 拦截。该脚本上线后一次性扫出 3 处真实遗漏（`updateToolbarPage` / `scrollPaneToRatio` / `renderToolbar`），均已修复。静态检查管不到的运行时问题由 `npm run smoke`（`scripts/smoke-reader.mjs`）负责：真 Chrome + 注入 `__TAURI__` 桩跑完整阅读流程，PDF 现场生成、任何未捕获异常即失败。
12. **更新下载复用 curl，但代理必须自己补**：`download_update` 交给系统自带 `curl`，不引入 HTTP 依赖。坑在于 curl **只认 `HTTPS_PROXY` 类环境变量，不读 Windows 系统代理**，而 WebView2 里的 `fetch` 会读——于是「检查更新能查到、点下载一直 0 字节」，浏览器却打得开下载页。现在读一次注册表 `Internet Settings` 补上 `--proxy`（环境变量已设则不插手），并用 `--connect-timeout 20`、`--speed-limit 1024 --speed-time 40` 把无限等待变成明确失败；失败时把 curl 退出码与 stderr 翻译成可处置的提示。前端另有看门狗：12 秒无字节提示「正在连接」、45 秒无新字节提示「下载没有响应」并放出发布页入口。
    **子进程一律 `quiet()`**：应用是 GUI 子系统（`windows_subsystem = "windows"`），自己没有控制台，此时启动 `curl.exe` / `reg.exe` / `cmd.exe` 这类控制台程序，Windows 会为它新建一个控制台窗口——curl 一跑几十秒，那个黑框就整个下载期间挂在桌面上。统一走 `commands::quiet()`（`CREATE_NO_WINDOW`）后再 `spawn`，输出仍可经管道读，桌面干净。
13. **升级链路必须「先关闭 → 再静默卸载 → 最后安装」**：`nsis/installer.nsi` 里 `YueJianUninstallPrevious` 的时序错一步，结果都是「升级装不上」，而且失败时旧版本原封不动，看起来就像「自动卸载功能没了」。三条硬约束：①`CheckIfAppIsRunning`（Restart Manager）必须在卸载**之前**执行，否则旧卸载程序删不掉被占用的 `yuejian.exe`，随后「主程序仍存在」的检查会把整个安装 `Abort` 掉；②旧卸载程序必须 `/S _?=$dir` **静默**执行。曾经为了「让用户决定是否删数据」改成带界面运行，等于在升级途中弹出第二个「确认卸载」向导，用户一取消（退出码 1）升级即失败；静默卸载不会勾选「删除应用数据」，`data/` 本来就保得住；③原地卸载（`_?=`）删不掉自己和安装目录，要补删 `uninstall.exe` 与目录，而目录非空时 `RMDir` 会失败——正好把 `data/` 留下。失败提示也从模板自带的「无法卸载！」换成可操作的说明（结束进程 / 从设置里手动卸载）。

14. **安装提示用非模态卡片，不用模态弹框**：更新包下载完成时用户多半正在读东西，铺遮罩 + 抢焦点的模态框会把阅读打断（还要处理 ESC 与全局快捷键的抢占）。因此做成右下角常驻卡片（`#installPrompt`，`role="dialog"` 但**不带** `aria-modal`）：不铺遮罩、`card.focus()` 一律不调、不注册任何全局键盘监听，点「立即安装」才 `installUpdate()`，「稍后再说」只收起卡片——状态不丢，侧栏红点与设置面板里的按钮仍在。文案与 URL 都走 i18n，标题里的版本号由 JS 填（带参数的键不能挂 `data-i18n`，否则会渲染出字面量 `{version}`）。

15. **PDF 默认「适合宽度」而不是「适合页面」**：默认值就是 `PdfReader.open()` 里 `zoom == null` 时的分支——`fitMode = "width"`，比例由 `fitWidthZoom()` 按可视区算（`clientWidth - 64` 除以基准页宽）。理由：正文阅读要的是字够大，整页看全属于排版审视，是少数场景，放进缩放菜单即可。代价是页面高度超过一屏、看得到页顶看不到页底，所以「下一页」用页码跳转与纵向滚动配合（`handleResize` 里高度变化的适配只对 `"page"` 生效，`"width"` 只跟宽度走）。缩放比例仍然不跨会话恢复：每次打开都重算，避免在窄窗口记下 165%、换到分栏后变成一堆超宽页。

## 5. 风险与对策

| 风险 | 对策 |
| --- | --- |
| pdf.js worker 在 WebView2 下加载失败 | 失败时 pdf.js 自动回退主线程渲染，并在控制台提示；同时校验 vendor 路径 |
| 大 PDF IPC 传输慢 | 默认走 asset 协议，不走 IPC |
| Windows 中文 PDF 缺字体 | 随包提供 `standard_fonts/` 与 `cmaps/`，配置 `cMapUrl` |
| 无边框窗口无法关闭 | 保留系统 Alt+F4；按钮调用 `appWindow.close()` |
| Rust 工具链不在 PATH | 项目 `.toolchains/` 下安装，构建脚本内联设置 `RUSTUP_HOME` / `CARGO_HOME` |
