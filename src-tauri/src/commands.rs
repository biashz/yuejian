use crate::markdown;
use crate::store::{self, Book, Bookmark, Category, Highlight, Progress, Settings, StoreState};
use crate::text;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

const MAX_TEXT_SIZE: u64 = 16 * 1024 * 1024;
/// 导入时统计字数的上限：再大就跳过，不为书架上的一个数字去读整份文件
const COUNT_TEXT_SIZE: u64 = 2 * 1024 * 1024;
/// asset 协议失效时兜底读取的上限，超过后直接报错而不是把内存吃光
const MAX_PDF_BYTES: u64 = 128 * 1024 * 1024;
/// 单次 range 读取的安全上限：正常页面对象远小于该值，
/// 一旦超过说明 PDF 结构异常（例如 pdf.js 退化成整份读取），此时报错而不是让进程崩掉
const MAX_RANGE_BYTES: u64 = 256 * 1024 * 1024;
/// 一本书的书签上限：超出来不再是「书签」而是笔记系统，那是另一件事
const MAX_BOOKMARKS: usize = 200;
/// 一本书的划线上限。比书签宽一些——一次阅读划十几条很正常，
/// 但仍然要有上限：侧栏列表与每章重绘的代价都跟着条数走
const MAX_HIGHLIGHTS: usize = 500;

/// 大文件的行索引缓存。
///
/// 索引只在打开时扫一次，之后每次窗口读取都要用它换算字节偏移，所以必须留在
/// 进程内。最多留两份——正好对应两个阅读栏；再多说明用户在反复切换文档，
/// 此时整体清空重扫（几百毫秒）比自己维护一套 LRU 更简单，也更难出错。
#[derive(Default)]
pub struct TextIndexCache(pub Mutex<HashMap<String, Arc<text::LineIndex>>>);

fn cached_index(cache: &TextIndexCache, path: &str) -> Option<Arc<text::LineIndex>> {
    cache.0.lock().ok()?.get(path).cloned()
}

fn remember_index(cache: &TextIndexCache, path: &str, index: Arc<text::LineIndex>) {
    if let Ok(mut map) = cache.0.lock() {
        if map.len() >= 2 && !map.contains_key(path) {
            map.clear();
        }
        map.insert(path.to_string(), index);
    }
}

/// 丢掉某份文本的索引。换编码重开时必须先丢：索引里记着编码名，窗口读取按它解码，
/// 留着旧索引会让新选择的编码只对第一屏生效。
fn forget_index(cache: &TextIndexCache, path: &str) {
    if let Ok(mut map) = cache.0.lock() {
        map.remove(path);
    }
}

fn lock<'a>(state: &'a State<'_, StoreState>) -> Result<std::sync::MutexGuard<'a, store::AppState>, String> {
    state.data.lock().map_err(|_| "书架状态已损坏".to_string())
}

/// 启动控制台程序时不要弹出黑框。
///
/// 应用本身是 GUI 子系统（`windows_subsystem = "windows"`），没有控制台；此时再启动
/// `curl.exe` / `reg.exe` / `cmd.exe` 这类控制台程序，Windows 会为它新建一个控制台窗口。
/// curl 一跑就是几十秒，那个黑框会一直挂在桌面上。`CREATE_NO_WINDOW` 让子进程不分配控制台，
/// 输出仍可通过管道读取。非 Windows 上是空操作。
fn quiet(command: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        return command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(target_os = "windows"))]
    command
}

