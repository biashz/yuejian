/**
 * 侧栏「信息」页：文件的编码、行数、字符数、换行符，以及电子书的出版元数据。
 *
 * 从 `ctx.js` 拆出来的。侧栏四个页签各管一摊，之前挤在一个 500 行的文件里，
 * 改「信息」页要先翻过目录、缩略图、搜索三套代码。
 */
import { $, escapeHtml } from "../core/dom.js";
import { t } from "../i18n.js";
import { kindLabel } from "../core/constants.js";
import { formatBytes } from "../core/format.js";
import { activePane } from "./panes.js";
import { canHighlight, willHighlight } from "../reader-text.js";
import { delimiterLabel } from "../reader-csv.js";

/**
 * 可手动指定的编码。`value` 直接作为标签传给 Rust（`encoding_rs` 认识这些别名），
 * 空串表示交回自动检测。
 *
 * 不必列全部几百种编码：会来切换的场景几乎只有「中文老文件被当成西文解」，
 * 按语种给出最常见的几种即可，列一屏反而不知道选哪个。GB18030 是 GBK / GB2312
 * 的超集，中文三项合并成一条，用户不必再区分自己那份是哪一年的标准。
 */
const ENCODINGS = [
  { value: "", key: "reader.encAuto" },
  { value: "utf-8", key: "reader.encUtf8" },
  { value: "gb18030", key: "reader.encGb" },
  { value: "big5", key: "reader.encBig5" },
  { value: "shift_jis", key: "reader.encSjis" },
  { value: "euc-kr", key: "reader.encKr" },
  { value: "windows-1252", key: "reader.encLatin" },
  { value: "utf-16le", key: "reader.encUtf16le" },
  { value: "utf-16be", key: "reader.encUtf16be" },
];

/**
 * 信息面板里「高亮」这一行只回答「开没开」，不写语言名。
 * 语言是哪个，上面「类型」徽标（RS / JSON / YAML）已经说了；而且 hljs 的
 * 语言名是给内部用的，`ini` 会显示成「TOML, also INI」，直接放出来更糊涂。
 */
function highlightLabel(doc) {
  if (!doc.lang) return t("reader.infoLangNone");
  if (!canHighlight(doc)) return t("reader.infoLangOff");
  return willHighlight(doc) ? t("reader.infoLangOn") : t("reader.infoLangUnsupported");
}

/**
 * 编码下拉。当前生效的是「书架里记的手动值」，不是 `doc.encoding`——
 * 后者是解码后回填的结果，自动检测时它也有值，分不出「用户选的」还是「猜的」。
 */
function encodingMenu(current) {
  const items = ENCODINGS.map((item) => `
    <button class="enc-item ${item.value === current ? "is-on" : ""}"
      role="menuitemradio" aria-checked="${item.value === current}" data-enc="${item.value}">
      ${t(item.key)}
    </button>`).join("");
  return `<div class="enc-menu" id="encMenu" role="menu" hidden>${items}</div>`;
}

/** 文本类的文件信息：编码、行数、字符数、换行符。编码是重点——探测可能不准 */
function renderInfo() {
  const body = $("#ctxBody");
  const pane = activePane();
  const doc = pane?.doc;
  if (doc?.kind === "ebook") return renderEbookInfo(pane);
  if (!doc || doc.kind !== "text") {
    body.innerHTML = `<div class="ctx-empty">${t("reader.infoEmpty")}</div>`;
    return;
  }
  const row = (key, value) => `<div class="info-row"><dt>${key}</dt><dd>${escapeHtml(value)}</dd></div>`;
  // 编码一行可点开：探测错了就在这里当场换一个重开，不必去翻设置
  const manual = pane.book?.encoding || "";
  const encodingRow = `
    <div class="info-row is-action">
      <dt>${t("reader.infoEncoding")}</dt>
      <dd><button class="info-enc" data-enc-toggle aria-haspopup="true" aria-expanded="false"
        aria-controls="encMenu">${escapeHtml(doc.encoding)}<span class="info-enc-tag">${
          manual ? t("reader.encManual") : t("reader.encAutoTag")
        }</span><span class="info-caret" aria-hidden="true">▾</span></button></dd>
    </div>`;

  const rows = [row(t("reader.infoKind"), kindLabel("text", pane.book)), encodingRow, encodingMenu(manual), row(t("reader.infoLines"), String(doc.lines))];
  // 大文件不整篇解码，字符数根本统计不出来——这一行宁可不显示，也不写 0 骗人
  if (!doc.windowed) rows.push(row(t("reader.infoChars"), String(doc.chars)));
  rows.push(
    row(t("reader.infoEol"), doc.eol),
    row(t("reader.infoSize"), formatBytes(pane.book?.size || 0)),
    row(t("reader.infoLang"), highlightLabel(doc)),
  );
  // 分隔符只在表格类文档上有意义：它决定了列是怎么拆的，拆错了要能看出来
  if (doc.mode === "table" && !doc.windowed) {
    const delimiter = pane.table?.delimiter || ",";
    rows.push(row(t("reader.infoDelimiter"), t(`reader.infoDelimiter.${delimiterLabel(delimiter)}`)));
  }
  body.innerHTML = `
    <dl class="info-list">${rows.join("")}</dl>
    ${doc.windowed ? `<p class="info-note">${t("reader.infoWindowed")}</p>` : ""}
    ${doc.clipped ? `<p class="info-note">${t("reader.infoClipped")}</p>` : ""}
    ${doc.truncated ? `<p class="info-note">${t("reader.infoTruncated")}</p>` : ""}
    ${pane.table?.clipped ? `<p class="info-note">${t("reader.infoTableClipped")}</p>` : ""}
    <p class="info-note">${t("reader.infoEncodingHint")}</p>`;
}

/**
 * 电子书信息：出版元数据来自书本身（OPF），比书架当初从文件名猜的可靠。
 * 这里只读不写——书名与作者在打开时已经回填到书架条目上了。
 */
function renderEbookInfo(pane) {
  const body = $("#ctxBody");
  const book = pane?.book;
  const meta = pane?.ebook?.book?.metadata || {};
  const row = (key, value) => `<div class="info-row"><dt>${key}</dt><dd>${escapeHtml(value)}</dd></div>`;
  const rows = [
    row(t("reader.infoKind"), kindLabel("ebook", book)),
    row(t("reader.infoChapters"), String(pane?.ebook?.chapters || pane?.ebookToc?.length || 0)),
    row(t("reader.infoSize"), formatBytes(book?.size || 0)),
  ];
  if (meta.title) rows.push(row(t("reader.infoTitle"), String(meta.title)));
  if (meta.author) rows.push(row(t("reader.infoAuthor"), String(meta.author)));
  if (meta.publisher) rows.push(row(t("reader.infoPublisher"), String(meta.publisher)));
  if (meta.language) rows.push(row(t("reader.infoLanguage"), String(meta.language)));
  body.innerHTML = `<dl class="info-list">${rows.join("")}</dl>
    <p class="info-note">${t("reader.infoEbookHint")}</p>`;
}

export { renderInfo };
