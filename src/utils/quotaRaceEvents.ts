export const QUOTA_SEGMENT_COMPLETED_EVENT = "claude_usage_monitor_quota_segment_completed";
export const QUOTA_RACE_SETTLED_EVENT = "claude_usage_monitor_quota_race_settled";
export const QUOTA_RACE_BREAK_FINISHED_EVENT = "claude_usage_monitor_quota_race_break_finished";

export interface QuotaSegmentCompletedDetail {
  raceId: string;
  provider: string;
  alias: string;
  accountKey: string;
  segmentIndex: number;
  segmentsTotal: number;
  targetDeltaPct: number;
  cumulativeDeltaPct: number;
  actualDeltaPct: number;
  raceTargetDeltaPct: number;
  totalPct: number;
  segmentElapsedSeconds?: number;
  segmentTargetSeconds?: number;
  cumulativeTargetSeconds?: number;
  elapsedSeconds: number;
  completedAt: string;
}

export function dispatchQuotaSegmentCompleted(detail: QuotaSegmentCompletedDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<QuotaSegmentCompletedDetail>(QUOTA_SEGMENT_COMPLETED_EVENT, { detail }));
}

export interface QuotaRaceSettledDetail {
  raceId: string;
  provider: string;
  alias: string;
  accountKey: string;
  status: "completed" | "expired" | "lost";
  targetDeltaPct: number;
  consumedDeltaPct: number;
  totalPct: number;
  completedSegments: number;
  segmentsTotal: number;
  elapsedSeconds: number;
}

export function dispatchQuotaRaceSettled(detail: QuotaRaceSettledDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<QuotaRaceSettledDetail>(QUOTA_RACE_SETTLED_EVENT, { detail }));
}

export interface QuotaRaceBreakFinishedDetail {
  raceId: string;
  provider: string;
  alias: string;
  accountKey: string;
  durationSeconds: number;
  finishedAt: string;
}

export function dispatchQuotaRaceBreakFinished(detail: QuotaRaceBreakFinishedDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<QuotaRaceBreakFinishedDetail>(QUOTA_RACE_BREAK_FINISHED_EVENT, { detail }));
}
