/**
 * 未声明调用检查（no-undefined-call）+ 模块路径解析检查（no-broken-import）
 * + 界面文案一致性检查（i18n-parity）
 *
 * 针对本项目最易复发的一类缺陷：模块拆分后函数被调用却漏了 import。
 * 这类错误不会在模块链接期报错（标识符被当成全局查找），只有真正执行到那一行才抛
 * `XXX is not defined`，因此静态链接检查与「只跑启动流程」的测试都抓不到。
 *
 * 做法：把注释与字符串挖空 → 收集本文件声明过的名字（import / 函数 / 变量 / 类 / 形参 /
 * 方法简写）→ 找出所有「调用式」标识符 → 减去声明名与全局白名单。
 * 只看调用位置（`name(`），因此不会把属性访问、对象字面量键误判成遗漏声明。
 *
 * 同时校验相对导入的路径是否存在。写错一级目录（把 `./core/dom.js` 写成 `../core/dom.js`）
 * 在 `node --check` 与上面那套检查里全都通得过——`escapeHtml` 已由 import 登记为「已声明」，
 * 但浏览器会在链接期对整个模块图 404，表现为页面一秒都没启动、控制台零报错。
 *
 * 第三项是 i18n：中英两套字典键集必须一样，且代码与 index.html 里用到的键两边都得有。
 * 少一条的表现是「英文界面里冒出一句中文」——不报错、不崩溃，最容易一路带到发布。
 *
 * 退出码：发现问题为 1，可直接接进 CI。
 */
import { readdir, readFile, access } from "node:fs/promises";
import { join, relative, posix } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SRC = join(ROOT, "src", "js");

/** 语言与宿主环境自带的标识符，不在本文件声明也算合法 */
const GLOBALS = new Set([
  // ECMAScript
  "Object", "Array", "String", "Number", "Boolean", "Symbol", "BigInt", "Math", "JSON", "Date",
  "RegExp", "Promise", "Map", "Set", "WeakMap", "WeakSet", "Error", "TypeError", "RangeError",
  "Proxy", "Reflect", "Function", "parseInt", "parseFloat", "isNaN", "isFinite", "decodeURI",
  "decodeURIComponent", "encodeURI", "encodeURIComponent", "structuredClone", "queueMicrotask",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame",
  "cancelAnimationFrame", "fetch", "async function", "if", "for", "while", "switch", "catch",
  "return", "typeof", "new", "delete", "void", "in", "of", "do", "else", "try", "throw", "case",
  // 浏览器
  "window", "document", "navigator", "location", "history", "localStorage", "sessionStorage",
  "console", "alert", "confirm", "prompt", "getComputedStyle", "matchMedia", "CustomEvent",
  "Event", "MouseEvent", "KeyboardEvent", "DragEvent", "DataTransfer", "FormData", "Blob", "File",
  "FileReader", "URL", "URLSearchParams", "AbortController", "IntersectionObserver",
  "ResizeObserver", "MutationObserver", "Worker", "Image", "Audio", "Element", "HTMLElement",
  "Node", "DOMParser", "XMLSerializer", "NodeFilter", "TextEncoder", "TextDecoder", "btoa", "atob", "performance",
  "SpeechSynthesisUtterance",
  "crypto", "innerWidth", "innerHeight", "devicePixelRatio", "screen",
  // 类型化数组与其它内建构造器
  "Uint8Array", "Uint8ClampedArray", "Uint16Array", "Uint32Array", "Int8Array", "Int16Array",
  "Int32Array", "Float32Array", "Float64Array", "ArrayBuffer", "DataView", "WeakRef", "Intl",
  "CSS", "Notification", "IndexedDB", "requestIdleCallback", "showOpenFilePicker",
  // 运行时注入（Tauri / pdf.js / highlight.js）
  "webkitRequestAnimationFrame",
]);

/**
 * 注释挖空；字符串与模板字面量默认也挖空，只保留定界引号。
 * `keepStrings` 时保留原文——模块路径校验需要拿到 `"./core/dom.js"` 里的真实路径。
 */
