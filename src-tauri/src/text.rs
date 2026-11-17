//! 文本格式（txt / log / csv / 代码配置）的解码与统计。
//!
//! 中文用户最常见的场景，是 Windows 记事本以 ANSI（简中 = GBK）存出来的 `.txt`。
//! `read_to_string` 遇到这种文件不是「显示乱码」而是直接报错（invalid UTF-8），
//! 用户看到的是一句他无法处理的英文错误。所以这里走三级流水线：
//!
//! 1. BOM 是硬证据，存在时任何探测都让位；
//! 2. 没有 BOM 时用 `chardetng` 在前 8KB 上猜（Firefox 在用的探测器）；
//! 3. 统一交给 `encoding_rs` 做**有损**解码——宁可个别字符变成 U+FFFD，
//!    也要把文件显示出来，而不是把用户挡在错误信息外面。
//!
//! 编码识别不是 100% 准确的（短文件尤甚），因此 `encoding` 会回传给界面，
//! 由「信息」面板显示出来——用户遇到乱码时，至少能据此判断是文件本身有问题
//! 还是判定错了。判错了就在同一个面板里换一个编码重开：`encoding_of` 负责把
//! 界面传来的标签归一化成 `encoding_rs` 的说法，选择写回书架，下次打开沿用。
//! 指定编码时**跳过所有自动判定**，包括二进制检测——「看起来不像文本」也是
//! 一种判定，用户既然明确说了是什么，就不该被它挡住。
//!
//! 大文件（> `MAX_VIEW_BYTES`）不整篇解码，而是先建一份**行索引**（每行的起始
//! 字节偏移），由前端按可视区窗口取用。索引只存偏移不存内容，100MB 日志约
//! 100 万行、索引约 4MB，与文件大小基本脱钩。

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};
use serde::Serialize;

/// 探测器与二进制检测都只看开头这么多字节：对准确率没有损失的窗口足够小，
/// 避免打开一个大文件时先把它整个扫一遍。
pub const SNIFF_BYTES: usize = 8 * 1024;

/// 文本类文档的元信息 + 正文。
///
/// 小文件（≤ `MAX_VIEW_BYTES`）一次性带回正文；大文件只带元信息（`windowed = true`），
/// 正文由 `read_text_window` 按可视区取，见文件头部的说明。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDoc {
    /// 已解码的正文；`windowed` 时为空串
    pub text: String,
    /// 实际使用的编码名，如 `UTF-8` / `GB18030` / `UTF-16LE`
    pub encoding: String,
    /// 行数（按 `\n` 计，末行没有换行符也算一行）
    pub lines: u32,
    /// 字符数（Unicode 标量值，不是字节数）；`windowed` 时无从统计，为 0
    pub chars: u32,
    /// `LF` / `CRLF` / `CR`
    pub eol: String,
    /// 语法高亮的语言别名；空串表示不做高亮
    pub lang: String,
    /// 默认视图模式：`plain` / `code` / `table`
    pub mode: String,
    /// 是否只加载了文件开头一部分
    pub truncated: bool,
    /// 是否走窗口模式（大文件）：正文按需取，不随本次响应回传
    pub windowed: bool,
    /// 窗口模式下是否还有没索引到的行（超过行数上限）
    pub clipped: bool,
}

/// 小文件的读取上限。超过它不再整篇解码：要么走行索引 + 窗口（`windowed`），
/// 要么退回截断（编码或行结构不适合窗口时）。
///
/// 8MB 这个数的依据：一次性把正文交给前端最简单也最稳，8MB 的字符串经 IPC
/// 传输约几十毫秒，两棵 `<pre>` 的排版也在毫秒级；再大就该走窗口了。
pub const MAX_VIEW_BYTES: u64 = 8 * 1024 * 1024;

/// 窗口模式的最小行数。行数太少的超大文件（压缩过的 JSON、超长单行）没有
/// 「按窗口翻」的意义，退回截断更诚实——否则一次窗口就是几十 MB。
pub const MIN_VIRTUAL_LINES: u32 = 64;

