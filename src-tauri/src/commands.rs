use crate::models::{AccountAnalysis, Recommendation, UsageSnapshot};
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub fn get_latest_snapshots(state: State<AppState>) -> Vec<UsageSnapshot> {
    state.db.latest_all().unwrap_or_default()
}

#[tauri::command]
pub fn get_history(alias: String, limit: i64, state: State<AppState>) -> Vec<UsageSnapshot> {
    state.db.history(&alias, limit).unwrap_or_default()
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
