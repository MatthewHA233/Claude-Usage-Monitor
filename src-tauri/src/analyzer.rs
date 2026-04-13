/// 历史数据分析模块
use crate::db::Database;
use crate::models::{AccountAnalysis, UsageSnapshot};
use chrono::{DateTime, Utc};
use std::collections::HashMap;

pub fn analyze_all(db: &Database, aliases: &[String]) -> Vec<AccountAnalysis> {
    aliases.iter().map(|alias| analyze_account(db, alias)).collect()
}

fn analyze_account(db: &Database, alias: &str) -> AccountAnalysis {
    let records = match db.history(alias, 500, 0) {
        Ok(r) => r,
        Err(_) => return empty_analysis(alias),
    };

    // 只保留无错误的记录（owned Vec 避免多重引用）
    let valid: Vec<UsageSnapshot> = records.into_iter().filter(|r| r.error.is_none()).collect();
    let data_points = valid.len() as i64;

    if data_points == 0 {
        return empty_analysis(alias);
    }

    // --- 加权平均（最近10条，越新权重越高）---
    let recent = &valid[..valid.len().min(10)];
    let weighted_session_pct = weighted_avg(recent.iter().map(|r| r.session_pct));
    let weighted_weekly_pct = weighted_avg(recent.iter().map(|r| r.weekly_pct));

    // --- Session 消耗速率（%/小时）---
    let avg_session_rate = calc_session_rate(&valid);

    // --- Session 耗尽率 ---
    let exhaustion_rate = calc_exhaustion_rate(&valid);

    // --- Weekly 周期末平均消耗% ---
    let avg_weekly_final_pct = calc_avg_weekly_final(&valid);

    let (weekly_cost_per_session_24h, exhaustion_count_24h) = calc_weekly_cost_per_session_24h(&valid);

    AccountAnalysis {
        alias: alias.to_string(),
        avg_session_rate,
        exhaustion_rate,
        avg_weekly_final_pct,
        weighted_session_pct,
        weighted_weekly_pct,
        data_points,
        weekly_cost_per_session_24h,
        exhaustion_count_24h,
    }
}

fn empty_analysis(alias: &str) -> AccountAnalysis {
    AccountAnalysis {
        alias: alias.to_string(),
        avg_session_rate: None,
        exhaustion_rate: None,
        avg_weekly_final_pct: None,
        weighted_session_pct: None,
        weighted_weekly_pct: None,
        data_points: 0,
        weekly_cost_per_session_24h: None,
        exhaustion_count_24h: 0,
    }
}

/// 加权平均，索引 0 权重最高（最新），权重线性递减
fn weighted_avg(values: impl Iterator<Item = Option<f64>>) -> Option<f64> {
    let vals: Vec<f64> = values.flatten().collect();
    if vals.is_empty() {
        return None;
    }
    let n = vals.len() as f64;
    let total_weight: f64 = (1..=vals.len()).map(|i| n - i as f64 + 1.0).sum();
    let weighted_sum: f64 = vals.iter().enumerate().map(|(i, v)| v * (n - i as f64)).sum();
    Some(weighted_sum / total_weight)
}

/// 计算平均 Session 消耗速率（%/小时）
fn calc_session_rate(records: &[UsageSnapshot]) -> Option<f64> {
    let mut groups: HashMap<String, Vec<(DateTime<Utc>, f64)>> = HashMap::new();

    for r in records {
        if let (Some(reset), Some(pct)) = (&r.session_reset_at, r.session_pct) {
            if let Ok(ts) = r.collected_at.parse::<DateTime<Utc>>() {
                groups.entry(reset.clone()).or_default().push((ts, pct));
            }
        }
    }

    let rates: Vec<f64> = groups
        .values()
        .filter_map(|pts| {
            if pts.len() < 2 {
                return None;
            }
            let max_pct = pts.iter().map(|(_, p)| *p).fold(f64::NEG_INFINITY, f64::max);
            let min_ts = pts.iter().map(|(t, _)| *t).min()?;
            let max_ts = pts.iter().map(|(t, _)| *t).max()?;
            let hours = (max_ts - min_ts).num_seconds() as f64 / 3600.0;
            if hours < 0.1 {
                return None;
            }
            Some(max_pct / hours)
        })
        .collect();

    if rates.is_empty() {
        None
    } else {
        Some(rates.iter().sum::<f64>() / rates.len() as f64)
    }
}

