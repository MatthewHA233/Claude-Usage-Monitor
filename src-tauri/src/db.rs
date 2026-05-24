use crate::models::{
    AccountColor, AccountPauseState, InboxItem, LocalUsageStatus, TokenUsageDay,
    TokenUsageFileCache, UsageSnapshot,
};
use rusqlite::{params, Connection, Result};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const APP_DATA_DIR: &str = "claude-usage-monitor";
const LEGACY_DATA_DIR: &str = "claude-switch";
const GENERIC_PLAN_ALIASES: &[&str] = &[
    "pro",
    "max",
    "team",
    "enterprise",
    "free",
    "claude pro",
    "claude max",
    "claude team",
    "claude enterprise",
    "claude free",
];

/// 根据账号名哈希确定性地从调色板选色（新账号自动分配）
fn color_for_alias(alias: &str) -> String {
    const PALETTE: &[&str] = &[
        "#cc785c", "#4a9eff", "#4ade80", "#f472b6", "#a78bfa", "#fb923c", "#34d399", "#60a5fa",
        "#f87171", "#facc15", "#38bdf8", "#e879f9", "#a3e635", "#fb7185", "#67e8f9",
    ];
    let hash: usize = alias.bytes().fold(5381usize, |acc, b| {
        acc.wrapping_mul(31).wrapping_add(b as usize)
    });
    PALETTE[hash % PALETTE.len()].to_string()
}

fn db_path() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP_DATA_DIR)
        .join("usage.db")
}

fn legacy_db_path() -> Option<PathBuf> {
    dirs::data_local_dir().map(|base| base.join(LEGACY_DATA_DIR).join("usage.db"))
}

fn migrate_legacy_data_dir() {
    let Some(base) = dirs::data_local_dir() else {
        return;
    };
    let legacy_dir = base.join(LEGACY_DATA_DIR);
    let app_dir = base.join(APP_DATA_DIR);
    if app_dir.exists() || !legacy_dir.exists() {
        return;
    }
    let _ = copy_dir_recursive(&legacy_dir, &app_dir);
}