function blankOut(source, { keepStrings = false } = {}) {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < n && source[i] !== "\n") { out += " "; i += 1; }
      continue;
    }
    if (ch === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) { out += source[i] === "\n" ? "\n" : " "; i += 1; }
      out += "  ";
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      // 保留定界引号，只清空内容：import 的模块路径要被正则识别成 `"   "`，
      // 否则 `import { x } from "./a.js"` 匹配不上，所有导入绑定都会漏登记。
      const quote = ch;
      out += quote;
      i += 1;
      while (i < n && source[i] !== quote) {
        if (source[i] === "\\") { out += keepStrings ? source.slice(i, i + 2) : "  "; i += 2; continue; }
        out += keepStrings ? source[i] : (source[i] === "\n" ? "\n" : " ");
        i += 1;
      }
      out += quote;
      i += 1;
      continue;
    }
    if (ch === "`") {
      out += "`";
      i += 1;
      let depth = 0;
      while (i < n) {
        if (source[i] === "\\") { out += keepStrings ? source.slice(i, i + 2) : "  "; i += 2; continue; }
        if (depth === 0 && source[i] === "`") { break; }
        if (source[i] === "$" && source[i + 1] === "{") { depth += 1; out += "${"; i += 2; continue; }
        if (depth > 0 && source[i] === "}") { depth -= 1; out += "}"; i += 1; continue; }
        if (keepStrings) out += source[i];
        else out += depth > 0 ? source[i] : (source[i] === "\n" ? "\n" : " ");
        i += 1;
      }
      out += "`";
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 从解构模式或参数表里把所有绑定名抽出来（去掉默认值与类型噪音） */
function namesFromPattern(text) {
  return (text.match(/[A-Za-z_$][\w$]*/g) || []).filter((name) => !/^\d/.test(name));
}

/**
 * 取 `code[openIndex]` 这个 `(` 对应的参数表内容。
 * 必须做括号配对而不是 `[^()]*`：本项目大量使用默认参数 `f(pane = activePane())`，
 * 那样 `[^()]*` 直接失配，函数名与形参全都登不上，随后被当成未声明调用狂报。
 */
function parenContent(code, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < code.length; i += 1) {
    if (code[i] === "(") depth += 1;
    else if (code[i] === ")") {
      depth -= 1;
      if (depth === 0) return code.slice(openIndex + 1, i);
    }
  }
  return "";
}

