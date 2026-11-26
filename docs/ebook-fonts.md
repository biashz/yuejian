# 电子书字体：系统栈 + 按需下载的开源字体

> 状态：已实现（v0.1.43 之后）· 相关代码：`src/js/reader/fonts.js`、`src-tauri/src/commands.rs`（字体一节）、`src/js/reader/ebook-style.js`、`src/js/reader/ebook-layout-panel.js`
> 设计位置：`docs/design-contract.md` §3「版式面板字体列表」一行族；界面说明见 `docs/ui-ebook-reading.md`

## 1. 原则

- **安装包里不带字体**。字体体积从 0.8 MB 到 25 MB，任何一种都足以把安装包撑大一截；而多数用户一辈子只用系统宋体。
- 系统字体栈常驻（宋体 / 黑体 / 楷体三档），离线永远可用；开源字体是**增强项**，用户点了才下载。
- 下载源只认官方：霞鹜文楷取 GitHub Release 资产，其余取 `github.com/google/fonts` 官方仓库里的原始 TTF。
- 字体落在**安装目录的 `data/fonts/`**（与书架、设置同根，见 `paths.rs::runtime_root`），随安装位置走，不写用户目录。

## 2. 目录

| id | 名称（界面） | 本地文件 | 许可 | 体积 | 官方源 |
| --- | --- | --- | --- | --- | --- |
| `wenkai-gb` | 霞鹜文楷 GB | `lxgwwenkai-gb-regular.ttf` | SIL OFL 1.1 | 26,170,696 B | https://github.com/lxgw/LxgwWenkaiGB/releases/download/v1.530/LXGWWenKaiGB-Regular.ttf |
| `noto-serif-sc` | 思源宋体 | `noto-serif-sc.ttf` | SIL OFL 1.1 | 25,125,512 B | https://raw.githubusercontent.com/google/fonts/main/ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf |
| `noto-sans-sc` | 思源黑体 | `noto-sans-sc.ttf` | SIL OFL 1.1 | 17,772,300 B | https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf |
| `literata` | Literata | `literata.ttf` | SIL OFL 1.1 | 955,132 B | https://raw.githubusercontent.com/google/fonts/main/ofl/literata/Literata%5Bopsz%2Cwght%5D.ttf |
| `eb-garamond` | EB Garamond | `eb-garamond.ttf` | SIL OFL 1.1 | 851,176 B | https://raw.githubusercontent.com/google/fonts/main/ofl/ebgaramond/EBGaramond%5Bwght%5D.ttf |

选型说明：

- 中文三款覆盖「楷 / 宋 / 黑」三种阅读气质：霞鹜文楷偏手写楷体，思源宋体是正文标准，思源黑体偏屏幕阅读。思源两款是可变字体（`[wght]`），一个文件覆盖全字重。
- 西文两款（Literata、EB Garamond）体积不到 1 MB，用来验证小文件下载与西文回退链；Literata 是 Google Books 的阅读字体。
- 霞鹜文楷 GB 的 Release 只有 `Regular` 单款（其余字重在 zip 里，而本项目不解压 zip），因此取 Regular。
- 五个源均用 `curl` 探测过：HTTP 200、`Content-Length` 与表中字节一致、前 4 字节为 `00 01 00 00`（TrueType sfnt）。

## 3. 下载与落盘

Rust 命令（`commands.rs`）：

- `list_fonts()` → `{ dir, files: [{ name, path, bytes }] }`；启动时由 `initFonts()` 调一次，按**文件名**认领目录里已有的字体。
- `download_font({ id, url, fileName, bytes })` → 落盘路径。系统 `curl`（`quiet()` 不弹控制台）下载到 `<name>.part`，校验通过后原子重命名为最终文件；每 150 ms `emit("font-progress", { id, received, total })`，前端据此把行状态写成百分比。
- `remove_font({ fileName })` → 删掉单个字体文件；文件本就不存在视为成功。

三道闸：

1. **https + 官方域名白名单**（`FONT_HOSTS`：`github.com` / `objects.githubusercontent.com` / `release-assets.githubusercontent.com` / `raw.githubusercontent.com`，按主机名精确或 `.suffix` 匹配，剥掉 userinfo 与端口后再比）。
2. **文件名收敛在 `data/fonts/` 内**（`safe_font_name`：`Path::file_name` 取末段、只收 `.ttf` / `.otf`、拒绝点开头、≤96 字符、ASCII 字母数字与 `-` `_` `.`）。
3. **文件头必须是字体**（`font_magic_ok`：`00 01 00 00`（TrueType）、`true`、`OTTO` 三者之一）；不符就删掉 `.part` 并报「下载的不是字体文件」。

失败信息走既有 `download_failure_message`（断网 / 超时 / HTTP 状态各有对应说法）。代理沿用更新检查的 `curl_proxy()`（环境变量或 Windows 注册表）。

## 4. 注册与注入

- 已装字体在 `fonts.js` 的 `installed` Map 里登记（id → `{ path, bytes }`），`initFonts()` 在启动时、`removeFont()` 移除后各自刷新。
- family 名统一加前缀：`"YJ <id>"`。书里可能自带同名 family 的定义，撞名时后加载的胜出，前缀把两边隔开。
- `@font-face` 的 `src` 用 `convertFileSrc()` 折成 asset 协议 URL（WebView2 上是 `http://asset.localhost/...`），CSP 的 `font-src` 已放行 `asset:`。
- 章节样式（`buildEbookStyles`）把 `fontFaceCss()` 放在最前——`@font-face` 只认顶层位置；版式面板的样例字用主文档 `<style id="fontFaceStyle">` 里同一条规则，装了就是活字样。
- 字体栈：`fontStack(id)` 对已装下载项返回 `"YJ <id>", <回退栈>`；文件被手动删掉就回落到系统宋体，设置里的 id 不急着清（补回文件即恢复）。
- 偏好字段只有一个：`settings.ebookFamily`（`serif` / `sans` / `kai` / 下载项 id）。

## 5. 加一款新字体

1. 找官方 Release / 仓库里的**单文件** TTF（zip 不解）；
2. `curl -I` 拿 `Content-Length`，`curl -r 0-3` 确认文件头；
3. 在 `fonts.js` 的 `DOWNLOAD` 里加一行：`id` / `labelKey` / `url` / `file` / `bytes` / `stack` / `weight`；
4. `i18n.js` 补 `font.<id>` 中英词条；
5. 冒烟里「3 项系统 + 5 项开源」与 e2e 的字体断言按新数量同步。

## 6. 验证

- 单元（Rust）：`font_urls_limited_to_official_sources`、`font_names_stay_inside_fonts_dir`、`font_magic_rejects_non_fonts`。
- 冒烟（Chrome + stub）：字体列表 8 行、未下载项「下载 → 进度 → 自动选中 → 落盘」、@font-face 进章节样式、移除退回宋体。
- 真机（e2e）：在 `target/release/data/fonts` 预置一份真 TTF，断言 `list_fonts` 认领、选中后偏好落盘、章 CSS 走 asset 协议、WebView2 里 `document.fonts.load('16px "YJ literata"')` 真的加载成功、移除后磁盘文件消失且设置回宋体。
