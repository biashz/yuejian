# 电子书格式支持 · 技术调研

> 目标：让阅笺能打开常见电子书（EPUB / FB2 / MOBI / AZW3 / CBZ），并提供「翻页、目录、
> 进度、书签、搜索、字号版式」这套电子书阅读器该有的交互。
>
> 现状基线：v0.1.31。已有三类文档：PDF（pdf.js）、Markdown（comrak）、文本（自研编码 + 行索引）。
> 电子书将是第四类，且是唯一一类**内容自带排版与样式**的文档——这是全部难点的来源。

## 1. 现状盘点：为什么电子书不能照抄文本 / PDF 的路子

| 环节 | PDF | Markdown | 文本 | 电子书需要什么 |
| --- | --- | --- | --- | --- |
| 容器 | 单文件 + 交叉引用表 | 单文件 | 单文件 | **ZIP 归档**（EPUB / CBZ）或**自定义二进制**（MOBI） |
| 正文 | 内容流 | Markdown 源码 | 纯文本行 | **XHTML 片段 + 自带 CSS** |
| 分页 | 页是文件里写死的 | 无页概念，滚动 | 无页概念，滚动 | **由视口实时算出来**（可重排） |
| 位置 | 页码 | 滚动比例 | 行号 | **CFI**（指向 DOM 节点偏移的字符串） |
| 资源 | 内嵌在 PDF 里 | 相对路径图片 | 无 | ZIP 内的图片 / 字体 / CSS，需按 href 解析 |

结论：**分页和位置表示是核心难点**，不是「把 HTML 渲染出来」这么简单。一本书在不同字号、
不同窗口宽度下的页数是不同的，所以「读到第几页」这种进度根本无法保存——必须用
相对 DOM 的位置（CFI）或章节内比例。

## 2. 格式范围：四类东西，成本差一个量级

| 类别 | 扩展名 | 本质 | 成本 | 本轮 |
| --- | --- | --- | --- | --- |
| **可重排电子书** | `epub` | ZIP + OPF 清单 + XHTML + CSS | 中（有成熟库） | ✅ 核心 |
| **其它可重排** | `fb2` `fb2.zip` `fbz` | 单个 XML，结构简单 | 低 | ✅ 顺便 |
| **Kindle 私有格式** | `mobi` `azw` `azw3` | PalmDOC 压缩 + HUFF/CDIC + 自有标记 | 高（解压实现极其繁琐） | ⚠️ 借用库，只读 |
| **固定版面漫画** | `cbz` `cbr` | 一堆图片打包 | 低（CBZ）/ 中（CBR 需 RAR） | ✅ CBZ |
| **带 DRM 的电子书** | 亚马逊 / Adobe ADEPT 加密的 `azw` `epub` | 加密内容 | **不做** | ❌ 明确拒绝并说明 |
| **其它** | `djvu` `chm` `lit` `pdb` | 各有独立编码 | 高、用户极少 | ❌ 不做 |

**DRM 这条线必须先划清楚**：亚马逊商店买的 `.azw3`、Adobe 加密的 `.epub` 都是加密的，
技术上要绕过就得实现破解，法律上也不该做。正确做法是**识别出来并明确告知**
（「这本带 DRM 保护，无法打开」），而不是让用户看到一堆乱码或一句英文报错。
识别点：EPUB 的 `META-INF/encryption.xml` 里出现 `EncryptedData`（字体混淆是允许的，
要区分算法）；MOBI 的 PalmDOC 头里 encryption 字段非 0。

## 3. 候选方案对比

### 方案 A：foliate-js（推荐）