/// 文档类型判定：pdf / markdown / text / ebook。
///
/// 文本类不再逐个枚举扩展名——`text::classify` 那一张表同时服务于
/// 「能不能打开」「默认哪种视图」「用什么语言高亮」三件事，避免三处各写一份。
///
/// 电子书在这里只按扩展名放行，真正的格式判定在前端（`foliate-js` 的
/// `makeBook` 按魔术字节分派）。两处判定不冲突：这里回答「让不让进书架」，
/// 那里回答「用什么解析器解」。
fn detect_kind(path: &Path) -> Option<&'static str> {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    match ext.as_str() {
        "pdf" => Some("pdf"),
        "md" | "markdown" | "mdown" => Some("markdown"),
        // 电子书：epub / fb2（纯 XML）/ fbz 与 fb2.zip（打包的 fb2）/ cbz（图片漫画）
        // / mobi 与 azw、azw3（Kindle）。`.fb2.zip` 的扩展名只有 `zip`，
        // 所以放行条件看的是整个文件名，否则会把普通压缩包也当书收进来
        "epub" | "fb2" | "fbz" | "cbz" | "mobi" | "azw" | "azw3" => Some("ebook"),
        "zip" if name.to_lowercase().ends_with(".fb2.zip") => Some("ebook"),
        _ => text::is_text(&ext, &name).then_some("text"),
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
    } else if kind == "text" {
        // 只对小文件统计字数：导入一份 200MB 的日志时不该为了书架上的一个数字
        // 把它整个读一遍，那是肉眼可见的卡顿。
        // 书名仍然用文件名：日志首行是时间戳、代码首行是 `use …`，
        // 拿它们当书名只会让书架更难扫读。
        if meta.len() <= COUNT_TEXT_SIZE {
            if let Ok(bytes) = fs::read(&canonical) {
                if !text::looks_binary(&bytes) {
                    let (source, _) = text::decode(&bytes);
                    words = source.chars().filter(|c| !c.is_whitespace()).count() as u32;
                }
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
        category_id: String::new(),
        encoding: String::new(),
        bookmarks: Vec::new(),
        highlights: Vec::new(),
        mtime: store::mtime_ms(&meta),
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

/// 文件对话框里默认列出的扩展名。
///
/// 只影响「默认看得见哪些」：用户仍可用「所有文件」选任意文件，
/// 不支持的会在导入时被跳过（前端会提示跳过了几个）。
const PICK_EXTS: &[&str] = &[
    "pdf", "epub", "fb2", "fbz", "cbz", "mobi", "azw", "azw3", "md", "markdown", "mdown",
    "txt", "text", "log", "nfo", "csv", "tsv", "json",
    "yml", "yaml", "toml", "ini", "conf", "xml", "html", "css", "js", "ts", "rs", "go", "py",
    "java", "c", "h", "cpp", "cs", "php", "rb", "sh", "sql", "diff",
];

/// 调起系统文件对话框，返回选中的路径
#[tauri::command]
pub async fn pick_files() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .add_filter("文本与文档", PICK_EXTS)
            .add_filter("所有文件", &["*"])
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
            // 重复导入往往是因为文件换过一版：体积与 mtime 变过就让检索索引重建
            existing.size = book.size;
            existing.mtime = book.mtime;
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
    Pdf {
        path: String,
        pages: u32,
        /// 文件体积，前端据此决定走 asset 协议还是 IPC 分块读取
        size: u64,
    },
    Markdown {
        html: String,
        toc: Vec<markdown::TocItem>,
        dir: String,
        words: u32,
    },
    /// 文本类（txt / log / csv / 代码配置）：正文 + 元信息
    Text(text::TextDoc),
    /// 电子书（EPUB / FB2 / MOBI / CBZ）：只回路径与体积。
    ///
    /// 正文由前端解析——解压、解析 OPF、排版全在 `foliate-js` 里做，
    /// Rust 侧再解一遍等于把同一份逻辑写两遍，还得跟着库的解析规则同步。
    Ebook {
        path: String,
        size: u64,
    },
}

#[tauri::command]
pub async fn open_book(
    state: State<'_, StoreState>,
    cache: State<'_, TextIndexCache>,
    id: String,
    // 用户手动指定的编码标签（`gbk` / `big5`…）。不传表示沿用书架里记的，
    // 传空串表示改回自动检测。只有显式传入才会写回书架。
    encoding: Option<String>,
) -> Result<OpenDoc, String> {
    // 锁只在快照阶段持有，避免把阻塞 IO 放在同步命令里卡住界面线程
    let book = {
        let mut data = lock(&state)?;
        let Some(book) = data.books.iter_mut().find(|b| b.id == id) else {
            return Err("书架中找不到这本书".into());
        };
        book.last_opened_at = store::now_ms();
        // 打开时顺手校准体积与 mtime：文件被外部改动过，检索索引就得重建。
        // 取不到（文件已删）就保持原值，由具体分支去报错
        if let Ok(meta) = fs::metadata(&book.path) {
            book.size = meta.len();
            book.mtime = store::mtime_ms(&meta);
        }
        // 手动选编码要跨会话有效：用户是为了「这份文件一直乱码」才来切的，
        // 重启后又回到自动检测，等于每次启动都让他重切一遍。
        // 先校验再落盘——存下一个解不出来的标签，这份文件以后每次打开都会失败，
        // 而改回来的入口（信息面板）要有正文才存在，会变成死路
        if let Some(label) = encoding.as_deref() {
            let label = label.trim();
            if !label.is_empty() && text::encoding_of(label).is_none() {
                return Err(format!("不认识的编码：{label}"));
            }
            book.encoding = label.to_string();
        }
        let snapshot = book.clone();
        let _ = store::persist(&data, &state.dir);
        snapshot
    };

    if book.kind == "pdf" {
        // 以磁盘上的实际体积为准：旧记录里的 size 可能缺失或不准确
        let size = fs::metadata(&book.path).map(|meta| meta.len()).unwrap_or(book.size);
        return Ok(OpenDoc::Pdf {
            path: book.path,
            pages: book.pages,
            size,
        });
    }

    if book.kind == "ebook" {
        // 只回路径与体积：解析在前端。文件不在这里打开，所以「书架里有、磁盘上没了」
        // 这种情况也要能让前端自己报错——体积取不到时回 0，由前端按失败处理
        let size = fs::metadata(&book.path).map(|meta| meta.len()).unwrap_or(book.size);
        return Ok(OpenDoc::Ebook { path: book.path, size });
    }

    if book.kind == "text" {
        let path = PathBuf::from(&book.path);
        let meta = fs::metadata(&path).map_err(|err| format!("读取文本失败：{err}"))?;
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let (mode, lang) = text::classify(&ext, &file_name).unwrap_or(("plain", ""));

        // 书架里记着的编码（用户手动选过的）优先于自动检测；空串 = 自动
        let forced = if book.encoding.is_empty() { None } else { Some(book.encoding.clone()) };

        // 解码与建索引都是 CPU / IO 活，几十 MB 足够卡住一帧界面，放到阻塞线程池
        let open = tauri::async_runtime::spawn_blocking(move || {
            read_text_doc(&path, meta.len(), lang, mode, forced.as_deref())
        })
        .await
        .map_err(|err| err.to_string())??;

        // 换了编码就必须丢掉旧索引：索引里记着编码名，窗口读取按它解码
        if encoding.is_some() {
            forget_index(&cache, &book.path);
        }
        if let Some(index) = open.index {
            remember_index(&cache, &book.path, index);
        }
        return Ok(OpenDoc::Text(open.doc));
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

/// `read_text_doc` 的结果：文档本身，外加「大文件才有」的行索引。
struct TextOpen {
    doc: text::TextDoc,
    index: Option<Arc<text::LineIndex>>,
}

/// 读一份文本：小文件整篇解码，大文件建索引交给窗口模式。
///
/// 三条分支的取舍：
/// 1. ≤ 8MB → 整篇解码。窗口模式的复杂度（行高、滚动换算、窗口缓存）换不来收益，
///    而且整篇在手时软换行、正文视图、语法高亮都还能用；
/// 2. 大文件且编码可按字节切行 → 建索引，只回元信息。正文由窗口读取按需取，
///    内存占用与文件大小脱钩；
/// 3. 其余（UTF-16、行数太少、行数超索引上限）→ 退回读前 8MB 截断。
///    截断是**显式**的：`truncated` 会传到界面上弹提示。
///
/// `forced` 是用户手动指定的编码。指定了就跳过一切自动判定——不做 BOM 优先、
/// 不做二进制检测；用户点了「GBK」却被告知「这看起来不是文本文件」，是最没道理的
/// 一种失败。
fn read_text_doc(
    path: &Path,
    size: u64,
    lang: &str,
    mode: &str,
    forced: Option<&str>,
) -> Result<TextOpen, String> {
    let small = size <= text::MAX_VIEW_BYTES;
    // 小文件直接读全文；大文件只读开头 8KB 用来判二进制与编码
    let sniff = if small { size } else { text::SNIFF_BYTES as u64 };

    let mut file = fs::File::open(path).map_err(|err| format!("读取文本失败：{err}"))?;
    let mut head = Vec::with_capacity(sniff as usize);
    file.by_ref()
        .take(sniff)
        .read_to_end(&mut head)
        .map_err(|err| format!("读取文本失败：{err}"))?;

    // 自动判定那条路顺手留下已解码的正文，小文件不必再解一遍
    let (auto_text, encoding) = match forced {
        Some(label) => {
            let enc = text::encoding_of(label).ok_or_else(|| format!("不认识的编码：{label}"))?;
            (None, enc.name().to_string())
        }
        None => {
            if text::looks_binary(&head) {
                return Err("这看起来不是文本文件（检测到二进制内容）".to_string());
            }
            let (decoded, enc) = text::decode(&head);
            (Some(decoded), enc.name().to_string())
        }
    };

    if small {
        let decoded = match auto_text {
            Some(decoded) => decoded,
            None => text::decode_with(&head, &encoding),
        };
        return Ok(TextOpen {
            doc: text::build(decoded, &encoding, lang, mode, false),
            index: None,
        });
    }

    if text::line_safe(&encoding) {
        // 索引建不出来（行数超限、文件超 4GB）不是错误，只是不能走窗口模式
        if let Ok(index) = text::build_index(path, &encoding, size) {
            if index.lines() >= text::MIN_VIRTUAL_LINES {
                let doc = text::build_virtual(
                    index.lines(),
                    &encoding,
                    &index.eol,
                    lang,
                    mode,
                    index.clipped,
                );
                return Ok(TextOpen { doc, index: Some(Arc::new(index)) });
            }
        }
    }

    // 兜底截断：读前 8MB，退到最后一个完整行再解码
    let mut buf = Vec::with_capacity(text::MAX_VIEW_BYTES as usize);
    fs::File::open(path)
        .and_then(|f| f.take(text::MAX_VIEW_BYTES).read_to_end(&mut buf))
        .map_err(|err| format!("读取文本失败：{err}"))?;
    let bytes = text::truncate_at_line(&buf);
    Ok(TextOpen {
        doc: text::build(text::decode_with(bytes, &encoding), &encoding, lang, mode, true),
        index: None,
    })
}

/// 取（必要时先建）某份文本的行索引。
///
/// 缓存未命中时会重建，此时编码必须与打开时一致：索引里记的编码名决定了窗口
/// 按什么解码。所以先查书架里记着的手动编码，没有再重新嗅探——否则用户手动选的
/// 编码会在缓存被清掉之后悄悄失效。
async fn ensure_index(
    cache: &State<'_, TextIndexCache>,
    store_state: &State<'_, StoreState>,
    path: &str,
) -> Result<Arc<text::LineIndex>, String> {
    if let Some(index) = cached_index(cache, path) {
        return Ok(index);
    }

    let forced = {
        let data = lock(store_state)?;
        data.books
            .iter()
            .find(|b| b.path == path)
            .map(|b| b.encoding.clone())
            .filter(|label| !label.is_empty())
    };

    let file_path = PathBuf::from(path);
    let meta = fs::metadata(&file_path).map_err(|err| format!("读取文本失败：{err}"))?;
    let size = meta.len();
    let index = tauri::async_runtime::spawn_blocking(move || -> Result<text::LineIndex, String> {
        let encoding = match forced {
            Some(label) => text::encoding_of(&label)
                .ok_or_else(|| format!("不认识的编码：{label}"))?
                .name()
                .to_string(),
            None => {
                let mut file = fs::File::open(&file_path).map_err(|err| format!("读取文本失败：{err}"))?;
                let mut head = vec![0u8; text::SNIFF_BYTES];
                let read = file.read(&mut head).map_err(|err| format!("读取文本失败：{err}"))?;
                head.truncate(read);
                text::decode(&head).1.name().to_string()
            }
        };
        text::build_index(&file_path, &encoding, size).map_err(|err| format!("读取文本失败：{err}"))
    })
    .await
    .map_err(|err| err.to_string())??;

    let index = Arc::new(index);
    remember_index(cache, path, index.clone());
    Ok(index)
}

/// 读第 `start` 行起的 `count` 行原始字节，供大文件窗口渲染使用。
///
/// 返回原始字节而不是 JSON 字符串有两个好处：一是省掉一次 UTF-8 转义
/// （JSON 里每个引号都要转义，日志正文里引号不少），二是前端能用
/// `TextDecoder` 按原编码解码，不必让 Rust 决定「这段按什么解」。
#[tauri::command]
pub async fn read_text_window(
    cache: State<'_, TextIndexCache>,
    store_state: State<'_, StoreState>,
    path: String,
    start: u32,
    count: u32,
) -> Result<tauri::ipc::Response, String> {
    let index = ensure_index(&cache, &store_state, &path).await?;
    let read_path = PathBuf::from(&path);
    // 一次要几万行的请求没有意义：窗口是按可视区算出来的，几百到几千行
    let count = count.clamp(1, 20_000);

    let bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let mut file = fs::File::open(&read_path).map_err(|err| format!("读取文本失败：{err}"))?;
        let (bytes, _) = text::read_window(&mut file, &index, start, count)
            .map_err(|err| format!("读取文本失败：{err}"))?;
        Ok(bytes)
    })
    .await
    .map_err(|err| err.to_string())??;

    Ok(tauri::ipc::Response::new(bytes))
}

/// 全文搜索命中的一行
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextHit {
    /// 行号，1 基，与界面上的行号一致
    pub line: u32,
    /// 该行内容（已截断到 160 个字符，够在侧栏里认出是哪一行）
    pub text: String,
}

/// 在大文件里搜索。
///
/// 窗口模式下正文只有一两千行在 DOM 里，前端遍历 DOM 等于只搜了当前屏，
/// 所以搜索必须下沉到这里：按行窗口逐段解码、逐行比对，命中即收集。
/// 一边扫一边返回不现实（需要流式协议），因此给一个上限，扫够条数就停。
#[tauri::command]
pub async fn search_text(
    cache: State<'_, TextIndexCache>,
    store_state: State<'_, StoreState>,
    path: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<TextHit>, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let index = ensure_index(&cache, &store_state, &path).await?;
    let limit = limit.unwrap_or(60).clamp(1, 500);
    let read_path = PathBuf::from(&path);

    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<TextHit>, String> {
        const BATCH: u32 = 4000;
        let mut file = fs::File::open(&read_path).map_err(|err| format!("读取文本失败：{err}"))?;
        let needle = query.to_lowercase();
        let total = index.lines();
        let mut hits: Vec<TextHit> = Vec::new();
        let mut line = 0u32;

        while line < total && hits.len() < limit {
            let (bytes, got) = text::read_window(&mut file, &index, line, BATCH)
                .map_err(|err| format!("读取文本失败：{err}"))?;
            if got == 0 {
                break;
            }
            let chunk = text::decode_with(&bytes, &index.encoding);
            for (offset, content) in chunk.lines().enumerate() {
                if content.is_empty() {
                    continue;
                }
                if content.to_lowercase().contains(&needle) {
                    hits.push(TextHit {
                        line: line + offset as u32 + 1,
                        text: snippet(content),
                    });
                    if hits.len() >= limit {
                        break;
                    }
                }
            }
            line += got;
        }
        Ok(hits)
    })
    .await
    .map_err(|err| err.to_string())?
}

/// 命中行的摘要：日志的单行可能几千字符，整行塞进侧栏会把列表撑爆
fn snippet(line: &str) -> String {
    const MAX: usize = 160;
    let trimmed = line.trim();
    if trimmed.chars().count() <= MAX {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(MAX).collect();
    out.push('…');
    out
}

#[tauri::command]
pub fn save_progress(
    state: State<'_, StoreState>,
    id: String,
    ratio: f64,
    page: u32,
    zoom: f64,
    pages: u32,
    // 只有电子书会传：流式排版里页码是算出来的，位置必须记 CFI
    cfi: Option<String>,
) -> Result<(), String> {
    let mut data = lock(&state)?;
    if let Some(book) = data.books.iter_mut().find(|b| b.id == id) {
        book.progress = Progress { ratio, page, zoom, cfi: cfi.unwrap_or_default() };
        if pages > 0 {
            book.pages = pages;
        }
        book.last_opened_at = store::now_ms();
    }
    store::persist(&data, &state.dir)
}

/// 加 / 删书签。幂等：同一个 CFI 反复加只留一条，删不存在的也不报错。
///
/// 用一个命令带 `on` 开关，而不是 add / remove 两个：前端本来就只有一个「切换」动作，
/// 拆成两个命令会让「点了两下」这种情形在并发下产生两条重复记录。
#[tauri::command]
pub fn set_bookmark(
    state: State<'_, StoreState>,
    id: String,
    cfi: String,
    label: String,
    on: bool,
) -> Result<Book, String> {
    let mut data = lock(&state)?;
    let Some(book) = data.books.iter_mut().find(|b| b.id == id) else {
        return Err("书架中找不到这本书".into());
    };
    if cfi.trim().is_empty() {
        // 没定位到位置就加书签，等于把书签加在第 0 页：宁可拒绝，也不写脏数据
        return Err("当前页还没有定位信息，稍后再试".into());
    }
    if on {
        if !book.bookmarks.iter().any(|m| m.cfi == cfi) {
            if book.bookmarks.len() >= MAX_BOOKMARKS {
                return Err(format!("一本书最多 {MAX_BOOKMARKS} 个书签，先删几个"));
            }
            book.bookmarks.push(Bookmark {
                cfi,
                label,
                created_at: store::now_ms(),
            });
        }
    } else {
        book.bookmarks.retain(|m| m.cfi != cfi);
    }
    let updated = book.clone();
    store::persist(&data, &state.dir)?;
    Ok(updated)
}

/// 划线：加一条或删一条。
///
/// 与 `set_bookmark` 同一套形状（幂等、返回整本书），因为前端两处的调用方式一样：
/// 画完立刻拿到新的整本书，直接塞回 `pane.book`，不必再发一次 `get_library`。
///
/// `text` 是选中时的原文快照。空原文仍然接受——固定版面上偶尔能选中图片替代文字，
/// 但拒绝空 CFI：没有位置信息的划线画不出来，也不能用来跳转。
#[tauri::command]
pub fn set_highlight(
    state: State<'_, StoreState>,
    id: String,
    cfi: String,
    text: String,
    color: String,
    label: String,
    on: bool,
    note: Option<String>,
) -> Result<Book, String> {
    let mut data = lock(&state)?;
    let Some(book) = data.books.iter_mut().find(|b| b.id == id) else {
        return Err("书架中找不到这本书".into());
    };
    if cfi.trim().is_empty() {
        return Err("没有选中文字，无法划线".into());
    }
    if on {
        // 同一条再说一次是「改色 / 改原文」，不是再加一条：前端点已有划线换颜色走的就是这里。
        // 先取下标再改：`if let Some(x) = iter_mut()...` 的 else 分支里还要写这个 Vec，
        // 借用会一直占到 else，编译器不让
        match book.highlights.iter().position(|m| m.cfi == cfi) {
            Some(index) => {
                let existing = &mut book.highlights[index];
                existing.color = color;
                if !text.is_empty() {
                    existing.text = text;
                }
                if !label.is_empty() {
                    existing.label = label;
                }
                // note 传 Some 才改（含空串 = 清空笔记）；老调用点不传，保持原笔记
                if let Some(note) = note.clone() {
                    existing.note = note;
                }
            }
            None => {
                if book.highlights.len() >= MAX_HIGHLIGHTS {
                    return Err(format!("一本书最多 {MAX_HIGHLIGHTS} 条划线，先删几条"));
                }
                book.highlights.push(Highlight { cfi, text, color, label, created_at: store::now_ms(), note: note.unwrap_or_default() });
            }
        }
    } else {
        book.highlights.retain(|m| m.cfi != cfi);
    }
    let updated = book.clone();
    store::persist(&data, &state.dir)?;
    Ok(updated)
}

/// 把前端拼好的文本写到用户选定的文件（摘录 .md、导出的 .html 都走这里）。
///
/// 内容由前端生成（`reader/export-marks.js`、`reader/doc-export.js`）：那是纯字符串
/// 处理，单元边界清楚，冒烟能直接断言输出形状；Rust 这边只负责弹保存框与落盘，
/// 不掺和格式。
///
/// 三个约定：
/// ① **取消返回空串**，不返回 Err——用户按「取消」不是失败，前端据此不弹提示；
/// ② 写 UTF-8 **无 BOM**：Markdown / HTML 都是给别的软件读的，BOM 会被部分解析器当成正文；
/// ③ 走 `spawn_blocking`：`rfd` 的保存框是阻塞调用，直接在命令线程里开会卡住 IPC。
///
/// `ext` 决定对话框的标题与文件类型过滤器，省略即 Markdown（摘录导出的老调用点
/// 不传这个参数，serde 对缺失的 `Option` 落 `None`，所以老路径一个字都不用改）。
#[tauri::command]
pub async fn save_text_file(
    default_name: String,
    content: String,
    ext: Option<String>,
) -> Result<String, String> {
    let ext = ext.unwrap_or_default().to_ascii_lowercase();
    let (title, fallback, filters): (&str, &str, Vec<(&str, &[&str])>) = match ext.as_str() {
        "html" => ("导出为 HTML", "document.html", vec![("HTML 文档", &["html", "htm"][..])]),
        "txt" => ("保存文本", "document.txt", vec![("文本文件", &["txt"][..])]),
        _ => (
            "保存摘录",
            "excerpt.md",
            vec![("Markdown", &["md"][..]), ("文本文件", &["txt"][..])],
        ),
    };
    let name = {
        let trimmed = default_name.trim();
        if trimmed.is_empty() { fallback.to_string() } else { trimmed.to_string() }
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new().set_title(title).set_file_name(name);
        for (label, extensions) in filters {
            dialog = dialog.add_filter(label, extensions);
        }
        let Some(path) = dialog.save_file() else {
            return Ok(String::new());
        };
        fs::write(&path, content.as_bytes()).map_err(|err| format!("写入失败：{err}"))?;
        Ok(path.to_string_lossy().to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

/// 另存一份**原文件副本**（PDF / 电子书用）。
///
/// 不重排版、不转格式：PDF 的版面与电子书的排版都由原文件本身决定，前端再
/// 「渲染」一遍只会得到一份更差的近似品——图丢了、字体换了、分页全乱。真正的
/// 需求是「把这本书带出去」，那就把原样的字节交出去。
///
/// 与 `save_text_file` 同一套约定：取消回空串、`spawn_blocking` 避开阻塞。
#[tauri::command]
pub async fn save_file_copy(path: String, default_name: String) -> Result<String, String> {
    let source = PathBuf::from(&path);
    if !source.is_file() {
        return Err("文件已不在原位置".into());
    }
    let fallback = source
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "copy".to_string());
    let name = {
        let trimmed = default_name.trim();
        if trimmed.is_empty() { fallback } else { trimmed.to_string() }
    };
    tauri::async_runtime::spawn_blocking(move || {
        let ext = source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let mut dialog = rfd::FileDialog::new().set_title("另存副本").set_file_name(name);
        if !ext.is_empty() {
            dialog = dialog.add_filter(ext.to_uppercase(), &[ext.as_str()]);
        }
        let Some(target) = dialog.save_file() else {
            return Ok(String::new());
        };
        fs::copy(&source, &target).map_err(|err| format!("复制失败：{err}"))?;
        Ok(target.to_string_lossy().to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

/// 读取一张本地图片并编码成 data URL，供「导出为 HTML」把图片内联进去。
///
/// 导出的 HTML 会被拿到别的机器上打开：`asset://` 只在应用内有效，不内联就是
/// 一排碎图标。上限 8MB——内联会让 HTML 膨胀 4/3 倍，更大的图片更适合外链。
#[tauri::command]
pub fn read_image_data_url(path: String) -> Result<String, String> {
    const MAX_INLINE_IMAGE: u64 = 8 * 1024 * 1024;
    let meta = fs::metadata(&path).map_err(|err| format!("读取失败：{err}"))?;
    if meta.len() > MAX_INLINE_IMAGE {
        return Err("图片超过 8MB".into());
    }
    let bytes = fs::read(&path).map_err(|err| format!("读取失败：{err}"))?;
    Ok(format!("data:{};base64,{}", image_mime(&path), base64(&bytes)))
}

/// 打印当前 WebView 的内容。
///
/// 平台差异必须在这里抹平，前端只认这一个命令：
/// - **macOS**：WKWebView 不支持 `window.print()`（调用后静默无反应，连错误都没有），
///   只能走 wry 暴露的原生打印（`NSPrintOperation`）；
/// - **Windows / Linux**：反过来——wry 的 `print()` 只有 macOS 实现，`window.print()`
///   才是通路（WebView2 的 `PrintAsync`、WebKitGTK 的打印对话框）。
///
/// 两边都遵守 `@media print`，所以「只打印正文、不打印工具栏」这件事交给 CSS，
/// 这里不拼任何内容。
#[tauri::command]
pub fn print_webview(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        window.print().map_err(|err| format!("打印失败：{err}"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        window.eval("window.print()").map_err(|err| format!("打印失败：{err}"))
    }
}

/// 扩展名 → MIME。内联图片只需要覆盖常见的几种，认不出的按二进制流交出去
fn image_mime(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

/// 标准 base64（RFC 4648，带 `=` 补位）。
///
/// 只为内联图片写这二十行，不引依赖：Base64 的规则只有一张 64 字符表和三条移位，
/// 而引一个 crate 就要多一份版本、许可证与打包体积的账。
fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let packed = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(packed >> 18) as usize & 63] as char);
        out.push(TABLE[(packed >> 12) as usize & 63] as char);
        // 不足三字节的尾部用 `=` 补位，解码端据此知道哪几位是填充
        out.push(if chunk.len() > 1 { TABLE[(packed >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[packed as usize & 63] as char } else { '=' });
    }
    out
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
    // 检索索引跟着书走：留着只会让 data/search 越积越多，而且再也对不上任何一本书
    let stale = search_dir(&state.dir).join(format!("{}.json", safe_id(&id)));
    let _ = fs::remove_file(stale);
    Ok(data.books.clone())
}

/// 撤销移除：把前端持有的 Book 快照原样塞回书架。
///
/// 幂等——id 已存在（撤销双击、窗口内重新导入了同一文件）直接返回当前书架。
/// 检索索引不随快照恢复：`read_search_index` 对缺失返回 None，下次检索按需重建。
#[tauri::command]
pub fn restore_book(state: State<'_, StoreState>, book: Book) -> Result<Vec<Book>, String> {
    let mut data = lock(&state)?;
    if !data.books.iter().any(|b| b.id == book.id) {
        data.books.push(book);
        store::persist(&data, &state.dir)?;
    }
    Ok(data.books.clone())
}

/* ---------------- 跨书检索的正文索引 ---------------- */

/// PDF 与电子书的正文不能像文本那样按需解码（一份是压缩流、一份是打包的 XHTML），
/// 所以由前端抽一次、存在这里，检索时反复用。
///
/// 只存正文与位置标签，不存渲染结果；`size` 与 `mtime` 是失效判据——文件被改过
/// 就得重建，否则搜到的会是旧内容。
#[derive(Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchIndex {
    /// 结构版本。将来改了单位形状就 +1，旧缓存自动作废，不必写迁移
    pub v: u32,
    pub size: u64,
    pub mtime: u64,
    pub units: Vec<SearchUnit>,
}

#[derive(Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchUnit {
    /// 位置标签：PDF 是「第 12 页」，电子书是章节名
    pub label: String,
    /// PDF 的页码；其它格式为 0
    #[serde(default)]
    pub page: u32,
    /// 电子书的章节 href；其它格式为空串。当前不参与跳转，留给第二期按位置命中
    #[serde(default)]
    pub href: String,
    pub text: String,
}

fn search_dir(dir: &Path) -> PathBuf {
    dir.join("search")
}

/// 索引文件名。`id` 是路径哈希（十六进制），理论上安全，仍然过一遍白名单——
/// 这个值来自前端，不该直接拼进路径。
fn safe_id(id: &str) -> String {
    id.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect()
}

#[tauri::command]
pub fn read_search_index(state: State<'_, StoreState>, id: String) -> Result<Option<SearchIndex>, String> {
    let path = search_dir(&state.dir).join(format!("{}.json", safe_id(&id)));
    let Ok(raw) = fs::read(&path) else {
        // 没有缓存是常态（第一次检索），不是错误
        return Ok(None);
    };
    // 解析失败按没有处理：宁可重建一次，也不要让一个坏文件永久卡住检索
    Ok(serde_json::from_slice::<SearchIndex>(&raw).ok())
}

#[tauri::command]
pub fn write_search_index(state: State<'_, StoreState>, id: String, index: SearchIndex) -> Result<(), String> {
    let dir = search_dir(&state.dir);
    fs::create_dir_all(&dir).map_err(|err| format!("写入索引失败：{err}"))?;
    let stem = safe_id(&id);
    if stem.is_empty() {
        return Err("索引 id 无效".into());
    }
    let raw = serde_json::to_vec(&index).map_err(|err| err.to_string())?;
    // 先写临时文件再改名：检索可能和写入并发（切书时常见），半截 JSON 会让下次
    // 读取解析失败，然后把整本书重抽一遍
    let tmp = dir.join(format!("{stem}.json.tmp"));
    fs::write(&tmp, &raw).map_err(|err| format!("写入索引失败：{err}"))?;
    fs::rename(&tmp, dir.join(format!("{stem}.json"))).map_err(|err| format!("写入索引失败：{err}"))
}

/* ---------------- 分类 ---------------- */

/// 分类色板：与前端 `src/js/core/constants.js` 的 CATEGORY_COLORS 保持一致
const CATEGORY_COLORS: [&str; 6] = ["clay", "indigo", "olive", "amber", "plum", "slate"];
const MAX_CATEGORIES: usize = 40;
const MAX_CATEGORY_NAME: usize = 20;

/// 归一化并校验分类输入。
/// 名称错误必须拦下（用户可修），颜色错误静默回落到 clay（只是显示属性，报错无法指导用户操作）。
fn normalize_category_input(
    categories: &[Category],
    skip_id: Option<&str>,
    name: &str,
    color: &str,
) -> Result<(String, String), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("名称不能为空".into());
    }
    if name.chars().count() > MAX_CATEGORY_NAME {
        return Err(format!("名称最多 {MAX_CATEGORY_NAME} 个字符"));
    }
    // 忽略大小写与首尾空白后比较，避免出现「论文」与「论文 」两个视觉上相同的分类
    let lowered = name.to_lowercase();
    if categories
        .iter()
        .any(|c| Some(c.id.as_str()) != skip_id && c.name.trim().to_lowercase() == lowered)
    {
        return Err("已存在同名分类".into());
    }
    let color = if CATEGORY_COLORS.contains(&color) { color } else { CATEGORY_COLORS[0] };
    Ok((name.to_string(), color.to_string()))
}

/// 生成不与现有分类冲突的 id：毫秒时间戳十六进制，撞上了就顺延
fn next_category_id(categories: &[Category]) -> String {
    let base = store::now_ms();
    let mut offset = 0u64;
    loop {
        let candidate = format!("c{:x}", base + offset);
        if !categories.iter().any(|c| c.id == candidate) {
            return candidate;
        }
        offset += 1;
    }
}

#[tauri::command]
pub fn get_categories(state: State<'_, StoreState>) -> Result<Vec<Category>, String> {
    Ok(lock(&state)?.categories.clone())
}

#[tauri::command]
pub fn create_category(
    state: State<'_, StoreState>,
    name: String,
    color: String,
) -> Result<Category, String> {
    let mut data = lock(&state)?;
    if data.categories.len() >= MAX_CATEGORIES {
        return Err(format!("分类数量已达上限（{MAX_CATEGORIES}）"));
    }
    let (name, color) = normalize_category_input(&data.categories, None, &name, &color)?;
    let category = Category {
        id: next_category_id(&data.categories),
        name,
        color,
        created_at: store::now_ms(),
    };
    data.categories.push(category.clone());
    store::persist(&data, &state.dir)?;
    Ok(category)
}

#[tauri::command]
pub fn update_category(
    state: State<'_, StoreState>,
    id: String,
    name: String,
    color: String,
) -> Result<Category, String> {
    let mut data = lock(&state)?;
    let (name, color) = normalize_category_input(&data.categories, Some(&id), &name, &color)?;
    let Some(category) = data.categories.iter_mut().find(|c| c.id == id) else {
        return Err("分类不存在，可能已被删除".into());
    };
    category.name = name;
    category.color = color;
    let updated = category.clone();
    store::persist(&data, &state.dir)?;
    Ok(updated)
}

/// 删除分类，同时把它下面的书重置为「未分类」。
/// 必须和删除在同一把锁里完成，否则会留下指向已删分类的悬挂引用。
#[tauri::command]
pub fn delete_category(state: State<'_, StoreState>, id: String) -> Result<Vec<Book>, String> {
    let mut data = lock(&state)?;
    if !data.categories.iter().any(|c| c.id == id) {
        return Err("分类不存在，可能已被删除".into());
    }
    data.categories.retain(|c| c.id != id);
    for book in data.books.iter_mut() {
        if book.category_id == id {
            book.category_id.clear();
        }
    }
    store::persist(&data, &state.dir)?;
    Ok(data.books.clone())
}

/// 批量归类。前端一次提交全部 id，避免逐条调用写入多次磁盘、中途失败留下半归类状态。
/// `category_id` 为空串表示移出分类（回到未分类）。
#[tauri::command]
pub fn assign_category(
    state: State<'_, StoreState>,
    ids: Vec<String>,
    category_id: String,
) -> Result<Vec<Book>, String> {
    let mut data = lock(&state)?;
    if !category_id.is_empty() && !data.categories.iter().any(|c| c.id == category_id) {
        return Err("分类不存在，可能已被删除".into());
    }
    for book in data.books.iter_mut() {
        // 找不到的 id 直接跳过：批量操作应当幂等，不因为其中一条已删除而整体失败
        if ids.iter().any(|id| *id == book.id) {
            book.category_id = category_id.clone();
        }
    }
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

/// pdf.js 的 PDFDataRangeTransport 按需读取字节区间。
///
/// 大文件必须走这里：asset 协议在收到**不带 Range** 的请求时会把整个文件读进内存，
/// 2 GB 的 PDF 会直接把进程撑死（表现为界面卡死后应用自动退出）。
/// 本命令只读请求到的那一段，内存占用与文件大小无关。
#[tauri::command]
pub fn read_pdf_range(path: String, begin: u64, end: u64) -> Result<tauri::ipc::Response, String> {
    let mut file = fs::File::open(&path).map_err(|err| format!("读取 PDF 失败：{err}"))?;
    let len = file
        .metadata()
        .map_err(|err| format!("读取 PDF 失败：{err}"))?
        .len();

    // 越界请求返回空块，由 pdf.js 按 EOF 处理
    if begin >= len || end <= begin {
        return Ok(tauri::ipc::Response::new(Vec::new()));
    }

    // 正常对象都是 KB～几十 MB 级；一次要上百 MB 说明文件结构已损坏
    // （pdf.js 会退化成整份读取），此时明确报错，避免分配几个 GB 把进程撑崩
    let size = (end.min(len) - begin) as u64;
    if size > MAX_RANGE_BYTES {
        return Err(format!(
            "这份 PDF 的结构异常，需要一次读取 {:.0} MB 数据，超出安全上限",
            size as f64 / 1024.0 / 1024.0
        ));
    }
    let size = size as usize;
    let mut buffer = Vec::new();
    buffer.try_reserve_exact(size).map_err(|_| {
        format!(
            "内存不足，无法读取这份 PDF 的 {:.0} MB 数据",
            size as f64 / 1024.0 / 1024.0
        )
    })?;
    buffer.resize(size, 0);
    file.seek(SeekFrom::Start(begin))
        .map_err(|err| format!("读取 PDF 失败：{err}"))?;
    file.read_exact(&mut buffer)
        .map_err(|err| format!("读取 PDF 失败：{err}"))?;
    Ok(tauri::ipc::Response::new(buffer))
}

/* ---------------- 应用更新 ---------------- */

/// 更新包只允许从 GitHub 官方域名下载，避免被替换成任意地址
const UPDATE_HOSTS: [&str; 4] = [
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "api.github.com",
];

#[derive(Clone, Serialize)]
struct UpdateProgress {
    received: u64,
    total: u64,
}

/// 当前应用版本（编译期写入 Cargo.toml 的版本号）
#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

fn update_host_allowed(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = host.split('@').next_back().unwrap_or(host);
    let host = host.split(':').next().unwrap_or(host);
    UPDATE_HOSTS
        .iter()
        .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")))
}

/// 下载更新包到临时目录，期间通过 `update-progress` 事件汇报进度。
///
/// 交给系统自带的 curl（Windows 10+ / macOS / 主流 Linux 均有），
/// 不额外引入 HTTP 依赖；下载中轮询文件大小即可算出百分比。
///
/// 代理必须显式处理：curl 只认 `HTTPS_PROXY` 之类的环境变量，**不读 Windows 系统代理**，
/// 而 WebView2 里的 `fetch` 会读。于是会出现「检查更新能查到、点下载却一直 0 字节」——
/// 浏览器能打开下载页、应用内却卡死。这里在读不到环境变量时补上系统代理。
#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    url: String,
    file_name: String,
    size: u64,
) -> Result<String, String> {
    if !update_host_allowed(&url) {
        return Err("更新地址不在允许范围内".into());
    }
    // 只接受安装包文件名，防止被当成任意路径写入
    let name = Path::new(&file_name)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| name.to_ascii_lowercase().ends_with(".exe"))
        .ok_or_else(|| "更新包文件名无效".to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        let dir = std::env::temp_dir().join("yuejian-update");
        fs::create_dir_all(&dir).map_err(|err| format!("无法创建更新目录：{err}"))?;
        let path = dir.join(&name);
        let _ = fs::remove_file(&path);

        let mut command = std::process::Command::new("curl");
        // 下载动辄几十秒，绝不能让 curl 自带的控制台窗口挂在桌面上
        quiet(&mut command);
        command.args([
            "-L",
            "--fail",
            "--silent",
            "--show-error",
            "--retry",
            "2",
            // 不给超时就会无限期挂着：界面停在 0%，用户既不知道在等什么也没法重试
            "--connect-timeout",
            "20",
            // 连续 40 秒低于 1 KB/s 视为链路已死，主动失败而不是假死
            "--speed-limit",
            "1024",
            "--speed-time",
            "40",
        ]);
        if let Some(proxy) = curl_proxy() {
            command.arg("--proxy").arg(proxy);
        }
        let mut child = command
            .arg("--user-agent")
            .arg(concat!("YueJianReader/", env!("CARGO_PKG_VERSION")))
            .arg("-o")
            .arg(&path)
            .arg(&url)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|err| format!("无法启动下载：{err}"))?;

        // stderr 要在独立线程里读完：管道容量有限，只等进程结束再读会把它堵死
        let stderr_handle = child.stderr.take().map(|mut pipe| {
            std::thread::spawn(move || {
                let mut text = String::new();
                let _ = pipe.read_to_string(&mut text);
                text
            })
        });

        loop {
            let received = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
            let _ = app.emit("update-progress", UpdateProgress { received, total: size });
            match child.try_wait() {
                Ok(Some(status)) => {
                    let stderr = stderr_handle
                        .and_then(|handle| handle.join().ok())
                        .unwrap_or_default();
                    if !status.success() {
                        let _ = fs::remove_file(&path);
                        return Err(download_failure_message(status.code(), &stderr));
                    }
                    let received = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
                    let _ = app.emit("update-progress", UpdateProgress { received, total: received.max(size) });
                    return Ok(path.to_string_lossy().to_string());
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(200)),
                Err(err) => {
                    let _ = child.kill();
                    let _ = fs::remove_file(&path);
                    return Err(format!("下载更新包失败：{err}"));
                }
            }
        }
    })
    .await
    .map_err(|err| err.to_string())?
}

/// curl 要用的代理地址；返回 None 表示让 curl 走自己的默认行为（含环境变量）
///
/// 顺序：环境变量已经设了就不插手（curl 自己会读，显式传反而可能覆盖用户意图），
/// 否则在 Windows 上读一次系统代理设置。
fn curl_proxy() -> Option<String> {
    for key in ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] {
        if std::env::var_os(key).is_some() {
            return None;
        }
    }
    #[cfg(target_os = "windows")]
    {
        return windows_system_proxy();
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

/// 读 `HKCU\...\Internet Settings` 里的系统代理。
///
/// 用 `reg query` 而不是引第三方 crate：这里只需要读两个值，
/// 为它拉一棵依赖树（还要跟着升级）不划算；`reg.exe` 在 System32 恒定存在。
#[cfg(target_os = "windows")]
fn windows_system_proxy() -> Option<String> {
    const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";

    let mut command = std::process::Command::new("reg");
    quiet(&mut command);
    let output = command
        .args(["query", KEY])
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_proxy_reg_query(&String::from_utf8_lossy(&output.stdout))
}

/// 解析 `reg query` 的输出，换算成 curl 的 `--proxy` 取值。
///
/// 输入形如（制表符分隔，这里按空白切分）：
/// ```text
/// HKEY_CURRENT_USER\Software\...\Internet Settings
///     ProxyEnable    REG_DWORD    0x1
///     ProxyServer    REG_SZ    127.0.0.1:7890
/// ```
/// `ProxyServer` 有两种形态：`127.0.0.1:7890`，或 `http=h:p;https=h:p;socks=h:p`。
/// 后者优先取 https，其次 http，最后 socks（转成 socks5h:// 让代理解析域名）。
fn parse_proxy_reg_query(text: &str) -> Option<String> {
    let (mut enabled, mut server) = (None, None);
    for line in text.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 3 {
            continue;
        }
        let kind = fields[fields.len() - 2];
        if !kind.starts_with("REG_") {
            continue;
        }
        let value = fields[fields.len() - 1];
        match fields[0] {
            "ProxyEnable" => enabled = Some(value.to_string()),
            "ProxyServer" => server = Some(value.to_string()),
            _ => {}
        }
    }
    // ProxyEnable 为 0 时忽略 ProxyServer 残留值（关掉代理后该键不会被清空）
    if !enabled.is_some_and(|value| value.trim_start_matches("0x") == "1") {
        return None;
    }
    let server = server?;
    let server = server.trim();
    if server.is_empty() {
        return None;
    }
    if !server.contains('=') {
        return Some(format!("http://{server}"));
    }
    let (mut http, mut https, mut socks) = (None, None, None);
    for part in server.split(';') {
        let Some((scheme, address)) = part.split_once('=') else {
            continue;
        };
        let address = address.trim();
        if address.is_empty() {
            continue;
        }
        match scheme.trim().to_ascii_lowercase().as_str() {
            "https" => https = Some(address.to_string()),
            "http" => http = Some(address.to_string()),
            "socks" | "socks5" | "socks4" => socks = Some(address.to_string()),
            _ => {}
        }
    }
    if let Some(address) = https.or(http) {
        return Some(format!("http://{address}"));
    }
    socks.map(|address| format!("socks5h://{address}"))
}

/// 把 curl 的退出码翻译成能指导下一次尝试的提示。
///
/// 只在失败路径调用，因此可以把「怎么办」直接写进文案。
fn download_failure_message(code: Option<i32>, stderr: &str) -> String {
    let reason = match code {
        Some(6) => "域名解析失败，可能是网络或 DNS 被拦截",
        Some(7) => "无法连接到下载服务器",
        Some(23) => "写入临时文件失败（磁盘空间不足或被安全软件拦截）",
        Some(28) => "连接或传输超时",
        Some(35) => "TLS 握手失败",
        Some(56) => "接收数据时连接中断",
        Some(other) => return format!("下载更新包失败（curl 退出码 {other}）"),
        None => "下载进程被异常终止",
    };
    let detail = stderr.trim();
    if detail.is_empty() {
        format!("{reason}。若浏览器能打开下载页，请检查系统代理设置后重试，或直接到发布页手动下载。")
    } else {
        format!("{reason}（{detail}）。若浏览器能打开下载页，请检查系统代理设置后重试，或直接到发布页手动下载。")
    }
}

/// 启动更新包并退出应用：安装器会先卸载旧版本（保留用户数据）再安装新版本
#[tauri::command]
pub fn install_update(app: AppHandle, path: String) -> Result<(), String> {
    let installer = PathBuf::from(&path);
    let is_exe = installer
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("exe"))
        .unwrap_or(false);
    if !is_exe || !installer.is_file() {
        return Err("更新包不存在，请重新下载".into());
    }
    // 必须以独立进程启动：安装器要替换正在运行的程序文件，应用需要先退出
    std::process::Command::new(&installer)
        .spawn()
        .map_err(|err| format!("无法启动更新包：{err}"))?;
    app.exit(0);
    Ok(())
}

