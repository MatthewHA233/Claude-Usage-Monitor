//! 会话数据的 rusqlite 物化层（方案B：文件级增量同步 + 索引查询）。
//!
//! 一个库装本机 + 所有远程源（按 `source` 区分）。聊天记录只增、按时间追加，
//! 故用文件级增量：未变的文件跳过，变化/新增的整文件重解析后替换其行。
//! DB 持久化在 `<LocalAppData>/claude-usage-monitor/sessions.db`，服务重启
//! 不再冷启动全量重解析。查询全部走索引。
//!
//! Phase 1：只同步本机文件系统（`~/.claude/projects`）。远程源在 Phase 2 接入。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use chrono::{Local, TimeZone, Timelike};
use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::session_parse::parse_session;
use crate::state::AppState;

pub const LOCAL_SOURCE: &str = "local";
/// 本机「输入历史」回填源：~/.claude/history.jsonl（你打过的每条 prompt，无 AI 回复）。
/// 完整 transcript 受 cleanupPeriodDays 滚动清理，history.jsonl 永久保留，故用它补早期发言。
pub const HISTORY_SOURCE: &str = "history";

/// 一个会话数据源（远程机器）。本机源是隐式的，不进此列表。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSource {
    pub id: String,
    pub label: String,
    pub base_url: String,
}

/// 一条「预备发言/待办」——用户手写的、面向未来的草稿提示词。
/// 与只读的会话历史相反：可变、用户产生、仅本机私有（不走远程中继）。
/// 可挂靠到某个具体会话（source_id + session_id），title/project 为创建时的快照，
/// 便于即使该会话不在当前日期视图里也能展示归属。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionDraft {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub session_title: String,
    #[serde(default)]
    pub project_name: String,
    #[serde(default)]
    pub done: bool,
    #[serde(default)]
    pub created_unix: i64,
    #[serde(default)]
    pub done_unix: Option<i64>,
}

/// 薄中继 /raw/list 的一项
#[derive(Debug, Deserialize)]
struct RawFileEntry {
    key: String,
    session_id: String,
    mtime: i64,
    size: i64,
}

#[derive(Debug, Deserialize)]
struct RawListResponse {
    files: Vec<RawFileEntry>,
}

fn blocking_client(timeout_secs: u64) -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .no_proxy() // 局域网请求不该走 7890 代理
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .unwrap_or_default()
}

fn join_url(base_url: &str, path: &str) -> String {
    let base = base_url.trim_end_matches('/');
    if path.starts_with('/') {
        format!("{base}{path}")
    } else {
        format!("{base}/{path}")
    }
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS files (
    source TEXT NOT NULL,
    path   TEXT NOT NULL,
    mtime  INTEGER NOT NULL,
    size   INTEGER NOT NULL,
    PRIMARY KEY(source, path)
);
CREATE TABLE IF NOT EXISTS sessions (
    source       TEXT NOT NULL,
    session_id   TEXT NOT NULL,
    file_path    TEXT NOT NULL,
    project_path TEXT,
    project_name TEXT,
    title        TEXT,
    git_branch   TEXT,
    last_unix    INTEGER,
    PRIMARY KEY(source, session_id)
);
CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source      TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    file_path   TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    ts          TEXT,
    ts_unix     INTEGER,
    local_date  TEXT,
    text        TEXT,
    chars       INTEGER,
    reply       TEXT,
    reply_chars INTEGER,
    images      TEXT
);
CREATE INDEX IF NOT EXISTS idx_msg_ts      ON messages(ts_unix DESC);
CREATE INDEX IF NOT EXISTS idx_msg_date    ON messages(local_date);
CREATE INDEX IF NOT EXISTS idx_msg_srcfile ON messages(source, file_path);
CREATE INDEX IF NOT EXISTS idx_msg_srcsess ON messages(source, session_id);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
";

#[derive(Serialize)]
pub struct MyMessage {
    pub session_id: String,
    pub source_id: String,
    pub project_name: String,
    pub project_path: String,
    pub ts: String,
    pub ts_unix: Option<i64>,
    pub local_date: String,
    pub text: String,
    pub chars: i64,
    pub reply: String,
    pub reply_chars: i64,
    pub images: Vec<String>,
}

#[derive(Serialize)]
pub struct TimelineBucket {
    pub b: i64,
    pub n: i64,
}

#[derive(Serialize)]
pub struct TimelineRow {
    pub session_id: String,
    pub source_id: String,
    pub title: String,
    pub project_name: String,
    pub project_path: String,
    pub first_unix: Option<i64>,
    pub last_unix: Option<i64>,
    pub count: i64,
    pub buckets: Vec<TimelineBucket>,
}

#[derive(Serialize)]
pub struct DailyStat {
    pub date: String,
    pub count: i64,
    pub chars: i64,
}

