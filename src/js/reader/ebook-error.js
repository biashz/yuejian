/**
 * 把解析器抛出来的错误折成一句人话。
 *
 * 库里的错误是给开发者看的：`UnsupportedTypeError`、`End of central directory
 * record signature not found`、`Missing MOBI header`……直接贴到界面上，用户读到的是
 * 一段英文加一个栈帧，能做的只有「再下一次」——而真正的原因往往是文件本身不完整，
 * 或者只是把 .zip 改成了 .epub。
 *
 * 只做归类，不改写细节：认得出来的两类给固定说法，认不出来的原样保留，
 * 免得把有用的线索盖掉。
 */

/**
 * @param {unknown} error 解析阶段抛出的错误
 * @param {string} format epub / fb2 / cbz / mobi …
 * @param {(key: string, params?: object) => string} translate i18n 的 t
 * @returns {string}
 */
export function explainEbookError(error, format, translate) {
  const name = String(error?.name || "");
  const message = String(error?.message || error || "");
  const label = String(format || "").toUpperCase();

  if (name === "UnsupportedTypeError" || /not supported|unsupported/i.test(message)) {
    return translate("reader.ebookUnsupported", { format: label });
  }
  // zip 的结构性错误（EOCD / 中央目录 / 条目）、XML 解析失败、容器缺件，都归到「文件不完整」
  if (/zip|central directory|signature|corrupt|invalid|missing|truncated|end of data|parsererror|xml|parsing/i.test(message)) {
    return translate("reader.ebookCorrupt", { format: label });
  }
  return message || translate("reader.ebookCorrupt", { format: label });
}