/// 索引支持的体积上限。行起点用 `u32` 存，超过 4GB 的文本文件不在支持范围内
/// （这种体量已经不是「随手看一眼」，明确报错好过静默出错）。
pub const MAX_INDEX_BYTES: u64 = u32::MAX as u64;

/// 窗口模式下可导航的最大行数。
///
/// 这个数由浏览器对**元素高度**的上限倒推出来：Tauri 用的 WebView2（Chromium）、
/// WKWebView 与 WebKitGTK 的布局尺寸上限都在 3355 万像素附近，前端按 20px 行高
/// 铺画布，30 047 000 像素对应约 150 万行，留了一点余量。
/// 超过这个行数不报错也不退回截断，而是只暴露前 150 万行并把 `clipped` 标出来——
/// 150 万行已经是 100MB 量级的日志，剩下的部分明确告知，比停在 8MB 更近人情。
pub const MAX_WINDOWED_LINES: u32 = 1_500_000;

/// 一次窗口最多取这么多字节。单行特别长的文件靠它兜底：宁可少给几行，
/// 也不让一次 IPC 传几十 MB。
pub const MAX_WINDOW_BYTES: u64 = 8 * 1024 * 1024;

/// 前 8KB 里出现 NUL 字节即判定「不是文本」。图片、压缩包被改名成 `.txt` 时，
/// 与其渲染满屏乱码，不如明确告诉用户这不是文本文件。
///
/// 有 BOM 时直接判为文本：UTF-16 正文里每个 ASCII 字符都跟着一个 0x00，
/// 拿 NUL 当二进制证据会把整类 UTF-16 文件挡在门外，而 BOM 是比 NUL 更硬的证据。
pub fn looks_binary(bytes: &[u8]) -> bool {
    if sniff_bom(bytes).is_some() {
        return false;
    }
    bytes.iter().take(SNIFF_BYTES).any(|b| *b == 0)
}

/// 解码整段字节，返回正文与实际采用的编码。
pub fn decode(bytes: &[u8]) -> (String, &'static Encoding) {
    if let Some(encoding) = sniff_bom(bytes) {
        // `decode` 会自行剥掉 BOM，并回填真实生效的编码
        let (text, actual, _) = encoding.decode(bytes);
        return (text.into_owned(), actual);
    }

    let mut detector = chardetng::EncodingDetector::new();
    let window = &bytes[..bytes.len().min(SNIFF_BYTES)];
    detector.feed(window, bytes.len() <= SNIFF_BYTES);
    // allow_utf8 = true：以 ASCII 为主的文本（大部分代码）应优先落到 UTF-8 上
    let guessed = detector.guess(None, true);
    let (text, actual, _) = guessed.decode(bytes);
    (text.into_owned(), actual)
}

/// 把界面传来的编码标签归一化成 `encoding_rs` 的编码表项。
///
/// 返回 `None` 表示这个标签不认识——此时宁可报错让用户重选，也不要静默按
/// UTF-8 解，否则「我明明选了 GBK 还是乱码」会变成更难查的问题。
pub fn encoding_of(label: &str) -> Option<&'static Encoding> {
    Encoding::for_label(label.trim().as_bytes())
}

fn sniff_bom(bytes: &[u8]) -> Option<&'static Encoding> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Some(UTF_8);
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return Some(UTF_16LE);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return Some(UTF_16BE);
    }
    None
}

/// 把字节截到「最后一个完整行」的边界。
///
/// 直接切在任意字节上会把一个 UTF-8 汉字的三个字节劈开，解码后末尾会多出一个 U+FFFD，
/// 看起来像文件损坏。切在换行之后既能避免这个问题，也让「已加载前 8MB」这句话成立。
pub fn truncate_at_line(bytes: &[u8]) -> &[u8] {
    match bytes.iter().rposition(|b| *b == b'\n') {
        // 保留换行符本身：行数统计与「最后一行有没有换行」的判断才准确
        Some(pos) => &bytes[..=pos],
        None => bytes,
    }
}