pub struct SessionStore {
    conn: Mutex<Connection>,
    syncing: AtomicBool,
}

fn db_path() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("claude-usage-monitor")
        .join("sessions.db")
}

fn projects_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

/// ~/.claude/history.jsonl —— 你输入过的每条 prompt 的全局索引（只增、永久）
fn history_file() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("history.jsonl"))
}

/// unix 秒 → 本地日期 YYYY-MM-DD（无效返回「未知」）
fn local_date_of(ts_unix: i64) -> String {
    Local
        .timestamp_opt(ts_unix, 0)
        .single()
        .map(|dt| dt.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| "未知".into())
}

/// unix 秒 → 本地 ISO 字符串（messages.ts 列用）
fn local_iso_of(ts_unix: i64) -> String {
    Local
        .timestamp_opt(ts_unix, 0)
        .single()
        .map(|dt| dt.format("%Y-%m-%dT%H:%M:%S%:z").to_string())
        .unwrap_or_default()
}

fn get_meta(conn: &Connection, k: &str) -> Result<Option<String>> {
    conn.query_row("SELECT v FROM meta WHERE k=?1", params![k], |r| r.get(0))
        .optional()
}

fn set_meta(conn: &Connection, k: &str, v: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO meta(k,v) VALUES(?1,?2) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
        params![k, v],
    )?;
    Ok(())
}

/// 解析 history.jsonl：每行 {display, timestamp(ms), project}。
/// 只取「cutoff 之前」的条目（cutoff = 本机完整 transcript 最早日期，避免与之重叠重复）。
/// 返回 (ts_unix, local_date, text, project_path)，按时间升序。
fn parse_history(content: &str, cutoff: Option<&str>) -> Vec<(i64, String, String, String)> {
    let mut out: Vec<(i64, String, String, String)> = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let text = v
            .get("display")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if text.is_empty() {
            continue;
        }
        let ts_ms = v.get("timestamp").and_then(|x| x.as_i64()).unwrap_or(0);
        if ts_ms <= 0 {
            continue;
        }
        let ts_unix = ts_ms / 1000;
        let date = local_date_of(ts_unix);
        if date == "未知" {
            continue;
        }
        // 只回填 cutoff 之前；cutoff 之后由完整 transcript 覆盖
        if let Some(c) = cutoff {
            if date.as_str() >= c {
                continue;
            }
        }
        let project = v
            .get("project")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        out.push((ts_unix, date, text, project));
    }
    out.sort_by_key(|e| e.0);
    out
}

/// 取路径最后一段作为项目名
fn basename(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    trimmed
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .to_string()
}

/// 当天第几个 10 分钟（本地时区）
fn bucket_of(ts_unix: i64) -> i64 {
    match Local.timestamp_opt(ts_unix, 0).single() {
        Some(dt) => (dt.hour() as i64 * 60 + dt.minute() as i64) / 10,
        None => 0,
    }
}

/// 行 → MyMessage（列序固定，最后一列 images 为 JSON 数组）
fn map_my_message(row: &rusqlite::Row) -> Result<MyMessage> {
    let images = row
        .get::<_, Option<String>>(11)?
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default();
    Ok(MyMessage {
        session_id: row.get(0)?,
        source_id: row.get(1)?,
        project_name: row.get(2)?,
        project_path: row.get(3)?,
        ts: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
        ts_unix: row.get(5)?,
        local_date: row.get::<_, Option<String>>(6)?.unwrap_or_else(|| "未知".into()),
        text: row.get::<_, Option<String>>(7)?.unwrap_or_default(),
        chars: row.get::<_, Option<i64>>(8)?.unwrap_or(0),
        reply: row.get::<_, Option<String>>(9)?.unwrap_or_default(),
        reply_chars: row.get::<_, Option<i64>>(10)?.unwrap_or(0),
        images,
    })
}

