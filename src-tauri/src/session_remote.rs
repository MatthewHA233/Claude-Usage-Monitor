//! 会话数据远程源：代理到各机器（本机/局域网 macOS 等）的 Python 会话 API。
//!
//! Python 端 `session_api_server.py` 在每台机器绑 0.0.0.0:<port> 提供只读 JSON：
//!   /api/ping /api/info /api/sessions /api/session/<id> /api/stats
//! 这里用 reqwest 代为请求，绕开浏览器 CORS / mixed-content，并显式 `no_proxy()`
//! 避免走 Claude 用量监控配置的 7890 代理（局域网请求不该走代理）。

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::state::AppState;

const SETTING_SESSION_SOURCES: &str = "session_sources";

/// 一个会话数据源（一台机器）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSource {
    pub id: String,
    pub label: String,
    pub base_url: String,
}

fn build_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| e.to_string())
}

fn join_url(base_url: &str, path: &str) -> String {
    let base = base_url.trim_end_matches('/');
    if path.starts_with('/') {
        format!("{base}{path}")
    } else {
        format!("{base}/{path}")
    }
}

/// 读取已保存的数据源列表
#[tauri::command]
pub fn session_sources_get(state: State<AppState>) -> Vec<SessionSource> {
    match state.db.get_setting(SETTING_SESSION_SOURCES) {
        Ok(Some(json)) => serde_json::from_str(&json).unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// 保存数据源列表
#[tauri::command]
pub fn session_sources_save(
    sources: Vec<SessionSource>,
    state: State<AppState>,
) -> Result<(), String> {
    let json = serde_json::to_string(&sources).map_err(|e| e.to_string())?;
    state
        .db
        .set_setting(SETTING_SESSION_SOURCES, &json)
        .map_err(|e| e.to_string())
}

/// 心跳：连得上且 2xx 即在线（短超时，供断连检测频繁轮询）
#[tauri::command]
pub async fn session_ping(base_url: String) -> bool {
    let client = match build_client(3) {
        Ok(c) => c,
        Err(_) => return false,
    };
    match client.get(join_url(&base_url, "/api/ping")).send().await {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

/// 通用 GET 代理：返回解析后的 JSON（/api/info、/api/sessions、/api/session/<id>、/api/stats）
#[tauri::command]
pub async fn session_api_get(
    base_url: String,
    path: String,
) -> Result<serde_json::Value, String> {
    let client = build_client(20)?;
    let resp = client
        .get(join_url(&base_url, &path))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

// ---------- 本机会话服务的按需拉起 / 停止（绑定会话窗口生命周期） ----------

const LOCAL_PORT: u16 = 47800;

/// launcher 写的公共注册文件，记录怎么拉起本机会话 API
#[derive(Debug, Deserialize)]
struct ApiRegistry {
    python: String,
    script: String,
    port: Option<u16>,
}

fn read_registry() -> Option<ApiRegistry> {
    let path = dirs::home_dir()?.join(".claude_session_api.json");
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

/// 确保本机会话服务在运行：已在跑则跳过，否则按注册文件拉起（供会话窗口打开时调用）
#[tauri::command]
pub async fn session_local_ensure() -> Result<String, String> {
    let base = format!("http://127.0.0.1:{LOCAL_PORT}");
    if session_ping(base).await {
        return Ok("running".to_string());
    }

    let reg = read_registry()
        .ok_or_else(|| "未找到本机会话服务注册信息（请先用 ccrun 启动过一次 launcher）".to_string())?;
    let port = reg.port.unwrap_or(LOCAL_PORT);

    let mut cmd = std::process::Command::new(&reg.python);
    cmd.arg(&reg.script).arg(port.to_string());
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        cmd.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }

    cmd.spawn()
        .map_err(|e| format!("拉起本机会话服务失败: {e}"))?;
    Ok("started".to_string())
}

/// 停止本机会话服务（会话窗口关闭时调用；空闲超时是兜底）
#[tauri::command]
pub async fn session_local_stop() -> bool {
    let url = format!("http://127.0.0.1:{LOCAL_PORT}/api/shutdown");
    let client = match build_client(3) {
        Ok(c) => c,
        Err(_) => return false,
    };
    client
        .post(&url)
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}