/// 换行符统计：以出现次数最多的为准，全都没有时按 LF 处理
fn eol_of(text: &str) -> &'static str {
    let (mut crlf, mut lf, mut cr) = (0u32, 0u32, 0u32);
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'\r' => {
                if bytes.get(index + 1) == Some(&b'\n') {
                    crlf += 1;
                    index += 2;
                    continue;
                }
                cr += 1;
            }
            b'\n' => lf += 1,
            _ => {}
        }
        index += 1;
    }
    if crlf >= lf && crlf >= cr && crlf > 0 {
        "CRLF"
    } else if cr > lf && cr > 0 {
        "CR"
    } else {
        // 只剩下 LF，或者整篇没有任何换行（单行文件按 LF 记，不影响显示）
        "LF"
    }
}

/// 文本类文档的视图模式与高亮语言；不是文本格式时返回 `None`。
///
/// `mode` 只是**默认值**：用户可以随时在工具栏覆盖，而且覆盖只作用于本次会话
/// （把上一次读日志选的「等宽」带到下一次打开的散文里，是很烦人的事）。
pub fn classify(ext: &str, file_name: &str) -> Option<(&'static str, &'static str)> {
    let ext = ext.to_lowercase();
    let name = file_name.to_lowercase();

    // 没有扩展名、但约定俗成的文件名，先按名字判断
    let by_name = name.as_str();
    if by_name.starts_with("readme") || by_name.starts_with("license") || by_name.starts_with("changelog") {
        return Some(("plain", ""));
    }
    if by_name == "makefile" || by_name == "justfile" {
        return Some(("code", "makefile"));
    }
    if by_name == "dockerfile" {
        return Some(("code", ""));
    }
    if by_name == ".gitignore" || by_name == ".gitattributes" || by_name == ".editorconfig" || by_name.starts_with(".env") {
        return Some(("code", ""));
    }

    let known = match ext.as_str() {
        // 表格：表格视图按分隔符拆行，分隔符由前端从表头行数出来（.tsv 是制表符，
        // 欧洲的 CSV 常用分号），比按扩展名硬编码更准
        "csv" | "tsv" => ("table", ""),

        // 日志：没有语言可高亮，但需要行号与横向滚动
        "log" | "nfo" => ("code", ""),

        // 纯文本
        "txt" | "text" | "me" | "lic" => ("plain", ""),

        // 代码与配置：语言别名对齐 highlight.js 11 的 common bundle，
        // 表里没有的语言一律交空串（高亮猜错的干扰比不高亮更大）
        "json" | "jsonc" | "json5" => ("code", "json"),
        "yml" | "yaml" => ("code", "yaml"),
        "toml" => ("code", "ini"),
        "ini" | "conf" | "config" | "properties" | "env" | "cnf" => ("code", "ini"),
        "xml" | "svg" | "htm" | "html" | "vue" | "svelte" => ("code", "xml"),
        "css" => ("code", "css"),
        "scss" => ("code", "scss"),
        "less" => ("code", "less"),
        "js" | "mjs" | "cjs" | "jsx" => ("code", "javascript"),
        "ts" | "tsx" | "mts" | "cts" => ("code", "typescript"),
        "rs" => ("code", "rust"),
        "go" => ("code", "go"),
        "py" | "pyw" => ("code", "python"),
        "java" => ("code", "java"),
        "kt" | "kts" => ("code", "kotlin"),
        "c" | "h" => ("code", "c"),
        "cc" | "cpp" | "cxx" | "hpp" | "hh" | "hxx" => ("code", "cpp"),
        "cs" => ("code", "csharp"),
        "php" => ("code", "php"),
        "rb" => ("code", "ruby"),
        "swift" => ("code", "swift"),
        "m" | "mm" => ("code", "objectivec"),
        "lua" => ("code", "lua"),
        "pl" | "pm" => ("code", "perl"),
        "r" => ("code", "r"),
        "sh" | "bash" | "zsh" | "fish" | "ksh" => ("code", "bash"),
        "ps1" | "psm1" => ("code", ""),
        "bat" | "cmd" | "vbs" => ("code", ""),
        "sql" => ("code", "sql"),
        "graphql" | "gql" => ("code", "graphql"),
        // 只认 .vb（VB.NET）。.vbs 是 VBScript，语法不是一回事，用 VB.NET 的
        // 规则去标只会标错，宁可不高亮
        "vb" => ("code", "vbnet"),
        "diff" | "patch" => ("code", "diff"),
        "gradle" => ("code", "java"),
        "tex" => ("code", ""),
        "dockerfile" => ("code", ""),
        "lock" => ("code", ""),
        "cmake" => ("code", ""),
        "mk" => ("code", "makefile"),

        _ => return None,
    };
    Some(known)
}

