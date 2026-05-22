use crate::db::Database;
use crate::models::UsageSnapshot;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, TimeZone, Utc};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, USER_AGENT};
use serde::Deserialize;
use serde_json::Value;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const COLLECT_INTERVAL_SECONDS: u64 = 60;
const CLAUDE_COLLECT_MIN_SECONDS: u64 = 300;
const SESSION_RESET_SIGNIFICANT_SECONDS: i64 = 4 * 60 * 60;
const WEEKLY_RESET_SIGNIFICANT_SECONDS: i64 = 12 * 60 * 60;

static LAST_CLAUDE_COLLECT: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();

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
        match collect_claude_oauth().await {
            Ok(Some(snapshot)) => {
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
                let _ = db.set_local_usage_status(
                    "claude_code",
                    None,
                    false,
                    "Claude credentials not found or empty",
                );
            }
            Err(error) => {
                if error.contains("HTTP 429") && has_cached_snapshot(&db, "claude_code") {
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
    let state = LAST_CLAUDE_COLLECT.get_or_init(|| Mutex::new(None));
    let mut last = state.lock().unwrap();
    let now = Instant::now();
    if let Some(previous) = *last {
        if now.duration_since(previous) < Duration::from_secs(CLAUDE_COLLECT_MIN_SECONDS) {
            return false;
        }
    }
    *last = Some(now);
    true
}

fn has_cached_snapshot(db: &Database, provider: &str) -> bool {
    latest_cached_alias(db, provider).is_some()
}

fn latest_cached_alias(db: &Database, provider: &str) -> Option<String> {
    db.latest_all()
        .map(|snapshots| {
            snapshots
                .into_iter()
                .find(|snapshot| snapshot.provider == provider && snapshot.error.is_none())
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

async fn collect_claude_oauth() -> Result<Option<UsageSnapshot>, String> {
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
    let usage = fetch_claude_usage(&credentials.access_token).await?;
    Ok(Some(usage.to_snapshot(&identity, &credentials)))
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
        let subscription_type = string_field(oauth, "subscriptionType");
        Ok(Self {
            access_token,
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
    fn account_alias(&self, credentials: &ClaudeCredentials) -> String {
        self.email
            .clone()
            .or_else(|| self.org_name.clone())
            .or_else(|| self.subscription_type.clone())
            .or_else(|| credentials.subscription_type.clone())
            .unwrap_or_else(|| "Claude Code Local".to_string())
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
    headers.insert(USER_AGENT, HeaderValue::from_static("Codex-switch"));
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
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "HTTP {status}: {}",
            body.chars().take(200).collect::<String>()
        ));
    }
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

fn claude_auth_status() -> Result<ClaudeAuthStatus, String> {
    let output = Command::new("cmd")
        .args(["/C", "claude", "auth", "status"])
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
    fn to_snapshot(
        &self,
        identity: &ClaudeAuthStatus,
        credentials: &ClaudeCredentials,
    ) -> UsageSnapshot {
        let weekly = self
            .seven_day
            .as_ref()
            .or(self.seven_day_opus.as_ref())
            .or(self.seven_day_sonnet.as_ref());

        UsageSnapshot {
            id: None,
            provider: "claude_code".to_string(),
            account_alias: identity.account_alias(credentials),
            collected_at: Utc::now().to_rfc3339(),
            session_pct: self
                .five_hour
                .as_ref()
                .and_then(|window| window.utilization),
            session_total_pct: Some(100.0),
            session_reset_at: self
                .five_hour
                .as_ref()
                .and_then(|window| window.resets_at.clone()),
            weekly_pct: weekly.and_then(|window| window.utilization),
            weekly_total_pct: Some(100.0),
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
        let plan = self.plan_type.as_deref().unwrap_or("").to_ascii_lowercase();
        if plan.contains("pro") {
            10.0
        } else {
            1.0
        }
    }
}

fn epoch_to_rfc3339(seconds: i64) -> Option<String> {
    let dt: DateTime<Utc> = Utc.timestamp_opt(seconds, 0).single()?;
    Some(dt.to_rfc3339())
}
