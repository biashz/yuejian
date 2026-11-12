use crate::markdown;
use crate::store::{self, Book, Progress, Settings, StoreState};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

const MAX_TEXT_SIZE: u64 = 16 * 1024 * 1024;
/// asset 协议失效时兜底读取的上限，超过后直接报错而不是把内存吃光
const MAX_PDF_BYTES: u64 = 128 * 1024 * 1024;

fn lock<'a>(state: &'a State<'_, StoreState>) -> Result<std::sync::MutexGuard<'a, store::AppState>, String> {
    state.data.lock().map_err(|_| "书架状态已损坏".to_string())
}

fn detect_kind(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_string_lossy().to_lowercase().as_str() {
        "pdf" => Some("pdf"),
        "md" | "markdown" | "mdown" => Some("markdown"),
        _ => None,
    }
}

fn build_book(path: &Path) -> Result<Book, String> {
    let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let kind = detect_kind(&canonical).ok_or_else(|| format!("不支持的文件类型：{}", canonical.display()))?;
    let meta = fs::metadata(&canonical).map_err(|err| format!("无法读取文件：{err}"))?;
    let stem = canonical
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "未命名文档".into());

    let mut title = stem.clone();
    let mut words = 0u32;

    if kind == "markdown" {
        if meta.len() <= MAX_TEXT_SIZE {
            if let Ok(source) = fs::read_to_string(&canonical) {
                if let Some(heading) = markdown::first_heading(&source) {
                    title = heading;
                }
                words = markdown::word_count(&source);
            }
        }
    }

    Ok(Book {
        id: store::book_id(&canonical),
        path: canonical.to_string_lossy().to_string(),
        title,
        author: "本地文档".into(),
        kind: kind.to_string(),
        size: meta.len(),
        pages: 0,
        words,
        added_at: store::now_ms(),
        last_opened_at: store::now_ms(),
        favorite: false,
        progress: Progress::default(),
    })
}

#[tauri::command]
pub fn get_library(state: State<'_, StoreState>) -> Result<Vec<Book>, String> {
    Ok(lock(&state)?.books.clone())
}

#[tauri::command]
pub fn get_settings(state: State<'_, StoreState>) -> Result<Settings, String> {
    Ok(lock(&state)?.settings.clone())
}

#[tauri::command]
pub fn save_settings(state: State<'_, StoreState>, settings: Settings) -> Result<(), String> {
    let mut data = lock(&state)?;
    data.settings = settings;
    store::persist(&data, &state.dir)
}

/// 调起系统文件对话框，返回选中的路径
#[tauri::command]
pub async fn pick_files() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .add_filter("文档", &["pdf", "md", "markdown", "mdown"])
            .set_title("导入到阅笺")
            .pick_files()
            .unwrap_or_default()
            .into_iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn import_files(state: State<'_, StoreState>, paths: Vec<String>) -> Result<Vec<Book>, String> {
    let mut data = lock(&state)?;
    for raw in paths {
        let path = PathBuf::from(&raw);
        let Ok(book) = build_book(&path) else { continue };
        // 已存在则只刷新打开时间，保留阅读进度
        if let Some(existing) = data.books.iter_mut().find(|b| b.id == book.id) {
            existing.last_opened_at = store::now_ms();
            if existing.pages == 0 && book.pages > 0 {
                existing.pages = book.pages;
            }
            continue;
        }
        data.books.push(book);
    }
    store::persist(&data, &state.dir)?;
    Ok(data.books.clone())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum OpenDoc {
    Pdf { path: String, pages: u32 },
    Markdown {
        html: String,
        toc: Vec<markdown::TocItem>,
        dir: String,
        words: u32,
    },
}

#[tauri::command]
pub async fn open_book(state: State<'_, StoreState>, id: String) -> Result<OpenDoc, String> {
    // 锁只在快照阶段持有，避免把阻塞 IO 放在同步命令里卡住界面线程
    let book = {
        let mut data = lock(&state)?;
        let Some(book) = data.books.iter_mut().find(|b| b.id == id) else {
            return Err("书架中找不到这本书".into());
        };
        book.last_opened_at = store::now_ms();
        let snapshot = book.clone();
        let _ = store::persist(&data, &state.dir);
        snapshot
    };

    if book.kind == "pdf" {
        return Ok(OpenDoc::Pdf { path: book.path, pages: book.pages });
    }

    let path = PathBuf::from(&book.path);
    let meta = fs::metadata(&path).map_err(|err| format!("读取 Markdown 失败：{err}"))?;
    if meta.len() > MAX_TEXT_SIZE {
        return Err(format!(
            "Markdown 文件过大（{:.1} MB），请拆分后再导入",
            meta.len() as f64 / 1024.0 / 1024.0
        ));
    }

    let dir = path
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    // 解析与渲染放到阻塞线程池，超大文档也不会冻结窗口
    let (html, toc, words) = tauri::async_runtime::spawn_blocking(move || {
        let source = fs::read_to_string(&path).map_err(|err| format!("读取 Markdown 失败：{err}"))?;
        let (html, toc) = markdown::render(&source);
        Ok::<_, String>((html, toc, markdown::word_count(&source)))
    })
    .await
    .map_err(|err| err.to_string())??;

    Ok(OpenDoc::Markdown { html, toc, dir, words })
}

#[tauri::command]
pub fn save_progress(
    state: State<'_, StoreState>,
    id: String,
    ratio: f64,
    page: u32,
    zoom: f64,
    pages: u32,
) -> Result<(), String> {
    let mut data = lock(&state)?;
    if let Some(book) = data.books.iter_mut().find(|b| b.id == id) {
        book.progress = Progress { ratio, page, zoom };
        if pages > 0 {
            book.pages = pages;
        }
        book.last_opened_at = store::now_ms();
    }
    store::persist(&data, &state.dir)
}

#[tauri::command]
pub fn toggle_favorite(state: State<'_, StoreState>, id: String) -> Result<Book, String> {
    let mut data = lock(&state)?;
    let Some(book) = data.books.iter_mut().find(|b| b.id == id) else {
        return Err("书架中找不到这本书".into());
    };
    book.favorite = !book.favorite;
    let updated = book.clone();
    store::persist(&data, &state.dir)?;
    Ok(updated)
}

#[tauri::command]
pub fn remove_book(state: State<'_, StoreState>, id: String) -> Result<Vec<Book>, String> {
    let mut data = lock(&state)?;
    data.books.retain(|b| b.id != id);
    store::persist(&data, &state.dir)?;
    Ok(data.books.clone())
}

/// asset 协议不可用时的兜底：直接把 PDF 字节交给前端。
/// 走二进制通道（不是 JSON 数组），并且拒绝超大文件，避免界面被拖死。
#[tauri::command]
pub fn read_pdf_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    let meta = fs::metadata(&path).map_err(|err| format!("读取 PDF 失败：{err}"))?;
    if meta.len() > MAX_PDF_BYTES {
        return Err("文件过大，无法通过备用通道读取".into());
    }
    let bytes = fs::read(&path).map_err(|err| format!("读取 PDF 失败：{err}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}