/// 这个扩展名 / 文件名是否属于「文本类」
pub fn is_text(ext: &str, file_name: &str) -> bool {
    classify(ext, file_name).is_some()
}

/// 组装文档：解码 → 剥掉结尾多余的换行 → 统计
pub fn build(text: String, encoding: &str, lang: &str, mode: &str, truncated: bool) -> TextDoc {
    let chars = text.chars().count() as u32;
    let lines = text.lines().count() as u32;
    let eol = eol_of(&text).to_string();
    TextDoc {
        text,
        encoding: encoding.to_string(),
        lines,
        chars,
        eol,
        lang: lang.to_string(),
        mode: mode.to_string(),
        truncated,
        windowed: false,
        clipped: false,
    }
}

/// 组装窗口模式的文档：只有元信息，正文留给 `read_text_window` 按需取。
///
/// `chars` 只能是 0——统计字符数要整篇解码，那正是窗口模式要避免的事。
/// 界面据此隐藏「字数」，改显示行数。
pub fn build_virtual(
    lines: u32,
    encoding: &str,
    eol: &str,
    lang: &str,
    mode: &str,
    clipped: bool,
) -> TextDoc {
    TextDoc {
        text: String::new(),
        encoding: encoding.to_string(),
        lines,
        chars: 0,
        eol: eol.to_string(),
        lang: lang.to_string(),
        mode: mode.to_string(),
        truncated: false,
        windowed: true,
        clipped,
    }
}

/// 按已知编码解码一段字节。
///
/// 窗口是切开读的，不能再用探测器重新猜——必须沿用打开时判定的编码，
/// 否则同一份文件前后两屏可能是两种解码结果。
pub fn decode_with(bytes: &[u8], label: &str) -> String {
    let encoding = Encoding::for_label(label.as_bytes()).unwrap_or(UTF_8);
    let (text, _, _) = encoding.decode(bytes);
    text.into_owned()
}

/// 这种编码能否安全地按字节切行。
///
/// 单字节与 UTF-8 / GB18030 的续字节都不会是 `0x0A`，按 `\n` 切一定落在
/// 字符边界上；UTF-16 的换行是两个字节，切在 `0x0A` 上可能劈开一个码元
/// （UTF-16BE 里 U+0A00 的高字节就是 0x0A），因此大文件不进窗口模式。
pub fn line_safe(encoding: &str) -> bool {
    !encoding.to_uppercase().starts_with("UTF-16")
}

/* ---------------- 行索引与窗口读取 ---------------- */

/// 大文件的行索引：每行的起始字节偏移 + 统计信息。
pub struct LineIndex {
    starts: Vec<u32>,
    size: u64,
    pub encoding: String,
    pub eol: String,
    /// 行数超过 `MAX_WINDOWED_LINES`，后面还有没索引到的行
    pub clipped: bool,
}

impl LineIndex {
    pub fn lines(&self) -> u32 {
        self.starts.len() as u32
    }

    /// 第 `line` 行起始处的字节偏移。末行之后返回文件长度——所以它同时
    /// 也是「前 `line` 行的总字节数」，窗口截断就靠这一点。
    fn offset_of(&self, line: u32) -> u64 {
        self.starts.get(line as usize).copied().map(u64::from).unwrap_or(self.size)
    }
}

