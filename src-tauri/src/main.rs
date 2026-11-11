#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebView2 的数据目录由 yuejian_lib 在创建窗口时显式指定，
    // 统一落在运行时数据目录下，不写入用户目录。
    yuejian_lib::run()
}
