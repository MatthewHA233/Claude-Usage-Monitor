use crate::db::Database;
use crate::models::{
    TokenUsageDay, TokenUsageFileCache, TokenUsageModelBreakdown, TokenUsageReport,
    TokenUsageSummary,
};
use chrono::{DateTime, Duration, Local, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

const MAX_FILES_PER_PROVIDER: usize = 2_000;
/// 远程 token 同步窗口：覆盖「所有月份」的历史，初始化即全量缓存到本地，
/// 之后每次刷新都对该来源做窗口内全量覆盖（中继离线则保留上次落库的旧缓存）。
const REMOTE_SYNC_DAYS: i64 = 3650;

#[derive(Default, Clone, Serialize, Deserialize)]
struct TokenTotals {
    input: i64,
    cache_read: i64,
    cache_create: i64,
    output: i64,
}

impl TokenTotals {
    fn total(&self) -> i64 {
        self.input + self.cache_read + self.cache_create + self.output
    }

    fn add(&mut self, other: &TokenTotals) {
        self.input += other.input;
        self.cache_read += other.cache_read;
        self.cache_create += other.cache_create;
        self.output += other.output;
    }
}

type FileDays = HashMap<String, HashMap<String, TokenTotals>>;

#[derive(Default)]
struct ScanStats {
    scanned_files: usize,
    parsed_files: usize,
    errors: Vec<String>,
    seen_claude_message_keys: HashSet<String>,
}

#[derive(Default)]
struct Aggregator {
    days: HashMap<String, HashMap<String, HashMap<String, TokenTotals>>>,
}

impl Aggregator {
    fn add(&mut self, provider: &str, day: &str, model: &str, totals: TokenTotals) {
        if totals.total() == 0 {
            return;
        }
        self.days
            .entry(provider.to_string())
            .or_default()
            .entry(day.to_string())
            .or_default()
            .entry(model.to_string())
            .or_default()
            .add(&totals);
    }
}

pub fn load_report(db: &Database, since_days: i64) -> TokenUsageReport {
    let days = since_days.clamp(1, 3650);
    let today = Local::now().date_naive();
    let since = today - Duration::days(days - 1);
    let until = today;
    let mut stats = ScanStats::default();

    scan_codex(db, &mut stats, since, until);
    scan_claude(db, &mut stats, since, until);

    // 本机：从文件缓存重算近 N 天并落库（source='本机'）。返回值不用，统一在末尾从 db 读。
    rebuild_daily_cache(db, since, until, &mut stats);

    // 跨机器：拉各远程中继 token 摘要，全量同步「所有月份」到本地缓存（按 source 落库，不与本机累加）。
    // 中继离线/失败 → 只记错误、保留上次落库的旧缓存，使离线时仍能展示该机器历史。
    let mut remote_errors: Vec<String> = Vec::new();
    let remote_since = today - Duration::days(REMOTE_SYNC_DAYS - 1);
    let remotes = token_remotes(db);
    for remote in &remotes {
        match fetch_remote_token_summary(&remote.base_url, REMOTE_SYNC_DAYS) {
            Ok(remote_days) => {
                // 持久化 key 用稳定的 source id（与会话数据对齐），不用可改名/可重名的 label
                let token_days = aggregate_remote_days(&remote.id, remote_days, remote_since, until);
                // 窗口内全量覆盖该来源：先删后写
                if let Err(e) = db.delete_token_usage_days_for_source(
                    &remote.id,
                    &remote_since.to_string(),
                    &until.to_string(),
                ) {
                    remote_errors.push(e.to_string());
                }
                for day in &token_days {
                    if let Err(e) = db.upsert_token_usage_day(day) {
                        remote_errors.push(e.to_string());
                    }
                }
            }
            Err(e) => remote_errors.push(format!("远程「{}」token 拉取失败: {}", remote.label, e)),
        }
    }

    // 清理孤儿：旧版用 label 当 key 的残留行、已删除来源的遗留行（保留本机 + 现存源 id）
    let valid_ids: Vec<String> = remotes.iter().map(|s| s.id.clone()).collect();
    let _ = db.retain_token_sources(&valid_ids);

    // 统一从 db 读当前窗口（含本机 + 各远程缓存；远程离线时读到的是上次成功落库的旧缓存）
    let mut report = load_cached_report(db, since_days);
    report.scanned_files = stats.scanned_files;
    report.parsed_files = stats.parsed_files;
    report.errors.extend(stats.errors.into_iter().take(20));
    report.errors.extend(remote_errors);
    report
}

pub fn load_cached_report(db: &Database, since_days: i64) -> TokenUsageReport {
    let days = since_days.clamp(1, 3650);
    let today = Local::now().date_naive();
    let since = today - Duration::days(days - 1);
    let until = today;
    match db.token_usage_days(&since.to_string(), &until.to_string()) {
        Ok(days) => {
            // 远程 source 存的是 id，显示前映射回 label 并丢弃孤儿行
            let days = relabel_sources(db, days);
            TokenUsageReport {
                since: since.to_string(),
                until: until.to_string(),
                summary: summary_from_days(&days),
                days,
                scanned_files: 0,
                parsed_files: 0,
                errors: Vec::new(),
            }
        }
        Err(error) => TokenUsageReport {
            since: since.to_string(),
            until: until.to_string(),
            summary: TokenUsageSummary {
                input_tokens: 0,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
                output_tokens: 0,
                total_tokens: 0,
                cost_usd: None,
            },
            days: Vec::new(),
            scanned_files: 0,
            parsed_files: 0,
            errors: vec![error.to_string()],
        },
    }
}

// ── 跨机器：从远程 claude启动器中继拉 token 摘要并合并进报告 ──

#[derive(Deserialize)]
struct RemoteTokenSummary {
    #[serde(default)]
    days: Vec<RemoteTokenDay>,
}

#[derive(Deserialize)]
struct RemoteTokenDay {
    date: String,
    provider: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    input_tokens: i64,
    #[serde(default)]
    cache_read_tokens: i64,
    #[serde(default)]
    cache_creation_tokens: i64,
    #[serde(default)]
    output_tokens: i64,
}

/// 已注册的远程会话源（中继地址）；跳过隐式本机源
fn token_remotes(db: &Database) -> Vec<crate::session_store::SessionSource> {
    db.get_setting("session_sources")
        .ok()
        .flatten()
        .and_then(|j| serde_json::from_str::<Vec<crate::session_store::SessionSource>>(&j).ok())
        .map(|v| v.into_iter().filter(|s| s.id != "local").collect())
        .unwrap_or_default()
}

/// 把 token 行里远程 source（库内存的是稳定的 SessionSource.id）映射回用户可读的 label。
/// 本机固定为「本机」；id 不在 session_sources（源已删 / 旧 label 残留）的孤儿行直接丢弃不显示。
fn relabel_sources(db: &Database, days: Vec<TokenUsageDay>) -> Vec<TokenUsageDay> {
    let map: HashMap<String, String> =
        token_remotes(db).into_iter().map(|s| (s.id, s.label)).collect();
    days
        .into_iter()
        .filter_map(|mut day| {
            if day.source == "本机" {
                return Some(day);
            }
            map.get(&day.source).map(|label| {
                day.source = label.clone();
                day
            })
        })
        .collect()
}

/// 拉远程中继的 /api/token_summary（局域网，强制不走系统代理）
fn fetch_remote_token_summary(
    base_url: &str,
    since_days: i64,
) -> Result<Vec<RemoteTokenDay>, String> {
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let base = base_url.trim_end_matches('/');
    let url = format!("{base}/api/token_summary?since_days={since_days}");
    let resp = client.get(&url).send().map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let parsed: RemoteTokenSummary = resp.json().map_err(|e| e.to_string())?;
    Ok(parsed.days)
}

/// 把某台远程机器的 token 行聚合成独立 TokenUsageDay(source=机器名)，返回供落库；
/// 不与本机或其它机器累加——同 provider+date 在该机器内部聚合 model 明细。
fn aggregate_remote_days(
    source: &str,
    remote: Vec<RemoteTokenDay>,
    since: NaiveDate,
    until: NaiveDate,
) -> Vec<TokenUsageDay> {
    use std::collections::HashMap;
    let mut acc: HashMap<(String, String), TokenUsageDay> = HashMap::new();
    for rd in remote {
        if !day_in_range(&rd.date, since, until) {
            continue;
        }
        let total =
            rd.input_tokens + rd.cache_read_tokens + rd.cache_creation_tokens + rd.output_tokens;
        if total <= 0 {
            continue;
        }
        let model = if rd.model.trim().is_empty() {
            "(unknown)".to_string()
        } else {
            rd.model.clone()
        };
        let entry = acc
            .entry((rd.provider.clone(), rd.date.clone()))
            .or_insert_with(|| TokenUsageDay {
                source: source.to_string(),
                date: rd.date.clone(),
                provider: rd.provider.clone(),
                input_tokens: 0,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
                output_tokens: 0,
                total_tokens: 0,
                cost_usd: None,
                models: Vec::new(),
            });
        entry.input_tokens += rd.input_tokens;
        entry.cache_read_tokens += rd.cache_read_tokens;
        entry.cache_creation_tokens += rd.cache_creation_tokens;
        entry.output_tokens += rd.output_tokens;
        entry.total_tokens += total;
        match entry.models.iter_mut().find(|m| m.model == model) {
            Some(m) => {
                m.input_tokens += rd.input_tokens;
                m.cache_read_tokens += rd.cache_read_tokens;
                m.cache_creation_tokens += rd.cache_creation_tokens;
                m.output_tokens += rd.output_tokens;
                m.total_tokens += total;
            }
            None => entry.models.push(TokenUsageModelBreakdown {
                model,
                input_tokens: rd.input_tokens,
                cache_read_tokens: rd.cache_read_tokens,
                cache_creation_tokens: rd.cache_creation_tokens,
                output_tokens: rd.output_tokens,
                total_tokens: total,
                cost_usd: None,
            }),
        }
    }
    let mut out: Vec<TokenUsageDay> = Vec::new();
    for (_key, mut day) in acc {
        day.models
            .sort_by(|a, b| b.total_tokens.cmp(&a.total_tokens).then(a.model.cmp(&b.model)));
        out.push(day);
    }
    out
}

fn scan_codex(db: &Database, stats: &mut ScanStats, since: NaiveDate, until: NaiveDate) {
    let mut seen_file_names = HashSet::new();
    for root in codex_session_roots() {
        for path in recent_jsonl_files(&root, since) {
            if let Some(file_name) = path.file_name().and_then(|name| name.to_str()) {
                if !seen_file_names.insert(file_name.to_string()) {
                    continue;
                }
            }
            stats.scanned_files += 1;
            if let Err(error) = scan_file_incremental(db, "codex", &path, stats, since, until) {
                stats.errors.push(format!("{}: {}", path.display(), error));
            }
        }
    }
}

fn scan_claude(db: &Database, stats: &mut ScanStats, since: NaiveDate, until: NaiveDate) {
    for root in claude_project_roots() {
        for path in recent_jsonl_files(&root, since) {
            stats.scanned_files += 1;
            if let Err(error) = scan_file_incremental(db, "claude_code", &path, stats, since, until)
            {
                stats.errors.push(format!("{}: {}", path.display(), error));
            }
        }
    }
}

fn scan_file_incremental(
    db: &Database,
    provider: &str,
    path: &Path,
    stats: &mut ScanStats,
    since: NaiveDate,
    until: NaiveDate,
) -> Result<(), String> {
    let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let modified_unix = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    let size = metadata.len() as i64;
    let path_text = path.to_string_lossy().to_string();

    if let Ok(Some(cache)) = db.token_file_cache(&path_text) {
        if cache.modified_unix == modified_unix && cache.size == size {
            return Ok(());
        }
    }

    let days = match provider {
        "codex" => scan_codex_file(path, since, until)?,
        "claude_code" => scan_claude_file(path, stats, since, until)?,
        _ => FileDays::new(),
    };
    let days_json = serde_json::to_string(&days).map_err(|e| e.to_string())?;
    db.upsert_token_file_cache(&TokenUsageFileCache {
        path: path_text,
        provider: provider.to_string(),
        modified_unix,
        size,
        days_json,
    })
    .map_err(|e| e.to_string())?;
    stats.parsed_files += 1;
    Ok(())
}

fn scan_codex_file(path: &Path, since: NaiveDate, until: NaiveDate) -> Result<FileDays, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);
    let mut current_model: Option<String> = None;
    let mut days = FileDays::new();

    for line in reader.lines() {
        let line = line.map_err(|e| e.to_string())?;
        if !line.contains("\"token_count\"") && !line.contains("\"turn_context\"") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };

        match value.get("type").and_then(Value::as_str) {
            Some("turn_context") => {
                current_model = value
                    .pointer("/payload/model")
                    .or_else(|| value.pointer("/payload/info/model"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or(current_model);
            }
            Some("event_msg") => {
                let Some(payload) = value.get("payload") else {
                    continue;
                };
                if payload.get("type").and_then(Value::as_str) != Some("token_count") {
                    continue;
                }
                let Some(day) = day_from_value(&value) else {
                    continue;
                };
                if day < since || day > until {
                    continue;
                }
                let info = payload.get("info").unwrap_or(&Value::Null);
                let Some(last) = info.get("last_token_usage") else {
                    continue;
                };
                let model = info
                    .get("model")
                    .or_else(|| info.get("model_name"))
                    .or_else(|| payload.get("model"))
                    .or_else(|| value.get("model"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| current_model.clone())
                    .unwrap_or_else(|| "gpt-5".to_string());
                let mut totals = parse_codex_usage(last);
                totals.cache_read = totals.cache_read.min(totals.input);
                add_to_file_days(
                    &mut days,
                    &day.to_string(),
                    &normalize_model(&model, "codex"),
                    totals,
                );
            }
            _ => {}
        }
    }

    Ok(days)
}

fn scan_claude_file(
    path: &Path,
    stats: &mut ScanStats,
    since: NaiveDate,
    until: NaiveDate,
) -> Result<FileDays, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);
    let mut days = FileDays::new();
    let mut unkeyed: Vec<(String, String, TokenTotals)> = Vec::new();

    for line in reader.lines() {
        let line = line.map_err(|e| e.to_string())?;
        if !line.contains("\"type\":\"assistant\"") || !line.contains("\"usage\"") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(day) = day_from_value(&value) else {
            continue;
        };
        if day < since || day > until {
            continue;
        }
        let Some(message) = value.get("message") else {
            continue;
        };
        let Some(model) = message.get("model").and_then(Value::as_str) else {
            continue;
        };
        let Some(usage) = message.get("usage") else {
            continue;
        };
        let totals = TokenTotals {
            input: int_field(usage, "input_tokens"),
            cache_read: int_field(usage, "cache_read_input_tokens"),
            cache_create: int_field(usage, "cache_creation_input_tokens"),
            output: int_field(usage, "output_tokens"),
        };
        if totals.total() == 0 {
            continue;
        }

        let day_key = day.to_string();
        let model = normalize_model(model, "claude_code");
        if let (Some(message_id), Some(request_id)) = (
            message.get("id").and_then(Value::as_str),
            value.get("requestId").and_then(Value::as_str),
        ) {
            let key = format!("{message_id}:{request_id}");
            if stats.seen_claude_message_keys.insert(key) {
                add_to_file_days(&mut days, &day_key, &model, totals);
            }
        } else {
            unkeyed.push((day_key, model, totals));
        }
    }

    for (day, model, totals) in unkeyed {
        add_to_file_days(&mut days, &day, &model, totals);
    }
    Ok(days)
}