/// 扫出每行的起始字节偏移。返回索引与「是否因为行数上限提前停止」。
///
/// 规则与 `str::lines()` 一致：末尾的换行不额外算一行，「a\nb\n」是 2 行、
/// 「\n」是 1 行、空文件是 0 行。所以判断「换行后还有没有内容」必须看下一块，
/// 这也是这里要留 `pending` 的原因。
pub fn scan_line_starts<R: Read>(mut reader: R, max_lines: usize) -> io::Result<(Vec<u32>, bool)> {
    const CHUNK: usize = 1 << 20;

    let mut buffer = vec![0u8; CHUNK];
    let mut starts: Vec<u32> = vec![0];
    let mut base: u64 = 0;
    // 上一块以换行结尾：那一行是否存在，要看这一块还有没有字节
    let mut pending: Option<u32> = None;
    let mut seen = false;

    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        if let Some(start) = pending.take() {
            // 走到这里说明这一行后面确实还有内容，是真实的一行
            if starts.len() >= max_lines {
                return Ok((starts, true));
            }
            starts.push(start);
        }
        seen = true;

        // memchr 是 SIMD 的字节搜索：26MB 的日志建索引从 264ms 降到二十几毫秒，
        // 换行查找占了建索引的全部时间，值得用
        for index in memchr::memchr_iter(b'\n', &buffer[..read]) {
            let next = base + index as u64 + 1;
            if next > u64::from(u32::MAX) {
                return Err(too_big());
            }
            let next = next as u32;
            // 块内还有字节，说明换行后面确实还有一行；否则留给下一块判断
            if index + 1 < read {
                if starts.len() >= max_lines {
                    return Ok((starts, true));
                }
                starts.push(next);
            } else {
                pending = Some(next);
            }
        }
        base += read as u64;
    }

    if !seen {
        return Ok((Vec::new(), false));
    }
    Ok((starts, false))
}

fn too_big() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "文件超过 4GB，不支持窗口模式")
}

/// 为一个大文件建立行索引。
///
/// 只做两件 IO：读前 64KB 判换行符、按 1MB 分块扫一遍字节。100MB 的日志
/// 大约几百毫秒，放在 `spawn_blocking` 里对界面无感。
pub fn build_index(path: &Path, encoding: &str, size: u64) -> io::Result<LineIndex> {
    if size > MAX_INDEX_BYTES {
        return Err(too_big());
    }

    let mut head = vec![0u8; 64 * 1024];
    let head_len = {
        let mut file = File::open(path)?;
        let read = file.read(&mut head)?;
        head.truncate(read);
        read
    };
    let eol = if head_len == 0 {
        "LF".to_string()
    } else {
        eol_of(&decode_with(&head, encoding)).to_string()
    };

    let file = File::open(path)?;
    let (starts, clipped) =
        scan_line_starts(io::BufReader::with_capacity(1 << 20, file), MAX_WINDOWED_LINES as usize)?;
    Ok(LineIndex {
        starts,
        size,
        encoding: encoding.to_string(),
        eol,
        clipped,
    })
}

