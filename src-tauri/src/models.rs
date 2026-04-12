use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageSnapshot {
    pub id: Option<i64>,
    pub account_alias: String,
    pub collected_at: String,
    pub session_pct: Option<f64>,
    pub session_reset_at: Option<String>,
    pub weekly_pct: Option<f64>,
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
    pub alias: String,
    pub session_pct: Option<f64>,
    pub session_remaining_hours: Option<f64>,
    pub weekly_pct: Option<f64>,
    pub weekly_remaining_hours: Option<f64>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Recommendation {
    pub recommended_alias: Option<String>,
    pub reason: String,
    pub estimated_remaining_hours: Option<f64>,
    pub warnings: Vec<String>,
    pub account_summaries: Vec<AccountSummary>,
}