fn add_to_file_days(days: &mut FileDays, day: &str, model: &str, totals: TokenTotals) {
    if totals.total() == 0 {
        return;
    }
    days.entry(day.to_string())
        .or_default()
        .entry(model.to_string())
        .or_default()
        .add(&totals);
}

fn rebuild_daily_cache(
    db: &Database,
    since: NaiveDate,
    until: NaiveDate,
    stats: &mut ScanStats,
) -> TokenUsageReport {
    let mut aggregate = Aggregator::default();
    match db.token_file_caches() {
        Ok(caches) => {
            for cache in caches {
                if !Path::new(&cache.path).exists() {
                    continue;
                }
                let Ok(days) = serde_json::from_str::<FileDays>(&cache.days_json) else {
                    continue;
                };
                for (day, models) in days {
                    if !day_in_range(&day, since, until) {
                        continue;
                    }
                    for (model, totals) in models {
                        aggregate.add(&cache.provider, &day, &model, totals);
                    }
                }
            }
        }
        Err(error) => stats.errors.push(error.to_string()),
    }

    let report = build_report(aggregate, since, until);
    if let Err(error) =
        db.delete_token_usage_days_for_source("本机", &since.to_string(), &until.to_string())
    {
        stats.errors.push(error.to_string());
        return report;
    }
    for day in &report.days {
        if let Err(error) = db.upsert_token_usage_day(day) {
            stats.errors.push(error.to_string());
        }
    }

    match db.token_usage_days(&since.to_string(), &until.to_string()) {
        Ok(days) => TokenUsageReport {
            since: since.to_string(),
            until: until.to_string(),
            summary: summary_from_days(&days),
            days,
            scanned_files: 0,
            parsed_files: 0,
            errors: Vec::new(),
        },
        Err(error) => {
            stats.errors.push(error.to_string());
            report
        }
    }
}

