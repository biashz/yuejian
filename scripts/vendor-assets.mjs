/**
 * 把 npm 依赖中的运行时资源拷贝到 src/vendor，保证应用离线可用。
 * 运行：npm run vendor
 */
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const vendor = path.join(root, "src", "vendor");

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

console.log("vendor 资源已就绪 →", vendor);
