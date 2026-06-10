use crate::db::Database;
use crate::models::UsageSnapshot;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, TimeZone, Utc};
use reqwest::header::{
    HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, RETRY_AFTER, USER_AGENT,
};
use serde::Deserialize;
use serde_json::Value;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const COLLECT_INTERVAL_SECONDS: u64 = 20;
const CLAUDE_COLLECT_MIN_SECONDS: u64 = 20;
const CLAUDE_RATE_LIMIT_FALLBACK_SECONDS: u64 = 5 * 60;
const RATE_LIMIT_RETRY_AFTER_MARKER: &str = "rate_limit_retry_after_seconds=";
const SESSION_RESET_SIGNIFICANT_SECONDS: i64 = 4 * 60 * 60;
const WEEKLY_RESET_SIGNIFICANT_SECONDS: i64 = 12 * 60 * 60;

#[derive(Default)]
struct ClaudeCollectState {
    last_attempt: Option<Instant>,
    rate_limited_until: Option<Instant>,
}

static CLAUDE_COLLECT_STATE: OnceLock<Mutex<ClaudeCollectState>> = OnceLock::new();

pub async fn run_background_collector(db: Arc<Database>) {
    collect_once(Arc::clone(&db)).await;
    let mut interval = tokio::time::interval(Duration::from_secs(COLLECT_INTERVAL_SECONDS));
    loop {
        interval.tick().await;
        collect_once(Arc::clone(&db)).await;
    }
}

pub async fn collect_once(db: Arc<Database>) {
    match collect_codex_oauth().await {
        Ok(Some(snapshot)) => {
            let message = format!(
                "Codex OAuth ok: {} session={:?} weekly={:?}",
                snapshot.account_alias, snapshot.session_pct, snapshot.weekly_pct
            );
            let account_alias = snapshot.account_alias.clone();
            save_snapshot(&db, snapshot);
            let _ = db.set_local_usage_status("codex", Some(&account_alias), true, &message);
        }
        Ok(None) => {
            let _ = db.set_local_usage_status(
                "codex",
                None,
                false,
                "Codex auth.json not found or empty",
            );
        }
        Err(error) => {
            let _ = db.set_local_usage_status("codex", None, false, &error);
            eprintln!("[local-usage] Codex OAuth failed: {error}");
        }
    }

    if should_collect_claude() {
        match collect_claude_oauth(db.as_ref()).await {
            Ok(Some(snapshot)) => {
                clear_claude_rate_limit();
                let message = format!(
                    "Claude OAuth ok: {} session={:?} weekly={:?}",
                    snapshot.account_alias, snapshot.session_pct, snapshot.weekly_pct
                );
                let account_alias = snapshot.account_alias.clone();
                save_snapshot(&db, snapshot);
                let _ =
                    db.set_local_usage_status("claude_code", Some(&account_alias), true, &message);
            }
            Ok(None) => {
                clear_claude_rate_limit();
                let _ = db.set_local_usage_status(
                    "claude_code",
                    None,
                    false,
                    "Claude credentials not found or empty",
                );
            }
            Err(error) => {
                if let Some(retry_after_seconds) = claude_rate_limit_retry_after_seconds(&error) {
                    schedule_claude_rate_limit(retry_after_seconds);
                    let message = format!(
                        "Claude OAuth rate limited; retrying after {}",
                        format_retry_after(retry_after_seconds)
                    );
                    if has_cached_snapshot(&db, "claude_code") {
                        let _ = db.set_local_usage_status(
                            "claude_code",
                            latest_cached_alias(&db, "claude_code").as_deref(),
                            true,
                            &message,
                        );
                    } else {
                        let _ = db.set_local_usage_status("claude_code", None, false, &message);
                    }
                    eprintln!(
                        "[local-usage] Claude OAuth rate limited; retrying after {}: {error}",
                        format_retry_after(retry_after_seconds)
                    );
                } else if error.contains("HTTP 429") && has_cached_snapshot(&db, "claude_code") {
                    let _ = db.set_local_usage_status(
                        "claude_code",
                        latest_cached_alias(&db, "claude_code").as_deref(),
                        true,
                        "Claude OAuth rate limited; using latest cached snapshot",
                    );
                } else {
                    let _ = db.set_local_usage_status("claude_code", None, false, &error);
                }
                eprintln!("[local-usage] Claude OAuth failed: {error}");
            }
        }
    }
}