/* ---------------- 正文字体（按需下载） ---------------- */

/// 字体只允许从这几个官方域名下载：GitHub Release 与其资产重定向、Google Fonts 官方仓库
const FONT_HOSTS: [&str; 4] = [
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "raw.githubusercontent.com",
];

#[derive(Clone, Serialize)]
struct FontProgress {
    id: String,
    received: u64,
    total: u64,
}

#[derive(Serialize)]
pub struct FontFile {
    pub name: String,
    pub path: String,
    pub bytes: u64,
}

#[derive(Serialize)]
pub struct FontStore {
    pub dir: String,
    pub files: Vec<FontFile>,
}

/// 下载的字体跟着数据目录走：发布构建在可执行文件同级的 `data/fonts/`
fn fonts_dir() -> PathBuf {
    crate::paths::runtime_root().join("fonts")
}

fn font_host_allowed(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = host.split('@').next_back().unwrap_or(host);
    let host = host.split(':').next().unwrap_or(host);
    FONT_HOSTS
        .iter()
        .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")))
}

/// 本地文件名只留安全字符：它是 `data/fonts/` 下的落盘名，不接受任何路径成分
fn safe_font_name(name: &str) -> Option<String> {
    let name = Path::new(name)
        .file_name()
        .map(|part| part.to_string_lossy().to_string())?;
    let lower = name.to_ascii_lowercase();
    if !(lower.ends_with(".ttf") || lower.ends_with(".otf")) || lower.starts_with('.') {
        return None;
    }
    if name.len() > 96 {
        return None;
    }
    let clean = name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    clean.then_some(name)
}

