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
│  │  └─ reader-pdf.js / reader-md.js / reader-text.js
│  └─ vendor/{pdfjs,highlight}/   离线第三方资源
├─ src-tauri/
│  ├─ Cargo.toml
│  ├─ tauri.conf.json
│  ├─ capabilities/default.json
│  ├─ icons/
│  └─ src/{main,lib,store,markdown,text,commands}.rs
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
| T13 | 摘录导出：`export-marks.js` 纯函数拼 Markdown、`marks-tools.js` 工具区、`marks-export.js` 两个出口、Rust `save_text_file` | T4,T11 | 有摘录时侧栏出现「复制 / 导出」；导出内容含标题、计数、引用块与出处行；无摘录不显示；见 [feature-export.md](feature-export.md) |

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
11. **「漏 import」用脚本兜住**：模块拆分后函数被调用却没 import，链接期不报错（标识符当全局查），只有执行到那一行才抛 `XXX is not defined`。项目无打包器也无 linter，因此用 `npm run check`（`scripts/check-undefined.mjs`）兜底：挖空注释与字符串后，比对「调用式标识符」与「本文件已声明的名字」，未声明即报错并以退出码 1 拦截。该脚本上线后一次性扫出 3 处真实遗漏（`updateToolbarPage` / `scrollPaneToRatio` / `renderToolbar`），均已修复。同一脚本还校验相对导入的路径是否真的存在：写错一级目录（把 `./core/dom.js` 写成 `../core/dom.js`）时，被导入的名字照样被登记为「已声明」，`node --check` 与上面那套比对全部通过，但浏览器会在模块链接期对整个模块图 404——现象是页面一秒都没启动、控制台零报错、`window.__errors` 为空，极难定位。该检查上线后正是靠它确认了 `reader-text.js` 的这类路径错误。静态检查管不到的运行时问题由 `npm run smoke`（`scripts/smoke-reader.mjs`）负责：真 Chrome + 注入 `__TAURI__` 桩跑完整阅读流程，PDF 现场生成、任何未捕获异常即失败。该脚本现在管第三件事：中英字典键集必须一致，且代码与 `index.html` 里用到的键两边都得有——少一条的表现是英文界面里冒出一句中文，不报错也不崩，最容易一路带到发布；加进去当场查出两处陈年欠账（`library.filterText` 只有中文、`library.hint` 还写着只支持 PDF / Markdown）。
12. **更新下载复用 curl，但代理必须自己补**：`download_update` 交给系统自带 `curl`，不引入 HTTP 依赖。坑在于 curl **只认 `HTTPS_PROXY` 类环境变量，不读 Windows 系统代理**，而 WebView2 里的 `fetch` 会读——于是「检查更新能查到、点下载一直 0 字节」，浏览器却打得开下载页。现在读一次注册表 `Internet Settings` 补上 `--proxy`（环境变量已设则不插手），并用 `--connect-timeout 20`、`--speed-limit 1024 --speed-time 40` 把无限等待变成明确失败；失败时把 curl 退出码与 stderr 翻译成可处置的提示。前端另有看门狗：12 秒无字节提示「正在连接」、45 秒无新字节提示「下载没有响应」并放出发布页入口。
    **子进程一律 `quiet()`**：应用是 GUI 子系统（`windows_subsystem = "windows"`），自己没有控制台，此时启动 `curl.exe` / `reg.exe` / `cmd.exe` 这类控制台程序，Windows 会为它新建一个控制台窗口——curl 一跑几十秒，那个黑框就整个下载期间挂在桌面上。统一走 `commands::quiet()`（`CREATE_NO_WINDOW`）后再 `spawn`，输出仍可经管道读，桌面干净。
