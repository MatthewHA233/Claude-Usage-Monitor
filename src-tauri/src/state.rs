use crate::db::Database;
use crate::models::PluginUsageStatus;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub struct AppState {
    pub db: Arc<Database>,
    pub runtime: Arc<RuntimeStatus>,
}

#[derive(Default)]
pub struct RuntimeStatus {
    plugin_reports: Mutex<HashMap<String, PluginUsageStatus>>,
}

impl RuntimeStatus {
    pub fn record_plugin_report(&self, provider: &str, account_alias: &str) {
        let account_key = format!("{provider}::{account_alias}");
        let status = PluginUsageStatus {
            provider: provider.to_string(),
            account_alias: account_alias.to_string(),
            account_key: account_key.clone(),
            updated_at: chrono::Utc::now().to_rfc3339(),
        };
        self.plugin_reports.lock().unwrap().insert(account_key, status);
    }

    pub fn plugin_usage_statuses(&self) -> Vec<PluginUsageStatus> {
        let mut statuses: Vec<_> = self.plugin_reports.lock().unwrap().values().cloned().collect();
        statuses.sort_by(|a, b| a.account_key.cmp(&b.account_key));
        statuses
    }
}

impl AppState {
    pub fn new() -> Result<Self, String> {
        let db = Database::open().map_err(|e| e.to_string())?;
        Ok(Self {
            db: Arc::new(db),
            runtime: Arc::new(RuntimeStatus::default()),
        })
    }
}
