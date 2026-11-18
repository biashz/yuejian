# foliate-js：来源、拷贝范围与升级注意

`src/vendor/foliate/` 是第三方电子书引擎 **foliate-js** 的离线副本。

- 来源：<https://github.com/johnfactotum/foliate-js>
- 固定提交：`78914aef4466eb960965702401634c2cb348e9b1`（2026-05-01）
- 许可证：MIT（副本随目录，见 `src/vendor/foliate/LICENSE`）
- 复现：`npm run vendor`（`scripts/vendor-assets.mjs` 里的 `fetchFoliate`）

> 这个文件本身不放在 `src/vendor/foliate/` 里：`npm run vendor` 会先清空整个
> `src/vendor`，目录里的说明会被一并删掉。脚本每次会写一份指向本文的短 README。

## 为什么要整目录拷进来

库里的模块用**写死的相对路径**做动态导入：

- `view.js` → `await import('./vendor/zip.js')`、`'./vendor/fflate.js'`
- `view.js` → `'./epub.js'`、`'./paginator.js'`、`'./fixed-layout.js'`、`'./search.js'`、
  `'./comic-book.js'`、`'./fb2.js'`、`'./mobi.js'`

只要有一个文件没跟着走、或者目录层级被拍平，打开书时才会在运行期报 404。
所以这里保持与上游一致的相对结构，由脚本按同一份清单复现。

## 拷了什么、没拷什么

拷入（电子书自身需要的最小闭包，加上 P4 要用的 FB2 / MOBI / CBZ）：

```
LICENSE  view.js  epub.js  epubcfi.js  paginator.js  fixed-layout.js
search.js  overlayer.js  progress.js  text-walker.js
comic-book.js  fb2.js  mobi.js  vendor/zip.js  vendor/fflate.js
```

没拷：

| 上游文件 | 原因 |
| --- | --- |
| `vendor/pdfjs/**`（约 10MB） | 本项目的 PDF 走自己的 pdf.js 链路（`src/vendor/pdfjs`），不需要第二份 |
| `pdf.js` | 同理，它是 foliate 的 PDF 适配层，`makeBook` 里只在 PDF 分支被动态导入 |
| `opds.js` / `dict.js` / `tts.js` | OPDS 目录、词典、朗读，本期不做 |
| `reader.js` / `reader.html` / `ui/*` | 上游自带的演示应用，不是库本身 |
| `tests/`、`rollup*`、`eslint.config.js` | 构建与测试脚本 |

## 我们依赖的接口（升级前逐条对一遍）

`View`：`open` / `init` / `next` / `prev` / `goTo` / `goToFraction` / `getCFI` /
`resolveNavigation`；事件 `load` / `relocate` / `link` / `external-link`；
`book.transformTarget` 上的 `load`（准入）与 `data`（字节改写）两个钩子。

`customElements.define('foliate-view', …)` 在 `view.js` 模块求值时执行，
所以必须**先 import 再创建** `<foliate-view>`，且同一文档只能 import 一次。

这个库没有 semver，API 跟着上游走。升级流程：换 `FOLIATE_SHA` → `npm run vendor` →
`npm run check` → `npm run smoke`（内含电子书用例：打开、目录、翻页、CFI 续读、
脚本清洗），全绿再提交。

## 已知取舍

- **不提供沙箱**：库的 iframe 用 `sandbox="allow-same-origin allow-scripts"`，README 明确说
  沙箱要调用方自己做。本项目在 `reader-epub.js` 里删脚本资源、清洗内联脚本，
  再由 `tauri.conf.json` 的 CSP（`script-src 'self'`）兜底。
- **加密字体**：IDPF / Adobe 的字体解混淆由库内 `Encryption` 处理，需要 SHA-1；
  WebView2 下 crypto.subtle 可用，其它平台未验证。
- **KF8 / AZW3**：HUFF/CDIC 解压是纯 JS，大文件首次打开会有可感知的延迟。
