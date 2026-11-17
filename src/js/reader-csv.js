/**
 * CSV / TSV 的解析与表格渲染。
 *
 * 解析按 RFC 4180 的规则手写，不引依赖：规则只有四条——引号包裹、`""` 表示一个
 * 引号、引号内可含分隔符与换行、行以换行结束。这点体量不值得为它多打一个包，
 * 而且放在前端可以复用已经传过来的正文，不必把解析结果再经 IPC 传一遍。
 *
 * 分隔符不按扩展名硬编码，而是从表头行数出来的：`.tsv` 是制表符，欧洲的 CSV
 * 常用分号，靠扩展名去猜反而不如直接看文件内容准。
 */

/** 表格最多渲染这么多行。再多的部分不渲染，并在界面上写明——不做静默截断 */
export const MAX_TABLE_ROWS = 1200;

/** 列数上限：防畸形文件（整篇没有换行）把表格撑成几万列 */
export const MAX_TABLE_COLS = 60;

/** 只看前若干个字符判断分隔符，避免大文件为了猜一个字符扫全篇 */
const DETECT_WINDOW = 4096;

const DELIMITERS = [
  { char: ",", label: "comma" },
  { char: "\t", label: "tab" },
  { char: ";", label: "semicolon" },
];

/**
 * 从表头行判断分隔符。
 * 只统计引号外的字符，否则 `"a,b",c` 里的逗号会被算进去。
 */
export function detectDelimiter(text) {
  const head = text.slice(0, DETECT_WINDOW);
  const counts = new Map(DELIMITERS.map((d) => [d.char, 0]));
  let quoted = false;

  for (let i = 0; i < head.length; i += 1) {
    const ch = head[i];
    if (quoted) {
      if (ch === '"') {
        if (head[i + 1] === '"') i += 1; // "" 是转义，不是收尾
        else quoted = false;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === "\n") break; // 只看第一行
    if (counts.has(ch)) counts.set(ch, counts.get(ch) + 1);
  }

  let best = ",";
  let bestCount = 0;
  for (const [char, count] of counts) {
    if (count > bestCount) {
      best = char;
      bestCount = count;
    }
  }
  return best;
}

/** 分隔符 → 界面文案用的键 */
export function delimiterLabel(delimiter) {
  return DELIMITERS.find((d) => d.char === delimiter)?.label || "comma";
}

/**
 * 按 RFC 4180 解析。返回二维数组，行内列数可能不齐——渲染时再补空，
 * 补在这里会让「这一行本来就少一列」这个信息丢失。
 */
export function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    // 引号只在字段开头才是定界符：`a"b` 里的引号按普通字符处理
    if (ch === '"' && field === "") {
      quoted = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += ch;
  }

  // 末尾没有换行时收尾；`a\n` 结尾不会多出一行空行
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function escapeCell(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 解析并生成表格 HTML。
 *
 * 第一行当表头——CSV 的通行约定如此。行号是表格自己的第一列（粘在左侧），
 * 不复用等宽视图那条行号栏。
 *
 * @returns {{html: string, rows: number, cols: number, totalRows: number, delimiter: string, clipped: boolean}}
 */
export function buildTable(text, maxRows = MAX_TABLE_ROWS, maxCols = MAX_TABLE_COLS) {
  const delimiter = detectDelimiter(text);
  const parsed = parseDelimited(text, delimiter);
  const totalRows = parsed.length;

  // 列数取前若干行的最大值：只扫开头，避免为了算列数把整个文件过一遍
  let cols = 0;
  for (let i = 0; i < Math.min(parsed.length, 500); i += 1) {
    if (parsed[i].length > cols) cols = parsed[i].length;
  }
  cols = Math.min(Math.max(cols, 1), maxCols);

  const shown = parsed.slice(0, Math.max(maxRows, 1));
  const header = shown[0] || [];
  const body = shown.slice(1);

  const cells = (row, tag) => {
    let out = "";
    for (let c = 0; c < cols; c += 1) {
      out += `<${tag}>${escapeCell(row[c] ?? "")}</${tag}>`;
    }
    return out;
  };

  const thead =
    `<thead><tr><th class="tx-rowno" scope="col">#</th>${cells(header, "th")}</tr></thead>`;
  const tbody = body
    .map((row, index) => {
      const n = index + 1;
      return `<tr><th class="tx-rowno" scope="row">${n}</th>${cells(row, "td")}</tr>`;
    })
    .join("");

  return {
    html: `<div class="tx-table-wrap"><table class="tx-table">${thead}<tbody>${tbody}</tbody></table></div>`,
    rows: body.length,
    cols,
    totalRows,
    delimiter,
    clipped: totalRows > shown.length || parsed.some((row) => row.length > cols),
  };
}
