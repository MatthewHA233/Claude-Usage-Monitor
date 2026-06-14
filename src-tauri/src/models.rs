use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageSnapshot {
    pub id: Option<i64>,
    pub provider: String,
    pub account_alias: String,
    pub collected_at: String,
    pub session_pct: Option<f64>,
    pub session_total_pct: Option<f64>,
    pub session_reset_at: Option<String>,
    pub weekly_pct: Option<f64>,
    pub weekly_total_pct: Option<f64>,
    pub weekly_reset_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountAnalysis {
    pub alias: String,
    pub avg_session_rate: Option<f64>,
    pub exhaustion_rate: Option<f64>,
    pub avg_weekly_final_pct: Option<f64>,
    pub weighted_session_pct: Option<f64>,
    pub weighted_weekly_pct: Option<f64>,
    pub data_points: i64,
    /// 最近 24h 内，每次 Session 耗尽时消耗的 weekly_pct 增量均值
    /// 算法：检测 session_reset_at 切换边界，取前后 weekly_pct 差值
    pub weekly_cost_per_session_24h: Option<f64>,
    /// 最近 24h 内可计算的 Session 耗尽次数
    pub exhaustion_count_24h: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountSummary {
    pub provider: String,
    pub key: String,
    pub alias: String,
    pub session_pct: Option<f64>,
    pub session_total_pct: Option<f64>,
    pub session_remaining_hours: Option<f64>,
    pub weekly_pct: Option<f64>,
    pub weekly_total_pct: Option<f64>,
    pub weekly_remaining_hours: Option<f64>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountColor {
    pub alias: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountPauseState {
    pub provider: String,
    pub account_alias: String,
    pub account_key: String,
    pub paused: bool,
    pub paused_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalUsageStatus {
    pub provider: String,
    pub account_alias: Option<String>,
    pub ok: bool,
    pub message: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxySettings {
    pub enabled: bool,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginUsageStatus {
    pub provider: String,
    pub account_alias: String,
    pub account_key: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InboxItem {
    pub id: Option<i64>,
    pub provider: String,
    pub account_alias: String,
    pub collected_at: String,
    pub session_pct: Option<f64>,
    pub session_total_pct: Option<f64>,
    pub session_reset_at: Option<String>,
    pub weekly_pct: Option<f64>,
    pub weekly_total_pct: Option<f64>,
    pub weekly_reset_at: Option<String>,
    pub filter_reason: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Recommendation {
    pub recommended_key: Option<String>,
    pub recommended_alias: Option<String>,
    pub reason: String,
    pub estimated_remaining_hours: Option<f64>,
    pub warnings: Vec<String>,
    pub account_summaries: Vec<AccountSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsageModelBreakdown {
    pub model: String,
    pub input_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsageDay {
    pub date: String,
    pub provider: String,
    pub input_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
    pub cost_usd: Option<f64>,
    pub models: Vec<TokenUsageModelBreakdown>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsageSummary {
    pub input_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsageReport {
    pub since: String,
    pub until: String,
    pub days: Vec<TokenUsageDay>,
    pub summary: TokenUsageSummary,
    pub scanned_files: usize,
    pub parsed_files: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct TokenUsageFileCache {
    pub path: String,
    pub provider: String,
    pub modified_unix: i64,
    pub size: i64,
    pub days_json: String,
}