fn copy_dir_recursive(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let dest = to.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &dest)?;
        } else if file_type.is_file() && !dest.exists() {
            std::fs::copy(entry.path(), dest)?;
        }
    }
    Ok(())
}

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    pub fn open() -> Result<Self> {
        migrate_legacy_data_dir();
        let path = db_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let conn = Connection::open(&path)?;
        let db = Self {
            conn: Mutex::new(conn),
        };
        db.migrate()?;
        db.import_legacy_database()?;
        db.normalize_pct_scale()?;
        db.normalize_codex_pro_scale()?;
        db.merge_generic_plan_aliases()?;
        db.dedupe_consecutive_snapshots()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS usage_snapshots (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                provider         TEXT    NOT NULL DEFAULT 'claude_code',
                account_alias    TEXT    NOT NULL,
                collected_at     TEXT    NOT NULL,
                session_pct      REAL,
                session_total_pct REAL DEFAULT 100,
                session_reset_at TEXT,
                weekly_pct       REAL,
                weekly_total_pct REAL DEFAULT 100,
                weekly_reset_at  TEXT,
                error            TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_snap_alias_time
                ON usage_snapshots(provider, account_alias, collected_at DESC);
            CREATE TABLE IF NOT EXISTS account_colors (
                alias TEXT PRIMARY KEY,
                color TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS account_pause_states (
                account_key   TEXT PRIMARY KEY,
                provider      TEXT    NOT NULL,
                account_alias TEXT    NOT NULL,
                paused        INTEGER NOT NULL DEFAULT 0,
                paused_at     TEXT
            );
            CREATE TABLE IF NOT EXISTS filtered_inbox (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                provider         TEXT    NOT NULL DEFAULT 'claude_code',
                account_alias    TEXT    NOT NULL,
                collected_at     TEXT    NOT NULL,
                session_pct      REAL,
                session_total_pct REAL DEFAULT 100,
                session_reset_at TEXT,
                weekly_pct       REAL,
                weekly_total_pct REAL DEFAULT 100,
                weekly_reset_at  TEXT,
                filter_reason    TEXT    NOT NULL,
                created_at       TEXT    NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_inbox_alias_id
                ON filtered_inbox(provider, account_alias, id DESC);
            CREATE TABLE IF NOT EXISTS token_usage_files (
                path          TEXT PRIMARY KEY,
                provider      TEXT    NOT NULL,
                modified_unix INTEGER NOT NULL,
                size          INTEGER NOT NULL,
                days_json     TEXT    NOT NULL,
                scanned_at    TEXT    NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_token_usage_files_provider
                ON token_usage_files(provider);
            CREATE TABLE IF NOT EXISTS token_usage_days (
                provider      TEXT    NOT NULL,
                date          TEXT    NOT NULL,
                input_tokens  INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                total_tokens  INTEGER NOT NULL DEFAULT 0,
                cost_usd      REAL,
                models_json   TEXT    NOT NULL,
                updated_at    TEXT    NOT NULL,
                PRIMARY KEY (provider, date)
            );
            CREATE INDEX IF NOT EXISTS idx_token_usage_days_date
                ON token_usage_days(date DESC);
            CREATE TABLE IF NOT EXISTS local_usage_status (
                provider      TEXT PRIMARY KEY,
                account_alias TEXT,
                ok            INTEGER NOT NULL,
                message       TEXT    NOT NULL,
                updated_at    TEXT    NOT NULL
            );
        ",
        )?;
        drop(conn);
        self.add_column_if_missing(
            "usage_snapshots",
            "provider",
            "TEXT NOT NULL DEFAULT 'claude_code'",
        )?;
        self.add_column_if_missing("usage_snapshots", "session_total_pct", "REAL DEFAULT 100")?;
        self.add_column_if_missing("usage_snapshots", "weekly_total_pct", "REAL DEFAULT 100")?;
        self.add_column_if_missing(
            "filtered_inbox",
            "provider",
            "TEXT NOT NULL DEFAULT 'claude_code'",
        )?;
        self.add_column_if_missing("filtered_inbox", "session_total_pct", "REAL DEFAULT 100")?;
        self.add_column_if_missing("filtered_inbox", "weekly_total_pct", "REAL DEFAULT 100")?;
        self.add_column_if_missing("local_usage_status", "account_alias", "TEXT")?;
        Ok(())
    }

    pub fn set_local_usage_status(
        &self,
        provider: &str,
        account_alias: Option<&str>,
        ok: bool,
        message: &str,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO local_usage_status (provider, account_alias, ok, message, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(provider) DO UPDATE SET
                account_alias = excluded.account_alias,
                ok = excluded.ok,
                message = excluded.message,
                updated_at = excluded.updated_at",
            params![
                provider,
                account_alias,
                if ok { 1 } else { 0 },
                message,
                chrono::Utc::now().to_rfc3339()
            ],
        )?;
        Ok(())
    }

    pub fn local_usage_statuses(&self) -> Result<Vec<LocalUsageStatus>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT provider, account_alias, ok, message, updated_at
             FROM local_usage_status
             ORDER BY provider",
        )?;
        let rows = stmt.query_map([], |row| {
            let ok_int: i64 = row.get(2)?;
            Ok(LocalUsageStatus {
                provider: row.get(0)?,
                account_alias: row.get(1)?,
                ok: ok_int != 0,
                message: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })?;
        rows.collect()
    }

    pub fn email_aliases(&self, provider: &str) -> Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT account_alias
             FROM (
                 SELECT account_alias, MAX(collected_at) AS last_seen
                 FROM usage_snapshots
                 WHERE provider = ?1
                   AND account_alias LIKE '%@%'
                 GROUP BY account_alias
             )
             ORDER BY last_seen DESC",
        )?;
        let rows = stmt.query_map(params![provider], |row| row.get::<_, String>(0))?;
        rows.collect()
    }

    pub fn token_file_cache(&self, path: &str) -> Result<Option<TokenUsageFileCache>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT path, provider, modified_unix, size, days_json
             FROM token_usage_files
             WHERE path = ?1",
        )?;
        let mut rows = stmt.query_map(params![path], |row| {
            Ok(TokenUsageFileCache {
                path: row.get(0)?,
                provider: row.get(1)?,
                modified_unix: row.get(2)?,
                size: row.get(3)?,
                days_json: row.get(4)?,
            })
        })?;
        Ok(rows.next().transpose()?)
    }

    pub fn upsert_token_file_cache(&self, cache: &TokenUsageFileCache) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO token_usage_files
             (path, provider, modified_unix, size, days_json, scanned_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(path) DO UPDATE SET
                provider = excluded.provider,
                modified_unix = excluded.modified_unix,
                size = excluded.size,
                days_json = excluded.days_json,
                scanned_at = excluded.scanned_at",
            params![
                cache.path,
                cache.provider,
                cache.modified_unix,
                cache.size,
                cache.days_json,
                chrono::Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn token_file_caches(&self) -> Result<Vec<TokenUsageFileCache>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT path, provider, modified_unix, size, days_json
             FROM token_usage_files",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(TokenUsageFileCache {
                path: row.get(0)?,
                provider: row.get(1)?,
                modified_unix: row.get(2)?,
                size: row.get(3)?,
                days_json: row.get(4)?,
            })
        })?;
        rows.collect()
    }

    pub fn upsert_token_usage_day(&self, day: &TokenUsageDay) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let models_json = serde_json::to_string(&day.models)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        conn.execute(
            "INSERT INTO token_usage_days
             (provider, date, input_tokens, cache_read_tokens, cache_creation_tokens,
              output_tokens, total_tokens, cost_usd, models_json, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(provider, date) DO UPDATE SET
                input_tokens = excluded.input_tokens,
                cache_read_tokens = excluded.cache_read_tokens,
                cache_creation_tokens = excluded.cache_creation_tokens,
                output_tokens = excluded.output_tokens,
                total_tokens = excluded.total_tokens,
                cost_usd = excluded.cost_usd,
                models_json = excluded.models_json,
                updated_at = excluded.updated_at",
            params![
                day.provider,
                day.date,
                day.input_tokens,
                day.cache_read_tokens,
                day.cache_creation_tokens,
                day.output_tokens,
                day.total_tokens,
                day.cost_usd,
                models_json,
                chrono::Utc::now().to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn delete_token_usage_days_between(&self, since: &str, until: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM token_usage_days WHERE date >= ?1 AND date <= ?2",
            params![since, until],
        )?;
        Ok(())
    }

    pub fn token_usage_days(&self, since: &str, until: &str) -> Result<Vec<TokenUsageDay>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT provider, date, input_tokens, cache_read_tokens, cache_creation_tokens,
                    output_tokens, total_tokens, cost_usd, models_json
             FROM token_usage_days
             WHERE date >= ?1 AND date <= ?2
             ORDER BY date DESC, provider",
        )?;
        let rows = stmt.query_map(params![since, until], |row| {
            let models_json: String = row.get(8)?;
            let models = serde_json::from_str(&models_json).unwrap_or_default();
            Ok(TokenUsageDay {
                provider: row.get(0)?,
                date: row.get(1)?,
                input_tokens: row.get(2)?,
                cache_read_tokens: row.get(3)?,
                cache_creation_tokens: row.get(4)?,
                output_tokens: row.get(5)?,
                total_tokens: row.get(6)?,
                cost_usd: row.get(7)?,
                models,
            })
        })?;
        rows.collect()
    }

    pub fn get_pause_states(&self) -> Result<Vec<AccountPauseState>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT provider, account_alias, account_key, paused, paused_at
             FROM account_pause_states
             ORDER BY provider, account_alias",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(AccountPauseState {
                provider: row.get(0)?,
                account_alias: row.get(1)?,
                account_key: row.get(2)?,
                paused: row.get::<_, i64>(3)? != 0,
                paused_at: row.get(4)?,
            })
        })?;
        rows.collect()
    }

    pub fn set_account_paused(&self, provider: &str, alias: &str, paused: bool) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let account_key = format!("{provider}::{alias}");
        let paused_at = paused.then(|| chrono::Utc::now().to_rfc3339());
        conn.execute(
            "INSERT INTO account_pause_states
             (account_key, provider, account_alias, paused, paused_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(account_key) DO UPDATE SET
                provider = excluded.provider,
                account_alias = excluded.account_alias,
                paused = excluded.paused,
                paused_at = excluded.paused_at",
            params![
                account_key,
                provider,
                alias,
                if paused { 1 } else { 0 },
                paused_at
            ],
        )?;
        Ok(())
    }

    pub fn paused_account_keys(&self) -> Result<HashSet<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT account_key FROM account_pause_states WHERE paused != 0")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect()
    }

    fn add_column_if_missing(&self, table: &str, column: &str, definition: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
        let columns = stmt.query_map([], |row| row.get::<_, String>(1))?;
        for existing in columns {
            if existing? == column {
                return Ok(());
            }
        }
        conn.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {definition};"
        ))?;
        Ok(())
    }

    /// 将历史遗留的 0-1 小数百分比一次性修正为 0-100
    /// 判断条件：session_pct 和 weekly_pct 都 < 1.5（真实百分比不可能两个都 <1.5%）
    fn normalize_pct_scale(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "
            UPDATE usage_snapshots
            SET session_pct = session_pct * 100,
                weekly_pct  = weekly_pct  * 100
            WHERE session_pct IS NOT NULL
              AND weekly_pct  IS NOT NULL
              AND session_pct < 1.5
              AND weekly_pct  < 1.5;
        ",
        )?;
        Ok(())
    }

    /// Codex GPT Pro is a 5x quota. Older builds stored Codex Pro as 10x.
    fn normalize_codex_pro_scale(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "
            UPDATE usage_snapshots
            SET session_pct = CASE
                    WHEN session_total_pct = 1000 AND session_pct IS NOT NULL THEN session_pct * 0.5
                    WHEN session_total_pct = 100 AND session_pct IS NOT NULL THEN session_pct * 5
                    ELSE session_pct
                END,
                session_total_pct = 500
            WHERE provider = 'codex'
              AND session_total_pct IN (100, 1000);

            UPDATE usage_snapshots
            SET weekly_pct = CASE
                    WHEN weekly_total_pct = 1000 AND weekly_pct IS NOT NULL THEN weekly_pct * 0.5
                    WHEN weekly_total_pct = 100 AND weekly_pct IS NOT NULL THEN weekly_pct * 5
                    ELSE weekly_pct
                END,
                weekly_total_pct = 500
            WHERE provider = 'codex'
              AND weekly_total_pct IN (100, 1000);

            UPDATE filtered_inbox
            SET session_pct = CASE
                    WHEN session_total_pct = 1000 AND session_pct IS NOT NULL THEN session_pct * 0.5
                    WHEN session_total_pct = 100 AND session_pct IS NOT NULL THEN session_pct * 5
                    ELSE session_pct
                END,
                session_total_pct = 500
            WHERE provider = 'codex'
              AND session_total_pct IN (100, 1000);

            UPDATE filtered_inbox
            SET weekly_pct = CASE
                    WHEN weekly_total_pct = 1000 AND weekly_pct IS NOT NULL THEN weekly_pct * 0.5
                    WHEN weekly_total_pct = 100 AND weekly_pct IS NOT NULL THEN weekly_pct * 5
                    ELSE weekly_pct
                END,
                weekly_total_pct = 500
            WHERE provider = 'codex'
              AND weekly_total_pct IN (100, 1000);
        ",
        )?;
        Ok(())
    }

    fn import_legacy_database(&self) -> Result<()> {
        let Some(legacy_path) = legacy_db_path() else {
            return Ok(());
        };
        if !legacy_path.exists() {
            return Ok(());
        }

        if let (Ok(current), Ok(legacy)) = (
            std::fs::canonicalize(db_path()),
            std::fs::canonicalize(&legacy_path),
        ) {
            if current == legacy {
                return Ok(());
            }
        }

        let conn = self.conn.lock().unwrap();
        let legacy_path = legacy_path.to_string_lossy().to_string();
        conn.execute("ATTACH DATABASE ?1 AS legacy", params![legacy_path])?;
        let import_result = import_attached_legacy_database(&conn);
        let detach_result = conn.execute_batch("DETACH DATABASE legacy");
        import_result?;
        detach_result?;
        Ok(())
    }

    fn merge_generic_plan_aliases(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let generic_aliases = quoted_generic_plan_aliases();
        let generic_count: i64 = conn.query_row(
            &format!(
                "SELECT COUNT(*)
                 FROM usage_snapshots
                 WHERE provider = 'claude_code'
                   AND lower(account_alias) IN ({generic_aliases})"
            ),
            [],
            |row| row.get(0),
        )?;
        if generic_count == 0 {
            return Ok(());
        }

        let email_aliases = {
            let mut stmt = conn.prepare(
                "SELECT account_alias
                 FROM (
                     SELECT account_alias, MAX(collected_at) AS last_seen
                     FROM usage_snapshots
                     WHERE provider = 'claude_code'
                       AND account_alias LIKE '%@%'
                     GROUP BY account_alias
                 )
                 ORDER BY last_seen DESC",
            )?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>>>()?
        };

        if email_aliases.len() != 1 {
            let message = if email_aliases.is_empty() {
                "Claude Code has plan-label history, but no email account to merge into".to_string()
            } else {
                format!(
                    "Claude Code has plan-label history, but multiple email accounts exist: {}",
                    email_aliases.join(", ")
                )
            };
            conn.execute(
                "INSERT INTO local_usage_status (provider, account_alias, ok, message, updated_at)
                 VALUES ('claude_code', NULL, 0, ?1, ?2)
                 ON CONFLICT(provider) DO UPDATE SET
                    account_alias = excluded.account_alias,
                    ok = excluded.ok,
                    message = excluded.message,
                    updated_at = excluded.updated_at",
                params![message, chrono::Utc::now().to_rfc3339()],
            )?;
            return Ok(());
        }

        let target_alias = &email_aliases[0];
        for alias in GENERIC_PLAN_ALIASES {
            conn.execute(
                "UPDATE usage_snapshots
                 SET account_alias = ?1
                 WHERE provider = 'claude_code'
                   AND lower(account_alias) = ?2",
                params![target_alias, alias],
            )?;
            conn.execute(
                "UPDATE filtered_inbox
                 SET account_alias = ?1
                 WHERE provider = 'claude_code'
                   AND lower(account_alias) = ?2",
                params![target_alias, alias],
            )?;
            conn.execute(
                "UPDATE local_usage_status
                 SET account_alias = ?1
                 WHERE provider = 'claude_code'
                   AND account_alias IS NOT NULL
                   AND lower(account_alias) = ?2",
                params![target_alias, alias],
            )?;
            conn.execute(
                "DELETE FROM account_pause_states
                 WHERE provider = 'claude_code'
                   AND lower(account_alias) = ?1",
                params![alias],
            )?;
            conn.execute(
                "DELETE FROM account_colors
                 WHERE lower(alias) = ?1",
                params![alias],
            )?;
        }

        Ok(())
    }

    /// OAuth APIs can jitter reset_at while the visible usage is unchanged.
    /// Keep true reset-window shifts, but remove adjacent rows caused by small reset_at drift.
    fn dedupe_consecutive_snapshots(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "
            WITH ordered AS (
                SELECT
                    id,
                    session_pct,
                    session_total_pct,
                    weekly_pct,
                    weekly_total_pct,
                    session_reset_at,
                    weekly_reset_at,
                    error,
                    LAG(session_pct) OVER w AS newer_session_pct,
                    LAG(session_total_pct) OVER w AS newer_session_total_pct,
                    LAG(weekly_pct) OVER w AS newer_weekly_pct,
                    LAG(weekly_total_pct) OVER w AS newer_weekly_total_pct,
                    LAG(session_reset_at) OVER w AS newer_session_reset_at,
                    LAG(weekly_reset_at) OVER w AS newer_weekly_reset_at,
                    LAG(error) OVER w AS newer_error
                FROM usage_snapshots
                WINDOW w AS (
                    PARTITION BY provider, account_alias
                    ORDER BY collected_at DESC, id DESC
                )
            )
            DELETE FROM usage_snapshots
            WHERE id IN (
                SELECT id
                FROM ordered
                WHERE session_pct IS newer_session_pct
                  AND session_total_pct IS newer_session_total_pct
                  AND weekly_pct IS newer_weekly_pct
                  AND weekly_total_pct IS newer_weekly_total_pct
                  AND error IS newer_error
                  AND (
                      session_reset_at IS newer_session_reset_at
                      OR (
                          session_reset_at IS NOT NULL
                          AND newer_session_reset_at IS NOT NULL
                          AND ABS((julianday(session_reset_at) - julianday(newer_session_reset_at)) * 86400) < 14400
                      )
                  )
                  AND (
                      weekly_reset_at IS newer_weekly_reset_at
                      OR (
                          weekly_reset_at IS NOT NULL
                          AND newer_weekly_reset_at IS NOT NULL
                          AND ABS((julianday(weekly_reset_at) - julianday(newer_weekly_reset_at)) * 86400) < 43200
                      )
                  )
            );
        ",
        )?;
        Ok(())
    }

    /// 获取某账号最新一条快照（用于去重判断）
    pub fn last_snapshot(&self, provider: &str, alias: &str) -> Result<Option<UsageSnapshot>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, provider, account_alias, collected_at,
                    session_pct, session_total_pct, session_reset_at,
                    weekly_pct, weekly_total_pct, weekly_reset_at, error
             FROM usage_snapshots
             WHERE provider = ?1 AND account_alias = ?2
             ORDER BY collected_at DESC
             LIMIT 1",
        )?;
        let mut rows = stmt.query_map(params![provider, alias], row_to_snapshot)?;
        Ok(rows.next().transpose()?)
    }

    pub fn insert_snapshot(&self, snap: &UsageSnapshot) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO usage_snapshots
             (provider, account_alias, collected_at, session_pct, session_total_pct, session_reset_at,
              weekly_pct, weekly_total_pct, weekly_reset_at, error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                snap.provider,
                snap.account_alias,
                snap.collected_at,
                snap.session_pct,
                snap.session_total_pct.unwrap_or(100.0),
                snap.session_reset_at,
                snap.weekly_pct,
                snap.weekly_total_pct.unwrap_or(100.0),
                snap.weekly_reset_at,
                snap.error,
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// 获取某账号的历史记录，最新在前，支持分页
    pub fn history(
        &self,
        provider: &str,
        alias: &str,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<UsageSnapshot>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, provider, account_alias, collected_at,
                    session_pct, session_total_pct, session_reset_at,
                    weekly_pct, weekly_total_pct, weekly_reset_at, error
             FROM usage_snapshots
             WHERE provider = ?1 AND account_alias = ?2
             ORDER BY collected_at DESC
             LIMIT ?3 OFFSET ?4",
        )?;
        let rows = stmt.query_map(params![provider, alias, limit, offset], row_to_snapshot)?;
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
            Ok(AccountColor {
                alias: row.get(0)?,
                color: row.get(1)?,
            })
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
            let base_alias = alias
                .split_once("::")
                .map(|(_, name)| name)
                .unwrap_or(alias);
            let inherited = conn
                .query_row(
                    "SELECT color FROM account_colors WHERE alias = ?1",
                    params![base_alias],
                    |row| row.get::<_, String>(0),
                )
                .ok();
            let color = inherited.unwrap_or_else(|| color_for_alias(alias));
            conn.execute(
                "INSERT OR IGNORE INTO account_colors (alias, color) VALUES (?1, ?2)",
                params![alias, color],
            )?;
        }
        Ok(())
    }

    /// 获取所有账号的历史记录（每账号最多 limit 条，最新在前）
    pub fn all_histories_grouped(&self, limit: i64) -> Result<HashMap<String, Vec<UsageSnapshot>>> {
        let accounts: Vec<(String, String)> = {
            let conn = self.conn.lock().unwrap();
            let generic_aliases = quoted_generic_plan_aliases();
            let mut stmt = conn.prepare(&format!(
                "SELECT DISTINCT provider, account_alias
                 FROM usage_snapshots
                 WHERE NOT (
                     provider = 'claude_code'
                     AND lower(account_alias) IN ({generic_aliases})
                 )
                 ORDER BY provider, account_alias",
            ))?;
            let rows =
                stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            rows.collect::<Result<Vec<_>>>()?
        };
        let mut result = HashMap::new();
        for (provider, alias) in accounts {
            let records = self.history(&provider, &alias, limit, 0)?;
            result.insert(format!("{provider}::{alias}"), records);
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
             (provider, account_alias, collected_at, session_pct, session_total_pct, session_reset_at,
              weekly_pct, weekly_total_pct, weekly_reset_at, filter_reason, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                snap.provider,
                snap.account_alias,
                snap.collected_at,
                snap.session_pct,
                snap.session_total_pct.unwrap_or(100.0),
                snap.session_reset_at,
                snap.weekly_pct,
                snap.weekly_total_pct.unwrap_or(100.0),
                snap.weekly_reset_at,
                reason,
                created_at,
            ],
        )?;
        let new_id = conn.last_insert_rowid();
        conn.execute(
            "DELETE FROM filtered_inbox
             WHERE provider = ?1 AND account_alias = ?2
               AND id NOT IN (
                   SELECT id FROM filtered_inbox
                   WHERE provider = ?1 AND account_alias = ?2
                   ORDER BY id DESC
                   LIMIT ?3
               )",
            params![snap.provider, snap.account_alias, PER_ALIAS_CAP],
        )?;
        Ok(new_id)
    }

    pub fn inbox_list(&self) -> Result<Vec<InboxItem>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, provider, account_alias, collected_at,
                    session_pct, session_total_pct, session_reset_at,
                    weekly_pct, weekly_total_pct, weekly_reset_at,
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
            "SELECT id, provider, account_alias, collected_at,
                    session_pct, session_total_pct, session_reset_at,
                    weekly_pct, weekly_total_pct, weekly_reset_at,
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
        let generic_aliases = quoted_generic_plan_aliases();
        let mut stmt = conn.prepare(&format!(
            "WITH ranked AS (
                 SELECT id, provider, account_alias, collected_at,
                        session_pct, session_total_pct, session_reset_at,
                        weekly_pct, weekly_total_pct, weekly_reset_at, error,
                        ROW_NUMBER() OVER (
                            PARTITION BY provider, account_alias
                            ORDER BY datetime(collected_at) DESC, collected_at DESC, id DESC
                        ) AS row_num
                 FROM usage_snapshots
                 WHERE NOT (
                     provider = 'claude_code'
                     AND lower(account_alias) IN ({generic_aliases})
                 )
             )
             SELECT id, provider, account_alias, collected_at,
                    session_pct, session_total_pct, session_reset_at,
                    weekly_pct, weekly_total_pct, weekly_reset_at, error
             FROM ranked
             WHERE row_num = 1
             ORDER BY provider, account_alias",
        ))?;
        let rows = stmt.query_map([], row_to_snapshot)?;
        rows.collect()
    }
}