fn build_report(agg: Aggregator, since: NaiveDate, until: NaiveDate) -> TokenUsageReport {
    let mut days_out = Vec::new();
    let mut providers: Vec<_> = agg.days.keys().cloned().collect();
    providers.sort();

    for provider in providers {
        let Some(by_day) = agg.days.get(&provider) else {
            continue;
        };
        let mut day_keys: Vec<_> = by_day.keys().cloned().collect();
        day_keys.sort();
        for day in day_keys {
            let Some(models) = by_day.get(&day) else {
                continue;
            };
            let mut model_rows: Vec<_> = models
                .iter()
                .map(|(model, totals)| TokenUsageModelBreakdown {
                    model: model.clone(),
                    input_tokens: totals.input,
                    cache_read_tokens: totals.cache_read,
                    cache_creation_tokens: totals.cache_create,
                    output_tokens: totals.output,
                    total_tokens: totals.total(),
                    cost_usd: None,
                })
                .collect();
            model_rows.sort_by(|a, b| {
                b.total_tokens
                    .cmp(&a.total_tokens)
                    .then(a.model.cmp(&b.model))
            });

            let summary = totals_from_models(&model_rows);
            days_out.push(TokenUsageDay {
                source: "本机".to_string(),
                date: day,
                provider: provider.clone(),
                input_tokens: summary.input_tokens,
                cache_read_tokens: summary.cache_read_tokens,
                cache_creation_tokens: summary.cache_creation_tokens,
                output_tokens: summary.output_tokens,
                total_tokens: summary.total_tokens,
                cost_usd: None,
                models: model_rows,
            });
        }
    }
    days_out.sort_by(|a, b| b.date.cmp(&a.date).then(a.provider.cmp(&b.provider)));

    TokenUsageReport {
        since: since.to_string(),
        until: until.to_string(),
        summary: summary_from_days(&days_out),
        days: days_out,
        scanned_files: 0,
        parsed_files: 0,
        errors: Vec::new(),
    }
}