/// 读第 `start` 行起的若干行，返回原始字节与**实际行数**。
///
/// 字节数超过 `MAX_WINDOW_BYTES` 时会在行边界上少给几行——首尾都是完整行，
/// 前端按收到的 `\n` 数就能知道拿到几行，不需要额外的元信息。
pub fn read_window(
    file: &mut File,
    index: &LineIndex,
    start: u32,
    count: u32,
) -> io::Result<(Vec<u8>, u32)> {
    let total = index.lines();
    let start = start.min(total);
    let begin = index.offset_of(start);
    let mut end = start.saturating_add(count).min(total);
    // 单行特别长的文件：宁可少给几行，也不让一次 IPC 传几十 MB
    while end > start + 1 && index.offset_of(end) - begin > MAX_WINDOW_BYTES {
        end -= 1;
    }

    let size = (index.offset_of(end) - begin) as usize;
    let mut buffer = vec![0u8; size];
    file.seek(SeekFrom::Start(begin))?;
    file.read_exact(&mut buffer)?;
    Ok((buffer, end - start))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_bom_is_stripped() {
        let bytes = [0xEF, 0xBB, 0xBF, b'h', b'i'];
        let (text, encoding) = decode(&bytes);
        assert_eq!(text, "hi");
        assert_eq!(encoding.name(), "UTF-8");
    }

    #[test]
    fn gbk_text_decodes() {
        // "中文" 的 GBK 编码
        let bytes = [0xD6, 0xD0, 0xCE, 0xC4];
        let (text, _encoding) = decode(&bytes);
        assert_eq!(text, "中文");
    }

    #[test]
    fn eol_detection() {
        assert_eq!(eol_of("a\r\nb\r\n"), "CRLF");
        assert_eq!(eol_of("a\nb\n"), "LF");
        assert_eq!(eol_of("a\rb\r"), "CR");
    }

    #[test]
    fn binary_sniff() {
        assert!(looks_binary(&[0x00, 0x01, 0x02]));
        assert!(!looks_binary("普通文本".as_bytes()));
    }

    #[test]
    fn truncate_keeps_last_full_line() {
        assert_eq!(truncate_at_line(b"aa\nbb\ncc"), b"aa\nbb\n");
        assert_eq!(truncate_at_line(b"no-newline"), b"no-newline");
    }

    #[test]
    fn classify_common_extensions() {
        assert_eq!(classify("log", "a.log").unwrap().0, "code");
        assert_eq!(classify("txt", "a.txt").unwrap().0, "plain");
        // 表格视图已实现，CSV / TSV 回到 table 才是对的
        assert_eq!(classify("csv", "a.csv").unwrap().0, "table");
        assert_eq!(classify("tsv", "a.tsv").unwrap().0, "table");
        assert_eq!(classify("rs", "a.rs").unwrap().1, "rust");
        assert_eq!(classify("graphql", "a.graphql").unwrap().1, "graphql");
        // .vbs 是 VBScript，不能被当成 VB.NET 高亮
        assert_eq!(classify("vb", "a.vb").unwrap().1, "vbnet");
        assert_eq!(classify("vbs", "a.vbs").unwrap().1, "");
        assert_eq!(classify("", "README").unwrap().0, "plain");
        assert_eq!(classify("", "Makefile").unwrap().0, "code");
        assert!(classify("exe", "a.exe").is_none());
        assert!(classify("", "a").is_none());
    }

    /// 行数口径必须与 `str::lines()` 一致，否则界面上「第几行」永远差一行
    #[test]
    fn line_starts_match_str_lines() {
        for sample in ["", "a", "a\n", "a\nb", "a\nb\n", "\n", "a\n\nb\n", "a\r\nb\r\n", "\n\n"] {
            let (starts, clipped) = scan_line_starts(sample.as_bytes(), MAX_WINDOWED_LINES as usize).unwrap();
            assert_eq!(starts.len(), sample.lines().count(), "样本 {sample:?}");
            assert!(!clipped);
            // 每个起点都要落在真实的行首上
            for (i, start) in starts.iter().enumerate() {
                let rest = &sample[*start as usize..];
                if i > 0 {
                    assert!(sample.as_bytes()[*start as usize - 1] == b'\n', "样本 {sample:?} 第 {i} 行不在行首");
                }
                assert!(rest.len() + *start as usize <= sample.len());
            }
        }
    }

    /// 跨 1MB 块边界时不能丢行：块尾的换行要等下一块有内容才补
    #[test]
    fn line_starts_across_chunk_boundary() {
        let line = "0123456789abcdef\n"; // 17 字节
        let count = 200_000;
        let text = line.repeat(count);
        let (starts, clipped) = scan_line_starts(text.as_bytes(), MAX_WINDOWED_LINES as usize).unwrap();
        assert_eq!(starts.len(), count);
        assert_eq!(starts[1], 17);
        assert!(!clipped);

        // 恰好让某一块以换行结尾、下一块还有内容
        let mut cut = 1 << 20;
        while cut % 17 != 0 {
            cut += 1;
        }
        let text = line.repeat(count);
        let (starts, _) = scan_line_starts(&text.as_bytes()[..cut + 20], MAX_WINDOWED_LINES as usize).unwrap();
        assert_eq!(starts.len(), (cut + 20) / 17 + 1);
    }

    /// 行数上限是「够用就停」，不是报错：超出部分交给 clipped 说明
    #[test]
    fn scan_stops_at_line_limit() {
        let text = "x\n".repeat(100);
        let (starts, clipped) = scan_line_starts(text.as_bytes(), 10).unwrap();
        assert_eq!(starts.len(), 10);
        assert!(clipped);

        // 恰好等于上限、后面没有更多行时不该谎报 clipped
        let text = "x\n".repeat(9) + "x";
        let (starts, clipped) = scan_line_starts(text.as_bytes(), 10).unwrap();
        assert_eq!(starts.len(), 10);
        assert!(!clipped);
    }

    #[test]
    fn window_read_keeps_whole_lines() {
        let path = std::env::temp_dir().join(format!("yuejian-window-{}.txt", std::process::id()));
        let text = (1..=500).map(|i| format!("第 {i} 行 line-{i}\n")).collect::<String>();
        std::fs::write(&path, &text).unwrap();

        let size = text.len() as u64;
        let index = build_index(&path, "UTF-8", size).unwrap();
        assert_eq!(index.lines(), 500);
        assert_eq!(index.eol, "LF");

        let mut file = File::open(&path).unwrap();
        let (bytes, got) = read_window(&mut file, &index, 99, 3).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert_eq!(got, 3);
        assert_eq!(text, "第 100 行 line-100\n第 101 行 line-101\n第 102 行 line-102\n");

        // 末窗不足一整屏：少给几行而不是报错
        let (_, got) = read_window(&mut file, &index, 498, 10).unwrap();
        assert_eq!(got, 2);
        // 越界起点直接给空
        let (bytes, got) = read_window(&mut file, &index, 900, 10).unwrap();
        assert!(bytes.is_empty() && got == 0);

        let _ = std::fs::remove_file(&path);
    }

    /// UTF-16 的换行是两个字节，按 0x0A 切会劈开码元——这类文件不进窗口模式
    #[test]
    fn utf16_is_not_line_safe() {
        assert!(line_safe("UTF-8"));
        assert!(line_safe("GB18030"));
        assert!(!line_safe("UTF-16LE"));
        assert!(!line_safe("utf-16be"));
    }

    /// 界面传来的标签五花八门（大小写、别名），归一化交给 encoding_rs；
    /// 不认识的必须回 None，不能兜底成 UTF-8
    #[test]
    fn encoding_label_normalization() {
        assert_eq!(encoding_of("utf-8").unwrap().name(), "UTF-8");
        assert_eq!(encoding_of(" UTF-8 ").unwrap().name(), "UTF-8");
        // gb2312 是 GBK 的别名；GB18030 在 encoding_rs 里是另一个更宽的编码，
        // 且规范名按 WHATWG 是小写（`name()` 的大小写并不统一，别拿它当显示名比大小）
        assert_eq!(encoding_of("gbk").unwrap().name(), "GBK");
        assert_eq!(encoding_of("gb2312").unwrap().name(), "GBK");
        assert_eq!(encoding_of("gb18030").unwrap().name(), "gb18030");
        assert_eq!(encoding_of("big5").unwrap().name(), "Big5");
        assert_eq!(encoding_of("shift_jis").unwrap().name(), "Shift_JIS");
        assert_eq!(encoding_of("utf-16le").unwrap().name(), "UTF-16LE");
        assert!(encoding_of("auto").is_none());
        assert!(encoding_of("").is_none());
    }

    /// BOM 是硬证据：带 BOM 的 UTF-16 正文里全是 NUL，不能被二进制检测挡住
    #[test]
    fn bom_wins_over_nul_heuristic() {
        let utf16le = [0xFF, 0xFE, b'h', 0x00, b'i', 0x00];
        let (text, encoding) = decode(&utf16le);
        assert_eq!(text, "hi");
        assert_eq!(encoding.name(), "UTF-16LE");
        assert!(!looks_binary(&utf16le));

        // 没有 BOM 的 NUL 仍然判为二进制
        assert!(looks_binary(b"abc\0def"));
    }
}
