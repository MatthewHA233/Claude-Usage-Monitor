use crate::models::{AccountAnalysis, AccountColor, AccountPauseState, InboxItem, Recommendation, UsageSnapshot};
use crate::state::AppState;
use std::collections::HashMap;
use tauri::State;

#[tauri::command]
pub fn get_latest_snapshots(state: State<AppState>) -> Vec<UsageSnapshot> {
    state.db.latest_all().unwrap_or_default()
}

#[tauri::command]
pub fn get_history(provider: Option<String>, alias: String, limit: i64, offset: i64, state: State<AppState>) -> Vec<UsageSnapshot> {
    let provider = provider.unwrap_or_else(|| "claude_code".to_string());
    state.db.history(&provider, &alias, limit, offset).unwrap_or_default()
}

#[tauri::command]
pub fn get_analysis(state: State<AppState>) -> Vec<AccountAnalysis> {
    let snapshots = state.db.latest_all().unwrap_or_default();
    let aliases: Vec<String> = snapshots.iter().map(|s| format!("{}::{}", s.provider, s.account_alias)).collect();
    crate::analyzer::analyze_all(&state.db, &aliases)
}

#[tauri::command]
pub fn get_recommendation(state: State<AppState>) -> Recommendation {
    let snapshots = state.db.latest_all().unwrap_or_default();
    let paused = state.db.paused_account_keys().unwrap_or_default();
    let active: Vec<UsageSnapshot> = snapshots
        .into_iter()
        .filter(|s| !paused.contains(&format!("{}::{}", s.provider, s.account_alias)))
        .collect();
    crate::recommender::recommend(&active)
}

#[tauri::command]
pub fn delete_snapshot(id: i64, state: State<AppState>) -> Result<(), String> {
    state.db.delete_snapshot(id).map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_account_colors(state: State<AppState>) -> Vec<AccountColor> {
    let snapshots = state.db.latest_all().unwrap_or_default();
    let aliases: Vec<String> = snapshots.iter().map(|s| format!("{}::{}", s.provider, s.account_alias)).collect();
    let _ = state.db.ensure_colors_for_aliases(&aliases);
    state.db.get_all_colors().unwrap_or_default()
}

#[tauri::command]
pub fn set_account_color(alias: String, color: String, state: State<AppState>) -> Result<(), String> {
    state.db.set_color(&alias, &color).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_account_pause_states(state: State<AppState>) -> Vec<AccountPauseState> {
    state.db.get_pause_states().unwrap_or_default()
}

#[tauri::command]
pub fn set_account_paused(provider: String, alias: String, paused: bool, state: State<AppState>) -> Result<(), String> {
    state.db.set_account_paused(&provider, &alias, paused).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_all_histories(state: State<AppState>) -> HashMap<String, Vec<UsageSnapshot>> {
    state.db.all_histories_grouped(500).unwrap_or_default()
}

#[tauri::command]
pub fn inbox_list(state: State<AppState>) -> Vec<InboxItem> {
    state.db.inbox_list().unwrap_or_default()
}

#[tauri::command]
pub fn inbox_accept(id: i64, state: State<AppState>) -> Result<(), String> {
    let item = state
        .db
        .inbox_get(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "收件箱条目不存在".to_string())?;
    let snap = UsageSnapshot {
        id: None,
        provider: item.provider,
        account_alias: item.account_alias,
        collected_at: item.collected_at,
        session_pct: item.session_pct,
        session_total_pct: item.session_total_pct,
        session_reset_at: item.session_reset_at,
        weekly_pct: item.weekly_pct,
        weekly_total_pct: item.weekly_total_pct,
        weekly_reset_at: item.weekly_reset_at,
        error: None,
    };
    state.db.insert_snapshot(&snap).map_err(|e| e.to_string())?;
    state.db.inbox_delete(id).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn inbox_delete(id: i64, state: State<AppState>) -> Result<(), String> {
    state.db.inbox_delete(id).map(|_| ()).map_err(|e| e.to_string())
}