fn totals_from_models(models: &[TokenUsageModelBreakdown]) -> TokenUsageSummary {
    TokenUsageSummary {
        input_tokens: models.iter().map(|m| m.input_tokens).sum(),
        cache_read_tokens: models.iter().map(|m| m.cache_read_tokens).sum(),
        cache_creation_tokens: models.iter().map(|m| m.cache_creation_tokens).sum(),
        output_tokens: models.iter().map(|m| m.output_tokens).sum(),
        total_tokens: models.iter().map(|m| m.total_tokens).sum(),
        cost_usd: None,
    }
}

fn summary_from_days(days: &[TokenUsageDay]) -> TokenUsageSummary {
    TokenUsageSummary {
        input_tokens: days.iter().map(|d| d.input_tokens).sum(),
        cache_read_tokens: days.iter().map(|d| d.cache_read_tokens).sum(),
        cache_creation_tokens: days.iter().map(|d| d.cache_creation_tokens).sum(),
        output_tokens: days.iter().map(|d| d.output_tokens).sum(),
        total_tokens: days.iter().map(|d| d.total_tokens).sum(),
        cost_usd: None,
    }
}

fn codex_session_roots() -> Vec<PathBuf> {
    let base = std::env::var("CODEX_HOME")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")));
    let Some(base) = base else {
        return Vec::new();
    };
    vec![base.join("sessions"), base.join("archived_sessions")]
}

