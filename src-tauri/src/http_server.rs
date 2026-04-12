/// 本地 HTTP 服务器，供 Chrome 扩展上报用量数据
/// 监听 localhost:47892
use axum::{
    Router,
    extract::State,
    http::{Method, StatusCode},
    response::Json,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};

use crate::db::Database;
use crate::models::UsageSnapshot;

pub const PORT: u16 = 47892;

/// Chrome 扩展上报的数据格式
#[derive(Debug, Deserialize)]
pub struct ReportPayload {
    /// 账号别名（扩展配置里填的，或自动从页面读取的 email）
    pub account_alias: String,
    pub session_pct: Option<f64>,
    pub session_reset_at: Option<String>,
    pub weekly_pct: Option<f64>,
    pub weekly_reset_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ReportResponse {
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct StatusResponse {
    pub snapshots: Vec<UsageSnapshot>,
}

pub async fn start(db: Arc<Database>) {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST])
        .allow_headers(Any);

    let app = Router::new()
        .route("/report", post(handle_report))
        .route("/status", get(handle_status))
        .route("/ping", get(|| async { "pong" }))
        .with_state(db)
        .layer(cors);

    let addr = format!("127.0.0.1:{PORT}");
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[HTTP] 启动失败，端口 {PORT} 可能被占用: {e}");
            return;
        }
    };

    println!("[HTTP] 监听 http://{addr}");
    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("[HTTP] 服务异常退出: {e}");
    }
}

async fn handle_report(
    State(db): State<Arc<Database>>,
    Json(payload): Json<ReportPayload>,
) -> (StatusCode, Json<ReportResponse>) {
    // API 返回 0-1 小数（如 0.47），统一归一化为 0-100 存储
    fn to_pct(v: Option<f64>) -> Option<f64> {
        v.map(|x| if x <= 1.0 { x * 100.0 } else { x })
    }

    let snap = UsageSnapshot {
        id: None,
        account_alias: payload.account_alias.clone(),
        collected_at: chrono::Utc::now().to_rfc3339(),
        session_pct: to_pct(payload.session_pct),
        session_reset_at: payload.session_reset_at,
        weekly_pct: to_pct(payload.weekly_pct),
        weekly_reset_at: payload.weekly_reset_at,
        error: None,
    };

    // 去重 & 异常跳变过滤
    if let Ok(Some(last)) = db.last_snapshot(&snap.account_alias) {
        // 1. 完全相同则跳过
        if last.session_pct == snap.session_pct
            && last.weekly_pct == snap.weekly_pct
        {
            return (
                StatusCode::OK,
                Json(ReportResponse {
                    ok: true,
                    message: "重复数据，已跳过".to_string(),
                }),
            );
        }
        // 2. 上条 weekly 接近 0%，新条突然 ≥95%，视为异常（页面刷新瞬间读到错误值）
        if let (Some(last_w), Some(new_w)) = (last.weekly_pct, snap.weekly_pct) {
            if last_w <= 5.0 && new_w >= 95.0 {
                return (
                    StatusCode::OK,
                    Json(ReportResponse {
                        ok: true,
                        message: "异常跳变数据（0→100%），已跳过".to_string(),
                    }),
                );
            }
        }
    }

    match db.insert_snapshot(&snap) {
        Ok(_) => (
            StatusCode::OK,
            Json(ReportResponse {
                ok: true,
                message: format!("已记录账号 {} 的用量数据", payload.account_alias),
            }),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ReportResponse {
                ok: false,
                message: format!("存储失败: {e}"),
            }),
        ),
    }
}

async fn handle_status(
    State(db): State<Arc<Database>>,
) -> Json<StatusResponse> {
    // 读取所有账号最新快照（不依赖 config，直接查 DB 里有记录的账号）
    let snapshots = db.latest_all().unwrap_or_default();
    Json(StatusResponse { snapshots })
}