/// 文件头必须是 TrueType / OpenType 容器，挡住「下载回来其实是一张网页」的情况
fn font_magic_ok(path: &Path) -> bool {
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut head = [0u8; 4];
    if file.read_exact(&mut head).is_err() {
        return false;
    }
    matches!(&head, [0, 1, 0, 0] | b"true" | b"OTTO")
}

/// 已下载的字体清单。只登记目录里像字体文件的条目，大小一并返回给前端做展示
#[tauri::command]
pub fn list_fonts() -> Result<FontStore, String> {
    let dir = fonts_dir();
    fs::create_dir_all(&dir).map_err(|err| format!("无法创建字体目录：{err}"))?;
    let mut files = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().map(|part| part.to_string_lossy().to_string()) else {
                continue;
            };
            if safe_font_name(&name).is_none() {
                continue;
            }
            let bytes = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            if bytes == 0 {
                continue;
            }
            files.push(FontFile {
                name,
                path: path.to_string_lossy().to_string(),
                bytes,
            });
        }
    }
    files.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(FontStore {
        dir: dir.to_string_lossy().to_string(),
        files,
    })
}

/// 把一款字体下载到 `data/fonts/`，返回落盘绝对路径；进度通过 `font-progress` 事件汇报。
///
/// 与更新包同一套做法：交给系统 curl（含代理透传），先写 `.part`，校验文件头之后
/// 才改名成正体——半截文件不会被下一次启动当成「已安装」。
#[tauri::command]
pub async fn download_font(
    app: AppHandle,
    id: String,
    url: String,
    file_name: String,
    bytes: u64,
) -> Result<String, String> {
    if !font_host_allowed(&url) {
        return Err("字体地址不在允许范围内".into());
    }
    let name = safe_font_name(&file_name).ok_or_else(|| "字体文件名无效".to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        let dir = fonts_dir();
        fs::create_dir_all(&dir).map_err(|err| format!("无法创建字体目录：{err}"))?;
        let path = dir.join(&name);
        let part = dir.join(format!("{name}.part"));
        let _ = fs::remove_file(&part);
        let _ = fs::remove_file(&path);

        let mut command = std::process::Command::new("curl");
        quiet(&mut command);
        command.args([
            "-L",
            "--fail",
            "--silent",
            "--show-error",
            "--retry",
            "2",
            "--connect-timeout",
            "20",
            "--speed-limit",
            "1024",
            "--speed-time",
            "40",
        ]);
        if let Some(proxy) = curl_proxy() {
            command.arg("--proxy").arg(proxy);
        }
        let mut child = command
            .arg("--user-agent")
            .arg(concat!("YueJianReader/", env!("CARGO_PKG_VERSION")))
            .arg("-o")
            .arg(&part)
            .arg(&url)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|err| format!("无法启动下载：{err}"))?;

        let stderr_handle = child.stderr.take().map(|mut pipe| {
            std::thread::spawn(move || {
                let mut text = String::new();
                let _ = pipe.read_to_string(&mut text);
                text
            })
        });

        loop {
            let received = fs::metadata(&part).map(|meta| meta.len()).unwrap_or(0);
            let _ = app.emit(
                "font-progress",
                FontProgress {
                    id: id.clone(),
                    received,
                    total: bytes,
                },
            );
            match child.try_wait() {
                Ok(Some(status)) => {
                    let stderr = stderr_handle
                        .and_then(|handle| handle.join().ok())
                        .unwrap_or_default();
                    if !status.success() {
                        let _ = fs::remove_file(&part);
                        return Err(download_failure_message(status.code(), &stderr));
                    }
                    if !font_magic_ok(&part) {
                        let _ = fs::remove_file(&part);
                        return Err("下载到的文件不是有效字体".into());
                    }
                    fs::rename(&part, &path).map_err(|err| {
                        let _ = fs::remove_file(&part);
                        format!("无法保存字体：{err}")
                    })?;
                    return Ok(path.to_string_lossy().to_string());
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(150)),
                Err(err) => {
                    let _ = child.kill();
                    let _ = fs::remove_file(&part);
                    return Err(format!("下载字体失败：{err}"));
                }
            }
        }
    })
    .await
    .map_err(|err| err.to_string())?
}

