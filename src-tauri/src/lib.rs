mod analyzer;
mod commands;
mod db;
mod http_server;
mod models;
mod recommender;
mod state;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = AppState::new().expect("初始化 AppState 失败");
    let db_for_http = std::sync::Arc::clone(&app_state.db);

    tauri::Builder::default()
        .manage(app_state)
        .setup(|_app| {
            tauri::async_runtime::spawn(async move {
                http_server::start(db_for_http).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_latest_snapshots,
            commands::get_history,
            commands::get_analysis,
            commands::get_recommendation,
            commands::delete_snapshot,
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 启动失败");
}
