//! 跨机文件占用 claim 的 registry：本机（开着 monitor 这台）总是当 registry。
//!
//! - registry 服务绑 `0.0.0.0:47801`，只挂 `/claims/*`，对局域网开放；先来后到由 db.rs 的
//!   SQLite（单连接串行）裁决。各机器的 PreToolUse hook POST acquire/heartbeat/release。
//! - 本机 UI 直接读 db；本机 hook 兜底连 `127.0.0.1:47801`；远程机 hook 用主控机下发来的地址。
//! - 启动 / 加源后把自己的局域网地址下发给各远程中继的 `/claims/set_registry`，远程 hook 据此
//!   acquire（地址全自动，IP 变了重新下发即更新，无需任何手填；设备唯一性靠 machine_id）。

use std::net::UdpSocket;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::State as AxState,
    http::Method,
    response::Json,
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use tauri::State;
use tower_http::cors::{Any, CorsLayer};

use crate::db::{AcquireOutcome, Database, FileClaim};
use crate::session_store::SessionSource;
use crate::state::AppState;

pub const PORT: u16 = 47801;

// ---------- registry HTTP 服务 ----------

#[derive(Clone)]
struct ClaimState {
    db: Arc<Database>,
}

#[derive(Debug, Deserialize)]
struct AcquireReq {
    path: String,
    owner: String,
    #[serde(default)]
    machine_id: String,
    #[serde(default)]
    host: String,
    #[serde(default)]
    session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct HeartbeatReq {
    #[serde(default)]
    owner: String,
    #[serde(default)]
    machine_id: String,
    #[serde(default)]
    paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ReleaseReq {
    path: String,
    #[serde(default)]
    owner: String,
    #[serde(default)]
    machine_id: String,
}

#[derive(Debug, Serialize)]
struct ListResp {
    ok: bool,
    claims: Vec<FileClaim>,
}

#[derive(Debug, Serialize)]
struct OkResp {
    ok: bool,
}

/// 启动 registry 服务（绑 0.0.0.0:PORT）。monitor 启动即调用——本机恒为 registry。
pub async fn start(db: Arc<Database>) {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST])
        .allow_headers(Any);

    let app = Router::new()
        .route("/claims/acquire", post(handle_acquire))
        .route("/claims/list", get(handle_list))
        .route("/claims/heartbeat", post(handle_heartbeat))
        .route("/claims/release", post(handle_release))
        .route("/claims/ping", get(|| async { "pong" }))
        .with_state(ClaimState { db })
        .layer(cors);

    let addr = format!("0.0.0.0:{PORT}");
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[claims] registry 启动失败，端口 {PORT} 可能被占用: {e}");
            return;
        }
    };
    println!("[claims] registry 监听 http://{addr}（跨机文件占用仲裁）");
    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("[claims] 服务异常退出: {e}");
    }
}

async fn handle_acquire(
    AxState(state): AxState<ClaimState>,
    Json(req): Json<AcquireReq>,
) -> Json<AcquireOutcome> {
    let outcome = state
        .db
        .claim_acquire(
            &req.path,
            &req.owner,
            &req.machine_id,
            &req.host,
            req.session_id.as_deref(),
        )
        // registry 出错时降级放行：advisory 不该因仲裁故障阻断写码
        .unwrap_or(AcquireOutcome {
            granted: true,
            holder: None,
        });
    Json(outcome)
}

async fn handle_list(AxState(state): AxState<ClaimState>) -> Json<ListResp> {
    let claims = state.db.claims_list().unwrap_or_default();
    Json(ListResp { ok: true, claims })
}

async fn handle_heartbeat(
    AxState(state): AxState<ClaimState>,
    Json(req): Json<HeartbeatReq>,
) -> Json<OkResp> {
    let _ = state
        .db
        .claims_heartbeat(&req.owner, &req.machine_id, &req.paths);
    Json(OkResp { ok: true })
}

async fn handle_release(
    AxState(state): AxState<ClaimState>,
    Json(req): Json<ReleaseReq>,
) -> Json<OkResp> {
    let _ = state.db.claim_release(&req.path, &req.owner, &req.machine_id);
    Json(OkResp { ok: true })
}

// ---------- HTTP 工具（局域网，不走代理） ----------

fn blocking_client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(4))
        .build()
        .unwrap_or_default()
}

fn join_url(base: &str, path: &str) -> String {
    let base = base.trim_end_matches('/');
    if path.starts_with('/') {
        format!("{base}{path}")
    } else {
        format!("{base}/{path}")
    }
}

/// 本机局域网 IP（不实际发包，仅取本地出口地址）。仅供下发用，用户不接触。
fn lan_ip() -> String {
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            s.connect("8.8.8.8:80")?;
            s.local_addr()
        })
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string())
}

fn remotes(db: &Database) -> Vec<SessionSource> {
    db.get_setting("session_sources")
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str::<Vec<SessionSource>>(&s).ok())
        .unwrap_or_default()
}

/// 把本机（registry）的局域网地址下发给所有远程中继的 /claims/set_registry，
/// 远程 hook 据此知道往哪 acquire（零手工）。失败静默（尽力而为）。
pub fn broadcast_registry_url(db: &Database) {
    let self_url = format!("http://{}:{}", lan_ip(), PORT);
    let client = blocking_client();
    for src in remotes(db) {
        let url = join_url(&src.base_url, "/claims/set_registry");
        let _ = client
            .post(&url)
            .json(&serde_json::json!({ "url": self_url }))
            .send();
    }
}

// ---------- Tauri 命令 ----------

/// 列出当前所有文件占用（先来在前）。本机恒为 registry → 直接读 db。
#[tauri::command]
pub fn session_claims_list(state: State<AppState>) -> Vec<FileClaim> {
    state.db.claims_list().unwrap_or_default()
}

/// 手动强制释放某文件占用（UI 用）。
#[tauri::command]
pub fn session_claim_release(state: State<AppState>, path: String) -> Result<(), String> {
    state
        .db
        .claim_release(&path, "", "")
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// 加源后调用：把本机 registry 地址下发给（含新）各远程中继。
#[tauri::command]
pub async fn session_claim_sync_registry(state: State<'_, AppState>) -> Result<(), String> {
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || broadcast_registry_url(&db))
        .await
        .map_err(|e| e.to_string())
}
