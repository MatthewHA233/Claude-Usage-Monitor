use crate::models::{AccountAnalysis, AccountColor, Recommendation, UsageSnapshot};
use crate::state::AppState;
use std::collections::HashMap;
use tauri::State;

#[tauri::command]
pub fn get_latest_snapshots(state: State<AppState>) -> Vec<UsageSnapshot> {
    state.db.latest_all().unwrap_or_default()
}

#[tauri::command]
pub fn get_history(alias: String, limit: i64, offset: i64, state: State<AppState>) -> Vec<UsageSnapshot> {
    state.db.history(&alias, limit, offset).unwrap_or_default()
}

#[tauri::command]
pub fn get_analysis(state: State<AppState>) -> Vec<AccountAnalysis> {
    let snapshots = state.db.latest_all().unwrap_or_default();
    let aliases: Vec<String> = snapshots.iter().map(|s| s.account_alias.clone()).collect();
    crate::analyzer::analyze_all(&state.db, &aliases)
}

#[tauri::command]
pub fn get_recommendation(state: State<AppState>) -> Recommendation {
    let snapshots = state.db.latest_all().unwrap_or_default();
    crate::recommender::recommend(&snapshots)
}

#[tauri::command]
pub fn delete_snapshot(id: i64, state: State<AppState>) -> Result<(), String> {
    state.db.delete_snapshot(id).map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_account_colors(state: State<AppState>) -> Vec<AccountColor> {
    let snapshots = state.db.latest_all().unwrap_or_default();
    let aliases: Vec<String> = snapshots.iter().map(|s| s.account_alias.clone()).collect();
    let _ = state.db.ensure_colors_for_aliases(&aliases);
    state.db.get_all_colors().unwrap_or_default()
}

#[tauri::command]
pub fn set_account_color(alias: String, color: String, state: State<AppState>) -> Result<(), String> {
    state.db.set_color(&alias, &color).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_all_histories(state: State<AppState>) -> HashMap<String, Vec<UsageSnapshot>> {
    state.db.all_histories_grouped(500).unwrap_or_default()
}
