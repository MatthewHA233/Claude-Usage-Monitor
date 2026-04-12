use crate::db::Database;
use std::sync::Arc;

pub struct AppState {
    pub db: Arc<Database>,
}

impl AppState {
    pub fn new() -> Result<Self, String> {
        let db = Database::open().map_err(|e| e.to_string())?;
        Ok(Self { db: Arc::new(db) })
    }
}