13. **升级拆成两个独立、各自完整的阶段**：`nsis/installer.nsi` 里 `YueJianUninstallPrevious` 的时序错一步，结果都是「升级装不上」，而且失败时旧版本原封不动，看起来就像「自动卸载功能没了」。因此把「升级」明确切成 **阶段 1/2 检测并完整卸载旧版本** + **阶段 2/2 完整安装新版本**，`Section Install` 只有在阶段 1/2 明确「本机已无旧版本」之后才动手写文件，两个阶段在 `DetailPrint` 里各自带 `阶段 1/2`／`阶段 2/2` 前缀，卡在哪一半一眼可辨。阶段 1/2 有四个出口，都必须把「卸载」这件事做到完整：①检测不到旧版本 → `$(YueJianNoOld)` 后返回；②检测到且有卸载程序 → 静默卸载后补删残留；③检测到但 `uninstall.exe` 已丢失（目录被手工删过、被安全软件清掉）→ 不再静默 `Return`（那样会留下指向旧路径的「设置 → 应用」记录），改为 `YueJianRemoveResidual` 手工补完：删主程序（占着就等 800ms 再删）→ 删指向旧 exe 的快捷方式 → `RMDir` → 删 `${UNINSTKEY}`；④卸载后主程序仍在 → `Abort` 并给出可操作提示。

    三条硬约束：①`CheckIfAppIsRunning`（Restart Manager）必须在卸载**之前**执行，否则旧卸载程序删不掉被占用的 `yuejian.exe`，随后「主程序仍存在」的检查会把整个安装 `Abort` 掉；②旧卸载程序必须 `/S _?=$dir` **静默**执行。曾经为了「让用户决定是否删数据」改成带界面运行，等于在升级途中弹出第二个「确认卸载」向导，用户一取消（退出码 1）升级即失败；静默卸载不会勾选「删除应用数据」，`data/` 本来就保得住；③原地卸载（`_?=`）删不掉自己和安装目录，要补删 `uninstall.exe` 与目录，而目录非空时 `RMDir` 会失败——正好把 `data/` 留下。

    快捷方式按「指向哪个 exe」判断（`IsShortcutTarget`）而不是按文件名判断，避免误删用户自建的同名 `.lnk`；`YueJianRemoveOldShortcuts` 会先 `MUI_STARTMENU_GETFOLDER` 读回安装时选定的开始菜单目录。刻意**不**清理 `$INSTDIR` 下的未知文件：那等于对一个可能含 `data/` 的目录做通配删除，收益远小于风险；也确实没有这类残留——每个版本的文件清单一致。

14. **安装提示用非模态卡片，不用模态弹框**：更新包下载完成时用户多半正在读东西，铺遮罩 + 抢焦点的模态框会把阅读打断（还要处理 ESC 与全局快捷键的抢占）。因此做成右下角常驻卡片（`#installPrompt`，`role="dialog"` 但**不带** `aria-modal`）：不铺遮罩、`card.focus()` 一律不调、不注册任何全局键盘监听，点「立即安装」才 `installUpdate()`，「稍后再说」只收起卡片——状态不丢，侧栏红点与设置面板里的按钮仍在。文案与 URL 都走 i18n，标题里的版本号由 JS 填（带参数的键不能挂 `data-i18n`，否则会渲染出字面量 `{version}`）。

15. **PDF 默认「适合宽度」而不是「适合页面」**：默认值就是 `PdfReader.open()` 里 `zoom == null` 时的分支——`fitMode = "width"`，比例由 `fitWidthZoom()` 按可视区算（`clientWidth - 64` 除以基准页宽）。理由：正文阅读要的是字够大，整页看全属于排版审视，是少数场景，放进缩放菜单即可。代价是页面高度超过一屏、看得到页顶看不到页底，所以「下一页」用页码跳转与纵向滚动配合（`handleResize` 里高度变化的适配只对 `"page"` 生效，`"width"` 只跟宽度走）。缩放比例仍然不跨会话恢复：每次打开都重算，避免在窄窗口记下 165%、换到分栏后变成一堆超宽页。

16. **文本编码不假定 UTF-8**：Windows 记事本默认存 ANSI（中文即 GBK），`fs::read_to_string` 遇到 GBK 会整篇失败（`stream did not contain valid UTF-8`），报错还指向不了真正原因。因此文本读取走三段式：①**BOM**（`EF BB BF` / `FF FE` / `FE FF`）是硬证据，存在即按对应编码解码；②无 BOM 时用 `chardetng`（Firefox 的检测器，纯 Rust）读前 8KB 猜编码——判错也只是个别字符受影响，不会整篇失败；③交给 `encoding_rs`（同为 Firefox 实现）**有损**解码，无法映射的字节替换为 `�` 而不是抛错。选这两个库而不是 `encoding` 之类，是因为它们就是 Firefox 在用的那一套，GBK / GB18030 / Shift_JIS 的判定质量有长期实践背书，且纯 Rust、无需外部依赖；代价是码表会进二进制：实测 Windows 安装包从 4436KB 涨到 4584KB（+148KB，含新增的全部解码与统计代码），比动手前估算的 300–400KB 小得多，可接受。判定结果（`encoding`）与换行符（`eol`）一并返回给前端，显示在「信息」面板——用户看到乱码时能立刻区分「文件本身有问题」还是「应用判错了」。

    配套两条约束：①**超限不静默**——超过 `MAX_VIEW_BYTES`（8MB）读前 8MB，在最后一个完整行处截断（保证不出现半行），以 toast 告知并在「信息」面板标注，绝不悄悄渲染半截（P4 起 8MB 以上改为行索引 + 窗口加载，这条只对 UTF-16、超短行等不适合窗口的文件生效，见决策 19）；②**节点数恒定**——等宽视图整篇只有两个 `<pre>`（行号栏 + 正文），不按行建节点。一份 5MB 日志十几万行，按行建 DOM 会卡几秒且滚动持续掉帧；两个 `<pre>` 靠相同 `line-height` 天然对齐，节点数与行数无关，冒烟里直接把「节点数 ≤ 4」写成断言，防止后续重构退回逐行渲染。