fn save_snapshot(db: &Database, snapshot: UsageSnapshot) {
    if let Ok(Some(last)) = db.last_snapshot(&snapshot.provider, &snapshot.account_alias) {
        if last.session_pct == snapshot.session_pct
            && last.session_total_pct == snapshot.session_total_pct
            && last.weekly_pct == snapshot.weekly_pct
            && last.weekly_total_pct == snapshot.weekly_total_pct
            && last.error == snapshot.error
            && !reset_shift_is_significant(
                last.session_reset_at.as_deref(),
                snapshot.session_reset_at.as_deref(),
                SESSION_RESET_SIGNIFICANT_SECONDS,
            )
            && !reset_shift_is_significant(
                last.weekly_reset_at.as_deref(),
                snapshot.weekly_reset_at.as_deref(),
                WEEKLY_RESET_SIGNIFICANT_SECONDS,
            )
        {
            return;
        }
    }
    if let Err(error) = db.insert_snapshot(&snapshot) {
        eprintln!("[local-usage] failed to insert snapshot: {error}");
    }
}

fn reset_shift_is_significant(
    previous: Option<&str>,
    current: Option<&str>,
    threshold_seconds: i64,
) -> bool {
    match (previous, current) {
        (None, None) => false,
        (Some(previous), Some(current)) => {
            if previous == current {
                return false;
            }
            let previous = DateTime::parse_from_rfc3339(previous).ok();
            let current = DateTime::parse_from_rfc3339(current).ok();
            match (previous, current) {
                (Some(previous), Some(current)) => {
                    (current.timestamp() - previous.timestamp()).abs() >= threshold_seconds
                }
                _ => true,
            }
        }
        _ => true,
    }
}

fn should_collect_claude() -> bool {
    let state = CLAUDE_COLLECT_STATE.get_or_init(|| Mutex::new(ClaudeCollectState::default()));
    let mut state = state.lock().unwrap();
    let now = Instant::now();
    if let Some(until) = state.rate_limited_until {
        if now < until {
            return false;
        }
        state.rate_limited_until = None;
    }
    if let Some(previous) = state.last_attempt {
        if now.duration_since(previous) < Duration::from_secs(CLAUDE_COLLECT_MIN_SECONDS) {
            return false;
        }
    }
    state.last_attempt = Some(now);
    true
}

fn schedule_claude_rate_limit(retry_after_seconds: u64) {
    let state = CLAUDE_COLLECT_STATE.get_or_init(|| Mutex::new(ClaudeCollectState::default()));
    let mut state = state.lock().unwrap();
    state.rate_limited_until =
        Some(Instant::now() + Duration::from_secs(retry_after_seconds.max(1)));
}

fn clear_claude_rate_limit() {
    let state = CLAUDE_COLLECT_STATE.get_or_init(|| Mutex::new(ClaudeCollectState::default()));
    let mut state = state.lock().unwrap();
    state.rate_limited_until = None;
}

fn claude_rate_limit_retry_after_seconds(error: &str) -> Option<u64> {
    if !error.contains("rate_limit_error") {
        return None;
    }
    error
        .split(RATE_LIMIT_RETRY_AFTER_MARKER)
        .nth(1)
        .and_then(|tail| tail.split(|ch: char| !ch.is_ascii_digit()).next())
        .filter(|value| !value.is_empty())
        .and_then(|value| value.parse::<u64>().ok())
        .or(Some(CLAUDE_RATE_LIMIT_FALLBACK_SECONDS))
        .map(|seconds| seconds.max(1))
}

fn format_retry_after(seconds: u64) -> String {
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let minutes = seconds / 60;
    let rest_seconds = seconds % 60;
    if minutes < 60 {
        if rest_seconds == 0 {
            return format!("{minutes}m");
        }
        return format!("{minutes}m{rest_seconds}s");
    }
    let hours = minutes / 60;
    let rest_minutes = minutes % 60;
    if rest_minutes == 0 {
        format!("{hours}h")
    } else {
        format!("{hours}h{rest_minutes}m")
    }
}

fn has_cached_snapshot(db: &Database, provider: &str) -> bool {
    latest_cached_alias(db, provider).is_some()
}