impl SessionStore {
    pub fn open() -> Result<Self> {
        let path = db_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self {
            conn: Mutex::new(conn),
            syncing: AtomicBool::new(false),
        })
    }

    /// 一次完整同步（本机文件系统 + 各远程薄中继）。AtomicBool 防并发重入：
    /// 已有同步在跑则立即返回，绝不阻塞查询命令。供后台循环调用。
    pub fn sync_all(&self, remotes: &[SessionSource]) {
        if self.syncing.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = self.sync_local();
        let _ = self.sync_history(); // 在本机 transcript 之后，cutoff 才准
        for src in remotes {
            // 单个远程失败（离线/超时）不影响其余源与本机
            let _ = self.sync_remote(&src.id, &src.base_url);
        }
        self.syncing.store(false, Ordering::SeqCst);
    }

    /// 后台循环用：读已保存远程源后做一次完整同步
    pub fn sync_tick(&self, db: &crate::db::Database) {
        let remotes = remotes_from_db(db);
        self.sync_all(&remotes);
    }

    pub fn is_syncing(&self) -> bool {
        self.syncing.load(Ordering::Relaxed)
    }

    pub fn total_messages(&self) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))
    }

    /// 远程薄中继增量同步：拉 /raw/list，对变化的文件拉 /raw/file 原始字节后本地解析入库。
    /// 网络请求期间不持有 DB 锁。
    pub fn sync_remote(&self, source_id: &str, base_url: &str) -> Result<()> {
        let client = blocking_client(20);
        let list: RawListResponse = match client
            .get(join_url(base_url, "/raw/list"))
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.json())
        {
            Ok(v) => v,
            Err(_) => return Ok(()), // 离线/出错：跳过，保留已有数据
        };

        let mut seen: Vec<String> = Vec::new();
        for f in &list.files {
            seen.push(f.key.clone());
            let existing: Option<(i64, i64)> = {
                let conn = self.conn.lock().unwrap();
                conn.query_row(
                    "SELECT mtime, size FROM files WHERE source=?1 AND path=?2",
                    params![source_id, f.key],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?
            };
            if existing == Some((f.mtime, f.size)) {
                continue;
            }
            let content = match client
                .get(join_url(base_url, "/raw/file"))
                .query(&[("key", &f.key)])
                .send()
                .and_then(|r| r.error_for_status())
                .and_then(|r| r.text())
            {
                Ok(c) => c,
                Err(_) => continue,
            };
            let conn = self.conn.lock().unwrap();
            ingest(&conn, source_id, &f.session_id, &f.key, &content)?;
            conn.execute(
                "INSERT INTO files(source,path,mtime,size) VALUES(?1,?2,?3,?4) \
                 ON CONFLICT(source,path) DO UPDATE SET mtime=excluded.mtime, size=excluded.size",
                params![source_id, f.key, f.mtime, f.size],
            )?;
        }

        // 清理远程已删除的文件
        let known: Vec<String> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare("SELECT path FROM files WHERE source=?1")?;
            let rows = stmt.query_map(params![source_id], |r| r.get::<_, String>(0))?;
            rows.filter_map(|x| x.ok()).collect()
        };
        for p in known {
            if !seen.contains(&p) {
                let conn = self.conn.lock().unwrap();
                conn.execute(
                    "DELETE FROM messages WHERE source=?1 AND file_path=?2",
                    params![source_id, p],
                )?;
                conn.execute(
                    "DELETE FROM sessions WHERE source=?1 AND file_path=?2",
                    params![source_id, p],
                )?;
                conn.execute(
                    "DELETE FROM files WHERE source=?1 AND path=?2",
                    params![source_id, p],
                )?;
            }
        }
        Ok(())
    }

    /// 远程心跳：连得上且 2xx 即在线
    pub fn ping_remote(base_url: &str) -> bool {
        blocking_client(3)
            .get(join_url(base_url, "/api/ping"))
            .send()
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }

    /// 本机文件系统增量同步
    pub fn sync_local(&self) -> Result<()> {
        let Some(root) = projects_dir() else {
            return Ok(());
        };
        if !root.exists() {
            return Ok(());
        }
        let conn = self.conn.lock().unwrap();
        let mut seen: Vec<String> = Vec::new();

        for dir_entry in std::fs::read_dir(&root).into_iter().flatten().flatten() {
            let dir = dir_entry.path();
            if !dir.is_dir() {
                continue;
            }
            for file_entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
                let fp = file_entry.path();
                if fp.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                    continue;
                }
                let p = fp.to_string_lossy().to_string();
                seen.push(p.clone());

                let Ok(meta) = std::fs::metadata(&fp) else {
                    continue;
                };
                let size = meta.len() as i64;
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);

                let existing: Option<(i64, i64)> = conn
                    .query_row(
                        "SELECT mtime, size FROM files WHERE source=?1 AND path=?2",
                        params![LOCAL_SOURCE, p],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()?;
                if existing == Some((mtime, size)) {
                    continue; // 未变
                }

                let content = std::fs::read_to_string(&fp).unwrap_or_default();
                let session_id = fp
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();
                ingest(&conn, LOCAL_SOURCE, &session_id, &p, &content)?;
                conn.execute(
                    "INSERT INTO files(source,path,mtime,size) VALUES(?1,?2,?3,?4) \
                     ON CONFLICT(source,path) DO UPDATE SET mtime=excluded.mtime, size=excluded.size",
                    params![LOCAL_SOURCE, p, mtime, size],
                )?;
            }
        }

        // 清理已删除的本机文件
        let known: Vec<String> = {
            let mut stmt = conn.prepare("SELECT path FROM files WHERE source=?1")?;
            let rows = stmt.query_map(params![LOCAL_SOURCE], |r| r.get::<_, String>(0))?;
            rows.filter_map(|x| x.ok()).collect()
        };
        for p in known {
            if !seen.contains(&p) {
                conn.execute(
                    "DELETE FROM messages WHERE source=?1 AND file_path=?2",
                    params![LOCAL_SOURCE, p],
                )?;
                conn.execute(
                    "DELETE FROM sessions WHERE source=?1 AND file_path=?2",
                    params![LOCAL_SOURCE, p],
                )?;
                conn.execute(
                    "DELETE FROM files WHERE source=?1 AND path=?2",
                    params![LOCAL_SOURCE, p],
                )?;
            }
        }
        Ok(())
    }

    /// 回填本机输入历史（~/.claude/history.jsonl）为独立源 `history`，
    /// 只补「本机完整 transcript 最早日期之前」的发言，按项目合成会话。
    /// 仅在 cutoff 变化 / 尚无历史数据时重建（新打的 prompt 都在 cutoff 之后，不影响回填集，
    /// 故不必每次打字都重灌 8000+ 行）。
    pub fn sync_history(&self) -> Result<()> {
        let Some(fp) = history_file() else {
            return Ok(());
        };
        if !fp.exists() {
            return Ok(());
        }
        let conn = self.conn.lock().unwrap();

        // cutoff = 本机 transcript 最早日期；history 只回填它之前
        let cutoff: Option<String> = conn
            .query_row(
                "SELECT MIN(local_date) FROM messages WHERE source=?1 AND local_date IS NOT NULL AND local_date!='未知'",
                params![LOCAL_SOURCE],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        let cutoff_key = cutoff.clone().unwrap_or_else(|| "∅".into());

        // 仅 cutoff 变化 / 尚无历史数据时重建
        let marker = get_meta(&conn, "history_cutoff")?;
        let hist_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM messages WHERE source=?1",
            params![HISTORY_SOURCE],
            |r| r.get(0),
        )?;
        if marker.as_deref() == Some(cutoff_key.as_str()) && hist_count > 0 {
            return Ok(());
        }

        let content = std::fs::read_to_string(&fp).unwrap_or_default();
        let entries = parse_history(&content, cutoff.as_deref());
        let hist_path = fp.to_string_lossy().to_string();

        // 整段重建放进单事务（8000+ 行，逐条 commit 会非常慢）
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM messages WHERE source=?1", params![HISTORY_SOURCE])?;
        tx.execute("DELETE FROM sessions WHERE source=?1", params![HISTORY_SOURCE])?;

        use std::collections::HashMap;
        let mut proj_last: HashMap<String, i64> = HashMap::new();
        for (seq, (ts_unix, date, text, project)) in entries.iter().enumerate() {
            let sid = format!("hist:{project}");
            let chars = text.chars().count() as i64;
            tx.execute(
                "INSERT INTO messages(source,session_id,file_path,seq,ts,ts_unix,local_date,text,chars,reply,reply_chars,images) \
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                params![
                    HISTORY_SOURCE, sid, hist_path, seq as i64,
                    local_iso_of(*ts_unix), *ts_unix, date.as_str(), text.as_str(), chars, "", 0i64, "[]"
                ],
            )?;
            let e = proj_last.entry((*project).clone()).or_insert(0);
            if *ts_unix > *e {
                *e = *ts_unix;
            }
        }
        for (project, last_unix) in &proj_last {
            let sid = format!("hist:{project}");
            let pname = basename(project);
            let title = if pname.is_empty() {
                "历史发言".to_string()
            } else {
                format!("历史 · {pname}")
            };
            tx.execute(
                "INSERT INTO sessions(source,session_id,file_path,project_path,project_name,title,git_branch,last_unix) \
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8) \
                 ON CONFLICT(source,session_id) DO UPDATE SET \
                    file_path=excluded.file_path, project_path=excluded.project_path, \
                    project_name=excluded.project_name, title=excluded.title, last_unix=excluded.last_unix",
                params![HISTORY_SOURCE, sid, hist_path, project.as_str(), pname.as_str(), title.as_str(), "", *last_unix],
            )?;
        }
        set_meta(&tx, "history_cutoff", &cutoff_key)?;
        tx.commit()?;
        Ok(())
    }

    /// 发言流：按时间倒序平铺
    pub fn my_messages(
        &self,
        limit: i64,
        offset: i64,
        source: Option<String>,
        session: Option<String>,
        since: Option<i64>,
        until: Option<i64>,
    ) -> Result<(i64, Vec<MyMessage>)> {
        use rusqlite::types::Value;
        let conn = self.conn.lock().unwrap();

        // 动态拼 WHERE：来源 / 单会话 / 时间区间（时间区间用于「1 小时单元格」过滤）
        let mut conds: Vec<&str> = Vec::new();
        let mut args: Vec<Value> = Vec::new();
        if let Some(s) = &source {
            conds.push("m.source = ?");
            args.push(Value::Text(s.clone()));
        }
        if let Some(s) = &session {
            conds.push("m.session_id = ?");
            args.push(Value::Text(s.clone()));
        }
        if let Some(a) = since {
            conds.push("m.ts_unix >= ?");
            args.push(Value::Integer(a));
        }
        if let Some(b) = until {
            conds.push("m.ts_unix <= ?");
            args.push(Value::Integer(b));
        }
        let where_sql = if conds.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conds.join(" AND "))
        };

        let total: i64 = conn.query_row(
            &format!("SELECT COUNT(*) FROM messages m {where_sql}"),
            rusqlite::params_from_iter(args.iter()),
            |r| r.get(0),
        )?;

        let base = "SELECT m.session_id, m.source, COALESCE(s.project_name,''), \
             COALESCE(s.project_path,''), m.ts, m.ts_unix, m.local_date, m.text, m.chars, \
             m.reply, m.reply_chars, m.images FROM messages m \
             LEFT JOIN sessions s ON s.source=m.source AND s.session_id=m.session_id";
        let sql =
            format!("{base} {where_sql} ORDER BY m.ts_unix DESC, m.id DESC LIMIT ? OFFSET ?");
        let mut sel_args = args;
        sel_args.push(Value::Integer(limit));
        sel_args.push(Value::Integer(offset));

        let mut stmt = conn.prepare(&sql)?;
        let mut items = Vec::new();
        for r in stmt.query_map(rusqlite::params_from_iter(sel_args.iter()), map_my_message)? {
            items.push(r?);
        }
        Ok((total, items))
    }

    /// 会话时间轴：某本地日期，每会话一行 + 10 分钟分桶
    pub fn timeline(&self, date: &str, source: Option<String>) -> Result<Vec<TimelineRow>> {
        let conn = self.conn.lock().unwrap();
        let base = "SELECT m.session_id, m.source, COALESCE(s.title,''), \
             COALESCE(s.project_name,''), COALESCE(s.project_path,''), m.ts_unix \
             FROM messages m LEFT JOIN sessions s ON s.source=m.source AND s.session_id=m.session_id \
             WHERE m.local_date=?1 AND m.ts_unix IS NOT NULL";

        // (session_id, source, title, project_name, project_path, ts_unix)
        let collect = |stmt: &mut rusqlite::Statement, p: &[&dyn rusqlite::ToSql]| -> Result<Vec<(String, String, String, String, String, i64)>> {
            let rows = stmt.query_map(p, |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            })?;
            rows.collect()
        };

        let raw: Vec<(String, String, String, String, String, i64)> = match &source {
            Some(s) => {
                let sql = format!("{base} AND m.source=?2 ORDER BY m.ts_unix");
                let mut stmt = conn.prepare(&sql)?;
                collect(&mut stmt, params![date, s])?
            }
            None => {
                let sql = format!("{base} ORDER BY m.ts_unix");
                let mut stmt = conn.prepare(&sql)?;
                collect(&mut stmt, params![date])?
            }
        };

        // 按 (source, session_id) 聚合
        let mut order: Vec<(String, String)> = Vec::new();
        let mut map: std::collections::HashMap<(String, String), TimelineRow> =
            std::collections::HashMap::new();
        let mut buckets: std::collections::HashMap<(String, String), std::collections::HashMap<i64, i64>> =
            std::collections::HashMap::new();

        for (sid, src, title, pname, ppath, ts_unix) in raw {
            let key = (src.clone(), sid.clone());
            let row = map.entry(key.clone()).or_insert_with(|| {
                order.push(key.clone());
                TimelineRow {
                    session_id: sid.clone(),
                    source_id: src.clone(),
                    title: if title.is_empty() {
                        sid.chars().take(8).collect()
                    } else {
                        title.clone()
                    },
                    project_name: pname.clone(),
                    project_path: ppath.clone(),
                    first_unix: Some(ts_unix),
                    last_unix: Some(ts_unix),
                    count: 0,
                    buckets: Vec::new(),
                }
            });
            row.count += 1;
            if row.first_unix.map(|f| ts_unix < f).unwrap_or(true) {
                row.first_unix = Some(ts_unix);
            }
            if row.last_unix.map(|l| ts_unix > l).unwrap_or(true) {
                row.last_unix = Some(ts_unix);
            }
            let b = bucket_of(ts_unix);
            *buckets.entry(key).or_default().entry(b).or_insert(0) += 1;
        }

        let mut out: Vec<TimelineRow> = Vec::new();
        for key in &order {
            let mut row = map.remove(key).unwrap();
            if let Some(bm) = buckets.remove(key) {
                let mut bs: Vec<(i64, i64)> = bm.into_iter().collect();
                bs.sort_by_key(|(b, _)| *b);
                row.buckets = bs
                    .into_iter()
                    .map(|(b, n)| TimelineBucket { b, n })
                    .collect();
            }
            out.push(row);
        }
        out.sort_by_key(|r| r.first_unix.unwrap_or(0));
        Ok(out)
    }

    /// 按天发言统计（可按来源 / 单会话过滤）
    pub fn daily_stats(
        &self,
        source: Option<String>,
        session: Option<String>,
    ) -> Result<Vec<DailyStat>> {
        use rusqlite::types::Value;
        let conn = self.conn.lock().unwrap();
        let mut conds: Vec<&str> = vec!["local_date IS NOT NULL", "local_date != '未知'"];
        let mut args: Vec<Value> = Vec::new();
        if let Some(s) = &source {
            conds.push("source = ?");
            args.push(Value::Text(s.clone()));
        }
        if let Some(sid) = &session {
            conds.push("session_id = ?");
            args.push(Value::Text(sid.clone()));
        }
        let sql = format!(
            "SELECT local_date, COUNT(*), COALESCE(SUM(chars),0) FROM messages \
             WHERE {} GROUP BY local_date ORDER BY local_date",
            conds.join(" AND ")
        );
        let mut stmt = conn.prepare(&sql)?;
        let mut out = Vec::new();
        for r in stmt.query_map(rusqlite::params_from_iter(args.iter()), |row| {
            Ok(DailyStat {
                date: row.get(0)?,
                count: row.get(1)?,
                chars: row.get(2)?,
            })
        })? {
            out.push(r?);
        }
        Ok(out)
    }

    /// 某来源的 (会话数, 项目数)
    pub fn counts(&self, source: &str) -> Result<(i64, i64)> {
        let conn = self.conn.lock().unwrap();
        let sc: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sessions WHERE source=?1",
            params![source],
            |r| r.get(0),
        )?;
        let pc: i64 = conn.query_row(
            "SELECT COUNT(DISTINCT project_path) FROM sessions WHERE source=?1 AND project_path IS NOT NULL AND project_path != ''",
            params![source],
            |r| r.get(0),
        )?;
        Ok((sc, pc))
    }

}