17. **高亮阈值与「不阻塞打开」**：hljs 是有状态的整段解析器，没法只高亮可见窗口，所以成本随文件线性增长。实测（Rust 代码，hljs 11.11.1 common bundle）：50KB→57ms、200KB→133ms、500KB→265ms、1MB→492ms、2MB→1010ms，且高亮后的 HTML 约为原文的 3.6 倍（500KB 源码变 1.79MB）。据此定两条：①**阈值 200KB**，超过就不高亮，只给等宽纯文本；②**异步补色**——先渲染纯文本，再用 `requestIdleCallback`（无此 API 时退回 `setTimeout`）算好替换，算之前用户已经能读了。异步带来一个必须处理的问题：算的过程中用户可能切了视图或换了文档，所以每次调度递增一个 `token`，回调里发现 token 变了就直接丢弃结果，否则会出现「正文视图里突然被替换成高亮 HTML」。

    高亮只在 `.tx-lines` 这一个 `<pre>` 里发生，行号栏是另一个 `<pre>`，两者字体与行高必须完全一致才不串行——冒烟里直接断言「行号行数 == 正文行数」守住这条。阈值与降级原因都写进「信息」面板的「高亮」一行，不做静默降级。

    另：`nodes <= 4` 那条常数节点断言只对**未高亮**的文本成立。高亮本质上是往正文里插 `<span>`，200KB 上限内最多几万个，与「按行建 div」那种十几万节点、且每个节点都要参与排版的情况不是一回事——两者不能混为一谈，所以断言分开写。

18. **表格：手写 RFC 4180 + 双向粘性，测量要先避开入场动画**：CSV / TSV 的解析按 RFC 4180 手写（引号包裹、`""` 表示一个引号、引号内可含分隔符与换行、行以换行结束），不引依赖——可执行的规则只有四条，一百多行写完，还省掉一份离线打包与许可证的账。分隔符**按内容判断**而不按扩展名写死：只数表头行里引号外的逗号 / 制表符 / 分号，谁多算谁（`.tsv` 是制表符，欧洲的 CSV 常用分号，硬编码会把整篇拆成一列）。渲染上靠 `position: sticky` 让 `thead th` 贴顶、`.tx-rowno` 贴左，左上角那格两个方向都压（`z-index: 4` 压在两者之上），长表滚到第 200 行仍知道每列是什么。

    三个踩过的坑：①`.scroll-area` 带 `scroll-behavior: smooth`，测试里直接赋 `scrollTop` 会启动动画、同步读回来还是 0，测量前必须临时改成 `auto`；②`.md-doc` 带 `animation: rise 600ms both`，进场期间整块内容被 `translateY` 推下去，此时量到的「表头偏移」是动画位移而不是 sticky 偏差（同一份代码上一轮量到 1px、下一轮 10px），测量前要 `document.getAnimations().forEach(a => a.finish())`；③断言也不能只看「偏移 ≈ 0」——还得同时看 `thead` 已经滚出去多少、以及行号是否从 1 连续到末行，否则「整块没滚」或「行号少一格」都会假通过。

19. **大文件：行索引在 Rust、窗口在画布上，四条硬约束**：①**索引只存偏移**（`u32` 每行 4 字节），100MB / 100 万行约 4MB，与文件大小脱钩；行数上限定在 150 万，因为它乘行高必须落在浏览器元素高度上限（约 3355 万像素）之内——没有这个上限，画布撑不出来，滚动条到底也够不到文件末尾。②**窗口起点必须罩住可视区**：按整块对齐是为了滚回来能命中缓存，但纯粹 `floor(from / 1200) * 1200` 会在「跳到某块末尾附近的行」时把窗口停在可视区之前，屏幕上一片空白；正确写法是把对齐结果再限制在 `[to - 窗口行数, from]` 区间内。③**画布要纵向裁掉窗口的尾部空白**：窗口盒子（flex 容器）比「行数 × 行高」高出几十像素，这点空白会计入 `scroll-container` 的滚动高度，于是滚到最大也差一截看不见最后一行；`overflow-x: visible; overflow-y: clip` 让滚动高度精确等于行数 × 行高，同时不切断长行的横向滚动。④**IPC 返回原始字节**：窗口正文用 `tauri::ipc::Response` 回 `Vec<u8>`，前端用 `TextDecoder(doc.encoding)` 解码——省掉 JSON 对每个引号的转义，也避免让 Rust 对每段窗口重新猜编码（猜错就是同一文件前后两屏解码不一致）。

    搜索必须同时下沉：窗口模式下 DOM 里只有一千多行，原来的 DOM 遍历会静默地只搜当前屏。现在大文件走 `search_text`（按行窗口逐段扫、命中带行号），非大文件仍走 DOM——后者能直接拿到节点做高亮与滚动，没必要绕一圈。