fn latest_cached_alias(db: &Database, provider: &str) -> Option<String> {
    db.latest_all()
        .map(|snapshots| {
            snapshots
                .into_iter()
                .find(|snapshot| {
                    snapshot.provider == provider
                        && snapshot.error.is_none()
                        && !is_plan_label(&snapshot.account_alias)
                })
                .map(|snapshot| snapshot.account_alias)
        })
        .unwrap_or(None)
}

async fn collect_codex_oauth() -> Result<Option<UsageSnapshot>, String> {
    let Some(auth_path) = codex_auth_path() else {
        return Ok(None);
    };
    let data = tokio::fs::read_to_string(&auth_path)
        .await
        .map_err(|e| format!("read {}: {e}", auth_path.display()))?;
    let credentials = CodexCredentials::parse(&data)?;
    if credentials.access_token.trim().is_empty() {
        return Ok(None);
    }

    let usage = fetch_codex_usage(&credentials).await?;
    Ok(Some(usage.to_snapshot(&credentials)))
}

fn codex_auth_path() -> Option<PathBuf> {
    let base = std::env::var("CODEX_HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))?;
    let path = base.join("auth.json");
    path.exists().then_some(path)
}

async fn collect_claude_oauth(db: &Database) -> Result<Option<UsageSnapshot>, String> {
    let Some(credentials_path) = claude_credentials_path() else {
        return Ok(None);
    };
    let data = tokio::fs::read_to_string(&credentials_path)
        .await
        .map_err(|e| format!("read {}: {e}", credentials_path.display()))?;
    let credentials = ClaudeCredentials::parse(&data)?;
    if credentials.access_token.trim().is_empty() {
        return Ok(None);
    }
    let identity = claude_auth_status().unwrap_or_default();
    let email_aliases = db
        .email_aliases("claude_code")
        .map_err(|error| error.to_string())?;
    let account_alias = identity.resolve_account_alias(&credentials, &email_aliases)?;
    let usage = fetch_claude_usage(&credentials.access_token).await?;
    // subscriptionType 往往只有 "max"（不带 5x/20x），CLI 侧检测不出倍率时
    // 复用插件上报落库的 total_pct（popup 套餐选择 / rate_limit_tier 自动检测）
    let mut multiplier = identity.quota_multiplier(&credentials);
    if multiplier <= 1.0 {
        if let Ok(Some(total)) = db.latest_session_total_pct("claude_code", &account_alias) {
            if total > 100.0 {
                multiplier = total / 100.0;
            }
        }
    }
    Ok(Some(usage.to_snapshot(account_alias, multiplier)))
}

fn claude_credentials_path() -> Option<PathBuf> {
    let path = dirs::home_dir()?.join(".claude").join(".credentials.json");
    path.exists().then_some(path)
}

#[derive(Debug, Clone)]
struct CodexCredentials {
    access_token: String,
    account_id: Option<String>,
    email: Option<String>,
}

#[derive(Debug, Clone)]
struct ClaudeCredentials {
    access_token: String,
    email: Option<String>,
    subscription_type: Option<String>,
}

impl ClaudeCredentials {
    fn parse(raw: &str) -> Result<Self, String> {
        let json: Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
        let oauth = json
            .get("claudeAiOauth")
            .ok_or_else(|| ".credentials.json missing claudeAiOauth".to_string())?;
        let access_token = string_field(oauth, "accessToken")
            .or_else(|| string_field(oauth, "access_token"))
            .ok_or_else(|| ".credentials.json missing access token".to_string())?;
        let id_token = string_field(oauth, "idToken").or_else(|| string_field(oauth, "id_token"));
        let email = email_candidate(string_field(oauth, "email"))
            .or_else(|| email_candidate(string_field(oauth, "accountEmail")))
            .or_else(|| id_token.as_deref().and_then(email_from_jwt))
            .or_else(|| email_from_jwt(&access_token));
        let subscription_type = string_field(oauth, "subscriptionType");
        Ok(Self {
            access_token,
            email,
            subscription_type,
        })
    }
}

#[derive(Debug, Default, Deserialize)]
struct ClaudeAuthStatus {
    #[serde(default)]
    email: Option<String>,
    #[serde(default, rename = "orgName")]
    org_name: Option<String>,
    #[serde(default, rename = "subscriptionType")]
    subscription_type: Option<String>,
}

impl ClaudeAuthStatus {
    fn quota_multiplier(&self, credentials: &ClaudeCredentials) -> f64 {
        for value in [
            self.subscription_type.as_deref(),
            credentials.subscription_type.as_deref(),
            self.org_name.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            let normalized = compact_plan_label(value);
            if normalized.contains("20x")
                || normalized.contains("x20")
                || normalized.contains("max20")
                || (normalized.contains("max") && normalized.contains("20"))
            {
                return 20.0;
            }
            if normalized.contains("5x")
                || normalized.contains("x5")
                || normalized.contains("max5")
                || (normalized.contains("max") && normalized.contains("5"))
            {
                return 5.0;
            }
        }
        1.0
    }

    fn resolve_account_alias(
        &self,
        credentials: &ClaudeCredentials,
        existing_email_aliases: &[String],
    ) -> Result<String, String> {
        if let Some(email) = email_candidate(self.email.clone())
            .or_else(|| email_candidate(credentials.email.clone()))
            .or_else(|| email_candidate(self.org_name.clone()))
        {
            return Ok(email);
        }

        if existing_email_aliases.len() == 1 {
            return Ok(existing_email_aliases[0].clone());
        }

        let label = self
            .subscription_type
            .clone()
            .or_else(|| credentials.subscription_type.clone())
            .or_else(|| self.org_name.clone())
            .unwrap_or_else(|| "unknown".to_string());
        if existing_email_aliases.is_empty() {
            Err(format!(
                "Claude Code account identity unresolved: CLI returned '{label}', but no existing email account can inherit it"
            ))
        } else {
            Err(format!(
                "Claude Code account identity unresolved: CLI returned '{label}', but multiple existing email accounts match: {}",
                existing_email_aliases.join(", ")
            ))
        }
    }
}

impl CodexCredentials {
    fn parse(raw: &str) -> Result<Self, String> {
        let json: Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
        if let Some(api_key) = json.get("OPENAI_API_KEY").and_then(Value::as_str) {
            return Ok(Self {
                access_token: api_key.to_string(),
                account_id: None,
                email: None,
            });
        }

        let tokens = json
            .get("tokens")
            .ok_or_else(|| "auth.json missing tokens".to_string())?;
        let access_token = string_field(tokens, "access_token")
            .or_else(|| string_field(tokens, "accessToken"))
            .ok_or_else(|| "auth.json missing access token".to_string())?;
        let account_id =
            string_field(tokens, "account_id").or_else(|| string_field(tokens, "accountId"));
        let id_token = string_field(tokens, "id_token").or_else(|| string_field(tokens, "idToken"));
        let email = id_token.as_deref().and_then(email_from_jwt);

        Ok(Self {
            access_token,
            account_id,
            email,
        })
    }

    fn account_alias(&self) -> String {
        self.email
            .clone()
            .or_else(|| self.account_id.clone())
            .unwrap_or_else(|| "Codex Local".to_string())
    }
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn email_candidate(value: Option<String>) -> Option<String> {
    let value = value?;
    let trimmed = value.trim();
    if trimmed.contains('@') && !is_plan_label(trimmed) {
        Some(trimmed.to_string())
    } else {
        None
    }
}

fn is_plan_label(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "pro"
            | "max"
            | "team"
            | "enterprise"
            | "free"
            | "claude pro"
            | "claude max"
            | "claude team"
            | "claude enterprise"
            | "claude free"
    )
}

fn email_from_jwt(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD.decode(payload.as_bytes()).ok()?;
    let json: Value = serde_json::from_slice(&decoded).ok()?;
    json.get("email")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

async fn fetch_codex_usage(credentials: &CodexCredentials) -> Result<CodexUsageResponse, String> {
    let url = codex_usage_url();
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static("claude-usage-monitor"));
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", credentials.access_token))
            .map_err(|e| e.to_string())?,
    );
    if let Some(account_id) = &credentials.account_id {
        if let Ok(value) = HeaderValue::from_str(account_id) {
            headers.insert("ChatGPT-Account-Id", value);
        }
    }

    let response = http_client()?
        .get(url)
        .headers(headers)
        .send()
        .await
        .map_err(reqwest_error_detail)?;
    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "HTTP {status}: {}",
            body.chars().take(200).collect::<String>()
        ));
    }
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