/// 删除一款已下载字体。文件不在也算成功——界面要的是「删干净了」这个结果
#[tauri::command]
pub fn remove_font(file_name: String) -> Result<(), String> {
    let name = safe_font_name(&file_name).ok_or_else(|| "字体文件名无效".to_string())?;
    let path = fonts_dir().join(name);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("无法删除字体：{err}")),
    }
}

/// 用系统默认浏览器打开外部链接（仅允许 https）
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("只能打开 https 链接".into());
    }
    #[cfg(target_os = "windows")]
    let spawned = {
        // `cmd /C start` 是控制台程序，不加这个会闪一下黑框
        let mut command = std::process::Command::new("cmd");
        quiet(&mut command);
        command.args(["/C", "start", "", &url]).spawn()
    };
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let spawned = std::process::Command::new("xdg-open").arg(&url).spawn();
    spawned.map(|_| ()).map_err(|err| format!("无法打开链接：{err}"))
}

#[cfg(test)]
mod tests {
    use super::parse_proxy_reg_query;

    const HEADER: &str = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

    #[test]
    fn reads_plain_host_port_proxy() {
        let text = format!("{HEADER}\n    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    127.0.0.1:7890\n");
        assert_eq!(parse_proxy_reg_query(&text).as_deref(), Some("http://127.0.0.1:7890"));
    }