/// 整文件重解析后替换其行（+ 更新会话元信息）
fn ingest(
    conn: &Connection,
    source: &str,
    session_id: &str,
    file_path: &str,
    content: &str,
) -> Result<()> {
    let meta = parse_session(content, session_id);
    let project_name = basename(&meta.cwd);

    conn.execute(
        "DELETE FROM messages WHERE source=?1 AND file_path=?2",
        params![source, file_path],
    )?;
    for (seq, t) in meta.turns.iter().enumerate() {
        let images_json = serde_json::to_string(&t.images).unwrap_or_else(|_| "[]".to_string());
        conn.execute(
            "INSERT INTO messages(source,session_id,file_path,seq,ts,ts_unix,local_date,text,chars,reply,reply_chars,images) \
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![
                source,
                session_id,
                file_path,
                seq as i64,
                t.ts,
                t.ts_unix,
                t.local_date,
                t.text,
                t.chars,
                t.reply,
                t.reply_chars,
                images_json
            ],
        )?;
    }
    conn.execute(
        "INSERT INTO sessions(source,session_id,file_path,project_path,project_name,title,git_branch,last_unix) \
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8) \
         ON CONFLICT(source,session_id) DO UPDATE SET \
            file_path=excluded.file_path, project_path=excluded.project_path, \
            project_name=excluded.project_name, title=excluded.title, \
            git_branch=excluded.git_branch, last_unix=excluded.last_unix",
        params![
            source,
            session_id,
            file_path,
            meta.cwd,
            project_name,
            meta.title,
            meta.git_branch,
            meta.last_unix
        ],
    )?;
    Ok(())
}

