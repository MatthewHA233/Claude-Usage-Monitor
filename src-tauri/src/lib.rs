mod analyzer;
mod commands;
mod db;
mod http_server;
mod local_usage;
mod models;
mod recommender;
mod state;
mod token_usage;

#[cfg(test)]
mod recommender_tests;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = AppState::new().expect("初始化 AppState 失败");
    let db_for_http = std::sync::Arc::clone(&app_state.db);
    let runtime_for_http = std::sync::Arc::clone(&app_state.runtime);
    let db_for_local_usage = std::sync::Arc::clone(&app_state.db);

    tauri::Builder::default()
        .manage(app_state)
        .setup(|_app| {
            tauri::async_runtime::spawn(async move {
                http_server::start(db_for_http, runtime_for_http).await;
            });
            tauri::async_runtime::spawn(async move {
                local_usage::run_background_collector(db_for_local_usage).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_latest_snapshots,
            commands::get_history,
            commands::get_analysis,
            commands::get_recommendation,
            commands::delete_snapshot,
            commands::get_account_colors,
            commands::set_account_color,
            commands::get_account_pause_states,
            commands::get_local_usage_statuses,
            commands::get_plugin_usage_statuses,
            commands::set_account_paused,
            commands::get_all_histories,
            commands::get_quota_races,
            commands::save_quota_races,
            commands::inbox_list,
            commands::inbox_accept,
            commands::inbox_delete,
            commands::get_token_usage_report,
            commands::get_cached_token_usage_report,
            commands::refresh_local_usage,
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 启动失败");
}