fn claude_project_roots() -> Vec<PathBuf> {
    if let Ok(raw) = std::env::var("CLAUDE_CONFIG_DIR") {
        let roots: Vec<PathBuf> = raw
            .split(',')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .map(|part| {
                let path = PathBuf::from(part);
                if path.file_name().and_then(|name| name.to_str()) == Some("projects") {
                    path
                } else {
                    path.join("projects")
                }
            })
            .collect();
        if !roots.is_empty() {
            return roots;
        }
    }

    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    vec![
        home.join(".config").join("claude").join("projects"),
        home.join(".claude").join("projects"),
    ]
}

fn recent_jsonl_files(root: &Path, since: NaiveDate) -> Vec<PathBuf> {
    let mut out = Vec::new();
    collect_jsonl_files(root, since, &mut out);
    out.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    out.into_iter()
        .take(MAX_FILES_PER_PROVIDER)
        .map(|(path, _)| path)
        .collect()
}

fn collect_jsonl_files(path: &Path, since: NaiveDate, out: &mut Vec<(PathBuf, i64)>) {
    let Ok(metadata) = std::fs::metadata(path) else {
        return;
    };
    if metadata.is_file() {
        if path.extension().and_then(|ext| ext.to_str()) == Some("jsonl") {
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs() as i64)
                .unwrap_or(0);
            if modified >= epoch_seconds_for_scan_floor(since) {
                out.push((path.to_path_buf(), modified));
            }
        }
        return;
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return;
    };
    for entry in entries.flatten() {
        collect_jsonl_files(&entry.path(), since, out);
    }
}

