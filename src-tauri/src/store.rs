use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::paths;

/// 单本书的阅读进度
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub ratio: f64,
    pub page: u32,
    pub zoom: f64,
    /// 电子书的 EPUB CFI（形如 `epubcfi(/6/14!/4/2/2)`）。
    ///
    /// 电子书是流式排版：页码由视口算出来，窗口一变「第 87 页」就是另一段文字了，
    /// 所以位置只能记成 CFI——它指向 DOM 节点偏移，与排版无关。
    /// `ratio` 仍然写，供书架进度条使用（那里没有排版，也用不到 CFI）。
    #[serde(default)]
    pub cfi: String,
}

impl Default for Progress {
    fn default() -> Self {
        Self { ratio: 0.0, page: 1, zoom: 1.0, cfi: String::new() }
    }
}

/// 用户自定义分类
///
/// 单份文档只属于一个分类（`Book::category_id`），不提供多标签；
/// 按创建时间升序展示，刻意不设 `order` 字段，避免出现「声明了但从不写入」的字段。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: String,
    pub name: String,
    /// 色板键：clay | indigo | olive | amber | plum | slate
    pub color: String,
    pub created_at: u64,
}

/// 电子书书签。
///
/// 只存 CFI 和当时的章节名。位置必须是 CFI：电子书是流式排版，「第 87 页」
/// 换一次窗口就是另一段文字，存页码等于存了个假位置。
///
/// `label` 是加入时的章节名快照，纯粹给侧栏列表看——每次渲染都去解析 CFI
/// 意味着同步打开一堆章节文档，代价与收益完全不成比例。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub cfi: String,
    pub label: String,
    pub created_at: u64,
}

/// 电子书划线。
///
/// 与书签同一个位置模型（CFI），区别是它跨一段文字而不是落到一点：`cfi` 是
/// 一个 Range CFI，`text` 是选中时的原文快照。原文必须存——重排之后 CFI 仍然
/// 指得准，但侧栏列表要能一眼看出划了哪句，为此去解析 CFI 再打开章节文档不值得。
///
/// `color` 是色板键（amber | olive | indigo | plum | ink），只影响画出来的颜色，
/// 不参与定位。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Highlight {
    pub cfi: String,
    pub text: String,
    pub color: String,
    pub label: String,
    pub created_at: u64,
    /// 附注笔记。旧数据没有该键时补空串 = 无笔记，导出与侧栏据此不渲染笔记行
    #[serde(default)]
    pub note: String,
}

/// 书架条目
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    pub id: String,
    pub path: String,
    pub title: String,
    pub author: String,
    /// pdf | markdown
    pub kind: String,
    pub size: u64,
    pub pages: u32,
    pub words: u32,
    pub added_at: u64,
    pub last_opened_at: u64,
    pub favorite: bool,
    /// 所属分类 id；空串表示「未分类」。
    /// 字段级 default 让旧版 state.json（无该字段）可直接读取，无需迁移代码。
    #[serde(default)]
    pub category_id: String,
    /// 用户手动指定的编码标签（如 `gbk`）；空串表示自动检测。
    ///
    /// 存的是**用户选的标签**而不是探测出来的编码名：自动检测每次打开都能重跑，
    /// 而用户的选择一旦丢了（比如重启后回到自动），乱码就又会回来。
    #[serde(default)]
    pub encoding: String,
    /// 电子书书签；只有 `kind == "ebook"` 会有内容
    #[serde(default)]
    pub bookmarks: Vec<Bookmark>,
    /// 电子书划线；同样只有电子书会有内容
    #[serde(default)]
    pub highlights: Vec<Highlight>,
    /// 文件修改时间（毫秒）。用于判断检索索引是否过期。
    ///
    /// 旧版 state.json 没有这个字段，读出来是 0；0 与任何真实 mtime 都不相等，
    /// 因此天然被当作「索引可能过期」，下次检索重建一次即可，不需要迁移代码。
    #[serde(default)]
    pub mtime: u64,
    pub progress: Progress,
}