    #[test]
    fn ignores_proxy_server_when_disabled() {
        // 关掉系统代理后 ProxyServer 会留在注册表里，不能拿来用
        let text = format!("{HEADER}\n    ProxyEnable    REG_DWORD    0x0\n    ProxyServer    REG_SZ    127.0.0.1:7890\n");
        assert_eq!(parse_proxy_reg_query(&text), None);
    }

    #[test]
    fn prefers_https_then_http_in_multi_scheme_value() {
        let text = format!("{HEADER}\n    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    http=1.1.1.1:8080;https=2.2.2.2:8443;ftp=3.3.3.3:21\n");
        assert_eq!(parse_proxy_reg_query(&text).as_deref(), Some("http://2.2.2.2:8443"));

        let only_http = format!("{HEADER}\n    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    http=1.1.1.1:8080\n");
        assert_eq!(parse_proxy_reg_query(&only_http).as_deref(), Some("http://1.1.1.1:8080"));
    }

    #[test]
    fn maps_socks_to_socks5h_for_remote_dns() {
        let text = format!("{HEADER}\n    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    socks=127.0.0.1:1080\n");
        assert_eq!(parse_proxy_reg_query(&text).as_deref(), Some("socks5h://127.0.0.1:1080"));
    }

    #[test]
    fn returns_none_without_usable_value() {
        assert_eq!(parse_proxy_reg_query(""), None);
        assert_eq!(parse_proxy_reg_query(HEADER), None);
        let empty_server = format!("{HEADER}\n    ProxyEnable    REG_DWORD    0x1\n");
        assert_eq!(parse_proxy_reg_query(&empty_server), None);
    }