fn quoted_generic_plan_aliases() -> String {
    GENERIC_PLAN_ALIASES
        .iter()
        .map(|alias| format!("'{}'", alias.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(", ")
}

fn import_attached_legacy_database(conn: &Connection) -> Result<()> {
    import_legacy_usage_snapshots(conn)?;
    import_legacy_filtered_inbox(conn)?;
    import_legacy_account_colors(conn)?;
    import_legacy_account_pause_states(conn)?;
    import_legacy_token_usage_files(conn)?;
    import_legacy_token_usage_days(conn)?;
    Ok(())
}

fn import_legacy_usage_snapshots(conn: &Connection) -> Result<()> {
    let columns = legacy_table_columns(conn, "usage_snapshots")?;
    if !columns.contains("account_alias") || !columns.contains("collected_at") {
        return Ok(());
    }

    let provider = legacy_expr(&columns, "provider", "'claude_code'");
    let account_alias = legacy_expr(&columns, "account_alias", "''");
    let collected_at = legacy_expr(&columns, "collected_at", "''");
    let session_pct = legacy_expr(&columns, "session_pct", "NULL");
    let session_total_pct = legacy_expr(&columns, "session_total_pct", "100");
    let session_reset_at = legacy_expr(&columns, "session_reset_at", "NULL");
    let weekly_pct = legacy_expr(&columns, "weekly_pct", "NULL");
    let weekly_total_pct = legacy_expr(&columns, "weekly_total_pct", "100");
    let weekly_reset_at = legacy_expr(&columns, "weekly_reset_at", "NULL");
    let error = legacy_expr(&columns, "error", "NULL");

    conn.execute_batch(&format!(
        "
        INSERT INTO usage_snapshots (
            provider, account_alias, collected_at,
            session_pct, session_total_pct, session_reset_at,
            weekly_pct, weekly_total_pct, weekly_reset_at, error
        )
        SELECT
            {provider}, {account_alias}, {collected_at},
            {session_pct}, {session_total_pct}, {session_reset_at},
            {weekly_pct}, {weekly_total_pct}, {weekly_reset_at}, {error}
        FROM legacy.usage_snapshots l
        WHERE NOT EXISTS (
            SELECT 1
            FROM usage_snapshots m
            WHERE m.provider IS {provider}
              AND m.account_alias IS {account_alias}
              AND m.collected_at IS {collected_at}
              AND m.session_pct IS {session_pct}
              AND m.session_total_pct IS {session_total_pct}
              AND m.session_reset_at IS {session_reset_at}
              AND m.weekly_pct IS {weekly_pct}
              AND m.weekly_total_pct IS {weekly_total_pct}
              AND m.weekly_reset_at IS {weekly_reset_at}
              AND m.error IS {error}
        );
        "
    ))?;
    Ok(())
}

fn import_legacy_filtered_inbox(conn: &Connection) -> Result<()> {
    let columns = legacy_table_columns(conn, "filtered_inbox")?;
    if !columns.contains("account_alias")
        || !columns.contains("collected_at")
        || !columns.contains("filter_reason")
        || !columns.contains("created_at")
    {
        return Ok(());
    }

    let provider = legacy_expr(&columns, "provider", "'claude_code'");
    let account_alias = legacy_expr(&columns, "account_alias", "''");
    let collected_at = legacy_expr(&columns, "collected_at", "''");
    let session_pct = legacy_expr(&columns, "session_pct", "NULL");
    let session_total_pct = legacy_expr(&columns, "session_total_pct", "100");
    let session_reset_at = legacy_expr(&columns, "session_reset_at", "NULL");
    let weekly_pct = legacy_expr(&columns, "weekly_pct", "NULL");
    let weekly_total_pct = legacy_expr(&columns, "weekly_total_pct", "100");
    let weekly_reset_at = legacy_expr(&columns, "weekly_reset_at", "NULL");
    let filter_reason = legacy_expr(&columns, "filter_reason", "''");
    let created_at = legacy_expr(&columns, "created_at", "''");

    conn.execute_batch(&format!(
        "
        INSERT INTO filtered_inbox (
            provider, account_alias, collected_at,
            session_pct, session_total_pct, session_reset_at,
            weekly_pct, weekly_total_pct, weekly_reset_at,
            filter_reason, created_at
        )
        SELECT
            {provider}, {account_alias}, {collected_at},
            {session_pct}, {session_total_pct}, {session_reset_at},
            {weekly_pct}, {weekly_total_pct}, {weekly_reset_at},
            {filter_reason}, {created_at}
        FROM legacy.filtered_inbox l
        WHERE NOT EXISTS (
            SELECT 1
            FROM filtered_inbox m
            WHERE m.provider IS {provider}
              AND m.account_alias IS {account_alias}
              AND m.collected_at IS {collected_at}
              AND m.session_pct IS {session_pct}
              AND m.session_total_pct IS {session_total_pct}
              AND m.session_reset_at IS {session_reset_at}
              AND m.weekly_pct IS {weekly_pct}
              AND m.weekly_total_pct IS {weekly_total_pct}
              AND m.weekly_reset_at IS {weekly_reset_at}
              AND m.filter_reason IS {filter_reason}
              AND m.created_at IS {created_at}
        );
        "
    ))?;
    Ok(())
}

fn import_legacy_account_colors(conn: &Connection) -> Result<()> {
    let columns = legacy_table_columns(conn, "account_colors")?;
    if columns.contains("alias") && columns.contains("color") {
        conn.execute_batch(
            "
            INSERT OR IGNORE INTO account_colors (alias, color)
            SELECT alias, color
            FROM legacy.account_colors;
            ",
        )?;
    }
    Ok(())
}

fn import_legacy_account_pause_states(conn: &Connection) -> Result<()> {
    let columns = legacy_table_columns(conn, "account_pause_states")?;
    if columns.contains("account_key")
        && columns.contains("provider")
        && columns.contains("account_alias")
        && columns.contains("paused")
        && columns.contains("paused_at")
    {
        conn.execute_batch(
            "
            INSERT OR IGNORE INTO account_pause_states (
                account_key, provider, account_alias, paused, paused_at
            )
            SELECT account_key, provider, account_alias, paused, paused_at
            FROM legacy.account_pause_states;
            ",
        )?;
    }
    Ok(())
}

fn import_legacy_token_usage_files(conn: &Connection) -> Result<()> {
    let columns = legacy_table_columns(conn, "token_usage_files")?;
    if columns.contains("path")
        && columns.contains("provider")
        && columns.contains("modified_unix")
        && columns.contains("size")
        && columns.contains("days_json")
        && columns.contains("scanned_at")
    {
        conn.execute_batch(
            "
            INSERT OR IGNORE INTO token_usage_files (
                path, provider, modified_unix, size, days_json, scanned_at
            )
            SELECT path, provider, modified_unix, size, days_json, scanned_at
            FROM legacy.token_usage_files;
            ",
        )?;
    }
    Ok(())
}

fn import_legacy_token_usage_days(conn: &Connection) -> Result<()> {
    let columns = legacy_table_columns(conn, "token_usage_days")?;
    if columns.contains("provider")
        && columns.contains("date")
        && columns.contains("input_tokens")
        && columns.contains("cache_read_tokens")
        && columns.contains("cache_creation_tokens")
        && columns.contains("output_tokens")
        && columns.contains("total_tokens")
        && columns.contains("cost_usd")
        && columns.contains("models_json")
        && columns.contains("updated_at")
    {
        conn.execute_batch(
            "
            INSERT OR IGNORE INTO token_usage_days (
                provider, date, input_tokens, cache_read_tokens,
                cache_creation_tokens, output_tokens, total_tokens,
                cost_usd, models_json, updated_at
            )
            SELECT
                provider, date, input_tokens, cache_read_tokens,
                cache_creation_tokens, output_tokens, total_tokens,
                cost_usd, models_json, updated_at
            FROM legacy.token_usage_days;
            ",
        )?;
    }
    Ok(())
}

fn legacy_table_columns(conn: &Connection, table: &str) -> Result<HashSet<String>> {
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*)
         FROM legacy.sqlite_master
         WHERE type = 'table' AND name = ?1",
        params![table],
        |row| row.get(0),
    )?;
    if exists == 0 {
        return Ok(HashSet::new());
    }

    let mut stmt = conn.prepare(&format!("PRAGMA legacy.table_info({table})"))?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    rows.collect()
}

