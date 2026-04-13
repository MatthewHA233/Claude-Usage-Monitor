export interface UsageSnapshot {
  id?: number;
  account_alias: string;
  collected_at: string; // ISO UTC
  session_pct: number | null;
  session_reset_at: string | null;
  weekly_pct: number | null;
  weekly_reset_at: string | null;
  error: string | null;
}

export interface AccountAnalysis {
  alias: string;
  avg_session_rate: number | null;
  exhaustion_rate: number | null;
  avg_weekly_final_pct: number | null;
  weighted_session_pct: number | null;
  weighted_weekly_pct: number | null;
  data_points: number;
  weekly_cost_per_session_24h: number | null;
  exhaustion_count_24h: number;
}

export interface AccountColor {
  alias: string;
  color: string;
}

export interface AccountSummary {
  alias: string;
  session_pct: number | null;
  session_remaining_hours: number | null;
  weekly_pct: number | null;
  weekly_remaining_hours: number | null;
  status: "available" | "exhausted" | "unknown";
}

export interface Recommendation {
  recommended_alias: string | null;
  reason: string;
  estimated_remaining_hours: number | null;
  warnings: string[];
  account_summaries: AccountSummary[];
}
