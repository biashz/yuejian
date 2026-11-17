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
//! 还是判定错了。手动切换编码留到后续阶段，此处不做。

use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};
use serde::Serialize;

/// 探测器与二进制检测都只看开头这么多字节：对准确率没有损失的窗口足够小，
/// 避免打开一个大文件时先把它整个扫一遍。
const SNIFF_BYTES: usize = 8 * 1024;

/// 文本类文档的元信息 + 正文。正文一次性回传，超过 `MAX_VIEW_BYTES` 时截断。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDoc {
    /// 已解码的正文（截断时只含已加载部分）
    pub text: String,
    /// 实际使用的编码名，如 `UTF-8` / `GB18030` / `UTF-16LE`
    pub encoding: String,
    /// 行数（按 `\n` 计，末行没有换行符也算一行）
    pub lines: u32,
    /// 字符数（Unicode 标量值，不是字节数）
    pub chars: u32,
    /// `LF` / `CRLF` / `CR`
    pub eol: String,
    /// 语法高亮的语言别名；空串表示不做高亮
    pub lang: String,
    /// 默认视图模式：`plain` / `code`。取值域里留了 `table`，但当前还没有表格渲染器，
    /// 因此不会有文件被判定成 `table`（见 `classify` 里 csv 分支的说明）。
    pub mode: String,
    /// 是否只加载了文件开头一部分
    pub truncated: bool,
}

/// 打开文本时的读取上限。超过它只读前面一段并标记 `truncated`。
///
/// 一期的取舍：一次性把正文交给前端最简单也最稳，8MB 的字符串经 IPC 传输大约几十毫秒。
/// 更大的文件（日志动辄上百 MB）要靠窗口读取 + 虚拟滚动，那是下一期的事——
/// 但**不能**在这里直接报错，那等于把「常见文本格式」挡在门外一半。
pub const MAX_VIEW_BYTES: u64 = 8 * 1024 * 1024;

/// 前 8KB 里出现 NUL 字节即判定「不是文本」。图片、压缩包被改名成 `.txt` 时，
/// 与其渲染满屏乱码，不如明确告诉用户这不是文本文件。
pub fn looks_binary(bytes: &[u8]) -> bool {
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
        // 表格：还没有表格渲染器，因此**必须**回 `code` 而不是预告一个不存在的 `table`。
        // 回 `table` 会落到前端「非 code 即 plain」的兜底分支，CSV 于是被当成散文、
        // 用宋体整段排下来，列完全对不齐；等宽 + 行号至少还能看出分隔符在哪。
        // 表格视图上了之后再改回 `table`。
        "csv" | "tsv" => ("code", ""),

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
    }
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
        // 表格视图尚未实现，CSV 必须按等宽渲染；回 `table` 会让它掉进正文视图
        assert_eq!(classify("csv", "a.csv").unwrap().0, "code");
        assert_eq!(classify("tsv", "a.tsv").unwrap().0, "code");
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
}