Foliate 是 Linux 上最成熟的 GTK 电子书阅读器，作者把渲染内核抽成了纯 JS 库
[johnfactotum/foliate-js](https://github.com/johnfactotum/foliate-js)（**MIT**）。
Readest（Tauri v2 + Next.js 的电子书阅读器，AGPL）也用它作为阅读内核，说明这条路在
Tauri 里是走得通的。

| 维度 | 情况 |
| --- | --- |
| 格式 | EPUB、MOBI、KF8/AZW3、FB2、CBZ（PDF 实验性，我们用现成的 pdf.js，不需要） |
| 分页 | `paginator.js` 用 CSS 多栏（`column-width`）实现真分页，支持单页 / 双页跨页 |
| 位置 | 自带 `epubcfi.js`，CFI 解析与生成齐全——这是最难自己写对的部分 |
| 辅助 | `progress.js`（章节进度）、`search.js`（全书搜索）、`overlayer.js`（划线/批注层） |
| 体积 | 纯 ES 模块，无构建步骤；核心十几个文件，加上 zip.js 与 fflate 约 400KB |
| 依赖 | **无硬依赖**，但需要把 `zip.js` 和 `fflate.js` 放在库目录下的 `vendor/`（路径写死） |
| 许可 | MIT，可随包分发 |
| 稳定性 | 作者自述「不稳定，API 随时可能变」，Foliate 的正式版在用 |

集成方式（已核对源码）：

- `view.js` 只 import 同目录的 4 个模块；`zip.js` / `fflate.js` 通过
  `await import('./vendor/zip.js')` **写死相对路径**动态加载 → 整包拷贝到
  `src/vendor/foliate/` 即可，不需要打包器，也不污染全局。
- `makeBook(file)` 靠**魔术字节**自动分派：`PK\x03\x04` → CBZ / FB2.ZIP / EPUB，
  PalmDOC 头 → MOBI / KF8，XML 根节点 → FB2。不需要我们自己判扩展名。
- `configure({ useWebWorkers: false })` 已在库内调用 → 不需要 `worker-src` 的 CSP 让步。
- `book.transformTarget` 是**每个资源加载时的拦截点**（`{ data, type, name }`），
  可以在这里注入主题 CSS、剥掉 `<script>`——见第 5 节。

### 方案 B：epub.js

[futurepress/epub.js](https://github.com/futurepress/epub.js)（BSD-3）是老牌 EPUB 渲染库，
CFI、分页、主题、注释都有。但：**只支持 EPUB**，MOBI / AZW3 / FB2 / CBZ 全无；
维护活跃度低；同样需要 CFI 与 iframe 分页。选它等于其余格式另找四套方案。

### 方案 C：自研 Rust 管线

Rust 侧用 `zip` + `quick-xml` 解 OPF / spine / NCX，前端用 iframe + CSS 多栏自己实现分页。

- 优点：完全可控，无第三方渲染库，脚本注入可以在这里一次性洗干净。
- 缺点：分页（跨栏测量、图片高度、竖排、双页对齐）、CFI、全书搜索、划线层
  全要自己写。「完美支持」这五个字在自研路线上是 3–5 倍的工作量，且这些正是 foliate
  八年迭代出来的细节。

### 方案 D：WebView 内置能力

Chromium 没有内建 EPUB 渲染，WebView2 也没有。不成立。

## 4. 选型结论

**采用方案 A：vendoring foliate-js。** 理由排序：

1. 它是唯一个「五种格式 + 分页 + CFI + 搜索 + 标注层」齐活的现成实现，MIT 许可；
2. Tauri 里有 Readest 的先例，不是纸上方案；
3. 纯 ES 模块、路径自包含，与本项目「无打包器 + `src/vendor/` 离线分发」的既有做法一致；
4. 自己重写分页与 CFI 的收益（可控）远小于代价（正确性 + 工期）。

**代价要接受**：API 不稳定，升级需回归；书内 CSS 与我们的主题会打架（需要「强制覆盖」
开关）；KF8 的 HUFF/CDIC 解压慢（大文件翻章有可感延迟）。

## 5. 五个必须提前想清楚的集成点

### 5.1 脚本安全：CSP 是硬性前提

foliate-js 的 README 明确警告：EPUB 可以含 JavaScript，库本身**不**提供沙箱
（iframe 用 `blob:` 同源 URL，且 WebKit 的 bug 使得必须加 `allow-scripts`，
sandbox 形同虚设），因此**必须依赖 CSP 拦截脚本**。

本项目当前 `tauri.conf.json` 的 `csp` 是 `null`（完全没有策略）。所以要做的第一件事是
加一条既能挡住书内脚本、又不破坏 pdf.js / 素材协议 / 内联样式的策略，并逐项回归：

```
default-src 'self' asset: http://asset.localhost blob: data:;
script-src 'self';
style-src 'self' 'unsafe-inline' asset:;
img-src 'self' asset: http://asset.localhost blob: data:;
font-src 'self' asset: blob: data:;
connect-src 'self' ipc: http://ipc.localhost;
```

**兜底第二道**：在 `transformTarget` 里对 XHTML 资源做一次清洗（去 `<script>`、去
`on*=` 属性、去 `javascript:` 协议），两道都不省——CSP 是最后防线，清洗保证即使
CSP 被放宽也不会立刻出事。

### 5.2 主题与版式：注入 CSS，而不是改书

阅读设置（字号、行高、页边距、字体、对齐、主题色）要落到书内的 iframe 里，
只能靠注入样式。`transformTarget` 拦截 `type` 为 XHTML 的资源，在 `</head>` 前插入一段
`<style>`；这段样式由我们的设置实时生成，改动时重新 `renderer.setStyles()`（foliate 提供）
或重新加载当前章节。

要点：书自带的 `font-family` / `line-height` 优先级常常很高，所以需要一个
**「强制覆盖书内样式」**开关——开启时用 `!important` 压过去，关闭时只设 `html{font-size}`
做温和缩放。默认关闭（尊重原书排版），但用户遇到「设置调了没效果」时能一键接管。

### 5.3 位置与进度：CFI 存档

`relocate` 事件给 `{ range, index, fraction }`，`view.getCFI()` 给出当前 CFI。
存储时两者都留：

- `Book.progress.cfi`：字符串，精确恢复位置（新增字段，`#[serde(default)]`，旧数据无影响）；
- `Book.progress.ratio`：整书百分比，书架进度条与排序继续用它，不必改现有代码。

页数不再有意义，状态栏改为「第 3 章 · 27%」。

### 5.4 打开方式：Blob 还是 URL

`view.open()` 接受 `File`/`Blob` 或 URL。两种路径：

- **Blob**：Rust 读整个文件 → IPC 回 `ArrayBuffer` → `new File([buf], name)`。
  简单、离线、无 CSP 额外放行；代价是整本进内存（一本 20MB 的 EPUB 常驻 20MB）。
- **URL**：`convertFileSrc(path)` 走 asset 协议，zip.js 用 Range 随机读，**不整本进内存**；
  代价是 asset 协议 + zip.js 的随机读行为要实测（PDF 那边已经在用 asset 协议，有基础）。

定为：**小于 64MB 用 Blob，超过用 URL**——与 PDF 的 `RANGE_READ_THRESHOLD` 同一套阈值思路。
超过 512MB 直接拒绝并提示（这种体量通常是扫描版漫画，应该走 CBZ 而不是塞进 EPUB）。

### 5.5 漫画（CBZ）与图片

CBZ 走 `comic-book.js` + `fixed-layout.js`：一张图一「页」，双页跨页、适应宽度。
它同样接受 loader，因此与 EPUB 共用 zip 通道。CBR（RAR）需要解压 RAR 的库，**本轮不做**，
导入时明确提示「请先转成 CBZ」。

## 6. 风险清单

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| foliate API 变化 | 升级即回归 | 锁 commit（vendoring 时记录），升级前跑完整冒烟 |
| CSP 加错 | 整个应用白屏 / pdf.js 挂掉 | 先加策略跑一遍全量冒烟，再动电子书 |
| 书内脚本 | 安全 | CSP + transformTarget 清洗，两道 |
| KF8 解压慢 | 翻章卡顿 | 明确说明「AZW3 首次打开较慢」，大文件给进度提示 |
| 竖排 / RTL | 显示错乱 | foliate 支持 `dir`，但不承诺完美；竖排书列入「已知限制」 |
| 字体混淆（IDPF） | 书内嵌字体解不出 | 需要 SHA-1；Tauri 自定义协议是否 secure context 要实测，不是就用纯 JS SHA-1 |
| 书内 CSS 与主题冲突 | 设置不生效 | 「强制覆盖」开关兜底 |

## 7. 验证素材

| 用途 | 来源 |
| --- | --- |
| EPUB 规范边界 | https://github.com/johnfactotum/epub-test（foliate 作者的测试书集：EPUB2/3、竖排、固定版面、加密字体） |
| 中文排版 | 自制：中文段落 + 标点挤压 + 图片 + 脚注 + 三级目录 |
| FB2 | 自制（XML 结构简单），外加一本俄文原书验证编码 |
| CBZ | 自制：几十张图 + 不同尺寸混排 |
| MOBI / AZW3 | 用 Calibre 从 EPUB 转换生成（无 DRM），覆盖 MOBI6 与 KF8 |
| DRM 拒绝 | 一份带 `encryption.xml` 的 EPUB（构造，不含真实密钥） |

> 上述文件放 `.playground/ebooks/`（已 gitignore），冒烟里用**打桩**代替真解析，
> 真实文件留给真机验收——与文本格式那五期的做法一致。
