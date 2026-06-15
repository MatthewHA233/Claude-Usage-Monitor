use crate::models::{
    AccountAnalysis, AccountColor, AccountPauseState, InboxItem, LocalUsageStatus,
    PluginUsageStatus, ProxySettings, Recommendation, TokenUsageReport, UsageSnapshot,
};
use crate::state::AppState;
use std::collections::HashMap;
use tauri::State;

#[tauri::command]
pub fn get_latest_snapshots(state: State<AppState>) -> Vec<UsageSnapshot> {
    state.db.latest_all().unwrap_or_default()
}

/// 账号「当前档位」手动覆盖：读全部（account_key → 倍率）
#[tauri::command]
pub fn get_plan_overrides(state: State<AppState>) -> HashMap<String, f64> {
    state.db.get_plan_overrides()
}

/// 设/清账号当前档位倍率（mult<=0 清除）。仅影响今后采集，不重写历史。
#[tauri::command]
pub fn set_plan_override(
    provider: String,
    alias: String,
    mult: f64,
    state: State<AppState>,
) -> Result<(), String> {
    state
        .db
        .set_plan_override(&provider, &alias, mult)
        .map_err(|e| e.to_string())
}

/// 一次性纠错：把选中的历史记录（snapshot id）按所选倍率重写；返回改写行数
#[tauri::command]
pub fn correct_history_snapshots(
    ids: Vec<i64>,
    mult: f64,
    state: State<AppState>,
) -> Result<usize, String> {
    state
        .db
        .correct_history_snapshots(&ids, mult)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_history(
    provider: Option<String>,
    alias: String,
    limit: i64,
    offset: i64,
    state: State<AppState>,
) -> Vec<UsageSnapshot> {
    let provider = provider.unwrap_or_else(|| "claude_code".to_string());
    state
        .db
        .history(&provider, &alias, limit, offset)
        .unwrap_or_default()
}

#[tauri::command]
pub fn get_history_since(
    provider: Option<String>,
    alias: String,
    since: String,
    state: State<AppState>,
) -> Vec<UsageSnapshot> {
    let provider = provider.unwrap_or_else(|| "claude_code".to_string());
    state
        .db
        .history_since(&provider, &alias, &since)
        .unwrap_or_default()
}

#[tauri::command]
pub fn get_analysis(state: State<AppState>) -> Vec<AccountAnalysis> {
    let snapshots = state.db.latest_all().unwrap_or_default();
    let aliases: Vec<String> = snapshots
        .iter()
        .map(|s| format!("{}::{}", s.provider, s.account_alias))
        .collect();
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
    state
        .db
        .delete_snapshot(id)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_account_colors(state: State<AppState>) -> Vec<AccountColor> {
    let snapshots = state.db.latest_all().unwrap_or_default();
    let aliases: Vec<String> = snapshots
        .iter()
        .map(|s| format!("{}::{}", s.provider, s.account_alias))
        .collect();
    let _ = state.db.ensure_colors_for_aliases(&aliases);
    state.db.get_all_colors().unwrap_or_default()
}

#[tauri::command]
pub fn set_account_color(
    alias: String,
    color: String,
    state: State<AppState>,
) -> Result<(), String> {
    state
        .db
        .set_color(&alias, &color)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_account_pause_states(state: State<AppState>) -> Vec<AccountPauseState> {
    state.db.get_pause_states().unwrap_or_default()
}

#[tauri::command]
pub fn get_local_usage_statuses(state: State<AppState>) -> Vec<LocalUsageStatus> {
    state.db.local_usage_statuses().unwrap_or_default()
}

#[tauri::command]
pub fn get_plugin_usage_statuses(state: State<AppState>) -> Vec<PluginUsageStatus> {
    state.runtime.plugin_usage_statuses()
}

#[tauri::command]
pub fn set_account_paused(
    provider: String,
    alias: String,
    paused: bool,
    state: State<AppState>,
) -> Result<(), String> {
    state
        .db
        .set_account_paused(&provider, &alias, paused)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_all_histories(state: State<AppState>) -> HashMap<String, Vec<UsageSnapshot>> {
    let since = (chrono::Utc::now() - chrono::Duration::days(31)).to_rfc3339();
    state
        .db
        .all_histories_grouped_since(&since)
        .unwrap_or_default()
}

#[tauri::command]
pub fn get_quota_races(state: State<AppState>) -> Option<String> {
    state.db.get_quota_races_json().unwrap_or_default()
}

#[tauri::command]
pub fn save_quota_races(races_json: String, state: State<AppState>) -> Result<(), String> {
    let parsed: serde_json::Value =
        serde_json::from_str(&races_json).map_err(|e| format!("竞赛记录 JSON 无效: {e}"))?;
    if !parsed.is_array() {
        return Err("竞赛记录必须是数组".to_string());
    }
    state
        .db
        .set_quota_races_json(&races_json)
        .map_err(|e| e.to_string())
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
    state
        .db
        .inbox_delete(id)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_token_usage_report(
    since_days: Option<i64>,
    state: State<'_, AppState>,
) -> Result<TokenUsageReport, String> {
    let days = since_days.unwrap_or(14);
    let db = std::sync::Arc::clone(&state.db);
    tauri::async_runtime::spawn_blocking(move || crate::token_usage::load_report(&db, days))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_cached_token_usage_report(
    since_days: Option<i64>,
    state: State<'_, AppState>,
) -> Result<TokenUsageReport, String> {
    let days = since_days.unwrap_or(14);
    let db = std::sync::Arc::clone(&state.db);
    tauri::async_runtime::spawn_blocking(move || crate::token_usage::load_cached_report(&db, days))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn refresh_local_usage(state: State<'_, AppState>) -> Result<(), String> {
    let db = std::sync::Arc::clone(&state.db);
    crate::local_usage::collect_once(db).await;
    Ok(())
}

const SETTING_PROXY_ENABLED: &str = "proxy_enabled";
const SETTING_PROXY_URL: &str = "proxy_url";

#[tauri::command]
pub fn get_proxy_settings(state: State<AppState>) -> ProxySettings {
    let cfg = crate::local_usage::current_proxy_config();
    // 以运行时配置为准（启动时已从 DB 载入），避免读到落后的库值
    let _ = state;
    ProxySettings {
        enabled: cfg.enabled,
        url: cfg.url,
    }
}

#[tauri::command]
pub fn set_proxy_settings(
    enabled: bool,
    url: String,
    state: State<AppState>,
) -> Result<ProxySettings, String> {
    let trimmed = url.trim();
    let stored_url = if trimmed.is_empty() {
        crate::local_usage::DEFAULT_PROXY_URL.to_string()
    } else {
        trimmed.to_string()
    };
    // 先写库（持久化），再更新运行时
    state
        .db
        .set_setting(SETTING_PROXY_ENABLED, if enabled { "true" } else { "false" })
        .map_err(|e| e.to_string())?;
    state
        .db
        .set_setting(SETTING_PROXY_URL, &stored_url)
        .map_err(|e| e.to_string())?;
    crate::local_usage::set_proxy_config(enabled, stored_url);
    Ok(get_proxy_settings(state))
}
