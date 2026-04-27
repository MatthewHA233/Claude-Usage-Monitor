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
    // Claude API 大多数情况返回百分比整数（1, 36, 44…），少数老路径返回 0-1 小数
    // 与启动迁移 normalize_pct_scale 保持一致：仅当 session 与 weekly 同时 <1.5 时
    // 视为旧格式整体放大；否则保留原值。避免把 1%（utilization=1）误判成 100%
    let (session_pct, weekly_pct) = match (payload.session_pct, payload.weekly_pct) {
        (Some(s), Some(w)) if s < 1.5 && w < 1.5 => (Some(s * 100.0), Some(w * 100.0)),
        (s, w) => (s, w),
    };

    let snap = UsageSnapshot {
        id: None,
        account_alias: payload.account_alias.clone(),
        collected_at: chrono::Utc::now().to_rfc3339(),
        session_pct,
        session_reset_at: payload.session_reset_at,
        weekly_pct,
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
        // 2. weekly 0→100 异常跳变（页面刷新瞬间读到错误值），放入收件箱
        if let (Some(last_w), Some(new_w)) = (last.weekly_pct, snap.weekly_pct) {
            if last_w <= 5.0 && new_w >= 95.0 {
                let reason = format!(
                    "异常跳变（weekly {:.0}% → {:.0}%）",
                    last_w, new_w
                );
                let _ = db.inbox_insert(&snap, &reason);
                return (
                    StatusCode::OK,
                    Json(ReportResponse {
                        ok: true,
                        message: format!("{}，已放入收件箱待审核", reason),
                    }),
                );
            }
        }
        // 3. session 0→100 但 weekly 几乎不变也是异常
        //    （耗完一个 session 必然对应 weekly 数个百分点的增长）
        if let (Some(last_s), Some(new_s), Some(last_w), Some(new_w)) =
            (last.session_pct, snap.session_pct, last.weekly_pct, snap.weekly_pct)
        {
            if last_s <= 5.0 && new_s >= 95.0 && (new_w - last_w).abs() < 5.0 {
                let reason = format!(
                    "异常跳变（session {:.0}% → {:.0}%，weekly 仅 {:+.1}%）",
                    last_s, new_s, new_w - last_w
                );
                let _ = db.inbox_insert(&snap, &reason);
                return (
                    StatusCode::OK,
                    Json(ReportResponse {
                        ok: true,
                        message: format!("{}，已放入收件箱待审核", reason),
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