20. **编码手动切换：选择写回书架，且必须让行索引失效**：探测再准也会判错（短文件、夹着少量中文的英文日志、日文与繁体混排），所以「信息」面板的编码一行做成可点的菜单。四个要点：
    - **写回书架而不是只改本次会话**：`Book` 增加 `encoding` 字段（空串 = 自动），选过之后下次打开沿用，改回「自动检测」即清空。用户来切编码正是因为这文件一直乱码，重启后又回到自动检测等于每次启动都要重切一遍。前端只在 `options.encoding !== undefined` 时才写这份副本——`undefined` 表示「沿用书架」，空串表示「改回自动」，两者语义不同，不能用 `if (encoding)` 混同。
    - **指定编码时跳过一切自动判定**，包括二进制检测。顺手修掉一个真 bug：原来先跑 `looks_binary`（前 8KB 有 NUL 即拒开）再判 BOM，而 UTF-16 正文里每个 ASCII 字符后都跟着 `0x00`，于是带 BOM 的 UTF-16 文件一律打不开，「UTF-16 退回截断」那段逻辑从未被执行过。现在 `looks_binary` 见到 BOM 直接返回 false。
    - **换编码必须 `forget_index`**：`LineIndex` 里记着编码名，窗口读取按它解码。不丢旧索引，新选择只对第一屏生效、往下滚又变回乱码。同理，`ensure_index` 缓存未命中重建时也要先查书架里的手动编码，否则第三份大文件把缓存清空之后，手动选择会悄悄失效。
    - **参数用 `Option<String>`，省略即 `None`**：serde 对缺失的 `Option` 字段落 `None`（已用隔离 crate 单独验证，不是靠猜），因此普通打开路径不必改前端调用。菜单只列 9 项、GBK/GB2312 并入 GB18030——列几百种编码只是把选择成本转嫁给用户。

21. **摘录导出：格式与落盘分家，两个出口共用一份内容**：`buildMarksMarkdown()` 是纯函数（不碰 DOM、不发请求），`save_text_file` 只负责弹保存框与写字节。这样冒烟能直接断言 Markdown 结构，不必卷进系统对话框——而导出的真正难点恰恰是「输出长什么样」。四条约束：
    - **复制与导出必须同源**：两个出口都调同一个函数。若各拼一套，「先复制看一眼」就不再能预览将要导出的东西，而这两处一旦漂移，通常要等用户贴出来才发现。
    - **取消不是失败**：`save_text_file` 在用户按取消时返回空串而不是 `Err`，前端据此不弹提示。把它当错误处理会得到一个「导出失败」的假警报，用户会重试一次再确认文件其实没写。
    - **空列表不摆按钮**：工具区由页面判「本页有没有内容」，不由「整本书有没有摘录」判。否则「书签页空着但有一条划线」时，会在「还没有书签」的空态上方看到一行孤零零的按钮。
    - **行首才转义**：`#` / `-` / `+` / `*` / `1.` / `1)` 只处理行首。行中的符号不构成块级语义，逐处转义只会在正文里堆一串多余的反斜杠。技术书正文以 `#`、`-` 开头很常见，不转义的话导出会被笔记软件重新排成标题与列表。

## 5. 风险与对策

| 风险 | 对策 |
| --- | --- |
| pdf.js worker 在 WebView2 下加载失败 | 失败时 pdf.js 自动回退主线程渲染，并在控制台提示；同时校验 vendor 路径 |
| 大 PDF IPC 传输慢 | 默认走 asset 协议，不走 IPC |
| Windows 中文 PDF 缺字体 | 随包提供 `standard_fonts/` 与 `cmaps/`，配置 `cMapUrl` |
| 无边框窗口无法关闭 | 保留系统 Alt+F4；按钮调用 `appWindow.close()` |
| Rust 工具链不在 PATH | 项目 `.toolchains/` 下安装，构建脚本内联设置 `RUSTUP_HOME` / `CARGO_HOME` |