    #[test]
    fn encodes_base64_with_padding() {
        // 三种尾部长度各取一个：无补位、补一个 `=`、补两个 `=`。
        // 内联图片的字节数几乎总不是 3 的倍数，补位错了整张图就解不出来
        assert_eq!(super::base64(b"Man"), "TWFu");
        assert_eq!(super::base64(b"Ma"), "TWE=");
        assert_eq!(super::base64(b"M"), "TQ==");
        assert_eq!(super::base64(b""), "");
        // 0xFB 0xFF：全部落在表的末段，用来验证移位后没越界
        assert_eq!(super::base64(&[0xfb, 0xff]), "+/8=");
    }

    #[test]
    fn maps_image_extension_to_mime() {
        assert_eq!(super::image_mime("C:/a/b.png"), "image/png");
        assert_eq!(super::image_mime("C:/a/b.JPEG"), "image/jpeg");
        assert_eq!(super::image_mime("C:/a/b.unknown"), "application/octet-stream");
        assert_eq!(super::image_mime("C:/a/b"), "application/octet-stream");
    }

    #[test]
    fn font_urls_limited_to_official_sources() {
        assert!(super::font_host_allowed(
            "https://raw.githubusercontent.com/google/fonts/main/ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf"
        ));
        assert!(super::font_host_allowed(
            "https://github.com/lxgw/LxgwWenkaiGB/releases/download/v1.530/LXGWWenKaiGB-Regular.ttf"
        ));
        assert!(super::font_host_allowed(
            "https://release-assets.githubusercontent.com/github-production-release-asset/1"
        ));
        assert!(super::font_host_allowed(
            "https://objects.githubusercontent.com/github-production-release-asset/1"
        ));
        assert!(!super::font_host_allowed("http://raw.githubusercontent.com/a.ttf"));
        assert!(!super::font_host_allowed("https://github.com.evil.example/a.ttf"));
        assert!(!super::font_host_allowed("https://evil.example/a.ttf"));
    }