/// Session 耗尽率：统计 >= 98% 的窗口占总窗口数的比例
fn calc_exhaustion_rate(records: &[UsageSnapshot]) -> Option<f64> {
    let mut groups: HashMap<String, f64> = HashMap::new();

    for r in records {
        if let (Some(reset), Some(pct)) = (&r.session_reset_at, r.session_pct) {
            let entry = groups.entry(reset.clone()).or_insert(0.0);
            if pct > *entry {
                *entry = pct;
            }
        }
    }

    if groups.is_empty() {
        return None;
    }

    let exhausted = groups.values().filter(|&&p| p >= 98.0).count();
    Some(exhausted as f64 / groups.len() as f64)
}

/// Weekly 周期末平均消耗%
fn calc_avg_weekly_final(records: &[UsageSnapshot]) -> Option<f64> {
    let mut groups: HashMap<String, (String, f64)> = HashMap::new();

    for r in records {
        if let (Some(reset), Some(pct)) = (&r.weekly_reset_at, r.weekly_pct) {
            let entry = groups.entry(reset.clone()).or_insert((String::new(), 0.0));
            if r.collected_at > entry.0 {
                *entry = (r.collected_at.clone(), pct);
            }
        }
    }

    if groups.is_empty() {
        return None;
    }

    let sum: f64 = groups.values().map(|(_, p)| *p).sum();
    Some(sum / groups.len() as f64)
}

/// 每烧完 100% Session，平均消耗多少 weekly_pct
///
/// 算法（累积 session 消耗法）：
/// 1. 按 weekly 大幅下降（>10%）将数据切分为多个"周"片段
/// 2. 在每个片段内，追踪累积 session 消耗：
///    - session_pct 上升 → 累加上升量
///    - session_pct 下降 ≥ 2%（归零重置） → 累加新值（session 从 0 涨到了当前值）
///    - 1% 以内的抖动忽略（API 精度噪声）
/// 3. cost = 该周期 weekly 增量 / 累积 session 消耗 × 100
/// 4. 按各周期累积 session 量加权平均
fn calc_weekly_cost_per_session_24h(records: &[UsageSnapshot]) -> (Option<f64>, i64) {
    // 按时间升序，过滤掉错误记录和缺失字段的记录
    let mut sorted: Vec<&UsageSnapshot> = records
        .iter()
        .filter(|r| r.error.is_none() && r.weekly_pct.is_some() && r.session_pct.is_some())
        .collect();
    sorted.sort_by(|a, b| a.collected_at.cmp(&b.collected_at));

    if sorted.len() < 2 {
        return (None, 0);
    }

    // 按周期切片（weekly 下降 > 10% 说明进入新周）
    let mut week_segs: Vec<&[&UsageSnapshot]> = Vec::new();
    let mut seg_start = 0usize;
    for i in 1..sorted.len() {
        let prev_w = sorted[i - 1].weekly_pct.unwrap();
        let curr_w = sorted[i].weekly_pct.unwrap();
        if prev_w - curr_w > 10.0 {
            week_segs.push(&sorted[seg_start..i]);
            seg_start = i;
        }
    }
    week_segs.push(&sorted[seg_start..]);

    let mut weighted_sum = 0.0f64;
    let mut total_weight = 0.0f64;
    let mut count = 0i64;

    for seg in &week_segs {
        if seg.len() < 3 {
            continue;
        }

        let w_start = seg[0].weekly_pct.unwrap();
        let w_end = seg.last().unwrap().weekly_pct.unwrap();
        let total_weekly = w_end - w_start;

        if total_weekly <= 0.0 {
            continue;
        }

        // 累积 session 消耗
        let mut cumulative = 0.0f64;
        let mut prev_s = seg[0].session_pct.unwrap();

        for r in seg[1..].iter() {
            let curr_s = r.session_pct.unwrap();
            if curr_s >= prev_s {
                cumulative += curr_s - prev_s;
            } else if prev_s - curr_s >= 2.0 {
                // 归零重置：session 从 0 涨回到了 curr_s
                cumulative += curr_s;
            }
            // 1% 以内的抖动忽略
            prev_s = curr_s;
        }

        if cumulative < 10.0 {
            continue; // 数据太少，跳过
        }

        let cost = total_weekly / cumulative * 100.0;
        weighted_sum += cost * cumulative;
        total_weight += cumulative;
        count += 1;
    }

    if count == 0 || total_weight == 0.0 {
        return (None, 0);
    }

    (Some(weighted_sum / total_weight), count)
}
