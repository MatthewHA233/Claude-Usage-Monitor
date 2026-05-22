#[cfg(test)]
mod tests {
    use crate::models::UsageSnapshot;
    use crate::recommender::recommend;

    fn snapshot(
        alias: &str,
        session_pct: f64,
        session_total_pct: f64,
        weekly_pct: f64,
        weekly_total_pct: f64,
    ) -> UsageSnapshot {
        UsageSnapshot {
            id: None,
            account_alias: alias.to_string(),
            collected_at: "2026-05-16T06:00:00Z".to_string(),
            session_pct: Some(session_pct),
            session_total_pct: Some(session_total_pct),
            session_reset_at: Some("2026-05-16T11:00:00Z".to_string()),
            weekly_pct: Some(weekly_pct),
            weekly_total_pct: Some(weekly_total_pct),
            weekly_reset_at: Some("2026-05-22T10:00:00Z".to_string()),
            error: None,
        }
    }

    #[test]
    fn scaled_codex_quota_is_available_until_scaled_total_is_used() {
        let snapshots = vec![snapshot("codex-pro", 200.0, 1000.0, 30.0, 1000.0)];

        let rec = recommend(&snapshots);

        assert_eq!(rec.recommended_alias.as_deref(), Some("codex-pro"));
        assert_eq!(rec.account_summaries[0].status, "available");
        assert_eq!(rec.account_summaries[0].session_total_pct, Some(1000.0));
        assert_eq!(rec.account_summaries[0].weekly_total_pct, Some(1000.0));
        assert!(rec.reason.contains("剩余 970%"));
    }
}