    #[test]
    fn font_names_stay_inside_fonts_dir() {
        assert_eq!(
            super::safe_font_name("lxgwwenkai-gb-regular.ttf").as_deref(),
            Some("lxgwwenkai-gb-regular.ttf")
        );
        // 路径成分被剥掉，只剩最后一段
        assert_eq!(
            super::safe_font_name("../../data/state.json").as_deref(),
            None
        );
        assert_eq!(
            super::safe_font_name("..\\fonts\\x.ttf").as_deref(),
            Some("x.ttf")
        );
        assert_eq!(super::safe_font_name("setup.exe"), None);
        assert_eq!(super::safe_font_name(".hidden.ttf"), None);
        assert_eq!(super::safe_font_name("NotoSerifSC[wght].ttf"), None);
        assert_eq!(super::safe_font_name(&"a".repeat(100)), None);
    }

    #[test]
    fn font_magic_rejects_non_fonts() {
        let dir = std::env::temp_dir().join(format!("yj-font-magic-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let good = dir.join("good.ttf");
        std::fs::write(&good, [0u8, 1, 0, 0, 9, 9]).unwrap();
        assert!(super::font_magic_ok(&good));
        let otto = dir.join("cff.otf");
        std::fs::write(&otto, b"OTTO\x01\x00").unwrap();
        assert!(super::font_magic_ok(&otto));
        let html = dir.join("bad.ttf");
        std::fs::write(&html, b"<!doctype html>").unwrap();
        assert!(!super::font_magic_ok(&html));
        let short = dir.join("short.ttf");
        std::fs::write(&short, b"\x00\x01").unwrap();
        assert!(!super::font_magic_ok(&short));
        assert!(!super::font_magic_ok(&dir.join("missing.ttf")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