async fn fetch_claude_usage(access_token: &str) -> Result<ClaudeOAuthUsageResponse, String> {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static("claude-code/2.1.0"));
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        "anthropic-beta",
        HeaderValue::from_static("oauth-2025-04-20"),
    );
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {access_token}")).map_err(|e| e.to_string())?,
    );

    let response = http_client()?
        .get("https://api.anthropic.com/api/oauth/usage")
        .headers(headers)
        .send()
        .await
        .map_err(reqwest_error_detail)?;
    let status = response.status();
    let retry_after = parse_retry_after_seconds(response.headers());
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let body_preview = body.chars().take(200).collect::<String>();
        if status.as_u16() == 429 && body.contains("rate_limit_error") {
            let retry_after_seconds = retry_after.unwrap_or(CLAUDE_RATE_LIMIT_FALLBACK_SECONDS);
            return Err(format!(
                "HTTP {status}: {body_preview} ({RATE_LIMIT_RETRY_AFTER_MARKER}{retry_after_seconds})"
            ));
        }
        return Err(format!(
            "HTTP {status}: {}",
            body_preview
        ));
    }
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

fn parse_retry_after_seconds(headers: &HeaderMap) -> Option<u64> {
    let value = headers.get(RETRY_AFTER)?.to_str().ok()?.trim();
    if value.is_empty() {
        return None;
    }
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(seconds.max(1));
    }
    let retry_at = DateTime::parse_from_rfc2822(value).ok()?.with_timezone(&Utc);
    let seconds = retry_at.signed_duration_since(Utc::now()).num_seconds();
    Some(seconds.max(1) as u64)
}

