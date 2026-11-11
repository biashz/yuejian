use std::path::{Path, PathBuf};

/// 运行时数据根目录。
///
/// - 发布构建：可执行文件同级的 `data/`，即安装目录内，
///   保证书架、设置、WebView2 缓存全部随安装位置走，不写入用户目录。
/// - 调试构建：项目根目录下的 `.data/`，避免污染 `src-tauri/target`。
pub fn runtime_root() -> PathBuf {
    if cfg!(debug_assertions) {
        if let Some(project_root) = Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
            return project_root.join(".data");
        }
    }

    // AppImage 内的可执行文件位于只读挂载点，数据要放在 .AppImage 文件同级目录
    #[cfg(target_os = "linux")]
    if let Some(appimage) = std::env::var_os("APPIMAGE") {
        if let Some(parent) = Path::new(&appimage).parent() {
            return parent.join("data");
        }
    }

    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("data")
}
