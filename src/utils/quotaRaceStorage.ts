export const QUOTA_RACES_STORAGE_KEY = "claude_usage_monitor_quota_races_v1";
export const QUOTA_RACE_SELECTED_STORAGE_KEY = "claude_usage_monitor_quota_race_selected";
export const QUOTA_RACE_FOCUSED_STORAGE_KEY = "claude_usage_monitor_quota_race_focused";
export const QUOTA_RACE_UPDATED_EVENT = "claude_usage_monitor_quota_race_updated";

export type StoredQuotaRaceStatus = "active" | "completed" | "expired";

export interface StoredQuotaRace {
  id: string;
  provider: string;
  alias: string;
  accountKey: string;
  startedAt: string;
  durationSeconds: number;
  targetDeltaPct: number;
  status: StoredQuotaRaceStatus;
}

function hasWindowStorage() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function notifyQuotaRacesUpdated() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(QUOTA_RACE_UPDATED_EVENT));
}

export function loadStoredQuotaRaces(): StoredQuotaRace[] {
  if (!hasWindowStorage()) return [];
  try {
    const raw = window.localStorage.getItem(QUOTA_RACES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((race): race is StoredQuotaRace => (
      race != null &&
      typeof race === "object" &&
      typeof race.id === "string" &&
      typeof race.accountKey === "string" &&
      typeof race.provider === "string" &&
      typeof race.alias === "string" &&
      typeof race.startedAt === "string" &&
      typeof race.durationSeconds === "number" &&
      typeof race.targetDeltaPct === "number" &&
      (race.status === "active" || race.status === "completed" || race.status === "expired")
    ));
  } catch {
    return [];
  }
}

export function setFocusedQuotaRaceId(raceId: string | null) {
  if (!hasWindowStorage()) return;
  if (raceId) {
    window.localStorage.setItem(QUOTA_RACE_FOCUSED_STORAGE_KEY, raceId);
  } else {
    window.localStorage.removeItem(QUOTA_RACE_FOCUSED_STORAGE_KEY);
  }
  notifyQuotaRacesUpdated();
}

export function setSelectedQuotaRaceAccountKey(accountKey: string | null) {
  if (!hasWindowStorage()) return;
  if (accountKey) {
    window.localStorage.setItem(QUOTA_RACE_SELECTED_STORAGE_KEY, accountKey);
  } else {
    window.localStorage.removeItem(QUOTA_RACE_SELECTED_STORAGE_KEY);
  }
  notifyQuotaRacesUpdated();
}
