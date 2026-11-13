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
}

impl Default for Progress {
    fn default() -> Self {
        Self { ratio: 0.0, page: 1, zoom: 1.0 }
    }
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
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppState {
    pub version: u32,
    pub books: Vec<Book>,
    pub settings: Settings,
}

impl Default for AppState {
    fn default() -> Self {
        Self { version: 1, books: Vec::new(), settings: Settings::default() }
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