// ---------- Tauri 命令（异步 + spawn_blocking 跑阻塞的 fs/sqlite） ----------

#[derive(Serialize)]
pub struct MyMessagesResponse {
    pub total: i64,
    pub offset: i64,
    pub limit: i64,
    pub items: Vec<MyMessage>,
}

#[derive(Serialize)]
pub struct TimelineResponse {
    pub date: String,
    pub sessions: Vec<TimelineRow>,
}

#[derive(Serialize)]
pub struct StatsResponse {
    pub days: Vec<DailyStat>,
}

#[derive(Serialize)]
pub struct SourceStatus {
    pub id: String,
    pub label: String,
    pub online: bool,
    pub hostname: String,
    pub os: String,
    pub session_count: i64,
    pub project_count: i64,
}

fn local_hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_default()
}

/// 读取已保存的远程源列表（过滤掉保留 id `local`：本机是隐式源，
/// 历史脏数据里可能残留一条 id=local 的"本机"，会导致重复采集 + 双芯片）
fn remotes_from_db(db: &crate::db::Database) -> Vec<SessionSource> {
    let list: Vec<SessionSource> = match db.get_setting("session_sources") {
        Ok(Some(json)) => serde_json::from_str(&json).unwrap_or_default(),
        _ => Vec::new(),
    };
    list.into_iter().filter(|s| s.id != LOCAL_SOURCE).collect()
}