/// 阅读偏好
/// 容器级 serde(default)：旧版 state.json 缺少新增字段时用默认值补齐，避免升级后读取失败
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub theme: String,
    pub font_size: u32,
    pub line_height: f64,
    pub measure: u32,
    pub show_ctx: bool,
    pub zen: bool,
    /// 是否启用左右双栏
    pub split: bool,
    /// 双栏打开同一份文档时是否联动翻页/滚动
    pub link_sync: bool,
    /// 界面语言：zh | en
    pub language: String,
    /// 启动时自动检查更新
    pub auto_check_update: bool,
    /// 电子书是否双页显示（窗口过窄时由前端自动降级为单页，不改这个值）
    pub ebook_spread: bool,
    /// 电子书正文字号（px）；与 PDF/文本的 `font_size` 分开，两者可用的取值范围不同
    pub ebook_font_size: u32,
    /// 电子书行高倍数
    pub ebook_line_height: f64,
    /// 电子书页边距（px），映射到分页器的 `margin` 属性
    pub ebook_margin: u32,
    /// 电子书字体：serif | sans | kai
    pub ebook_family: String,
    /// 电子书对齐：left | justify
    pub ebook_align: String,
    /// 覆盖书内排版：书自带的字体/字号/行高/缩进一律让位给上面的设置
    pub ebook_override: bool,
    /// 电子书字间距（px），可为负
    pub ebook_letter_spacing: f64,
    /// 首行缩进（字符数）：0 / 1 / 2。与 `ebook_para_spacing` 是二选一的分段策略
    pub ebook_indent: u32,
    /// 段间距（px）；只在「分段方式 = 段间距」时生效
    pub ebook_para_spacing: u32,
    /// 版心宽度（px），映射到分页器的 `max-inline-size`
    pub ebook_measure: u32,
    /// 列间距（百分比），映射到分页器的 `gap`
    pub ebook_gap: f64,
    /// 西文连字符
    pub ebook_hyphenate: bool,
    /// 标点挤压：中西文自动间隙 + 标点半角 + 标点不走行首
    pub ebook_punctuate: bool,
    /// 覆盖书内配色（字色 / 底色跟随应用主题）。独立于 `ebook_override`，缺省视为开。
    ///
    /// 用 `Option` 只是容错：旧版 state.json 没有这个键，读出来是 None，前端按「开」处理；
    /// 万一哪份数据里是 null 也不会让整份设置反序列化失败。
    pub ebook_override_color: Option<bool>,
    /// 书架排序轴：recent | added | title | progress
    pub sort: String,
    /// 排序方向：true = 降序。书名轴自然方向为升序，切换轴时按自然方向重置
    pub sort_desc: bool,
    /// 电子书阅读姿势：paged | scroll。滚动模式纵向连续，章末自动接章
    pub ebook_flow: String,
    /// 翻页动效：slide | fade | none。reduce-motion 时前端一律表现为 none
    pub ebook_turn: String,
    /// 朗读语速倍数（0.5–2）
    pub ebook_tts_rate: f64,
    /// 朗读嗓音 name；空串 = 按界面语言挑本地嗓音
    pub ebook_tts_voice: String,
    /// 自动滚动速度档 1–10；运行态不持久化，只存速度
    pub ebook_auto_speed: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "paper".into(),
            font_size: 17,
            line_height: 1.9,
            measure: 720,
            show_ctx: true,
            zen: false,
            split: false,
            link_sync: true,
            language: "zh".into(),
            auto_check_update: true,
            ebook_spread: true,
            // 这一组默认值 = 版式面板的「舒适中文」预设（见 reader/ebook-layout.js）：
            // 出厂就落在某一套预设上，面板打开时第一眼是「已选中」，不是「自定义」
            ebook_font_size: 19,
            ebook_line_height: 1.85,
            ebook_margin: 56,
            ebook_family: "serif".into(),
            ebook_align: "justify".into(),
            ebook_override: false,
            ebook_letter_spacing: 0.25,
            ebook_indent: 2,
            ebook_para_spacing: 0,
            ebook_measure: 660,
            ebook_gap: 8.0,
            ebook_hyphenate: false,
            ebook_punctuate: true,
            ebook_override_color: None,
            sort: "recent".into(),
            sort_desc: true,
            ebook_flow: "paged".into(),
            ebook_turn: "slide".into(),
            ebook_tts_rate: 1.0,
            ebook_tts_voice: String::new(),
            ebook_auto_speed: 5,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppState {
    pub version: u32,
    pub books: Vec<Book>,
    /// 用户自定义分类。旧版 state.json 没有该字段时由容器级 default 补齐为空数组。
    pub categories: Vec<Category>,
    pub settings: Settings,
}

impl Default for AppState {
    fn default() -> Self {
        Self { version: 1, books: Vec::new(), categories: Vec::new(), settings: Settings::default() }
    }
}

/// 进程内共享状态
pub struct StoreState {
    pub data: Mutex<AppState>,
    pub dir: PathBuf,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 文件修改时间（毫秒）。取不到就返回 0——0 表示「不知道」，索引那边按过期处理。
pub fn mtime_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 用文件路径的哈希作为稳定 id，避免重复导入
pub fn book_id(path: &Path) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.to_string_lossy().to_lowercase().hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

/// 初始化书架状态。
///
/// 数据目录固定在运行时数据根目录下，安装后即为可执行文件同级的 `data/`。
pub fn init() -> StoreState {
    let dir = paths::runtime_root();
    let _ = fs::create_dir_all(&dir);
    let data = fs::read_to_string(dir.join("state.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<AppState>(&raw).ok())
        .unwrap_or_default();
    StoreState { data: Mutex::new(data), dir }
}

/// 先写临时文件再重命名，避免写入中断损坏书架
pub fn persist(state: &AppState, dir: &Path) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(state).map_err(|err| err.to_string())?;
    let tmp = dir.join("state.json.tmp");
    fs::write(&tmp, raw).map_err(|err| err.to_string())?;
    fs::rename(&tmp, dir.join("state.json")).map_err(|err| err.to_string())
}
