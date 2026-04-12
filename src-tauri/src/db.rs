use crate::models::UsageSnapshot;
use rusqlite::{Connection, Result, params};
use std::path::PathBuf;
use std::sync::Mutex;

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

    /// 获取某账号的历史记录，最新在前
    pub fn history(&self, alias: &str, limit: i64) -> Result<Vec<UsageSnapshot>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, account_alias, collected_at,
                    session_pct, session_reset_at,
                    weekly_pct, weekly_reset_at, error
             FROM usage_snapshots
             WHERE account_alias = ?1
             ORDER BY collected_at DESC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![alias, limit], row_to_snapshot)?;
        rows.collect()
    }

    /// 删除指定 id 的快照记录
    pub fn delete_snapshot(&self, id: i64) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        let affected = conn.execute("DELETE FROM usage_snapshots WHERE id = ?1", params![id])?;
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
