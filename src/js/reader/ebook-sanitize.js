/**
 * 章节资源清洗：删掉脚本类标签、内联事件属性、`javascript:` 链接。
 *
 * 为什么必须自己做：foliate 把每章塞进 `blob:` iframe，而那个 iframe 为了事件
 * 不得不开 `allow-scripts`（WebKit bug 218086），库本身不提供任何隔离。外层还有
 * CSP 兜底，但两道都在才算数——CSP 挡的是「执行」，这里挡的是「东西还在」。
 *
 * **入参可能是字符串也可能是字节**：走 `loadReplaced` 的 XHTML 在库里已经被解成
 * 字符串，只有二进制资源才是 Blob 的字节。返回类型必须与入参一致，否则库里
 * `new Blob([data])` 会把二进制写坏，章节直接加载失败（表现为 iframe 里永远没有
 * document，报错却指向 `paginator.js` 的 `viewSize`，极难倒推）。
 */

const DANGEROUS_TAGS = "script,iframe,object,embed,base";
const HAS_DANGEROUS = new RegExp(`<(${DANGEROUS_TAGS.split(",").join("|")})\\b|\\son[a-z]+\\s*=|\\bjavascript:`, "i");

export function stripActiveContent(input, type) {
  const isBytes = typeof input !== "string";
  const text = isBytes ? new TextDecoder().decode(input) : input;
  const same = (out) => (isBytes ? new TextEncoder().encode(out) : out);
  // 绝大多数章节只有正文和 <img>，不值得为每一章都解析再重新序列化（500 章差别明显）
  if (!HAS_DANGEROUS.test(text)) return input;

  try {
    const isXml = /xml|svg/i.test(type);
    const doc = new DOMParser().parseFromString(text, type);
    if (doc.querySelector("parsererror")) throw new Error("not well-formed");
    doc.querySelectorAll(DANGEROUS_TAGS).forEach((node) => node.remove());
    for (const el of doc.querySelectorAll("*")) {
      for (const attr of [...el.attributes]) {
        if (/^on/i.test(attr.name) || /^\s*javascript:/i.test(attr.value)) {
          el.removeAttribute(attr.name);
        }
      }
    }
    const out = isXml
      ? new XMLSerializer().serializeToString(doc)
      : `<!DOCTYPE html>${doc.documentElement.outerHTML}`;
    return same(out);
  } catch (_) {
    // 不是良构 XML 时退化成按标签裁掉 <script>：宁可少删几个事件属性，
    // 也不能因为清洗把一整章正文弄没
    return same(text.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ""));
  }
}