/** 返回 `)` 之前的 `(` 的下标；找不到返回 -1 */
function matchingOpen(code, closeIndex) {
  let depth = 0;
  for (let i = closeIndex; i >= 0; i -= 1) {
    if (code[i] === ")") depth += 1;
    else if (code[i] === "(") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 跳过空白后看下一个字符 */
function nextChar(code, index) {
  let i = index;
  while (i < code.length && /\s/.test(code[i])) i += 1;
  return code[i];
}

function collectDeclared(code) {
  const declared = new Set();

  // import a, { b as c, d } from "..."
  for (const match of code.matchAll(/import\s+([^;]+?)\s+from\s+["'][^"']*["']/g)) {
    const clause = match[1];
    for (const name of clause.match(/[A-Za-z_$][\w$]*/g) || []) {
      if (name === "as" || name === "default") continue;
      declared.add(name);
    }
    // `{ b as c }` 里 `b` 是导出名不是本地名，去掉它
    for (const alias of clause.matchAll(/([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/g)) {
      declared.delete(alias[1]);
      declared.add(alias[2]);
    }
  }
  // import "..." 副作用导入
  for (const match of code.matchAll(/^import\s+["'][^"']*["']/gm)) declared.add("__side_effect__" + match.index);

  // function / async function（形参可含嵌套括号，如 `pane = activePane()`）
  for (const match of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    declared.add(match[1]);
    namesFromPattern(parenContent(code, match.index + match[0].length - 1)).forEach((name) => declared.add(name));
  }
  // class
  for (const match of code.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) declared.add(match[1]);

  // const / let / var（含解构），只取到 `=` 或 `;` 为止
  for (const match of code.matchAll(/\b(?:const|let|var)\s+([^=;\n]+)/g)) {
    const head = match[1];
    const beforeEq = head.split("=")[0];
    for (const name of namesFromPattern(beforeEq)) declared.add(name);
  }

  // 形参：箭头函数 `(...)` / `( ... ) =>` 与单参 `x =>`
  for (const match of code.matchAll(/\)\s*=>/g)) {
    const open = matchingOpen(code, match.index);
    if (open >= 0) namesFromPattern(parenContent(code, open)).forEach((name) => declared.add(name));
  }
  for (const match of code.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) declared.add(match[1]);

  // 方法简写与方法定义：`name(...) {`（含 get/set/static/async 前缀）
  for (const match of code.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (/[\w$.]/.test(code[match.index - 1] || "")) continue;
    if (/^(if|for|while|switch|catch|with|return|typeof|new|delete|void|await|yield|in|of|do|else|case|throw|function|class|super|import|export|async)$/.test(match[1])) continue;
    const open = match.index + match[0].length - 1;
    const params = parenContent(code, open);
    const close = open + 1 + params.length;
    if (code[close] !== ")") continue;
    if (nextChar(code, close + 1) !== "{") continue;
    declared.add(match[1]);
    namesFromPattern(params).forEach((name) => declared.add(name));
  }

  // catch (err)
  for (const match of code.matchAll(/\bcatch\s*\(([^()]*)\)/g)) {
    namesFromPattern(match[1]).forEach((name) => declared.add(name));
  }
  // for (const x of ...) 已被 const 规则覆盖

  return declared;
}

/** 找出所有「调用式」标识符的位置：前面不能是 . 或 $，避免 obj.method( 与 $("...") */
function collectCalls(code) {
  const calls = [];
  for (const match of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1];
    // 关键字构造（if/for/while/switch/catch/return/typeof/new/delete/await/yield 等）
    if (/^(if|for|while|switch|catch|return|typeof|new|delete|void|await|yield|in|of|do|else|case|throw|function|class|super|import|export|async)$/.test(name)) continue;
    const line = code.slice(0, match.index).split("\n").length;
    calls.push({ name, line });
  }
  return calls;
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else if (entry.name.endsWith(".js")) out.push(path);
  }
  return out;
}

const files = await walk(SRC);
const problems = [];
/** 代码里用到的文案键 → 首次出现的文件，用来查「两边字典都没有」 */
const usedKeys = new Map();

/** 相对导入的路径必须真的落在磁盘上；只查静态字符串，动态 import() 不在此列 */
async function checkImports(file, code) {
  const broken = [];
  for (const match of code.matchAll(/\bfrom\s+["'](\.[^"']*)["']/g)) {
    const spec = match[1];
    const target = posix.normalize(posix.join(posix.dirname(relative(ROOT, file).replace(/\\/g, "/")), spec));
    try {
      await access(join(ROOT, target));
    } catch {
      broken.push({ line: code.slice(0, match.index).split("\n").length, spec, target });
    }
  }
  return broken;
}

for (const file of files) {
  const raw = await readFile(file, "utf8");
  // 文案键要在原始源码里找：带 `$` 的是模板拼接（`reader.infoDelimiter.${x}`），跳过
  for (const match of raw.matchAll(/\bt\(\s*["']([^"'`$]+)["']/g)) {
    if (!usedKeys.has(match[1])) usedKeys.set(match[1], relative(ROOT, file).replace(/\\/g, "/"));
  }
  const code = blankOut(raw);
  const declared = collectDeclared(code);
  for (const call of collectCalls(code)) {
    if (declared.has(call.name) || GLOBALS.has(call.name)) continue;
    problems.push({ file: relative(ROOT, file).replace(/\\/g, "/"), line: call.line, name: call.name });
  }
  // 路径校验必须用保留字符串的版本：默认版本会把 "./core/dom.js" 挖成空串
  for (const bad of await checkImports(file, blankOut(raw, { keepStrings: true }))) {
    problems.push({
      file: relative(ROOT, file).replace(/\\/g, "/"),
      line: bad.line,
      name: `import "${bad.spec}" → ${bad.target} 不存在`,
    });
  }
}

/* ---------------- 界面文案一致性 ----------------
   两边键集必须相同；代码与 index.html 用到的键两边都要有。
   没做「反向无用键」检查：常用键是由 data-i18n 属性驱动的，静态扫不全，报了也只是噪音 */
const I18N_FILE = join(SRC, "i18n.js");
const i18nSource = await readFile(I18N_FILE, "utf8");
const zhAt = i18nSource.indexOf("  zh: {");
const enAt = i18nSource.indexOf("  en: {");
/** 字典是扁平的点号键，缩进固定 4 空格，按行取键名即可 */
const dictKeys = (text) => new Set([...text.matchAll(/^ {4}"([^"]+)":/gm)].map((m) => m[1]));
const zhKeys = dictKeys(i18nSource.slice(zhAt, enAt));
const enKeys = dictKeys(i18nSource.slice(enAt));

if (!zhKeys.size || !enKeys.size) {
  problems.push({ file: "src/js/i18n.js", line: 0, name: "解析不出 zh / en 字典，检查脚本需跟着 i18n 结构调整" });
}
for (const key of zhKeys) {
  if (!enKeys.has(key)) problems.push({ file: "src/js/i18n.js", line: 0, name: `en 缺少文案「${key}」` });
}
for (const key of enKeys) {
  if (!zhKeys.has(key)) problems.push({ file: "src/js/i18n.js", line: 0, name: `zh 缺少文案「${key}」` });
}
// 静态标记里的键（index.html 的 data-i18n）
const htmlFile = join(ROOT, "src", "index.html");
const htmlSource = await readFile(htmlFile, "utf8");
for (const match of htmlSource.matchAll(/data-i18n="([^"]+)"/g)) {
  if (!usedKeys.has(match[1])) usedKeys.set(match[1], "src/index.html");
}
for (const [key, where] of usedKeys) {
  if (!zhKeys.has(key) || !enKeys.has(key)) {
    problems.push({ file: where, line: 0, name: `用到的文案「${key}」在 ${zhKeys.has(key) ? "en" : "zh"} 字典里没有` });
  }
}

if (!problems.length) {
  console.log(
    `静态检查通过：${files.length} 个模块，0 处问题（未声明调用 / 导入路径 / i18n ${zhKeys.size} 个键中英一致）`,
  );
  process.exit(0);
}

const byFile = new Map();
for (const item of problems) {
  if (!byFile.has(item.file)) byFile.set(item.file, []);
  byFile.get(item.file).push(item);
}
console.error(`发现 ${problems.length} 处问题（未声明调用 / 导入路径不存在 / i18n 不一致）：\n`);
for (const [file, items] of byFile) {
  console.error(`  ${file}`);
  for (const item of items) {
    console.error(item.name.startsWith("import ") || item.line === 0 ? `    ${item.name}` : `    L${item.line}  ${item.name}(...)`);
  }
  console.error("");
}
process.exit(1);
