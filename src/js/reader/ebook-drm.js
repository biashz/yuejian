/**
 * DRM 探测：只回答「这本书是不是加密的」，不做任何解密。
 *
 * 为什么要单独探一次，而不是等库里报错：加密的书在 `makeBook` 里会以
 * 「Missing MOBI header」「无法解析 OPF」之类的形式失败，用户看到的是
 * 「文件损坏」，于是去重新下载同一本书——问题不在文件。一句话说清是哪种方案，
 * 用户才知道该去哪儿换一个不带 DRM 的版本。
 *
 * 两类判定，都是读文件头，不解包全文：
 *
 * - **EPUB**：`META-INF/encryption.xml` 里列了加密字体以外的算法。EPUB 3 允许
 *   只混淆内嵌字体（IDPF / Adobe 两种算法），那种书是能正常读的，foliate 自己会
 *   解混淆——列进去的算法全是这两位，就不算 DRM。
 * - **MOBI / AZW3**：PalmDOC 头第 12 字节的 encryption type，0 是未加密。
 */

/** 允许的「加密」——只混淆字体，正文仍是明文 */
const FONT_ONLY = /(idpf\.org\/2008\/embedding|ns\.adobe\.com\/pdf\/enc#RC)$/i;

/**
 * @param {File} file
 * @param {string} format epub / mobi / azw / azw3 …
 * @returns {Promise<string>} 加密方案名；未加密返回空串
 */
export async function detectDrm(file, format) {
  try {
    if (format === "epub") return await epubDrm(file);
    if (format === "mobi" || format === "azw" || format === "azw3") return await mobiDrm(file);
  } catch (_) {
    // 探测失败不该挡住打开：判定不出来就交给解析器，让它报自己的错
  }
  return "";
}

async function mobiDrm(file) {
  // PalmDB 头 78 字节，紧接着是记录表，第 0 条记录的偏移就在 78 处
  const head = new DataView(await file.slice(0, 82).arrayBuffer());
  const record0 = head.getUint32(78);
  if (!record0) return "";
  // PalmDOC 头：compression(0) … encryption 在偏移 12，大端 2 字节
  const palmdoc = new DataView(await file.slice(record0, record0 + 14).arrayBuffer());
  const type = palmdoc.getUint16(12);
  if (!type) return "";
  return type === 1 ? "Mobipocket" : "Kindle";
}

async function epubDrm(file) {
  // 只用 zip.js 读中央目录那一条：它是 BlobReader，按需读，不会把整本书拉进内存
  const { configure, ZipReader, BlobReader, TextWriter } =
    await import("../../vendor/foliate/vendor/zip.js");
  configure({ useWebWorkers: false });
  const reader = new ZipReader(new BlobReader(file));
  try {
    const entries = await reader.getEntries();
    const entry = entries.find((item) => item.filename === "META-INF/encryption.xml");
    if (!entry) return "";
    const xml = await entry.getData(new TextWriter());
    const algorithms = [...String(xml).matchAll(/Algorithm\s*=\s*"([^"]+)"/gi)].map((m) => m[1]);
    if (!algorithms.length || algorithms.every((item) => FONT_ONLY.test(item))) return "";
    return schemeName(String(xml));
  } finally {
    // 不关会留着一条打开的句柄；失败也要关，所以放 finally
    reader.close().catch(() => {});
  }
}

/** 从 encryption.xml 认出是哪家的方案，认不出就叫它「未知」 */
function schemeName(xml) {
  if (/adept|adobe/i.test(xml)) return "Adobe ADEPT";
  if (/fairplay|apple/i.test(xml)) return "Apple FairPlay";
  if (/kindle|amazon/i.test(xml)) return "Kindle";
  return "未知方案";
}
