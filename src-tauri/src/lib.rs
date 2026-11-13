mod commands;
mod markdown;
pub mod paths;
mod store;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let state = store::init();
            // 窗口标题跟随上次选择的界面语言，避免启动瞬间闪现另一种语言的名称
            let language = state
                .data
                .lock()
                .map(|data| data.settings.language.clone())
                .unwrap_or_default();
            let title = if language == "en" { "YueJian Reader" } else { "阅笺" };
            app.manage(state);

            // 窗口的 WebView2 数据目录指向运行时数据目录，
            // 否则 Tauri 会默认在 %LOCALAPPDATA%\<identifier> 下建目录。
            let webview_dir = paths::runtime_root().join("webview2");
            std::fs::create_dir_all(&webview_dir)?;

            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title(title)
                .inner_size(1320.0, 860.0)
                .min_inner_size(960.0, 620.0)
                .center()
                .decorations(false)
                .data_directory(webview_dir)
                .build()?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_library,
            commands::get_settings,
            commands::save_settings,
            commands::pick_files,
            commands::import_files,
            commands::open_book,
            commands::save_progress,
            commands::toggle_favorite,
            commands::remove_book,
            commands::read_pdf_bytes,
            commands::read_pdf_range,
        ])
        .run(tauri::generate_context!())
        .expect("启动阅笺失败");
}