fn legacy_expr(columns: &HashSet<String>, column: &str, fallback: &str) -> String {
    if columns.contains(column) {
        format!("l.{column}")
    } else {
        fallback.to_string()
    }
}

fn row_to_snapshot(row: &rusqlite::Row<'_>) -> Result<UsageSnapshot> {
    Ok(UsageSnapshot {
        id: Some(row.get(0)?),
        provider: row.get(1)?,
        account_alias: row.get(2)?,
        collected_at: row.get(3)?,
        session_pct: row.get(4)?,
        session_total_pct: row.get(5)?,
        session_reset_at: row.get(6)?,
        weekly_pct: row.get(7)?,
        weekly_total_pct: row.get(8)?,
        weekly_reset_at: row.get(9)?,
        error: row.get(10)?,
    })
}

fn row_to_inbox(row: &rusqlite::Row<'_>) -> Result<InboxItem> {
    Ok(InboxItem {
        id: Some(row.get(0)?),
        provider: row.get(1)?,
        account_alias: row.get(2)?,
        collected_at: row.get(3)?,
        session_pct: row.get(4)?,
        session_total_pct: row.get(5)?,
        session_reset_at: row.get(6)?,
        weekly_pct: row.get(7)?,
        weekly_total_pct: row.get(8)?,
        weekly_reset_at: row.get(9)?,
        filter_reason: row.get(10)?,
        created_at: row.get(11)?,
    })
}
