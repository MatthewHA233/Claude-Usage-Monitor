use crate::models::{AccountColor, InboxItem, UsageSnapshot};
use rusqlite::{Connection, Result, params};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

/// 根据账号名哈希确定性地从调色板选色（新账号自动分配）
fn color_for_alias(alias: &str) -> String {
    const PALETTE: &[&str] = &[
        "#cc785c", "#4a9eff", "#4ade80", "#f472b6", "#a78bfa",
        "#fb923c", "#34d399", "#60a5fa", "#f87171", "#facc15",
        "#38bdf8", "#e879f9", "#a3e635", "#fb7185", "#67e8f9",
    ];
    let hash: usize = alias
        .bytes()
        .fold(5381usize, |acc, b| acc.wrapping_mul(31).wrapping_add(b as usize));
    PALETTE[hash % PALETTE.len()].to_string()
}

fn db_path() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("claude-switch")
        .join("usage.db")
}

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    pub fn open() -> Result<Self> {
        let path = db_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let conn = Connection::open(&path)?;
        let db = Self { conn: Mutex::new(conn) };
        db.migrate()?;
        db.normalize_pct_scale()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch("
            CREATE TABLE IF NOT EXISTS usage_snapshots (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                account_alias    TEXT    NOT NULL,
                collected_at     TEXT    NOT NULL,
                session_pct      REAL,
                session_reset_at TEXT,
                weekly_pct       REAL,
                weekly_reset_at  TEXT,
                error            TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_snap_alias_time
                ON usage_snapshots(account_alias, collected_at DESC);
            CREATE TABLE IF NOT EXISTS account_colors (
                alias TEXT PRIMARY KEY,
                color TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS filtered_inbox (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                account_alias    TEXT    NOT NULL,
                collected_at     TEXT    NOT NULL,
                session_pct      REAL,
                session_reset_at TEXT,
                weekly_pct       REAL,
                weekly_reset_at  TEXT,
                filter_reason    TEXT    NOT NULL,
                created_at       TEXT    NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_inbox_alias_id
                ON filtered_inbox(account_alias, id DESC);
        ")?;
        Ok(())
    }

    /// 将历史遗留的 0-1 小数百分比一次性修正为 0-100
    /// 判断条件：session_pct 和 weekly_pct 都 < 1.5（真实百分比不可能两个都 <1.5%）
    fn normalize_pct_scale(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch("
            UPDATE usage_snapshots
            SET session_pct = session_pct * 100,
                weekly_pct  = weekly_pct  * 100
            WHERE session_pct IS NOT NULL
              AND weekly_pct  IS NOT NULL
              AND session_pct < 1.5
              AND weekly_pct  < 1.5;
        ")?;
        Ok(())
    }

    /// 获取某账号最新一条快照（用于去重判断）
    pub fn last_snapshot(&self, alias: &str) -> Result<Option<UsageSnapshot>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, account_alias, collected_at,
                    session_pct, session_reset_at,
                    weekly_pct, weekly_reset_at, error
             FROM usage_snapshots
             WHERE account_alias = ?1
             ORDER BY collected_at DESC
             LIMIT 1",
        )?;
        let mut rows = stmt.query_map(params![alias], row_to_snapshot)?;
        Ok(rows.next().transpose()?)
    }

    pub fn insert_snapshot(&self, snap: &UsageSnapshot) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO usage_snapshots
             (account_alias, collected_at, session_pct, session_reset_at,
              weekly_pct, weekly_reset_at, error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                snap.account_alias,
                snap.collected_at,
                snap.session_pct,
                snap.session_reset_at,
                snap.weekly_pct,
                snap.weekly_reset_at,
                snap.error,
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// 获取某账号的历史记录，最新在前，支持分页
    pub fn history(&self, alias: &str, limit: i64, offset: i64) -> Result<Vec<UsageSnapshot>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, account_alias, collected_at,
                    session_pct, session_reset_at,
                    weekly_pct, weekly_reset_at, error
             FROM usage_snapshots
             WHERE account_alias = ?1
             ORDER BY collected_at DESC
             LIMIT ?2 OFFSET ?3",
        )?;
        let rows = stmt.query_map(params![alias, limit, offset], row_to_snapshot)?;
        rows.collect()
    }

    /// 删除指定 id 的快照记录
    pub fn delete_snapshot(&self, id: i64) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        let affected = conn.execute("DELETE FROM usage_snapshots WHERE id = ?1", params![id])?;
        Ok(affected)
    }

    /// 获取所有账号的颜色配置
    pub fn get_all_colors(&self) -> Result<Vec<AccountColor>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT alias, color FROM account_colors ORDER BY alias")?;
        let rows = stmt.query_map([], |row| {
            Ok(AccountColor { alias: row.get(0)?, color: row.get(1)? })
        })?;
        rows.collect()
    }

    /// 设置账号颜色（不存在则插入，存在则更新）
    pub fn set_color(&self, alias: &str, color: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO account_colors (alias, color) VALUES (?1, ?2)
             ON CONFLICT(alias) DO UPDATE SET color = excluded.color",
            params![alias, color],
        )?;
        Ok(())
    }

    /// 为还没有颜色的账号自动分配（基于哈希，幂等）
    pub fn ensure_colors_for_aliases(&self, aliases: &[String]) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        for alias in aliases {
            let color = color_for_alias(alias);
            conn.execute(
                "INSERT OR IGNORE INTO account_colors (alias, color) VALUES (?1, ?2)",
                params![alias, color],
            )?;
        }
        Ok(())
    }

    /// 获取所有账号的历史记录（每账号最多 limit 条，最新在前）
    pub fn all_histories_grouped(&self, limit: i64) -> Result<HashMap<String, Vec<UsageSnapshot>>> {
        let aliases: Vec<String> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare(
                "SELECT DISTINCT account_alias FROM usage_snapshots ORDER BY account_alias",
            )?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>>>()?
        };
        let mut result = HashMap::new();
        for alias in aliases {
            let records = self.history(&alias, limit, 0)?;
            result.insert(alias, records);
        }
        Ok(result)
    }

    /// 写入收件箱并维持每账号最多 10 条 FIFO
    pub fn inbox_insert(&self, snap: &UsageSnapshot, reason: &str) -> Result<i64> {
        const PER_ALIAS_CAP: i64 = 10;
        let conn = self.conn.lock().unwrap();
        let created_at = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO filtered_inbox
             (account_alias, collected_at, session_pct, session_reset_at,
              weekly_pct, weekly_reset_at, filter_reason, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                snap.account_alias,
                snap.collected_at,
                snap.session_pct,
                snap.session_reset_at,
                snap.weekly_pct,
                snap.weekly_reset_at,
                reason,
                created_at,
            ],
        )?;
        let new_id = conn.last_insert_rowid();
        conn.execute(
            "DELETE FROM filtered_inbox
             WHERE account_alias = ?1
               AND id NOT IN (
                   SELECT id FROM filtered_inbox
                   WHERE account_alias = ?1
                   ORDER BY id DESC
                   LIMIT ?2
               )",
            params![snap.account_alias, PER_ALIAS_CAP],
        )?;
        Ok(new_id)
    }

    pub fn inbox_list(&self) -> Result<Vec<InboxItem>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, account_alias, collected_at,
                    session_pct, session_reset_at,
                    weekly_pct, weekly_reset_at,
                    filter_reason, created_at
             FROM filtered_inbox
             ORDER BY id DESC",
        )?;
        let rows = stmt.query_map([], row_to_inbox)?;
        rows.collect()
    }

    pub fn inbox_get(&self, id: i64) -> Result<Option<InboxItem>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, account_alias, collected_at,
                    session_pct, session_reset_at,
                    weekly_pct, weekly_reset_at,
                    filter_reason, created_at
             FROM filtered_inbox
             WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], row_to_inbox)?;
        Ok(rows.next().transpose()?)
    }

    pub fn inbox_delete(&self, id: i64) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        let affected = conn.execute("DELETE FROM filtered_inbox WHERE id = ?1", params![id])?;
        Ok(affected)
    }

    /// 获取数据库中所有账号各自最新一条（不依赖 config）
    pub fn latest_all(&self) -> Result<Vec<UsageSnapshot>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, account_alias, collected_at,
                    session_pct, session_reset_at,
                    weekly_pct, weekly_reset_at, error
             FROM usage_snapshots
             WHERE id IN (
                 SELECT MAX(id) FROM usage_snapshots GROUP BY account_alias
             )
             ORDER BY account_alias",
        )?;
        let rows = stmt.query_map([], row_to_snapshot)?;
        rows.collect()
    }
}

fn row_to_snapshot(row: &rusqlite::Row<'_>) -> Result<UsageSnapshot> {
    Ok(UsageSnapshot {
        id: Some(row.get(0)?),
        account_alias: row.get(1)?,
        collected_at: row.get(2)?,
        session_pct: row.get(3)?,
        session_reset_at: row.get(4)?,
        weekly_pct: row.get(5)?,
        weekly_reset_at: row.get(6)?,
        error: row.get(7)?,
    })
}

fn row_to_inbox(row: &rusqlite::Row<'_>) -> Result<InboxItem> {
    Ok(InboxItem {
        id: Some(row.get(0)?),
        account_alias: row.get(1)?,
        collected_at: row.get(2)?,
        session_pct: row.get(3)?,
        session_reset_at: row.get(4)?,
        weekly_pct: row.get(5)?,
        weekly_reset_at: row.get(6)?,
        filter_reason: row.get(7)?,
        created_at: row.get(8)?,
    })
}