#[tauri::command]
pub fn session_sources_get(state: State<AppState>) -> Vec<SessionSource> {
    remotes_from_db(&state.db)
}

#[tauri::command]
pub fn session_sources_save(
    sources: Vec<SessionSource>,
    state: State<AppState>,
) -> Result<(), String> {
    let json = serde_json::to_string(&sources).map_err(|e| e.to_string())?;
    state
        .db
        .set_setting("session_sources", &json)
        .map_err(|e| e.to_string())
}

/// 读取本机的「预备发言/待办」清单（独立表 session_drafts，按 created_unix 倒序）。
#[tauri::command]
pub fn session_drafts_get(state: State<AppState>) -> Vec<SessionDraft> {
    state.db.drafts_list().unwrap_or_default()
}

/// 新增或更新一条待办（按行 upsert，只动这一行——不会整表覆盖）。
#[tauri::command]
pub fn session_draft_upsert(draft: SessionDraft, state: State<AppState>) -> Result<(), String> {
    state.db.draft_upsert(&draft).map_err(|e| e.to_string())
}

/// 删除一条待办（按 id，只动这一行）。
#[tauri::command]
pub fn session_draft_delete(id: String, state: State<AppState>) -> Result<(), String> {
    state.db.draft_delete(&id).map_err(|e| e.to_string())
}

