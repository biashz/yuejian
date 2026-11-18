/**
 * 把 npm 依赖中的运行时资源拷贝到 src/vendor，保证应用离线可用。
 * 运行：npm run vendor
 */
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const vendor = path.join(root, "src", "vendor");
const foliateDir = path.join(vendor, "foliate");
// 下面第一件事是清空 vendor。foliate 要联网取，取不到时不能连仓库里已有的副本一起清掉，
// 所以在清空之前先把它挪到缓存目录当备份。
const foliateBackup = path.join(root, ".cache", "vendor-foliate-backup");
await rm(foliateBackup, { recursive: true, force: true });
await cp(foliateDir, foliateBackup, { recursive: true }).catch(() => {});

await rm(vendor, { recursive: true, force: true });
await mkdir(path.join(vendor, "pdfjs"), { recursive: true });
await mkdir(path.join(vendor, "highlight"), { recursive: true });

const pdfRoot = path.join(root, "node_modules", "pdfjs-dist");
for (const file of ["build/pdf.mjs", "build/pdf.worker.mjs", "web/pdf_viewer.css"]) {
  await cp(path.join(pdfRoot, file), path.join(vendor, "pdfjs", path.basename(file)));
}
// PDF 渲染所需的附加资源：CJK 字符映射、标准字体、色彩配置、WASM 解码器
for (const dir of ["cmaps", "standard_fonts", "iccs", "wasm"]) {
  await cp(path.join(pdfRoot, dir), path.join(vendor, "pdfjs", dir), { recursive: true });
}

/**
 * pdf.worker.mjs 的上游补丁。
 *
 * 这个文件是整份覆盖式的拷贝，手改的修复会被无声洗掉——实测：跑一次 vendor，
 * `git diff` 里那处修改立刻反向。所以补丁必须写进脚本，并且**锚点找不到时抛错**，
 * 逼人在上游改动这段代码时来看一眼，而不是让修复静默失效。
 */
const PDF_PATCHES = [
  {
    name: "负 Prev 偏移按无符号 32 位还原",
    file: "pdfjs/pdf.worker.mjs",
    marker: "obj < 0 ? obj >>> 0 : obj",
    from: [
      '        obj = dict.get("Prev");',
      "        if (Number.isInteger(obj)) {",
      "          this.startXRefQueue.push(obj);",
    ].join("\n"),
    to: [
      '        obj = dict.get("Prev");',
      "        if (Number.isInteger(obj)) {",
      "          // 部分合并工具把超过 2 GB 的偏移写成有符号 32 位整数（负数），",
      "          // 这里按无符号 32 位还原，否则整条 xref 链断裂，pdf.js 会退化成扫描整个文件",
      "          this.startXRefQueue.push(obj < 0 ? obj >>> 0 : obj);",
    ].join("\n"),
  },
];

for (const patch of PDF_PATCHES) {
  const file = path.join(vendor, patch.file);
  const text = await readFile(file, "utf8");
  if (text.includes(patch.marker)) {
    console.log(`pdf 补丁已就位：${patch.name}`);
    continue;
  }
  if (!text.includes(patch.from)) {
    throw new Error(`pdf 补丁锚点消失（${patch.file}）：${patch.name} —— 上游改了这段，需要人工确认`);
  }
  await writeFile(file, text.replace(patch.from, patch.to));
  console.log(`已应用 pdf 补丁：${patch.name}`);
}

// highlight.js 官方浏览器构建（离线随包分发，文件内自带 BSD-3 许可声明）
const hljsUrl = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js";
try {
  const res = await fetch(hljsUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await writeFile(path.join(vendor, "highlight", "highlight.min.js"), Buffer.from(await res.arrayBuffer()));
  console.log("highlight.js vendored");
} catch (err) {
  console.warn(`highlight.js 下载失败（将跳过代码高亮）：${err.message}`);
}

/**
 * foliate-js（电子书引擎）。
 *
 * 不能用 npm 装：库内部用的是写死的相对路径动态导入（`./vendor/zip.js`、
 * `./epub.js`…），走 node_modules 会解析到别处。所以按固定提交逐个文件取，
 * 保持与上游一致的相对结构。清单与理由写在 src/vendor/foliate/README.md。
 *
 * 用 API 的 raw 端点而不是 raw.githubusercontent.com：后者在部分网络下不可达，
 * 前者与把文件写进仓库是等价的（同一 commit 的内容不可变）。
 */
const FOLIATE_SHA = "78914aef4466eb960965702401634c2cb348e9b1";
const FOLIATE_FILES = [
  "LICENSE",
  "view.js",
  "epub.js",
  "epubcfi.js",
  "paginator.js",
  "fixed-layout.js",
  "search.js",
  "overlayer.js",
  "progress.js",
  "text-walker.js",
  "comic-book.js",
  "fb2.js",
  "mobi.js",
  "vendor/zip.js",
  "vendor/fflate.js",
];

async function fetchFoliate() {
  let failed = 0;
  for (const file of FOLIATE_FILES) {
    const url = `https://api.github.com/repos/johnfactotum/foliate-js/contents/${file}?ref=${FOLIATE_SHA}`;
    const dest = path.join(vendor, "foliate", file);
    try {
      const res = await fetch(url, { headers: { Accept: "application/vnd.github.raw" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, Buffer.from(await res.arrayBuffer()));
    } catch (err) {
      failed += 1;
      console.warn(`foliate:${file} 下载失败：${err.message}`);
    }
  }
  if (failed) throw new Error(`${failed}/${FOLIATE_FILES.length} 个文件没有取到，src/vendor/foliate 不完整`);
  // 目录会被整个清空重建，说明文件由脚本生成，别指望手写的能留下来
  await writeFile(path.join(vendor, "foliate", "README.md"), [
    "# foliate-js（离线副本，由 npm run vendor 生成）",
    "",
    `- 来源：https://github.com/johnfactotum/foliate-js`,
    `- 固定提交：\`${FOLIATE_SHA}\``,
    "- 许可证：MIT，见同目录 LICENSE",
    "- 拷贝范围、依赖的接口与升级流程：`docs/ebook-vendor-foliate.md`",
    "",
  ].join("\n"));
  console.log(`foliate-js vendored @ ${FOLIATE_SHA.slice(0, 7)}`);
}

// 拿不到网络时把清空前备份的那份放回去，别让一次失败的 vendor 把可用的电子书模块清空
try {
  await fetchFoliate();
} catch (err) {
  await cp(foliateBackup, foliateDir, { recursive: true }).catch(() => {});
  console.warn(`foliate-js 未更新（已回退到仓库内已有副本）：${err.message}`);
}

await rm(foliateBackup, { recursive: true, force: true });

console.log("vendor 资源已就绪 →", vendor);