fn claude_auth_status() -> Result<ClaudeAuthStatus, String> {
    let mut command = Command::new("cmd");
    command.args(["/C", "claude", "auth", "status"]);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    let output = command
        .output()
        .map_err(|e| format!("run claude auth status: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("claude auth status failed: {}", stderr.trim()));
    }
    let stdout = String::from_utf8(output.stdout).map_err(|e| e.to_string())?;
    serde_json::from_str(&stdout).map_err(|e| e.to_string())
}

fn http_client() -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(30));
    if let Some(proxy) = system_proxy_url() {
        if let Ok(proxy) = reqwest::Proxy::all(&proxy) {
            builder = builder.proxy(proxy);
        }
    }
    builder.build().map_err(|e| e.to_string())
}

fn reqwest_error_detail(error: reqwest::Error) -> String {
    let mut parts = vec![error.to_string()];
    let mut source = std::error::Error::source(&error);
    while let Some(err) = source {
        parts.push(err.to_string());
        source = err.source();
    }
    parts.join(": ")
}

fn system_proxy_url() -> Option<String> {
    for key in ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] {
        if let Ok(value) = std::env::var(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(normalize_proxy_url(trimmed));
            }
        }
    }
    windows_proxy_url()
}

fn normalize_proxy_url(value: &str) -> String {
    if value.contains("://") {
        value.to_string()
    } else {
        format!("http://{value}")
    }
}

#[cfg(windows)]
fn windows_proxy_url() -> Option<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let settings = hkcu
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
        .ok()?;
    let enabled: u32 = settings.get_value("ProxyEnable").ok()?;
    if enabled == 0 {
        return None;
    }
    let proxy_server: String = settings.get_value("ProxyServer").ok()?;
    parse_windows_proxy_server(&proxy_server).map(normalize_proxy_url)
}

#[cfg(not(windows))]
fn windows_proxy_url() -> Option<String> {
    None
}

fn parse_windows_proxy_server(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if !trimmed.contains('=') {
        return Some(trimmed);
    }
    for part in trimmed.split(';') {
        let (scheme, proxy) = part.split_once('=')?;
        if scheme.eq_ignore_ascii_case("https") || scheme.eq_ignore_ascii_case("http") {
            let proxy = proxy.trim();
            if !proxy.is_empty() {
                return Some(proxy);
            }
        }
    }
    None
}

fn codex_usage_url() -> &'static str {
    "https://chatgpt.com/backend-api/wham/usage"
}

#[derive(Debug, Deserialize)]
struct CodexUsageResponse {
    #[serde(default)]
    plan_type: Option<String>,
    #[serde(default)]
    rate_limit: Option<CodexRateLimit>,
}

#[derive(Debug, Deserialize)]
struct CodexRateLimit {
    #[serde(default)]
    primary_window: Option<CodexWindow>,
    #[serde(default)]
    secondary_window: Option<CodexWindow>,
}

