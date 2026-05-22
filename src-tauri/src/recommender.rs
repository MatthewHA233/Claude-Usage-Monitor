/// 智能调度推荐引擎
use crate::models::{AccountSummary, Recommendation, UsageSnapshot};
use chrono::{DateTime, Utc};

/// 从最新快照计算推荐
pub fn recommend(snapshots: &[UsageSnapshot]) -> Recommendation {
    let summaries: Vec<AccountSummary> = snapshots.iter().map(build_summary).collect();

    if summaries.is_empty() {
        return Recommendation {
            recommended_key: None,
            recommended_alias: None,
            reason: "暂无账号数据，请确认扩展已上报".to_string(),
            estimated_remaining_hours: None,
            warnings: vec![],
            account_summaries: summaries,
        };
    }

    let mut warnings: Vec<String> = Vec::new();

    // 预警：本周剩余 >40% 但 <24h 后就重置（会浪费额度）
    for s in &summaries {
        if let (Some(weekly_pct), Some(weekly_hours)) = (s.weekly_pct, s.weekly_remaining_hours) {
            let weekly_total = s.weekly_total_pct.unwrap_or(100.0);
            let weekly_remaining = weekly_total - weekly_pct;
            if weekly_remaining > weekly_total * 0.4 && weekly_hours < 24.0 {
                warnings.push(format!(
                    "账号 {} 本周剩余 {:.0}% Weekly，但 {:.1}h 后重置，存在浪费风险",
                    s.alias, weekly_remaining, weekly_hours
                ));
            }
        }
    }

    // 筛选条件：Session 未耗尽 且 Weekly 未耗尽 且 无错误
    let available: Vec<&AccountSummary> = summaries
        .iter()
        .filter(|s| {
            let session_total = s.session_total_pct.unwrap_or(100.0);
            let weekly_total = s.weekly_total_pct.unwrap_or(100.0);
            s.status != "unknown"
                && s.session_pct.unwrap_or(session_total) < session_total - 1.0
                && s.weekly_pct.unwrap_or(weekly_total) < weekly_total - 1.0
        })
        .collect();

    if available.is_empty() {
        // 检查是否都耗尽了
        let all_exhausted = summaries.iter().all(|s| s.status == "exhausted");
        return Recommendation {
            recommended_key: None,
            recommended_alias: None,
            reason: if all_exhausted {
                "所有账号额度已耗尽，请等待重置".to_string()
            } else {
                "无可用账号（Session 或 Weekly 已满）".to_string()
            },
            estimated_remaining_hours: None,
            warnings,
            account_summaries: summaries,
        };
    }

    // 推荐逻辑：优先选"周限额距重置最近"的账号
    // 即把快到期的周额度用完，避免浪费；同时 session 还有余量
    let best = available.iter().min_by(|a, b| {
        let a_weekly_h = a.weekly_remaining_hours.unwrap_or(f64::MAX);
        let b_weekly_h = b.weekly_remaining_hours.unwrap_or(f64::MAX);
        a_weekly_h.partial_cmp(&b_weekly_h).unwrap()
    });

    let recommended = match best {
        Some(s) => s,
        None => {
            return Recommendation {
                recommended_key: None,
                recommended_alias: None,
                reason: "无法计算推荐".to_string(),
                estimated_remaining_hours: None,
                warnings,
                account_summaries: summaries,
            }
        }
    };

    let session_total = recommended.session_total_pct.unwrap_or(100.0);
    let weekly_total = recommended.weekly_total_pct.unwrap_or(100.0);
    let session_remaining = recommended
        .session_pct
        .map(|p| session_total - p)
        .unwrap_or(session_total);
    let weekly_remaining = recommended
        .weekly_pct
        .map(|p| weekly_total - p)
        .unwrap_or(weekly_total);

    let reason = build_reason(recommended, session_remaining, weekly_remaining);

    Recommendation {
        recommended_key: Some(recommended.key.clone()),
        recommended_alias: Some(recommended.alias.clone()),
        reason,
        estimated_remaining_hours: recommended.session_remaining_hours,
        warnings,
        account_summaries: summaries,
    }
}

fn build_summary(snap: &UsageSnapshot) -> AccountSummary {
    let session_remaining_hours = snap
        .session_reset_at
        .as_deref()
        .and_then(|s| s.parse::<DateTime<Utc>>().ok())
        .map(|t| {
            let diff = (t - Utc::now()).num_seconds();
            diff.max(0) as f64 / 3600.0
        });

    let weekly_remaining_hours = snap
        .weekly_reset_at
        .as_deref()
        .and_then(|s| s.parse::<DateTime<Utc>>().ok())
        .map(|t| {
            let diff = (t - Utc::now()).num_seconds();
            diff.max(0) as f64 / 3600.0
        });

    let status = if snap.error.is_some() {
        "unknown".to_string()
    } else if snap
        .session_pct
        .map(|p| p >= snap.session_total_pct.unwrap_or(100.0) - 1.0)
        .unwrap_or(false)
        || snap
            .weekly_pct
            .map(|p| p >= snap.weekly_total_pct.unwrap_or(100.0) - 1.0)
            .unwrap_or(false)
    {
        "exhausted".to_string()
    } else {
        "available".to_string()
    };

    AccountSummary {
        provider: snap.provider.clone(),
        key: format!("{}::{}", snap.provider, snap.account_alias),
        alias: snap.account_alias.clone(),
        session_pct: snap.session_pct,
        session_total_pct: snap.session_total_pct.or(Some(100.0)),
        session_remaining_hours,
        weekly_pct: snap.weekly_pct,
        weekly_total_pct: snap.weekly_total_pct.or(Some(100.0)),
        weekly_remaining_hours,
        status,
    }
}

fn build_reason(s: &AccountSummary, session_remaining: f64, weekly_remaining: f64) -> String {
    let fmt_hours = |h: f64| -> String {
        if h < 1.0 {
            format!("{:.0}min", h * 60.0)
        } else if h < 24.0 {
            format!("{:.1}h", h)
        } else {
            format!("{:.0}天{:.0}h", (h / 24.0).floor(), h % 24.0)
        }
    };

    let weekly_h = s
        .weekly_remaining_hours
        .map(|h| fmt_hours(h))
        .unwrap_or_else(|| "未知".to_string());
    let session_h = s
        .session_remaining_hours
        .map(|h| fmt_hours(h))
        .unwrap_or_else(|| "未知".to_string());

    format!(
        "{} 周额度{}后重置（剩余 {:.0}%），Session 剩余 {:.0}%（{}后重置）",
        s.alias, weekly_h, weekly_remaining, session_remaining, session_h
    )
}
