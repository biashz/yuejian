use comrak::{markdown_to_html, Options};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TocItem {
    pub level: u8,
    pub id: String,
    pub text: String,
}

/// Markdown → 安全 HTML（原始 HTML 转义），同时抽取 h1–h3 目录
pub fn render(source: &str) -> (String, Vec<TocItem>) {
    let mut options = Options::default();
    options.extension.table = true;
    options.extension.strikethrough = true;
    options.extension.tasklist = true;
    options.extension.footnotes = true;
    options.extension.autolink = true;
    options.extension.header_ids = Some("h-".to_string());
    options.render.github_pre_lang = true;
    // comrak 默认 r#unsafe = false：原始 HTML 会被转义，避免本地文档注入脚本

    let html = markdown_to_html(source, &options);
    let toc = extract_toc(&html);
    (html, toc)
}

/// 从首个一级标题取书名，取不到则用文件名
pub fn first_heading(source: &str) -> Option<String> {
    source
        .lines()
        .find_map(|line| line.trim().strip_prefix("# ").map(|t| t.trim().to_string()))
        .filter(|t| !t.is_empty())
}

/// 粗略统计非空白字符数
pub fn word_count(source: &str) -> u32 {
    source.chars().filter(|c| !c.is_whitespace()).count() as u32
}

fn extract_toc(html: &str) -> Vec<TocItem> {
    let mut items = Vec::new();
    let mut cursor = 0usize;

    while cursor < html.len() {
        let next = ["<h1", "<h2", "<h3"]
            .iter()
            .filter_map(|tag| html[cursor..].find(tag).map(|pos| (pos, *tag)))
            .min_by_key(|(pos, _)| *pos);

        let Some((offset, tag)) = next else { break };
        let start = cursor + offset;
        let level = tag.as_bytes()[2] - b'0';
        let Some(open_end) = html[start..].find('>') else { break };
        let inner_start = start + open_end + 1;
        let close_tag = format!("</h{level}>");
        let Some(close_offset) = html[inner_start..].find(&close_tag) else { break };
        let inner = &html[inner_start..inner_start + close_offset];

        if let Some(id) = attribute(inner, "id") {
            let text = strip_tags(inner);
            if !text.is_empty() {
                items.push(TocItem { level, id, text });
            }
        }
        cursor = inner_start + close_offset + close_tag.len();
    }
    items
}

fn attribute(fragment: &str, name: &str) -> Option<String> {
    let needle = format!("{name}=\"");
    let start = fragment.find(&needle)? + needle.len();
    let rest = &fragment[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// 去掉标题内部可能存在的锚点标签（comrak 会插入 <a aria-hidden>）
fn strip_tags(fragment: &str) -> String {
    let mut out = String::with_capacity(fragment.len());
    let mut in_tag = false;
    for ch in fragment.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    decode_entities(out.trim())
}

fn decode_entities(text: &str) -> String {
    text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .trim()
        .to_string()
}