fn epoch_seconds_for_scan_floor(since: NaiveDate) -> i64 {
    let floor = since - Duration::days(1);
    floor
        .and_hms_opt(0, 0, 0)
        .map(|dt| dt.and_utc().timestamp())
        .unwrap_or(0)
}

fn parse_codex_usage(value: &Value) -> TokenTotals {
    TokenTotals {
        input: int_field(value, "input_tokens"),
        cache_read: int_field(value, "cached_input_tokens")
            .max(int_field(value, "cache_read_input_tokens")),
        cache_create: int_field(value, "cache_creation_input_tokens"),
        output: int_field(value, "output_tokens"),
    }
}

fn int_field(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(0).max(0)
}

fn day_from_value(value: &Value) -> Option<NaiveDate> {
    let ts = value.get("timestamp").and_then(Value::as_str)?;
    parse_day(ts)
}

fn parse_day(timestamp: &str) -> Option<NaiveDate> {
    if timestamp.len() >= 10 {
        if let Ok(day) = NaiveDate::parse_from_str(&timestamp[..10], "%Y-%m-%d") {
            return Some(day);
        }
    }
    DateTime::parse_from_rfc3339(timestamp)
        .ok()
        .map(|dt| dt.with_timezone(&Utc).date_naive())
}

fn day_in_range(day: &str, since: NaiveDate, until: NaiveDate) -> bool {
    NaiveDate::parse_from_str(day, "%Y-%m-%d")
        .map(|date| date >= since && date <= until)
        .unwrap_or(false)
}

fn normalize_model(model: &str, provider: &str) -> String {
    let model = model.trim();
    if provider == "claude_code" {
        return model.split('@').next().unwrap_or(model).trim().to_string();
    }
    model.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_day_prefix() {
        assert_eq!(
            parse_day("2026-05-22T08:10:00Z").unwrap().to_string(),
            "2026-05-22"
        );
    }
}