/// 把一条「预备发言」推送到 claude启动器的队列，由启动器进入该会话时逐字符打入输入框。
/// - 本机会话（source_id 为空/local）：直接写 `~/.claude/launcher_queue.json`（不依赖中继是否在跑）。
/// - 远程会话：POST 到该来源中继的 `/queue/push`，由中继写它本机的同名队列文件。
#[tauri::command]
pub async fn session_draft_push(
    state: State<'_, AppState>,
    draft: SessionDraft,
) -> Result<(), String> {
    let session_id = draft
        .session_id
        .clone()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "该待办未挂靠会话，无法推送到启动器".to_string())?;
    let text = draft.text.clone();
    if text.trim().is_empty() {
        return Err("待办内容为空".to_string());
    }
    let draft_id = draft.id.clone();
    let source = draft.source_id.clone();
    let db = state.db.clone();

    tokio::task::spawn_blocking(move || {
        let is_local = matches!(source.as_deref(), None | Some("") | Some(LOCAL_SOURCE));
        if is_local {
            push_local_queue(&session_id, &draft_id, &text)
        } else {
            let src = source.unwrap_or_default();
            let base = remotes_from_db(&db)
                .into_iter()
                .find(|s| s.id == src)
                .map(|s| s.base_url)
                .ok_or_else(|| format!("未找到来源 {src} 的中继地址"))?;
            push_remote_queue(&base, &session_id, &draft_id, &text)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn launcher_queue_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join(".claude").join("launcher_queue.json"))
        .ok_or_else(|| "无法定位用户主目录".to_string())
}

/// 本机直写队列文件：读改写 + 临时文件 rename 原子替换；同 draft_id 去重。
fn push_local_queue(session_id: &str, draft_id: &str, text: &str) -> Result<(), String> {
    let path = launcher_queue_path()?;
    if let Some(p) = path.parent() {
        let _ = std::fs::create_dir_all(p);
    }
    let mut root: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .filter(|v: &serde_json::Value| v.get("queue").map(|q| q.is_object()).unwrap_or(false))
        .unwrap_or_else(|| serde_json::json!({ "version": 1, "queue": {} }));

    let queue = root
        .get_mut("queue")
        .and_then(|q| q.as_object_mut())
        .ok_or("队列结构损坏")?;
    let arr = queue
        .entry(session_id.to_string())
        .or_insert_with(|| serde_json::json!([]));
    let list = arr.as_array_mut().ok_or("队列结构损坏")?;
    list.retain(|it| it.get("id").and_then(|v| v.as_str()) != Some(draft_id));
    list.push(serde_json::json!({ "id": draft_id, "text": text }));

    let body = serde_json::to_string(&root).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| format!("写入队列失败: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("替换队列失败: {e}"))?;
    Ok(())
}

/// 远程：POST 到中继 /queue/push（局域网，不走代理）。
fn push_remote_queue(
    base_url: &str,
    session_id: &str,
    draft_id: &str,
    text: &str,
) -> Result<(), String> {
    let url = join_url(base_url, "/queue/push");
    let client = blocking_client(5);
    let resp = client
        .post(&url)
        .json(&serde_json::json!({ "session_id": session_id, "id": draft_id, "text": text }))
        .send()
        .map_err(|e| format!("推送到中继失败（对方启动器可能未运行）: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("中继返回 {}", resp.status()));
    }
    Ok(())
}

#[tauri::command]
pub async fn session_my_messages(
    state: State<'_, AppState>,
    limit: Option<i64>,
    offset: Option<i64>,
    source: Option<String>,
    session: Option<String>,
    since: Option<i64>,
    until: Option<i64>,
) -> Result<MyMessagesResponse, String> {
    let store = state.sessions.clone();
    let limit = limit.unwrap_or(400).clamp(1, 5000);
    let offset = offset.unwrap_or(0).max(0);
    let (total, items) = tokio::task::spawn_blocking(move || {
        store.my_messages(limit, offset, source, session, since, until)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    Ok(MyMessagesResponse {
        total,
        offset,
        limit,
        items,
    })
}

#[tauri::command]
pub async fn session_timeline(
    state: State<'_, AppState>,
    date: Option<String>,
    source: Option<String>,
) -> Result<TimelineResponse, String> {
    let store = state.sessions.clone();
    let date = date
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| Local::now().format("%Y-%m-%d").to_string());
    let d = date.clone();
    let sessions = tokio::task::spawn_blocking(move || {
        store.timeline(&d, source)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    Ok(TimelineResponse { date, sessions })
}

#[tauri::command]
pub async fn session_stats(
    state: State<'_, AppState>,
    source: Option<String>,
    session: Option<String>,
) -> Result<StatsResponse, String> {
    let store = state.sessions.clone();
    let days = tokio::task::spawn_blocking(move || {
        store.daily_stats(source, session)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    Ok(StatsResponse { days })
}

#[tauri::command]
pub async fn session_status(state: State<'_, AppState>) -> Result<Vec<SourceStatus>, String> {
    let store = state.sessions.clone();
    let db = state.db.clone();
    tokio::task::spawn_blocking(move || {
        let remotes = remotes_from_db(&db);

        let (sc, pc) = store.counts(LOCAL_SOURCE).unwrap_or((0, 0));
        let mut out = vec![SourceStatus {
            id: LOCAL_SOURCE.to_string(),
            label: "本机".to_string(),
            online: true,
            hostname: local_hostname(),
            os: "windows".to_string(),
            session_count: sc,
            project_count: pc,
        }];
        // 本机·历史（输入历史回填，仅当有数据时出现）
        let (hsc, hpc) = store.counts(HISTORY_SOURCE).unwrap_or((0, 0));
        if hsc > 0 {
            out.push(SourceStatus {
                id: HISTORY_SOURCE.to_string(),
                label: "本机·历史".to_string(),
                online: true,
                hostname: local_hostname(),
                os: "windows".to_string(),
                session_count: hsc,
                project_count: hpc,
            });
        }
        for s in remotes {
            let online = SessionStore::ping_remote(&s.base_url);
            let (rsc, rpc) = if online {
                store.counts(&s.id).unwrap_or((0, 0))
            } else {
                (0, 0)
            };
            out.push(SourceStatus {
                id: s.id,
                label: s.label,
                online,
                hostname: String::new(),
                os: String::new(),
                session_count: rsc,
                project_count: rpc,
            });
        }
        Ok::<Vec<SourceStatus>, String>(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct SyncState {
    pub syncing: bool,
    pub total: i64,
}

/// 读取本机图片文件转 data URL（供 [Image #N] 悬浮预览）
#[tauri::command]
pub async fn session_image(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let ext = std::path::Path::new(&path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        let mime = match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            "svg" => "image/svg+xml",
            _ => return Err(format!("不支持的图片类型: {ext}")),
        };
        let bytes = std::fs::read(&path).map_err(|e| format!("读取失败: {e}"))?;
        if bytes.len() > 25 * 1024 * 1024 {
            return Err("图片过大（>25MB）".to_string());
        }
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        Ok::<String, String>(format!("data:{mime};base64,{b64}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_sync_state(state: State<'_, AppState>) -> Result<SyncState, String> {
    let store = state.sessions.clone();
    tokio::task::spawn_blocking(move || {
        let total = store.total_messages().unwrap_or(0);
        Ok::<SyncState, String>(SyncState {
            syncing: store.is_syncing(),
            total,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
