# 开发任务规划 — 阅笺 YueJian Reader

> 依据 [product-spec.md](product-spec.md) 与 [design-contract.md](design-contract.md)，把原型落地为可运行的 Tauri 2 桌面应用。

## 1. 架构

```
┌──────────────────────────── 前端（src/，原生 ES Module） ────────────────────────────┐
│  index.html / styles.css                                                             │
│  js/app.js        视图切换、书架、命令面板、设置                                        │
│  js/reader-pdf.js pdf.js 渲染、连续滚动、缩放、目录、搜索                                │
│  js/reader-md.js  Markdown HTML 注入、目录高亮、代码高亮                                 │
│  js/api.js        Tauri invoke 封装（唯一后端出入口）                                   │
└───────────────────────────────────┬──────────────────────────────────────────────────┘
                                    │ invoke / asset 协议 / 原生拖拽事件
┌───────────────────────────────────▼──────────── src-tauri/（Rust） ───────────────────┐
│  main.rs / lib.rs  窗口与命令注册                                                      │
│  store.rs          书架 + 设置持久化（%APPDATA%/com.yuejian.reader/state.json）          │
│  markdown.rs       comrak 解析 → HTML + 标题目录                                        │
│  commands.rs       导入、打开、收藏、进度、设置、PDF 字节兜底读取                          │
└──────────────────────────────────────────────────────────────────────────────────────┘
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
│  ├─ js/{app,api,reader-pdf,reader-md}.js
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

## 4. 关键实现决策

1. **PDF 文件访问**：优先 `convertFileSrc` + asset 协议（支持 Range 请求）；若加载失败，回退到 `read_pdf_bytes` 命令按字节传给 pdf.js。
2. **Markdown 安全**：comrak 保持 `unsafe_ = false`，原始 HTML 转义，避免本地文档注入脚本。
3. **图片相对路径**：Rust 返回文档所在目录，前端用 `convertFileSrc(dir + "/" + src)` 重写 `img.src`。
4. **进度保存**：滚动节流 300ms，写回 Rust（整库 JSON 写入，条目级更新）。
5. **无打包器**：前端保持原生 ES Module，`vendor/` 放 pdf.js 与 highlight.js，保证离线可运行、启动快。
6. **窗口**：`decorations: false` + `data-tauri-drag-region`，用 Tauri window API 实现最小化/最大化/关闭。

## 5. 风险与对策

| 风险 | 对策 |
| --- | --- |
| pdf.js worker 在 WebView2 下加载失败 | 失败时 pdf.js 自动回退主线程渲染，并在控制台提示；同时校验 vendor 路径 |
| 大 PDF IPC 传输慢 | 默认走 asset 协议，不走 IPC |
| Windows 中文 PDF 缺字体 | 随包提供 `standard_fonts/` 与 `cmaps/`，配置 `cMapUrl` |
| 无边框窗口无法关闭 | 保留系统 Alt+F4；按钮调用 `appWindow.close()` |
| Rust 工具链不在 PATH | 项目 `.toolchains/` 下安装，构建脚本内联设置 `RUSTUP_HOME` / `CARGO_HOME` |
