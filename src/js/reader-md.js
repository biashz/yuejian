/**
 * Markdown 渲染辅助：
 * - 把相对图片路径改写成 asset 协议地址（本地图片可直接显示）
 * - 用 highlight.js 做代码高亮（可选依赖，缺失时降级为纯文本）
 * - 提供标题滚动高亮（scroll spy）
 */
import { convertFileSrc } from "./api.js";

const EXTERNAL = /^(?:[a-z]+:)?\/\//i;

function isAbsolutePath(value) {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/** 归一化 `..` 与 `.` 片段，避免拼出非法路径 */
function normalize(path) {
  const parts = [];
  for (const segment of path.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

/** 相对路径 → 绝对路径（Windows 盘符形式） */
function resolvePath(dir, src) {
  let value = src.trim();
  if (/^file:\/\/\//i.test(value)) {
    value = decodeURIComponent(value.replace(/^file:\/\/\//i, ""));
    if (/^\/[a-zA-Z]:/.test(value)) value = value.slice(1);
  }
  if (isAbsolutePath(value)) return value.replace(/\//g, "\\");

  const base = (dir || "").replace(/\\/g, "/");
  const joined = normalize(`${base}/${value}`);
  return joined.replace(/\//g, "\\");
}

function rewriteImages(root, dir) {
  root.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") || "";
    if (!src || EXTERNAL.test(src) || /^(data|blob):/i.test(src)) return;
    img.src = convertFileSrc(resolvePath(dir, src));
    img.loading = "lazy";
    img.addEventListener("error", () => img.classList.add("is-broken"), { once: true });
  });
}

function highlight(root) {
  const hljs = window.hljs;
  if (!hljs) return;
  root.querySelectorAll("pre code").forEach((block) => {
    try {
      hljs.highlightElement(block);
    } catch (_) {
      /* 单个代码块失败不影响正文 */
    }
  });
}

/**
 * 渲染 Markdown HTML 到容器。
 * @returns {HTMLElement[]} 标题元素列表，用于目录定位
 */
export function renderMarkdown(doc, container) {
  container.innerHTML = doc.html || "";
  rewriteImages(container, doc.dir || "");
  highlight(container);
  container.scrollTop = 0;
  return [...container.querySelectorAll("h1[id], h2[id], h3[id]")];
}

/**
 * 监听滚动区域，回调当前视口顶部的标题。
 * @returns {() => void} 取消监听
 */
export function setupScrollSpy(scrollArea, headings, onActive) {
  if (!headings.length) return () => {};
  let ticking = false;

  const measure = () => {
    ticking = false;
    const areaTop = scrollArea.getBoundingClientRect().top + 120;
    let active = headings[0];
    for (const heading of headings) {
      if (heading.getBoundingClientRect().top <= areaTop) active = heading;
      else break;
    }
    onActive(active?.id || "");
  };

  const handler = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(measure);
  };

  scrollArea.addEventListener("scroll", handler, { passive: true });
  measure();
  return () => scrollArea.removeEventListener("scroll", handler);
}

/** 滚动到某个标题 */
export function scrollToHeading(scrollArea, id) {
  const target = document.getElementById(id);
  if (!target) return;
  const offset = target.getBoundingClientRect().top - scrollArea.getBoundingClientRect().top;
  scrollArea.scrollTo({ top: scrollArea.scrollTop + offset - 24, behavior: "smooth" });
}