#[derive(Debug, Deserialize)]
struct CodexWindow {
    used_percent: f64,
    reset_at: i64,
}

#[derive(Debug, Deserialize)]
struct ClaudeOAuthUsageResponse {
    #[serde(default)]
    five_hour: Option<ClaudeOAuthWindow>,
    #[serde(default)]
    seven_day: Option<ClaudeOAuthWindow>,
    #[serde(default)]
    seven_day_opus: Option<ClaudeOAuthWindow>,
    #[serde(default)]
    seven_day_sonnet: Option<ClaudeOAuthWindow>,
}

#[derive(Debug, Deserialize)]
struct ClaudeOAuthWindow {
    #[serde(default)]
    utilization: Option<f64>,
    #[serde(default)]
    resets_at: Option<String>,
}

impl ClaudeOAuthUsageResponse {
    fn to_snapshot(&self, account_alias: String, multiplier: f64) -> UsageSnapshot {
        let weekly = self
            .seven_day
            .as_ref()
            .or(self.seven_day_opus.as_ref())
            .or(self.seven_day_sonnet.as_ref());
        let multiplier = multiplier.max(1.0);
        let total_pct = 100.0 * multiplier;

        UsageSnapshot {
            id: None,
            provider: "claude_code".to_string(),
            account_alias,
            collected_at: Utc::now().to_rfc3339(),
            session_pct: self
                .five_hour
                .as_ref()
                .and_then(|window| window.utilization)
                .map(|pct| pct * multiplier),
            session_total_pct: Some(total_pct),
            session_reset_at: self
                .five_hour
                .as_ref()
                .and_then(|window| window.resets_at.clone()),
            weekly_pct: weekly
                .and_then(|window| window.utilization)
                .map(|pct| pct * multiplier),
            weekly_total_pct: Some(total_pct),
            weekly_reset_at: weekly.and_then(|window| window.resets_at.clone()),
            error: None,
        }
    }
}

impl CodexUsageResponse {
    fn to_snapshot(&self, credentials: &CodexCredentials) -> UsageSnapshot {
        let primary = self
            .rate_limit
            .as_ref()
            .and_then(|rate| rate.primary_window.as_ref());
        let secondary = self
            .rate_limit
            .as_ref()
            .and_then(|rate| rate.secondary_window.as_ref());
        let multiplier = self.quota_multiplier();
        let total_pct = 100.0 * multiplier;
        UsageSnapshot {
            id: None,
            provider: "codex".to_string(),
            account_alias: credentials.account_alias(),
            collected_at: Utc::now().to_rfc3339(),
            session_pct: primary.map(|window| window.used_percent * multiplier),
            session_total_pct: Some(total_pct),
            session_reset_at: primary.and_then(|window| epoch_to_rfc3339(window.reset_at)),
            weekly_pct: secondary.map(|window| window.used_percent * multiplier),
            weekly_total_pct: Some(total_pct),
            weekly_reset_at: secondary.and_then(|window| epoch_to_rfc3339(window.reset_at)),
            error: None,
        }
    }

    fn quota_multiplier(&self) -> f64 {
        self.plan_type
            .as_deref()
            .and_then(codex_quota_multiplier_from_label)
            .unwrap_or(1.0)
    }
}

fn codex_quota_multiplier_from_label(label: &str) -> Option<f64> {
    let normalized = compact_plan_label(label);
    if normalized.is_empty() {
        return None;
    }
    if normalized.contains("20x")
        || normalized.contains("x20")
        || normalized.contains("pro20")
        || (normalized.contains("pro") && normalized.contains("20"))
    {
        return Some(20.0);
    }
    if normalized.contains("5x")
        || normalized.contains("x5")
        || normalized.contains("prolite")
        || normalized.contains("pro5")
        || (normalized.contains("pro") && normalized.contains("5"))
    {
        return Some(5.0);
    }
    if normalized.contains("plus") {
        return Some(1.0);
    }
    if normalized == "pro" {
        return Some(5.0);
    }
    None
}

fn compact_plan_label(label: &str) -> String {
    label
        .to_ascii_lowercase()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect()
}

fn epoch_to_rfc3339(seconds: i64) -> Option<String> {
    let dt: DateTime<Utc> = Utc.timestamp_opt(seconds, 0).single()?;
    Some(dt.to_rfc3339())
}
