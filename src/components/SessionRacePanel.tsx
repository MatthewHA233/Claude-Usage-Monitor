import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Flag,
  History,
  RefreshCw,
  Target,
  Timer,
  TimerReset,
  Trash2,
  Trophy,
  X,
} from "lucide-react";
import type { PluginUsageStatus, Recommendation, UsageSnapshot } from "../types";
import { useAccountColors, useAllHistories } from "../hooks/useData";
import ProgressBar from "./ProgressBar";
import { formatLocalTime } from "../utils/format";
import {
  notifyQuotaRacesUpdated,
  QUOTA_RACE_FOCUSED_STORAGE_KEY,
  QUOTA_RACE_UPDATED_EVENT,
  QUOTA_RACE_SELECTED_STORAGE_KEY,
  QUOTA_RACES_STORAGE_KEY,
  setFocusedQuotaRaceId,
  setSelectedQuotaRaceAccountKey,
} from "../utils/quotaRaceStorage";
import {
  dispatchQuotaRaceSettled,
  dispatchQuotaSegmentCompleted,
  type QuotaRaceSettledDetail,
  type QuotaSegmentCompletedDetail,
} from "../utils/quotaRaceEvents";

const SESSION_HOURS = 5;
const PX_PER_HOUR = 72;
const LABEL_W = 178;
const ROW_H = 58;
const HEADER_H = 26;
const DEFAULT_STEP_PCT = 2;
const MAX_SAVED_RACES = 120;
const ACTIVE_UPDATE_WINDOW_MS = 10 * 60_000;
const MAX_SPEED_ESTIMATE_DELTA_PCT = 8;
const PROVIDER_ORDER = ["claude_code", "codex"];
const ACCOUNT_COLORS = ["#cc785c", "#4a9eff", "#4ade80", "#f0a500", "#a78bfa"];
const PLUGIN_STATUS_FRESH_MS = 90_000;
const TIMER_OK_COLOR = "#c084fc";
const TIMER_OVER_COLOR = "#f87171";
const RECORD_OK_COLOR = "#4ade80";
const RECORD_PENDING_COLOR = "#858585";

interface Props {
  snapshots: UsageSnapshot[];
  recommendation: Recommendation | null;
  pluginUsageStatuses: PluginUsageStatus[];
  onRefresh: () => void;
}

interface Sample {
  atMs: number;
  iso: string;
  normPct: number;
  rawPct: number;
}

interface ActiveSession {
  key: string;
  provider: string;
  alias: string;
  color: string;
  resetAt: string;
  resetKey: string;
  resetMs: number;
  totalPct: number;
  currentRawPct: number;
  currentNormPct: number;
  remainingNormPct: number;
  remainingSeconds: number;
  recentDeltaPct: number;
  samples: Sample[];
}

type RaceStatus = "active" | "completed" | "expired" | "lost";

interface RaceSegment {
  index: number;
  targetDeltaPct: number;
  cumulativeDeltaPct: number;
  completedAt: string | null;
  elapsedSeconds: number | null;
  actualDeltaPct: number | null;
}

interface UsageRace {
  id: string;
  provider: string;
  alias: string;
  accountKey: string;
  createdAt: string;
  startedAt: string;
  durationSeconds: number;
  targetDeltaPct: number;
  stepPct: number;
  startNormPct: number;
  startRawPct: number;
  totalPct: number;
  resetAt: string;
  resetKey: string;
  status: RaceStatus;
  segments: RaceSegment[];
}

interface RaceDraft {
  durationMinutes: string;
  targetPct: string;
  stepPct: string;
}

const accountKey = (snap: Pick<UsageSnapshot, "provider" | "account_alias">) =>
  `${snap.provider ?? "claude_code"}::${snap.account_alias}`;

const providerLabel = (provider: string) => {
  if (provider === "codex") return "Codex";
  if (provider === "claude_code") return "Claude Code";
  return provider;
};

const providerColor = (provider: string) => provider === "codex" ? "#4a9eff" : "#cc785c";

const round1 = (value: number) => Math.round(value * 10) / 10;
const round2 = (value: number) => Math.round(value * 100) / 100;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function normalizeResetKey(isoStr: string): string {
  const d = new Date(isoStr);
  if (d.getMinutes() >= 30) d.setHours(d.getHours() + 1);
  d.setMinutes(0, 0, 0);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}`;
}

function parseDraftNumber(value: string, fallback: number) {
  if (value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatDigitalClock(seconds: number | null) {
  if (seconds == null || !Number.isFinite(seconds)) return "--:--";
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatRaceClockParts(seconds: number | null, showHours: boolean) {
  if (seconds == null || !Number.isFinite(seconds)) return { main: "--:--", centis: "" };
  const safeMs = Math.max(0, Math.floor(seconds * 1000));
  const totalSeconds = Math.floor(safeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  const centis = Math.floor((safeMs % 1000) / 10);
  const main = showHours || hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return { main, centis: `.${String(centis).padStart(2, "0")}` };
}

function formatShortDuration(seconds: number | null) {
  if (seconds == null || !Number.isFinite(seconds)) return "-";
  const safe = Math.max(0, Math.round(seconds));
  if (safe < 60) return `${safe}s`;
  const minutes = Math.floor(safe / 60);
  const secs = safe % 60;
  if (minutes < 60) return secs > 0 ? `${minutes}m${secs}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours}h${restMinutes}m` : `${hours}h`;
}

function formatDetailedHms(seconds: number | null) {
  if (seconds == null || !Number.isFinite(seconds)) return "-";
  const safe = Math.max(0, Math.round(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  const parts = [
    hours > 0 ? `${hours}h` : null,
    minutes > 0 ? `${minutes}m` : null,
    secs > 0 ? `${secs}s` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "0s";
}

function formatTargetDelta(elapsedSeconds: number, targetSeconds: number) {
  const delta = targetSeconds - elapsedSeconds;
  if (delta >= 0) return `盈余 ${formatShortDuration(delta)}`;
  return `超出 ${formatShortDuration(Math.abs(delta))}`;
}

function shortAlias(alias: string) {
  if (!alias.includes("@")) return alias;
  return alias.split("@")[0];
}

function rawFromNorm(normPct: number, totalPct: number) {
  return normPct * totalPct / 100;
}

function formatWhole(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "-";
  return String(Math.round(value));
}

function formatWholePct(value: number | null | undefined) {
  return `${formatWhole(value)}%`;
}

function formatDraftNumber(value: number, decimals = 0) {
  const rounded = decimals > 0 ? round2(value) : Math.round(value);
  return decimals > 0
    ? rounded.toFixed(decimals).replace(/\.?0+$/, "")
    : String(rounded);
}

function durationPartsFromMinutes(value: string) {
  const totalSeconds = Math.max(0, Math.round(parseDraftNumber(value, 0) * 60));
  return {
    minutes: Math.floor(totalSeconds / 60),
    seconds: totalSeconds % 60,
  };
}

function durationStringFromParts(minutes: number, seconds: number) {
  const safeMinutes = Math.max(0, Math.round(minutes));
  const safeSeconds = clamp(Math.round(seconds), 0, 59);
  return formatDraftNumber(safeMinutes + safeSeconds / 60, safeSeconds > 0 ? 2 : 0);
}

function durationStringFromSeconds(totalSeconds: number) {
  const safeSeconds = Math.max(0, Math.round(totalSeconds));
  return durationStringFromParts(Math.floor(safeSeconds / 60), safeSeconds % 60);
}

function loadRaces(): UsageRace[] {
  try {
    const raw = localStorage.getItem(QUOTA_RACES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isRaceLike) : [];
  } catch {
    return [];
  }
}

function isRaceLike(value: unknown): value is UsageRace {
  if (!value || typeof value !== "object") return false;
  const race = value as Partial<UsageRace>;
  return typeof race.id === "string" &&
    typeof race.accountKey === "string" &&
    typeof race.startedAt === "string" &&
    Array.isArray(race.segments);
}

function buildSamples(records: UsageSnapshot[], latest: UsageSnapshot, resetKey: string, fallbackTotal: number, nowMs: number) {
  const seen = new Map<number, Sample>();
  for (const record of [...records, latest]) {
    if (record.error != null || record.session_pct == null || record.session_reset_at == null) continue;
    if (normalizeResetKey(record.session_reset_at) !== resetKey) continue;
    const atMs = new Date(record.collected_at).getTime();
    if (!Number.isFinite(atMs) || atMs > nowMs + 60_000) continue;
    const totalPct = record.session_total_pct ?? fallbackTotal;
    if (totalPct <= 0) continue;
    const rawPct = record.session_pct;
    seen.set(atMs, {
      atMs,
      iso: record.collected_at,
      rawPct,
      normPct: clamp((rawPct / totalPct) * 100, 0, 1000),
    });
  }
  return [...seen.values()].sort((a, b) => a.atMs - b.atMs);
}

function computeRecentDelta(samples: Sample[], nowMs: number) {
  const cutoff = nowMs - 60 * 60_000;
  let delta = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1];
    const current = samples[i];
    if (current.atMs <= cutoff || current.atMs > nowMs) continue;
    const rawDelta = current.normPct - prev.normPct;
    if (rawDelta <= 0.05) continue;
    const duration = current.atMs - prev.atMs;
    if (duration <= 0) continue;
    const startMs = Math.max(prev.atMs, cutoff);
    const ratio = (startMs - prev.atMs) / duration;
    const startPct = prev.normPct + rawDelta * ratio;
    delta += Math.max(0, current.normPct - startPct);
  }
  return round1(delta);
}

function samplesFromRecords(records: UsageSnapshot[], nowMs: number) {
  const grouped = new Map<string, Map<number, Sample>>();
  for (const record of records) {
    if (record.error != null || record.session_pct == null || record.session_reset_at == null) continue;
    const atMs = new Date(record.collected_at).getTime();
    if (!Number.isFinite(atMs) || atMs > nowMs + 60_000) continue;
    const totalPct = record.session_total_pct ?? 100;
    if (totalPct <= 0) continue;
    const resetKey = normalizeResetKey(record.session_reset_at);
    const samples = grouped.get(resetKey) ?? new Map<number, Sample>();
    samples.set(atMs, {
      atMs,
      iso: record.collected_at,
      rawPct: record.session_pct,
      normPct: clamp((record.session_pct / totalPct) * 100, 0, 1000),
    });
    grouped.set(resetKey, samples);
  }
  return new Map([...grouped.entries()].map(([key, samples]) => [
    key,
    [...samples.values()].sort((a, b) => a.atMs - b.atMs),
  ]));
}

function activeUsageStats(samples: Sample[]) {
  const changeEvents: Sample[] = [];
  for (const sample of samples) {
    const last = changeEvents[changeEvents.length - 1];
    if (!last || sample.normPct > last.normPct + 0.05) {
      changeEvents.push(sample);
    }
  }

  let activeMs = 0;
  let deltaPct = 0;
  for (let i = 1; i < changeEvents.length; i += 1) {
    const previous = changeEvents[i - 1];
    const current = changeEvents[i];
    const durationMs = current.atMs - previous.atMs;
    const delta = current.normPct - previous.normPct;
    if (durationMs <= 0 || durationMs > ACTIVE_UPDATE_WINDOW_MS || delta <= 0.05) continue;
    if (delta > MAX_SPEED_ESTIMATE_DELTA_PCT) continue;
    activeMs += durationMs;
    deltaPct += delta;
  }

  return { activeMs, deltaPct };
}

function estimateDurationFromRecentSessions(
  session: ActiveSession,
  records: UsageSnapshot[],
  nowMs: number,
  targetPct: number,
) {
  const grouped = samplesFromRecords(records, nowMs);
  grouped.set(session.resetKey, session.samples);

  const recentGroups = [...grouped.values()]
    .filter((samples) => samples.length >= 2)
    .sort((a, b) => b[b.length - 1].atMs - a[a.length - 1].atMs);

  let activeMs = 0;
  let deltaPct = 0;
  let countedSessions = 0;
  for (const samples of recentGroups) {
    const stats = activeUsageStats(samples);
    if (stats.activeMs <= 0 || stats.deltaPct <= 0) continue;
    activeMs += stats.activeMs;
    deltaPct += stats.deltaPct;
    countedSessions += 1;
    if (countedSessions >= 2) break;
  }

  if (activeMs <= 0 || deltaPct <= 0) return null;
  const pctPerMinute = deltaPct / (activeMs / 60_000);
  if (!Number.isFinite(pctPerMinute) || pctPerMinute <= 0) return null;
  return Math.max(60, Math.round((targetPct / pctPerMinute) * 60));
}

function buildActiveSessions(
  snapshots: UsageSnapshot[],
  histories: Record<string, UsageSnapshot[]>,
  nowMs: number,
  colors: Record<string, string>,
  activeRaceAccountKeys: ReadonlySet<string>,
) {
  return snapshots
    .map((snap, index): ActiveSession | null => {
      if (snap.error != null || snap.session_pct == null || snap.session_reset_at == null) return null;
      const resetMs = new Date(snap.session_reset_at).getTime();
      if (!Number.isFinite(resetMs) || resetMs <= nowMs) return null;
      const totalPct = snap.session_total_pct ?? 100;
      if (totalPct <= 0) return null;
      const provider = snap.provider ?? "claude_code";
      const key = accountKey(snap);
      const resetKey = normalizeResetKey(snap.session_reset_at);
      const currentRawPct = snap.session_pct;
      const currentNormPct = clamp((currentRawPct / totalPct) * 100, 0, 1000);
      if (currentNormPct >= 99 && !activeRaceAccountKeys.has(key)) return null;
      const samples = buildSamples(histories[key] ?? [], snap, resetKey, totalPct, nowMs);
      return {
        key,
        provider,
        alias: snap.account_alias,
        color: colors[key] ?? colors[snap.account_alias] ?? ACCOUNT_COLORS[index % ACCOUNT_COLORS.length],
        resetAt: snap.session_reset_at,
        resetKey,
        resetMs,
        totalPct,
        currentRawPct,
        currentNormPct,
        remainingNormPct: Math.max(0, 100 - currentNormPct),
        remainingSeconds: Math.max(0, (resetMs - nowMs) / 1000),
        recentDeltaPct: computeRecentDelta(samples, nowMs),
        samples,
      };
    })
    .filter((session): session is ActiveSession => session != null)
    .sort((a, b) => {
      const providerSort = PROVIDER_ORDER.indexOf(a.provider) - PROVIDER_ORDER.indexOf(b.provider);
      if (providerSort !== 0) return providerSort;
      return a.resetMs - b.resetMs;
    });
}

function buildSegments(targetDeltaPct: number, stepPct: number) {
  const segments: RaceSegment[] = [];
  let cumulative = 0;
  let index = 1;
  while (cumulative < targetDeltaPct - 0.001) {
    const size = Math.min(stepPct, targetDeltaPct - cumulative);
    cumulative = round2(cumulative + size);
    segments.push({
      index,
      targetDeltaPct: round2(size),
      cumulativeDeltaPct: Math.min(round2(cumulative), round2(targetDeltaPct)),
      completedAt: null,
      elapsedSeconds: null,
      actualDeltaPct: null,
    });
    index += 1;
  }
  return segments;
}

function findObservedCrossingTime(samples: Sample[], targetNormPct: number, fallbackMs: number, startedMs: number) {
  if (samples.length === 0) return fallbackMs;
  for (const sample of samples) {
    if (sample.atMs < startedMs) continue;
    if (sample.normPct >= targetNormPct) return sample.atMs;
  }
  return fallbackMs;
}

function hasNonMonotonicCompletedSegmentTimes(race: UsageRace) {
  let previousElapsed = 0;
  for (const segment of race.segments) {
    if (segment.completedAt == null || segment.elapsedSeconds == null) continue;
    if (segment.elapsedSeconds + 0.001 < previousElapsed) return true;
    previousElapsed = segment.elapsedSeconds;
  }
  return false;
}

function repairObservedRaceTiming(race: UsageRace, histories: Record<string, UsageSnapshot[]>, nowMs: number) {
  if ((race.status !== "active" && race.status !== "completed") || !hasNonMonotonicCompletedSegmentTimes(race)) {
    return race;
  }
  const samples = samplesFromRecords(histories[race.accountKey] ?? [], nowMs).get(race.resetKey) ?? [];
  if (samples.length === 0) return race;
  const startedMs = new Date(race.startedAt).getTime();
  if (!Number.isFinite(startedMs)) return race;
  let changed = false;
  let lastCompletedMs = startedMs;
  const segments = race.segments.map((segment) => {
    if (segment.completedAt == null) return segment;
    const previousMs = new Date(segment.completedAt).getTime();
    const fallbackMs = Number.isFinite(previousMs) ? previousMs : lastCompletedMs;
    const observedMs = findObservedCrossingTime(
      samples,
      race.startNormPct + segment.cumulativeDeltaPct,
      fallbackMs,
      startedMs,
    );
    const completedMs = Math.max(lastCompletedMs, observedMs);
    const completedAt = new Date(completedMs).toISOString();
    const elapsedSeconds = Math.max(0, Math.round((completedMs - startedMs) / 1000));
    lastCompletedMs = completedMs;
    if (segment.completedAt !== completedAt || segment.elapsedSeconds !== elapsedSeconds) changed = true;
    return { ...segment, completedAt, elapsedSeconds };
  });
  return changed ? { ...race, segments } : race;
}

function repairObservedRaceTimings(races: UsageRace[], histories: Record<string, UsageSnapshot[]>, nowMs: number) {
  let changed = false;
  const next = races.map((race) => {
    const repaired = repairObservedRaceTiming(race, histories, nowMs);
    if (repaired !== race) changed = true;
    return repaired;
  });
  return changed ? next : races;
}

function updateRaceProgress(races: UsageRace[], sessionsByKey: Map<string, ActiveSession>, nowMs: number) {
  let changed = false;
  const updated = races.map((race) => {
    if (race.status !== "active") return race;
    const deadlineMs = new Date(race.startedAt).getTime() + race.durationSeconds * 1000;
    const startedMs = new Date(race.startedAt).getTime();
    const session = sessionsByKey.get(race.accountKey);
    const nextRace: UsageRace = { ...race, segments: race.segments.map((segment) => ({ ...segment })) };

    if (session && session.resetKey === race.resetKey) {
      const currentDelta = Math.max(0, session.currentNormPct - race.startNormPct);
      let lastCompletedMs = startedMs;
      for (const segment of nextRace.segments) {
        if (!segment.completedAt) continue;
        const completedMs = new Date(segment.completedAt).getTime();
        if (Number.isFinite(completedMs)) lastCompletedMs = Math.max(lastCompletedMs, completedMs);
      }
      for (const segment of nextRace.segments) {
        if (segment.completedAt != null) continue;
        if (currentDelta + 0.001 < segment.cumulativeDeltaPct) continue;
        const targetNormPct = race.startNormPct + segment.cumulativeDeltaPct;
        const completedMs = Math.max(
          lastCompletedMs,
          findObservedCrossingTime(session.samples, targetNormPct, nowMs, startedMs),
        );
        segment.completedAt = new Date(completedMs).toISOString();
        segment.elapsedSeconds = Math.max(0, Math.round((completedMs - startedMs) / 1000));
        segment.actualDeltaPct = round2(Math.min(currentDelta, segment.cumulativeDeltaPct));
        lastCompletedMs = completedMs;
        changed = true;
      }
      if (nextRace.segments.every((segment) => segment.completedAt != null)) {
        nextRace.status = "completed";
        changed = true;
      }
    }

    if (nextRace.status === "active") {
      const raceResetMs = new Date(race.resetAt).getTime();
      const sessionChanged = session != null && session.resetKey !== race.resetKey;
      const resetPassedWithoutSession = session == null && Number.isFinite(raceResetMs) && nowMs >= raceResetMs;
      if (sessionChanged || resetPassedWithoutSession) {
        nextRace.status = "lost";
        changed = true;
      }
    }

    if (nextRace.status === "active" && nowMs >= deadlineMs) {
      nextRace.status = "expired";
      changed = true;
    }
    return nextRace;
  });
  return changed ? updated : races;
}

function raceConsumedDelta(race: UsageRace, session: ActiveSession | undefined) {
  if (session && session.resetKey === race.resetKey) {
    return clamp(session.currentNormPct - race.startNormPct, 0, race.targetDeltaPct);
  }
  const lastDone = [...race.segments].reverse().find((segment) => segment.completedAt != null);
  return lastDone?.cumulativeDeltaPct ?? 0;
}

function nextOpenSegment(race: UsageRace) {
  return race.segments.find((segment) => segment.completedAt == null) ?? race.segments[race.segments.length - 1] ?? null;
}

function segmentStartMs(race: UsageRace, segment: RaceSegment | null) {
  if (!segment || segment.index <= 1) return new Date(race.startedAt).getTime();
  const previous = race.segments[segment.index - 2];
  return previous?.completedAt ? new Date(previous.completedAt).getTime() : new Date(race.startedAt).getTime();
}

function openSegment(race: UsageRace) {
  return race.segments.find((segment) => segment.completedAt == null) ?? null;
}

function segmentTargetSeconds(race: UsageRace, segment: RaceSegment) {
  if (race.targetDeltaPct <= 0) return race.durationSeconds / Math.max(1, race.segments.length);
  return race.durationSeconds * (segment.targetDeltaPct / race.targetDeltaPct);
}

function segmentCumulativeTargetSeconds(race: UsageRace, segment: RaceSegment) {
  if (race.targetDeltaPct <= 0) return race.durationSeconds;
  return race.durationSeconds * (segment.cumulativeDeltaPct / race.targetDeltaPct);
}

function raceElapsedSeconds(race: UsageRace, nowMs: number) {
  if (race.status === "completed") {
    const lastCompleted = [...race.segments].reverse().find((segment) => segment.elapsedSeconds != null);
    if (lastCompleted?.elapsedSeconds != null) return lastCompleted.elapsedSeconds;
  }
  if (race.status === "expired") return race.durationSeconds;
  if (race.status === "lost") {
    const startedMs = new Date(race.startedAt).getTime();
    const resetMs = new Date(race.resetAt).getTime();
    if (Number.isFinite(resetMs)) return Math.max(0, (resetMs - startedMs) / 1000);
  }
  const startedMs = new Date(race.startedAt).getTime();
  return Math.max(0, (nowMs - startedMs) / 1000);
}

function segmentTiming(race: UsageRace, segment: RaceSegment, nowMs?: number) {
  const previous = segment.index > 1 ? race.segments[segment.index - 2] : null;
  const previousTotalSeconds = previous?.elapsedSeconds ?? 0;
  const currentOpen = openSegment(race);
  const isLiveSegment = race.status === "active" && currentOpen?.index === segment.index && nowMs != null;
  const totalElapsedSeconds = segment.elapsedSeconds ?? (isLiveSegment && nowMs != null ? raceElapsedSeconds(race, nowMs) : null);
  const elapsedSeconds = totalElapsedSeconds != null ? Math.max(0, totalElapsedSeconds - previousTotalSeconds) : null;
  const targetSeconds = segmentTargetSeconds(race, segment);
  const cumulativeTargetSeconds = segmentCumulativeTargetSeconds(race, segment);
  return {
    elapsedSeconds,
    totalElapsedSeconds,
    targetSeconds,
    cumulativeTargetSeconds,
    isLiveSegment,
    isSegmentOver: elapsedSeconds != null && elapsedSeconds > targetSeconds,
    isTotalOver: totalElapsedSeconds != null && totalElapsedSeconds > cumulativeTargetSeconds,
  };
}

function completedSegmentNotice(
  race: UsageRace,
  segment: RaceSegment,
  session: ActiveSession | undefined,
): QuotaSegmentCompletedDetail {
  const consumed = raceConsumedDelta(race, session);
  const timing = segmentTiming(race, segment);
  return {
    raceId: race.id,
    provider: race.provider,
    alias: race.alias,
    accountKey: race.accountKey,
    segmentIndex: segment.index,
    segmentsTotal: race.segments.length,
    targetDeltaPct: segment.targetDeltaPct,
    cumulativeDeltaPct: segment.cumulativeDeltaPct,
    actualDeltaPct: segment.actualDeltaPct ?? Math.min(consumed, segment.cumulativeDeltaPct),
    raceTargetDeltaPct: race.targetDeltaPct,
    totalPct: race.totalPct,
    segmentElapsedSeconds: timing.elapsedSeconds ?? segment.elapsedSeconds ?? 0,
    segmentTargetSeconds: timing.targetSeconds,
    cumulativeTargetSeconds: timing.cumulativeTargetSeconds,
    elapsedSeconds: segment.elapsedSeconds ?? 0,
    completedAt: segment.completedAt ?? new Date().toISOString(),
  };
}

function raceSettlementNotice(
  race: UsageRace,
  session: ActiveSession | undefined,
  nowMs: number,
): QuotaRaceSettledDetail | null {
  if (race.status !== "completed" && race.status !== "expired" && race.status !== "lost") return null;
  const consumed = raceConsumedDelta(race, session);
  return {
    raceId: race.id,
    provider: race.provider,
    alias: race.alias,
    accountKey: race.accountKey,
    status: race.status,
    targetDeltaPct: race.targetDeltaPct,
    consumedDeltaPct: consumed,
    totalPct: race.totalPct,
    completedSegments: race.segments.filter((segment) => segment.completedAt != null).length,
    segmentsTotal: race.segments.length,
    elapsedSeconds: raceElapsedSeconds(race, nowMs),
  };
}

export default function SessionRacePanel({ snapshots, recommendation: _recommendation, pluginUsageStatuses, onRefresh }: Props) {
  void _recommendation;
  const { colors } = useAccountColors();
  const { histories, refetch: refetchHistories, loading: historiesLoading } = useAllHistories();
  const notifiedSegmentKeysRef = useRef<Set<string>>(new Set());
  const segmentNotificationsReadyRef = useRef(false);
  const notifiedSettlementKeysRef = useRef<Set<string>>(new Set());
  const settlementNotificationsReadyRef = useRef(false);
  const [nowMs, setNowMs] = useState(Date.now());
  const [races, setRaces] = useState<UsageRace[]>(() => loadRaces());
  const [selectedKey, setSelectedKey] = useState<string | null>(() => localStorage.getItem(QUOTA_RACE_SELECTED_STORAGE_KEY));
  const [expandedRaceId, setExpandedRaceId] = useState<string | null>(null);
  const [focusedRaceId, setFocusedRaceId] = useState<string | null>(() => localStorage.getItem(QUOTA_RACE_FOCUSED_STORAGE_KEY));
  const [showHistoryView, setShowHistoryView] = useState(false);
  const [deleteRaceId, setDeleteRaceId] = useState<string | null>(null);
  const [draftSeedKey, setDraftSeedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<RaceDraft>({ durationMinutes: "300", targetPct: "", stepPct: String(DEFAULT_STEP_PCT) });

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const syncRaceNavigationState = () => {
      setSelectedKey(localStorage.getItem(QUOTA_RACE_SELECTED_STORAGE_KEY));
      setFocusedRaceId(localStorage.getItem(QUOTA_RACE_FOCUSED_STORAGE_KEY));
    };
    window.addEventListener(QUOTA_RACE_UPDATED_EVENT, syncRaceNavigationState);
    window.addEventListener("storage", syncRaceNavigationState);
    return () => {
      window.removeEventListener(QUOTA_RACE_UPDATED_EVENT, syncRaceNavigationState);
      window.removeEventListener("storage", syncRaceNavigationState);
    };
  }, []);

  const activeRaces = useMemo(
    () => races.filter((race) => race.status === "active"),
    [races],
  );
  const activeRaceAccountKeys = useMemo(
    () => new Set(activeRaces.map((race) => race.accountKey)),
    [activeRaces],
  );

  const activeSessions = useMemo(
    () => buildActiveSessions(snapshots, histories, nowMs, colors, activeRaceAccountKeys),
    [snapshots, histories, nowMs, colors, activeRaceAccountKeys],
  );

  const sessionsByKey = useMemo(
    () => new Map(activeSessions.map((session) => [session.key, session])),
    [activeSessions],
  );
  const freshPluginKeys = useMemo(() => new Set(pluginUsageStatuses
    .filter((status) => nowMs - new Date(status.updated_at).getTime() <= PLUGIN_STATUS_FRESH_MS)
    .map((status) => status.account_key)),
  [nowMs, pluginUsageStatuses]);

  useEffect(() => {
    if (selectedKey && sessionsByKey.has(selectedKey)) return;
    const first = activeSessions[0];
    if (first) setSelectedKey(first.key);
  }, [activeSessions, selectedKey, sessionsByKey]);

  useEffect(() => {
    if (!selectedKey) return;
    setSelectedQuotaRaceAccountKey(selectedKey);
  }, [selectedKey]);

  useEffect(() => {
    localStorage.setItem(QUOTA_RACES_STORAGE_KEY, JSON.stringify(races.slice(0, MAX_SAVED_RACES)));
    notifyQuotaRacesUpdated();
  }, [races]);

  useEffect(() => {
    setFocusedQuotaRaceId(focusedRaceId);
  }, [focusedRaceId]);

  useEffect(() => {
    setRaces((previous) => updateRaceProgress(previous, sessionsByKey, nowMs));
  }, [nowMs, sessionsByKey]);

  useEffect(() => {
    setRaces((previous) => repairObservedRaceTimings(previous, histories, Date.now()));
  }, [histories]);

  useEffect(() => {
    const completedSegments: Array<{ key: string; detail: QuotaSegmentCompletedDetail }> = [];
    for (const race of races) {
      for (const segment of race.segments) {
        if (segment.completedAt == null) continue;
        const key = `${race.id}:${segment.index}`;
        completedSegments.push({
          key,
          detail: completedSegmentNotice(race, segment, sessionsByKey.get(race.accountKey)),
        });
      }
    }

    if (!segmentNotificationsReadyRef.current) {
      for (const { key } of completedSegments) notifiedSegmentKeysRef.current.add(key);
      segmentNotificationsReadyRef.current = true;
      return;
    }

    for (const { key, detail } of completedSegments) {
      if (notifiedSegmentKeysRef.current.has(key)) continue;
      notifiedSegmentKeysRef.current.add(key);
      dispatchQuotaSegmentCompleted(detail);
    }
  }, [races, sessionsByKey]);

  useEffect(() => {
    const settledRaces: Array<{ key: string; detail: QuotaRaceSettledDetail }> = [];
    for (const race of races) {
      const detail = raceSettlementNotice(race, sessionsByKey.get(race.accountKey), nowMs);
      if (!detail) continue;
      settledRaces.push({ key: `${race.id}:${race.status}`, detail });
    }

    if (!settlementNotificationsReadyRef.current) {
      for (const { key } of settledRaces) notifiedSettlementKeysRef.current.add(key);
      settlementNotificationsReadyRef.current = true;
      return;
    }

    for (const { key, detail } of settledRaces) {
      if (notifiedSettlementKeysRef.current.has(key)) continue;
      notifiedSettlementKeysRef.current.add(key);
      dispatchQuotaRaceSettled(detail);
    }
  }, [nowMs, races, sessionsByKey]);

  useEffect(() => {
    const session = selectedKey ? sessionsByKey.get(selectedKey) : null;
    if (!session) return;
    const seedKey = `${session.key}:${session.resetKey}`;
    if (draftSeedKey === seedKey) return;
    setDraft({
      durationMinutes: String(Math.max(5, Math.ceil(session.remainingSeconds / 60))),
      targetPct: String(Math.max(1, Math.floor(session.remainingNormPct))),
      stepPct: String(DEFAULT_STEP_PCT),
    });
    setDraftSeedKey(seedKey);
  }, [draftSeedKey, selectedKey, sessionsByKey]);

  const selectedSession = selectedKey ? sessionsByKey.get(selectedKey) ?? null : null;

  useEffect(() => {
    if (!selectedSession) return;
    const maxTargetPct = Math.max(1, Math.floor(selectedSession.remainingNormPct));
    setDraft((current) => {
      const currentTarget = parseDraftNumber(current.targetPct, maxTargetPct);
      if (currentTarget <= maxTargetPct) return current;
      return { ...current, targetPct: String(maxTargetPct) };
    });
  }, [selectedSession?.key, selectedSession?.remainingNormPct]);

  const selectedActiveRace = useMemo(
    () => activeRaces.find((race) => race.accountKey === selectedKey) ?? null,
    [activeRaces, selectedKey],
  );
  const activeRace = selectedActiveRace;

  const estimatedDurationSeconds = useMemo(() => {
    if (!selectedSession) return null;
    const maxTargetPct = Math.max(1, Math.floor(selectedSession.remainingNormPct));
    const targetPct = Math.round(clamp(parseDraftNumber(draft.targetPct, maxTargetPct), 1, maxTargetPct));
    return estimateDurationFromRecentSessions(
      selectedSession,
      histories[selectedSession.key] ?? [],
      nowMs,
      targetPct,
    );
  }, [draft.targetPct, histories, nowMs, selectedSession]);

  const refreshAll = useCallback(() => {
    void refetchHistories();
    onRefresh();
  }, [onRefresh, refetchHistories]);

  const selectSession = useCallback((key: string) => {
    setSelectedKey(key);
  }, []);

  const startRace = useCallback(() => {
    if (!selectedSession) return;
    const durationSeconds = clamp(Math.round(parseDraftNumber(draft.durationMinutes, 300) * 60), 1, 24 * 3600);
    if (durationSeconds > Math.floor(selectedSession.remainingSeconds)) return;
    const maxTargetPct = Math.max(1, Math.floor(selectedSession.remainingNormPct));
    const targetPct = Math.round(clamp(parseDraftNumber(draft.targetPct, maxTargetPct), 1, maxTargetPct));
    const stepPct = Math.round(clamp(parseDraftNumber(draft.stepPct, DEFAULT_STEP_PCT), 1, 20));
    const nowIso = new Date().toISOString();
    const race: UsageRace = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      provider: selectedSession.provider,
      alias: selectedSession.alias,
      accountKey: selectedSession.key,
      createdAt: nowIso,
      startedAt: nowIso,
      durationSeconds,
      targetDeltaPct: round2(targetPct),
      stepPct: round2(stepPct),
      startNormPct: round2(selectedSession.currentNormPct),
      startRawPct: round2(selectedSession.currentRawPct),
      totalPct: selectedSession.totalPct,
      resetAt: selectedSession.resetAt,
      resetKey: selectedSession.resetKey,
      status: "active",
      segments: buildSegments(targetPct, stepPct),
    };
    setRaces((previous) => [race, ...previous.filter((item) => item.id !== race.id)].slice(0, MAX_SAVED_RACES));
    setExpandedRaceId(race.id);
    setFocusedRaceId(race.id);
  }, [draft, selectedSession]);

  const stopRace = useCallback((raceId: string) => {
    setRaces((previous) => previous.map((race) => (
      race.id === raceId && race.status === "active" ? { ...race, status: "expired" } : race
    )));
  }, []);

  const requestDeleteRace = useCallback((raceId: string) => {
    setDeleteRaceId(raceId);
  }, []);

  const confirmDeleteRace = useCallback(() => {
    if (!deleteRaceId) return;
    setRaces((previous) => previous.filter((item) => item.id !== deleteRaceId));
    setExpandedRaceId((current) => current === deleteRaceId ? null : current);
    setFocusedRaceId((current) => current === deleteRaceId ? null : current);
    setDeleteRaceId(null);
  }, [deleteRaceId]);

  const pendingDeleteRace = deleteRaceId ? races.find((race) => race.id === deleteRaceId) ?? null : null;
  const deleteDialog = pendingDeleteRace ? (
    <DeleteRaceConfirmDialog
      race={pendingDeleteRace}
      onCancel={() => setDeleteRaceId(null)}
      onConfirm={confirmDeleteRace}
    />
  ) : null;

  const focusedRace = focusedRaceId ? races.find((race) => race.id === focusedRaceId) ?? null : null;

  useEffect(() => {
    if (focusedRaceId && !focusedRace) setFocusedRaceId(null);
  }, [focusedRace, focusedRaceId]);

  if (focusedRace) {
    return (
      <section>
        <FocusedRaceView
          race={focusedRace}
          session={sessionsByKey.get(focusedRace.accountKey)}
          nowMs={nowMs}
          onBack={() => setFocusedRaceId(null)}
          onStop={() => stopRace(focusedRace.id)}
        />
        {deleteDialog}
      </section>
    );
  }

  if (showHistoryView) {
    return (
      <section>
        <RaceHistoryPanel
          races={races}
          activeSessions={sessionsByKey}
          expandedRaceId={expandedRaceId}
          onToggle={(raceId) => setExpandedRaceId((current) => current === raceId ? null : raceId)}
          onDelete={requestDeleteRace}
          onBack={() => setShowHistoryView(false)}
          fullView
        />
        {deleteDialog}
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-base font-semibold" style={{ color: "#f3f4f6" }}>额度小目标竞赛</div>
          <div className="text-xs" style={{ color: "#858585" }}>
            {activeSessions.length > 0 ? `${activeSessions.length} 个进行中的 5h session` : "当前没有可追踪的进行中 session"}
            {historiesLoading ? " · 历史同步中" : ""}
          </div>
        </div>
        <div className="flex items-center gap-2" style={{ flexShrink: 0 }}>
          <button
            type="button"
            onClick={() => setShowHistoryView(true)}
            title="打开历史记录"
            className="inline-flex items-center justify-center gap-1.5"
            style={{ height: 30, padding: "0 10px", borderRadius: 6, border: "1px solid #3a3a3a", background: "#202020", color: "#d1d5db", fontSize: 12, fontWeight: 600 }}
          >
            <History size={14} />
            历史记录
          </button>
          <button
            type="button"
            onClick={refreshAll}
            title="刷新用量"
            className="inline-flex items-center justify-center"
            style={{ width: 30, height: 30, borderRadius: 6, border: "1px solid #3a3a3a", background: "#202020", color: "#d1d5db" }}
          >
            <RefreshCw size={15} />
          </button>
        </div>
      </div>

      {activeRaces.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3 text-[11px]" style={{ color: "#858585" }}>
            <span>进行中的竞赛</span>
            <span>{activeRaces.length} 个账号</span>
          </div>
          <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
            {activeRaces.map((race) => {
              const session = sessionsByKey.get(race.accountKey);
              const isSelectedRace = race.accountKey === selectedKey;
              const raceColor = session?.color ?? providerColor(race.provider);
              return (
                <ActiveRaceShortcut
                  key={race.id}
                  race={race}
                  session={session}
                  nowMs={nowMs}
                  title={isSelectedRace ? "当前账号竞赛" : "进行中的竞赛"}
                  context={`${providerLabel(race.provider)} · ${shortAlias(race.alias)}`}
                  tone={isSelectedRace ? "selected" : "global"}
                  colorOverride={raceColor}
                  onOpen={() => setFocusedRaceId(race.id)}
                  onStop={() => stopRace(race.id)}
                />
              );
            })}
          </div>
        </div>
      )}

      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
        <div className="space-y-3" style={{ minWidth: 0 }}>
          <TimelinePanel
            sessions={activeSessions}
            selectedKey={selectedKey}
            races={races}
            nowMs={nowMs}
            freshPluginKeys={freshPluginKeys}
            onSelect={selectSession}
          />
        </div>

        <div className="space-y-3" style={{ minWidth: 0 }}>
          <RaceBuilder
            session={selectedSession}
            draft={draft}
            activeRace={activeRace}
            races={races}
            estimatedDurationSeconds={estimatedDurationSeconds}
            onDraftChange={setDraft}
            onStart={startRace}
          />
        </div>
      </div>

      {deleteDialog}
    </section>
  );
}

function TimelinePanel({
  sessions,
  selectedKey,
  races,
  nowMs,
  freshPluginKeys,
  onSelect,
}: {
  sessions: ActiveSession[];
  selectedKey: string | null;
  races: UsageRace[];
  nowMs: number;
  freshPluginKeys: Set<string>;
  onSelect: (key: string) => void;
}) {
  const activeRaceByKey = new Map(races
    .filter((race) => race.status === "active")
    .map((race) => [race.accountKey, race]));
  const maxRemainingHours = Math.max(SESSION_HOURS, ...sessions.map((session) => session.remainingSeconds / 3600));
  const timelineHours = Math.min(SESSION_HOURS, Math.max(1, Math.ceil(maxRemainingHours)));
  const timelineWidth = timelineHours * PX_PER_HOUR;
  const nowDate = new Date(nowMs);
  const minutesPastHour = nowDate.getMinutes() + nowDate.getSeconds() / 60;
  const hoursToNextHour = minutesPastHour === 0 ? 0 : 1 - minutesPastHour / 60;
  const hourTicks: { offsetHour: number; label: string }[] = [];
  for (let i = 0; i <= timelineHours; i += 1) {
    const offsetHour = hoursToNextHour + i;
    if (offsetHour > timelineHours) break;
    const d = new Date(nowMs + offsetHour * 3600_000);
    hourTicks.push({ offsetHour, label: `${String(d.getHours()).padStart(2, "0")}:00` });
  }

  return (
    <div className="card p-0 overflow-hidden">
      <div className="px-4 py-2.5 flex items-center justify-between" style={{ borderBottom: "1px solid #3a3a3a" }}>
        <span className="text-sm font-semibold" style={{ color: "#ddd" }}>选择账号追踪</span>
        <span className="text-[11px]" style={{ color: "#858585" }}>点击时间块建立竞赛</span>
      </div>
      {sessions.length === 0 ? (
        <div className="py-8 text-center text-xs" style={{ color: "#777" }}>暂无进行中的 session</div>
      ) : (
        <div className="overflow-x-auto" style={{ paddingBottom: 4 }}>
          <div style={{ display: "flex", minWidth: LABEL_W + timelineWidth }}>
            <div style={{ width: LABEL_W, flexShrink: 0 }}>
              <div style={{ height: HEADER_H, borderBottom: "1px solid #2e2e2e" }} />
              {sessions.map((session) => {
                const activeRace = activeRaceByKey.get(session.key) ?? null;
                return (
                  <button
                    key={session.key}
                    type="button"
                    onClick={() => onSelect(session.key)}
                    style={{
                      width: "100%",
                      height: ROW_H,
                      display: "flex",
                      alignItems: "center",
                      gap: 9,
                      padding: "0 10px",
                      border: 0,
                      borderBottom: "1px solid #2e2e2e",
                      background: selectedKey === session.key ? "#252128" : "#202020",
                      textAlign: "left",
                      cursor: "pointer",
                    }}
                  >
                    <ProviderBadge provider={session.provider} color={session.color} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="text-xs font-semibold truncate" style={{ color: "#ddd" }}>{shortAlias(session.alias)}</div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px]" style={{ color: "#858585" }}>{providerLabel(session.provider)}</span>
                        {session.provider !== "codex" && !freshPluginKeys.has(session.key) && <PluginCollectMarker />}
                      </div>
                      {activeRace != null && (
                        <div className="inline-flex items-center gap-1 text-[10px]" style={{ color: session.color }}>
                          <Flag size={10} />
                          进行中
                        </div>
                      )}
                    </div>
                    <CircularPercent
                      pct={session.currentNormPct}
                      color={session.color}
                      size={38}
                      targetStartPct={activeRace?.startNormPct}
                      targetEndPct={activeRace != null ? activeRace.startNormPct + activeRace.targetDeltaPct : undefined}
                    />
                  </button>
                );
              })}
            </div>

            <div style={{ position: "relative", width: timelineWidth, flexShrink: 0 }}>
              <div style={{ position: "relative", height: HEADER_H, background: "#222", borderBottom: "1px solid #2e2e2e" }}>
                <span style={{ position: "absolute", bottom: 4, left: 4, fontSize: 10, color: "#cc785c", fontWeight: 700 }}>现在</span>
                {hourTicks.map(({ offsetHour, label }) => (
                  <span
                    key={label}
                    style={{
                      position: "absolute",
                      bottom: 4,
                      left: offsetHour * PX_PER_HOUR + 3,
                      fontSize: 9,
                      color: "#888",
                      whiteSpace: "nowrap",
                      pointerEvents: "none",
                    }}
                  >
                    {label}
                  </span>
                ))}
              </div>

              {sessions.map((session, index) => {
                const selected = selectedKey === session.key;
                const blockWidth = Math.max(34, Math.min(session.remainingSeconds / 3600, timelineHours) * PX_PER_HOUR - 4);
                const activeRace = activeRaceByKey.get(session.key) ?? null;
                const raceTargetLeft = activeRace != null
                  ? ((new Date(activeRace.startedAt).getTime() - nowMs) / 3600_000) * PX_PER_HOUR + 2
                  : 0;
                const raceTargetWidth = activeRace != null
                  ? Math.max(28, activeRace.durationSeconds / 3600 * PX_PER_HOUR - 4)
                  : 0;
                const raceTargetVisible = activeRace != null
                  && raceTargetLeft < timelineWidth - 2
                  && raceTargetLeft + raceTargetWidth > 2;
                return (
                  <button
                    key={session.key}
                    type="button"
                    onClick={() => onSelect(session.key)}
                    style={{
                      position: "relative",
                      display: "block",
                      width: "100%",
                      height: ROW_H,
                      border: 0,
                      borderBottom: "1px solid #2e2e2e",
                      background: selected ? "#252128" : index % 2 === 0 ? "#1e1e1e" : "#1a1a1a",
                      cursor: "pointer",
                      textAlign: "left",
                      overflow: "hidden",
                    }}
                  >
                    {hourTicks.map(({ offsetHour, label }) => (
                      <span
                        key={label}
                        style={{
                          position: "absolute",
                          left: offsetHour * PX_PER_HOUR,
                          top: 0,
                          bottom: 0,
                          borderLeft: "1px solid #2a2a2a",
                          pointerEvents: "none",
                        }}
                      />
                    ))}
                    <span
                      style={{
                        position: "absolute",
                        left: 2,
                        top: 10,
                        width: blockWidth,
                        height: ROW_H - 20,
                        borderRadius: 5,
                        background: `${session.color}${selected ? "33" : "18"}`,
                        border: `${selected ? 2 : 1}px solid ${session.color}${selected ? "" : "99"}`,
                        color: session.color,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 6,
                        fontSize: 11,
                        fontWeight: 700,
                      }}
                    >
                      <span>{formatShortDuration(session.remainingSeconds)} 后重置</span>
                    </span>
                    {raceTargetVisible && activeRace != null && (
                      <span
                        title={`竞赛目标时长 ${formatDetailedHms(activeRace.durationSeconds)}`}
                        style={{
                          position: "absolute",
                          left: raceTargetLeft,
                          top: 24,
                          width: raceTargetWidth,
                          height: 10,
                          borderRadius: 999,
                          background: `${session.color}16`,
                          border: `1px dashed ${session.color}`,
                          zIndex: 2,
                          pointerEvents: "none",
                        }}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PluginCollectMarker() {
  return (
    <span
      title="未检测到 Chrome 插件实时采集；竞赛建议打开对应网页并让插件上报额度"
      className="inline-flex items-center justify-center"
      style={{
        width: 15,
        height: 15,
        borderRadius: 999,
        border: "1px solid #4a3d20",
        background: "#2a2418",
        color: "#f6c177",
        fontSize: 11,
        fontWeight: 800,
        lineHeight: 1,
        flexShrink: 0,
      }}
    >
      !
    </span>
  );
}

function RaceBuilder({
  session,
  draft,
  activeRace,
  races,
  estimatedDurationSeconds,
  onDraftChange,
  onStart,
}: {
  session: ActiveSession | null;
  draft: RaceDraft;
  activeRace: UsageRace | null;
  races: UsageRace[];
  estimatedDurationSeconds: number | null;
  onDraftChange: (draft: RaceDraft) => void;
  onStart: () => void;
}) {
  const [showHistoricalReference, setShowHistoricalReference] = useState(false);
  const maxTargetPct = session ? Math.max(1, Math.floor(session.remainingNormPct)) : 1;
  const targetPct = session ? Math.round(clamp(parseDraftNumber(draft.targetPct, maxTargetPct), 1, maxTargetPct)) : 0;
  const targetRaw = session ? rawFromNorm(targetPct, session.totalPct) : 0;
  const stepLabel = Math.round(clamp(parseDraftNumber(draft.stepPct, DEFAULT_STEP_PCT), 1, 20));
  const durationParts = durationPartsFromMinutes(draft.durationMinutes);
  const requestedDurationSeconds = durationParts.minutes * 60 + durationParts.seconds;
  const stepTargetSeconds = targetPct > 0
    ? requestedDurationSeconds * Math.min(stepLabel, targetPct) / targetPct
    : null;
  const maxAllowedDurationSeconds = session ? Math.max(0, Math.floor(session.remainingSeconds)) : 0;
  const durationExceedsSession = session != null && requestedDurationSeconds > maxAllowedDurationSeconds;
  const startDisabled = activeRace != null || session == null || session.remainingNormPct <= 0 || durationExceedsSession;
  const startLabel = activeRace
    ? "这个账号已有进行中竞赛"
    : durationExceedsSession
      ? "超过了最大允许时间"
      : "开始竞赛";
  const setDurationMinutes = (value: string) => {
    const parsed = parseDraftNumber(value, durationParts.minutes);
    onDraftChange({
      ...draft,
      durationMinutes: durationStringFromParts(Math.max(0, parsed), durationParts.seconds),
    });
  };
  const setDurationSeconds = (value: string) => {
    const parsed = parseDraftNumber(value, durationParts.seconds);
    onDraftChange({
      ...draft,
      durationMinutes: durationStringFromParts(durationParts.minutes, clamp(parsed, 0, 59)),
    });
  };
  const writeEstimatedDuration = () => {
    if (estimatedDurationSeconds == null) return;
    onDraftChange({
      ...draft,
      durationMinutes: durationStringFromSeconds(clamp(estimatedDurationSeconds, 60, 24 * 3600)),
    });
  };
  const writeRemainingDuration = () => {
    if (!session) return;
    onDraftChange({
      ...draft,
      durationMinutes: durationStringFromSeconds(maxAllowedDurationSeconds),
    });
  };
  return (
    <div className="card p-0" style={{ position: "relative" }}>
      <div className="px-4 py-2.5 flex items-center gap-2" style={{ borderBottom: "1px solid #3a3a3a" }}>
        <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
          <Target size={15} style={{ color: session?.color ?? "#aaa", flexShrink: 0 }} />
          <span className="text-sm font-semibold truncate" style={{ color: "#ddd" }}>建立额度使用小目标竞赛</span>
        </div>
      </div>
      {!session ? (
        <div className="py-8 text-center text-xs" style={{ color: "#777" }}>先在选择账号追踪里选择一个进行中的 session</div>
      ) : (
        <div className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div style={{ minWidth: 0 }}>
              <div className="text-sm font-semibold truncate" style={{ color: "#f3f4f6" }}>{session.alias}</div>
              <div className="text-[11px]" style={{ color: "#858585" }}>{providerLabel(session.provider)} · {formatLocalTime(session.resetAt)} 重置</div>
            </div>
            <div className="text-right font-mono" style={{ flexShrink: 0 }}>
              <div className="text-xs" style={{ color: session.color }}>{formatWholePct(session.currentNormPct)} / 100%</div>
              <div className="text-[10px]" style={{ color: "#858585" }}>{formatWhole(session.currentRawPct)} / {formatWhole(session.totalPct)}</div>
            </div>
          </div>

          <div className="space-y-1.5">
            <div
              className="grid gap-2 text-[11px] font-medium"
              style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))", color: "#d4d4d4" }}
            >
              <span className="inline-flex items-center gap-1.5" style={{ gridColumn: "span 2", minWidth: 0 }}>
                <span>多长时间完成</span>
                <IconActionButton
                  title={estimatedDurationSeconds == null ? "最近两个 session 暂无足够活跃额度记录" : `按最近两个 session 活跃速度估算：${formatShortDuration(estimatedDurationSeconds)}`}
                  disabled={estimatedDurationSeconds == null}
                  onClick={writeEstimatedDuration}
                >
                  <TimerReset size={12} />
                </IconActionButton>
                <IconActionButton
                  title={`写入当前 session 剩余时间：${formatShortDuration(maxAllowedDurationSeconds)}`}
                  onClick={writeRemainingDuration}
                >
                  <Timer size={12} />
                </IconActionButton>
              </span>
              <span>总目标额度</span>
              <span>每个小目标额度</span>
            </div>
            <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
              <NumberField
                value={String(durationParts.minutes)}
                min={0}
                step={1}
                suffix="m"
                tone={durationExceedsSession ? "danger" : "normal"}
                onChange={setDurationMinutes}
              />
              <NumberField
                value={String(durationParts.seconds)}
                min={0}
                max={59}
                step={5}
                suffix="s"
                tone={durationExceedsSession ? "danger" : "normal"}
                onChange={setDurationSeconds}
              />
              <NumberField
                value={draft.targetPct}
                min={1}
                max={maxTargetPct}
                step={1}
                suffix="%"
                onChange={(value) => onDraftChange({ ...draft, targetPct: value })}
              />
              <NumberField
                value={draft.stepPct}
                min={1}
                max={20}
                step={1}
                suffix="%"
                onChange={(value) => onDraftChange({ ...draft, stepPct: value })}
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 text-[11px]" style={{ color: "#a3a3a3" }}>
            <div className="flex items-center gap-1.5" style={{ minWidth: 0, color: durationExceedsSession ? TIMER_OVER_COLOR : undefined }}>
              {durationExceedsSession ? (
                <span className="truncate">超过最大允许时间 {formatDetailedHms(maxAllowedDurationSeconds)}</span>
              ) : (
                <>
                  <span className="truncate">默认每 {stepLabel}% 自动记录一次</span>
                  <span
                    className="inline-flex items-center font-mono font-semibold"
                    style={{
                      height: 20,
                      padding: "0 8px",
                      borderRadius: 999,
                      border: "1px solid #7c3aed66",
                      background: "#2b1f37",
                      color: TIMER_OK_COLOR,
                      boxShadow: `0 0 14px ${TIMER_OK_COLOR}22`,
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                    }}
                  >
                    每段目标 {formatDetailedHms(stepTargetSeconds)}
                  </span>
                  <IconActionButton
                    title="历史小目标参考"
                    onClick={() => setShowHistoricalReference(true)}
                  >
                    <History size={12} />
                  </IconActionButton>
                </>
              )}
            </div>
            <span className="font-mono" style={{ color: session.color }}>映射 {formatWhole(targetRaw)} / {formatWhole(session.totalPct)}</span>
          </div>

          <button
            type="button"
            className="btn-primary w-full inline-flex items-center justify-center gap-2"
            disabled={startDisabled}
            onClick={onStart}
          >
            <Flag size={14} />
            <span>{startLabel}</span>
          </button>
        </div>
      )}
      {session && showHistoricalReference && (
        <HistoricalRaceReference
          session={session}
          races={races}
          color={session.color}
          onClose={() => setShowHistoricalReference(false)}
        />
      )}
    </div>
  );
}

interface HistoricalReferenceSegment {
  index: number;
  targetDeltaPct: number;
  cumulativeDeltaPct: number;
  elapsedSeconds: number;
  totalElapsedSeconds: number;
  targetSeconds: number;
}

interface HistoricalReferenceRace {
  race: UsageRace;
  averageSegmentSeconds: number;
  completedCount: number;
  segments: HistoricalReferenceSegment[];
}

function HistoricalRaceReference({
  session,
  races,
  color,
  onClose,
}: {
  session: ActiveSession;
  races: UsageRace[];
  color: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const referenceRaces = useMemo<HistoricalReferenceRace[]>(() => {
    const result: HistoricalReferenceRace[] = [];
    for (const race of races) {
      if (race.accountKey !== session.key || race.status === "active") continue;
      const completedSegments: HistoricalReferenceSegment[] = [];
      for (const segment of race.segments) {
        if (segment.completedAt == null || segment.elapsedSeconds == null) continue;
        const timing = segmentTiming(race, segment);
        if (timing.elapsedSeconds == null || timing.totalElapsedSeconds == null) continue;
        completedSegments.push({
          index: segment.index,
          targetDeltaPct: segment.targetDeltaPct,
          cumulativeDeltaPct: segment.cumulativeDeltaPct,
          elapsedSeconds: timing.elapsedSeconds,
          totalElapsedSeconds: timing.totalElapsedSeconds,
          targetSeconds: timing.targetSeconds,
        });
      }
      if (completedSegments.length === 0) continue;
      const averageSegmentSeconds = completedSegments.reduce((sum, item) => sum + item.elapsedSeconds, 0) / completedSegments.length;
      result.push({
        race,
        averageSegmentSeconds,
        completedCount: completedSegments.length,
        segments: completedSegments.slice(0, 8),
      });
    }
    return result
      .sort((a, b) => new Date(b.race.startedAt).getTime() - new Date(a.race.startedAt).getTime())
      .slice(0, 2);
  }, [races, session.key]);

  if (referenceRaces.length === 0) {
    return (
      <FloatingReferenceShell color={color} onClose={onClose} segmentCount={0} raceCount={0}>
        <div
          className="flex items-center gap-2 text-[11px]"
          style={{ border: "1px dashed #3a3a3a", borderRadius: 8, padding: "12px 10px", color: "#858585" }}
        >
          <History size={13} />
          <span>暂无同账号历史竞赛小目标用时</span>
        </div>
      </FloatingReferenceShell>
    );
  }

  const totalSegments = referenceRaces.reduce((sum, item) => sum + item.completedCount, 0);
  return (
    <FloatingReferenceShell color={color} onClose={onClose} segmentCount={totalSegments} raceCount={referenceRaces.length}>
      <div className="space-y-2">
        {referenceRaces.map((item) => (
          <div
            key={item.race.id}
            style={{
              border: "1px solid #333",
              borderRadius: 8,
              background: "#1f1f1f",
              padding: 8,
            }}
          >
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="flex items-center gap-2 min-w-0">
                <StatusBadge status={item.race.status} />
                <span className="text-[11px] truncate" style={{ color: "#bdbdbd" }}>
                  {formatLocalTime(item.race.startedAt)} · {formatShortDuration(item.race.durationSeconds)}
                </span>
              </div>
              <span className="text-[11px] font-mono" style={{ color, flexShrink: 0 }}>
                均值 {formatShortDuration(item.averageSegmentSeconds)}
              </span>
            </div>
            <div className="space-y-1.5">
              {item.segments.map((segment) => {
                const isOver = segment.elapsedSeconds > segment.targetSeconds;
                return (
                  <div
                    key={`${item.race.id}-${segment.index}`}
                    className="grid items-center gap-2 text-[11px]"
                    style={{
                      gridTemplateColumns: "minmax(72px, 1fr) minmax(46px, auto) minmax(66px, auto) minmax(66px, auto)",
                      border: `1px solid ${isOver ? "#5a3535" : "#355a35"}`,
                      borderRadius: 7,
                      background: isOver ? "#302424" : "#203120",
                      color: "#d6f5d6",
                      padding: "7px 9px",
                    }}
                  >
                    <span className="inline-flex items-center gap-1.5" style={{ minWidth: 0 }}>
                      <Trophy size={11} style={{ color: isOver ? TIMER_OVER_COLOR : RECORD_OK_COLOR, flexShrink: 0 }} />
                      <span className="truncate">#{segment.index} +{formatWholePct(segment.targetDeltaPct)}</span>
                    </span>
                    <span>到 {formatWholePct(segment.cumulativeDeltaPct)}</span>
                    <span className="text-right" style={{ color: isOver ? TIMER_OVER_COLOR : RECORD_OK_COLOR }}>
                      用时 {formatShortDuration(segment.elapsedSeconds)}
                    </span>
                    <span className="text-right" style={{ color: "#a3a3a3" }}>
                      累计 {formatShortDuration(segment.totalElapsedSeconds)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </FloatingReferenceShell>
  );
}

function FloatingReferenceShell({
  color,
  raceCount,
  segmentCount,
  onClose,
  children,
}: {
  color: string;
  raceCount: number;
  segmentCount: number;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <div
        className="fixed inset-0"
        style={{ zIndex: 72, background: "rgba(0, 0, 0, 0.14)" }}
        onClick={onClose}
      />
      <div
        className="fixed"
        style={{
          zIndex: 73,
          top: 86,
          right: 16,
          width: "min(560px, calc(100vw - 32px))",
          maxHeight: "calc(100vh - 116px)",
          overflowY: "auto",
          border: `1px solid ${color}66`,
          borderRadius: 9,
          background: "#191919",
          boxShadow: "0 22px 64px rgba(0, 0, 0, 0.56)",
          padding: 12,
        }}
      >
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
            <span
              className="inline-flex items-center justify-center"
              style={{ width: 24, height: 24, borderRadius: 6, background: `${color}22`, color, flexShrink: 0 }}
            >
              <History size={13} />
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="text-xs font-semibold" style={{ color: "#f3f4f6" }}>历史小目标参考</div>
              <div className="text-[10px] font-mono" style={{ color: "#858585" }}>{raceCount} 场 · {segmentCount} 段</div>
            </div>
          </div>
          <button
            type="button"
            title="关闭"
            onClick={onClose}
            className="inline-flex items-center justify-center"
            style={{ width: 24, height: 24, borderRadius: 6, border: "1px solid #3a3a3a", background: "#202020", color: "#aaa", flexShrink: 0 }}
          >
            <X size={13} />
          </button>
        </div>
        {children}
      </div>
    </>
  );
}

function FocusedRaceView({
  race,
  session,
  nowMs,
  onBack,
  onStop,
}: {
  race: UsageRace;
  session: ActiveSession | undefined;
  nowMs: number;
  onBack: () => void;
  onStop: () => void;
}) {
  const [liveNowMs, setLiveNowMs] = useState(nowMs);
  const [showAbandonConfirm, setShowAbandonConfirm] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setLiveNowMs(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setLiveNowMs(nowMs);
  }, [nowMs]);

  const color = session?.color ?? providerColor(race.provider);
  const consumed = raceConsumedDelta(race, session);
  const progress = race.targetDeltaPct > 0 ? (consumed / race.targetDeltaPct) * 100 : 0;
  const nextSegment = openSegment(race) ?? race.segments[race.segments.length - 1] ?? null;
  const currentTiming = nextSegment ? segmentTiming(race, nextSegment, liveNowMs) : null;
  const currentSegmentElapsed = currentTiming?.elapsedSeconds ?? 0;
  const currentSegmentTarget = currentTiming?.targetSeconds ?? race.durationSeconds;
  const totalElapsed = raceElapsedSeconds(race, liveNowMs);
  const totalProgressTarget = currentTiming?.cumulativeTargetSeconds ?? race.durationSeconds;
  const completedCount = race.segments.filter((segment) => segment.completedAt != null).length;
  const segmentRemaining = nextSegment && nextSegment.completedAt == null
    ? Math.max(0, nextSegment.cumulativeDeltaPct - consumed)
    : 0;
  const targetRaw = rawFromNorm(race.targetDeltaPct, race.totalPct);
  const consumedRaw = rawFromNorm(consumed, race.totalPct);
  const currentClockColor = race.status === "active" && currentTiming?.isSegmentOver ? TIMER_OVER_COLOR : TIMER_OK_COLOR;
  const totalClockColor = race.status === "active" && (currentTiming?.isTotalOver || totalElapsed > race.durationSeconds) ? TIMER_OVER_COLOR : TIMER_OK_COLOR;
  const showHours = race.durationSeconds >= 3600 || totalElapsed >= 3600 || currentSegmentTarget >= 3600;
  const currentTargetColor = currentTiming?.isSegmentOver ? TIMER_OVER_COLOR : RECORD_OK_COLOR;
  const totalTargetColor = currentTiming?.isTotalOver ? TIMER_OVER_COLOR : RECORD_OK_COLOR;
  const segmentSubtext = race.status === "active" && nextSegment != null && nextSegment.completedAt == null
    ? `#${nextSegment.index} 还差 ${formatWholePct(segmentRemaining)}`
    : `${completedCount} / ${race.segments.length} 个小目标`;
  const segmentTargetSubtext = `每个小目标 ${formatDetailedHms(currentSegmentTarget)}`;
  const totalTargetSubtext = `总共 ${formatDetailedHms(race.durationSeconds)}`;

  if (race.status === "completed" || race.status === "lost") {
    return (
      <RaceSettlementView
        race={race}
        session={session}
        nowMs={liveNowMs}
        onBack={onBack}
      />
    );
  }

  return (
    <>
      <div
        className="card p-0 overflow-hidden"
        style={{ minHeight: "calc(100vh - 150px)", display: "flex", flexDirection: "column" }}
      >
      <div className="px-4 py-3 flex items-center justify-between gap-3" style={{ borderBottom: "1px solid #3a3a3a" }}>
        <div className="flex items-center gap-3" style={{ minWidth: 0 }}>
          <button
            type="button"
            title="返回主页"
            onClick={onBack}
            className="inline-flex items-center justify-center"
            style={{ width: 30, height: 30, borderRadius: 6, border: "1px solid #3a3a3a", background: "#202020", color: "#d1d5db", flexShrink: 0 }}
          >
            <ArrowLeft size={15} />
          </button>
          <ProviderBadge provider={race.provider} color={color} />
          <div style={{ minWidth: 0 }}>
            <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
              <span className="text-sm font-semibold truncate" style={{ color: "#f3f4f6" }}>{race.alias}</span>
              <StatusBadge status={race.status} />
            </div>
            <div className="text-[11px]" style={{ color: "#858585" }}>
              {providerLabel(race.provider)} · {formatLocalTime(race.resetAt)} 重置
            </div>
          </div>
        </div>
        {race.status === "active" && (
          <button
            type="button"
            onClick={() => setShowAbandonConfirm(true)}
            className="inline-flex items-center justify-center gap-1.5"
            style={{ height: 30, padding: "0 10px", borderRadius: 6, border: "1px solid #5a3535", background: "#2b1d1d", color: "#fecaca", flexShrink: 0, fontSize: 12, fontWeight: 600 }}
          >
            <X size={13} />
            放弃
          </button>
        )}
      </div>

      <div className="p-3 sm:p-4 space-y-4" style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
          <FocusTimerCard
            label="当前小目标"
            seconds={currentSegmentElapsed}
            subtext={`${segmentSubtext} · ${segmentTargetSubtext}`}
            targetText={`目标 ${formatShortDuration(currentSegmentTarget)} · ${formatTargetDelta(currentSegmentElapsed, currentSegmentTarget)}`}
            targetColor={currentTargetColor}
            color={currentClockColor}
            showHours={showHours}
          />
          <FocusTimerCard
            label="总时间"
            seconds={totalElapsed}
            subtext={`${completedCount} / ${race.segments.length} 个小目标 · ${totalTargetSubtext}`}
            targetText={`当前目标 ${formatShortDuration(totalProgressTarget)} · ${formatTargetDelta(totalElapsed, totalProgressTarget)}`}
            targetColor={totalTargetColor}
            color={totalClockColor}
            showHours={showHours}
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span style={{ color: "#d4d4d4" }}>竞赛进度</span>
            <span className="font-mono" style={{ color }}>{formatWhole(consumed)} / {formatWholePct(race.targetDeltaPct)}</span>
          </div>
          <ProgressBar pct={progress} total={100} />
          <div className="grid gap-2 text-[11px]" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", color: "#858585" }}>
            <span>映射 {formatWhole(consumedRaw)} / {formatWhole(targetRaw)}</span>
            <span>每 {formatWholePct(race.stepPct)} 自动记录一次</span>
            <span>{completedCount} / {race.segments.length} 个小目标</span>
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0 }}>
          <div className="text-xs font-medium mb-2" style={{ color: "#d4d4d4" }}>自动记录</div>
          <div style={{ maxHeight: 260, overflowY: "auto", paddingRight: 2 }}>
            <SegmentList
              race={race}
              compact={false}
              nowMs={liveNowMs}
              currentDeltaPct={consumed}
            />
          </div>
        </div>
      </div>
      </div>
      {showAbandonConfirm && (
        <AbandonRaceConfirmDialog
          race={race}
          onCancel={() => setShowAbandonConfirm(false)}
          onConfirm={() => {
            setShowAbandonConfirm(false);
            onStop();
          }}
        />
      )}
    </>
  );
}

function RaceSettlementView({
  race,
  session,
  nowMs,
  onBack,
}: {
  race: UsageRace;
  session: ActiveSession | undefined;
  nowMs: number;
  onBack: () => void;
}) {
  const isWin = race.status === "completed";
  const color = session?.color ?? providerColor(race.provider);
  const consumed = raceConsumedDelta(race, session);
  const completedCount = race.segments.filter((segment) => segment.completedAt != null).length;
  const elapsed = raceElapsedSeconds(race, nowMs);
  const targetRaw = rawFromNorm(race.targetDeltaPct, race.totalPct);
  const consumedRaw = rawFromNorm(consumed, race.totalPct);
  const progress = race.targetDeltaPct > 0 ? consumed / race.targetDeltaPct * 100 : 0;
  const toneColor = isWin ? RECORD_OK_COLOR : TIMER_OVER_COLOR;
  const title = isWin ? "目标完成" : "战败";
  const subtitle = isWin
    ? "小目标竞赛已经达成，记录已写入历史。"
    : "session 已刷新，计时器仍在进行的竞赛未能完成。";
  const statusText = isWin ? "胜利结算" : "失败结算";

  return (
    <div
      className="card p-0 overflow-hidden"
      style={{ minHeight: "calc(100vh - 150px)", display: "flex", flexDirection: "column", position: "relative" }}
    >
      <div className="px-4 py-3 flex items-center justify-between gap-3" style={{ borderBottom: "1px solid #3a3a3a", position: "relative", zIndex: 2 }}>
        <div className="flex items-center gap-3" style={{ minWidth: 0 }}>
          <button
            type="button"
            title="返回主页"
            onClick={onBack}
            className="inline-flex items-center justify-center"
            style={{ width: 30, height: 30, borderRadius: 6, border: "1px solid #3a3a3a", background: "#202020", color: "#d1d5db", flexShrink: 0 }}
          >
            <ArrowLeft size={15} />
          </button>
          <ProviderBadge provider={race.provider} color={color} />
          <div style={{ minWidth: 0 }}>
            <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
              <span className="text-sm font-semibold truncate" style={{ color: "#f3f4f6" }}>{race.alias}</span>
              <StatusBadge status={race.status} />
            </div>
            <div className="text-[11px]" style={{ color: "#858585" }}>
              {providerLabel(race.provider)} · {formatLocalTime(race.startedAt)} 开始
            </div>
          </div>
        </div>
        <span className="text-[11px] font-semibold" style={{ color: toneColor, flexShrink: 0 }}>{statusText}</span>
      </div>

      <div
        className="p-4 sm:p-5"
        style={{
          flex: 1,
          display: "grid",
          gridTemplateRows: "auto auto minmax(0, 1fr)",
          gap: 16,
          position: "relative",
          zIndex: 2,
        }}
      >
        <div className="text-center" style={{ padding: "14px 0 4px" }}>
          <div
            className="inline-flex items-center justify-center"
            style={{
              width: 72,
              height: 72,
              borderRadius: 999,
              border: `1px solid ${toneColor}66`,
              background: isWin ? "#17291d" : "#2b1d1d",
              color: toneColor,
              boxShadow: `0 0 38px ${toneColor}28`,
            }}
          >
            {isWin ? <Trophy size={34} /> : <X size={34} />}
          </div>
          <div className="mt-3 text-2xl font-bold" style={{ color: "#f3f4f6", letterSpacing: 0 }}>{title}</div>
          <div className="mt-1 text-xs" style={{ color: "#a3a3a3" }}>{subtitle}</div>
        </div>

        <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))" }}>
          <SettlementMetric label="已用额度" value={`${formatWhole(consumed)} / ${formatWholePct(race.targetDeltaPct)}`} color={toneColor} />
          <SettlementMetric label="映射额度" value={`${formatWhole(consumedRaw)} / ${formatWhole(targetRaw)}`} color={color} />
          <SettlementMetric label="用时" value={formatDetailedHms(elapsed)} color={toneColor} />
          <SettlementMetric label="小目标" value={`${completedCount} / ${race.segments.length}`} color={color} />
        </div>

        <div style={{ minHeight: 0 }}>
          <div className="flex items-center justify-between gap-3 text-xs mb-2">
            <span style={{ color: "#d4d4d4" }}>结算进度</span>
            <span className="font-mono" style={{ color: toneColor }}>{formatWhole(Math.min(progress, 100))}%</span>
          </div>
          <ProgressBar pct={progress} total={100} />
          <div className="mt-3" style={{ maxHeight: 260, overflowY: "auto", paddingRight: 2 }}>
            <SegmentList race={race} compact={false} />
          </div>
        </div>
      </div>
    </div>
  );
}

function SettlementMetric({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div
      style={{
        borderRadius: 8,
        border: "1px solid #383838",
        background: "#202020",
        padding: "10px 12px",
        minWidth: 0,
      }}
    >
      <div className="text-[11px]" style={{ color: "#858585" }}>{label}</div>
      <div className="font-mono text-sm font-semibold truncate" style={{ color, marginTop: 2 }}>{value}</div>
    </div>
  );
}

function ActiveRaceShortcut({
  race,
  session,
  nowMs,
  title,
  context,
  tone,
  colorOverride,
  onOpen,
  onStop,
}: {
  race: UsageRace;
  session: ActiveSession | undefined;
  nowMs: number;
  title: string;
  context: string | null;
  tone: "selected" | "global";
  colorOverride?: string;
  onOpen: () => void;
  onStop: () => void;
}) {
  const color = colorOverride ?? session?.color ?? providerColor(race.provider);
  const consumed = raceConsumedDelta(race, session);
  const progress = race.targetDeltaPct > 0 ? (consumed / race.targetDeltaPct) * 100 : 0;
  const nextSegment = nextOpenSegment(race);
  const currentSegmentStartMs = segmentStartMs(race, nextSegment);
  const currentSegmentElapsed = nextSegment?.completedAt
    ? nextSegment.elapsedSeconds
    : Math.max(0, (nowMs - currentSegmentStartMs) / 1000);
  const totalElapsed = raceElapsedSeconds(race, nowMs);
  const currentTiming = nextSegment ? segmentTiming(race, nextSegment, nowMs) : null;
  const totalProgressTarget = currentTiming?.cumulativeTargetSeconds ?? race.durationSeconds;
  const completedCount = race.segments.filter((segment) => segment.completedAt != null).length;

  return (
    <div
      className="flex items-center gap-3 p-3"
      style={{
        background: tone === "global" ? "#1f1f1f" : "#202020",
        border: `1px solid ${color}66`,
        borderRadius: 8,
        boxShadow: `inset 3px 0 0 ${color}`,
      }}
    >
      <ProviderBadge provider={race.provider} color={color} />
      <button
        type="button"
        onClick={onOpen}
        className="flex items-center gap-3"
        style={{ flex: 1, minWidth: 0, padding: 0, border: 0, background: "transparent", textAlign: "left", cursor: "pointer" }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
            <span className="text-[11px] font-semibold" style={{ color, flexShrink: 0 }}>{title}</span>
            <span className="text-sm font-semibold truncate" style={{ color: "#f3f4f6" }}>{race.alias}</span>
            <StatusBadge status={race.status} />
          </div>
          <div className="text-[11px] mt-0.5" style={{ color: "#858585" }}>
            当前小目标 {formatDigitalClock(currentSegmentElapsed)} · 总时间 {formatDigitalClock(totalElapsed)}
            · 目标{formatShortDuration(totalProgressTarget)}，{formatTargetDelta(totalElapsed, totalProgressTarget)}
            {context ? ` · ${context}` : ""}
          </div>
        </div>
        <div className="hidden sm:block" style={{ width: 150, flexShrink: 0 }}>
          <div className="flex items-center justify-between text-[11px] mb-1">
            <span style={{ color: "#a3a3a3" }}>{completedCount}/{race.segments.length}</span>
            <span className="font-mono" style={{ color }}>{formatWhole(consumed)} / {formatWholePct(race.targetDeltaPct)}</span>
          </div>
          <ProgressBar pct={progress} total={100} />
        </div>
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold" style={{ color, flexShrink: 0 }}>
          <TimerReset size={14} />
          打开
        </span>
      </button>
      {race.status === "active" && (
        <button
          type="button"
          title="停止记录"
          onClick={onStop}
          className="inline-flex items-center justify-center"
          style={{ width: 24, height: 24, borderRadius: 6, border: "1px solid #444", background: "#2a2a2a", color: "#aaa" }}
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}

function AbandonRaceConfirmDialog({
  race,
  onCancel,
  onConfirm,
}: {
  race: UsageRace;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  const completed = race.segments.filter((segment) => segment.completedAt != null).length;

  return (
    <div
      role="presentation"
      onMouseDown={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 82,
        padding: 18,
        background: "rgba(0, 0, 0, 0.58)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="abandon-race-title"
        onMouseDown={(event) => event.stopPropagation()}
        style={{
          width: "min(420px, 100%)",
          borderRadius: 10,
          border: "1px solid #5a3535",
          background: "#202020",
          boxShadow: "0 18px 50px rgba(0, 0, 0, 0.48)",
          overflow: "hidden",
        }}
      >
        <div className="px-4 py-3 flex items-center gap-2" style={{ borderBottom: "1px solid #333" }}>
          <span
            className="inline-flex items-center justify-center"
            style={{ width: 30, height: 30, borderRadius: 7, background: "#2b1d1d", color: "#fecaca", flexShrink: 0 }}
          >
            <X size={15} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div id="abandon-race-title" className="text-sm font-semibold" style={{ color: "#f3f4f6" }}>放弃进行中的竞赛？</div>
            <div className="text-[11px] truncate" style={{ color: "#858585" }}>{race.alias}</div>
          </div>
        </div>

        <div className="px-4 py-4 space-y-3">
          <p className="text-sm" style={{ color: "#d4d4d4", margin: 0 }}>
            放弃后这场竞赛会停止继续记录，并作为未完成记录保留在历史竞赛里。
          </p>
          <div
            className="grid gap-2 text-[11px]"
            style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))", color: "#858585" }}
          >
            <span>{providerLabel(race.provider)}</span>
            <span className="text-right">{formatLocalTime(race.startedAt)}</span>
            <span>目标 {formatWholePct(race.targetDeltaPct)}</span>
            <span className="text-right">已完成 {completed}/{race.segments.length}</span>
          </div>
        </div>

        <div className="px-4 py-3 flex items-center justify-end gap-2" style={{ borderTop: "1px solid #333" }}>
          <button
            type="button"
            autoFocus
            onClick={onCancel}
            className="inline-flex items-center justify-center"
            style={{ height: 30, padding: "0 12px", borderRadius: 6, border: "1px solid #444", background: "#262626", color: "#d4d4d4" }}
          >
            继续竞赛
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="inline-flex items-center justify-center gap-1.5"
            style={{ height: 30, padding: "0 12px", borderRadius: 6, border: "1px solid #7f2f2f", background: "#3a1f1f", color: "#fecaca" }}
          >
            <X size={13} />
            确认放弃
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteRaceConfirmDialog({
  race,
  onCancel,
  onConfirm,
}: {
  race: UsageRace;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  const isActive = race.status === "active";
  const message = isActive
    ? "这条竞赛仍在进行，删除后会停止记录，并从历史里移除。"
    : "删除后会从历史竞赛列表移除，本地记录不会再显示。";

  return (
    <div
      role="presentation"
      onMouseDown={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        padding: 18,
        background: "rgba(0, 0, 0, 0.58)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-race-title"
        onMouseDown={(event) => event.stopPropagation()}
        style={{
          width: "min(420px, 100%)",
          borderRadius: 10,
          border: "1px solid #443333",
          background: "#202020",
          boxShadow: "0 18px 50px rgba(0, 0, 0, 0.48)",
          overflow: "hidden",
        }}
      >
        <div className="px-4 py-3 flex items-center gap-2" style={{ borderBottom: "1px solid #333" }}>
          <span
            className="inline-flex items-center justify-center"
            style={{ width: 30, height: 30, borderRadius: 7, background: "#2b1d1d", color: "#fca5a5", flexShrink: 0 }}
          >
            <Trash2 size={15} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div id="delete-race-title" className="text-sm font-semibold" style={{ color: "#f3f4f6" }}>删除历史竞赛</div>
            <div className="text-[11px] truncate" style={{ color: "#858585" }}>{race.alias}</div>
          </div>
        </div>

        <div className="px-4 py-4 space-y-3">
          <p className="text-sm" style={{ color: "#d4d4d4", margin: 0 }}>{message}</p>
          <div
            className="grid gap-2 text-[11px]"
            style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))", color: "#858585" }}
          >
            <span>{providerLabel(race.provider)}</span>
            <span className="text-right">{formatLocalTime(race.startedAt)}</span>
            <span>目标 {formatWholePct(race.targetDeltaPct)}</span>
            <span className="text-right">分卷 {race.segments.length}</span>
          </div>
        </div>

        <div className="px-4 py-3 flex items-center justify-end gap-2" style={{ borderTop: "1px solid #333" }}>
          <button
            type="button"
            autoFocus
            onClick={onCancel}
            className="inline-flex items-center justify-center"
            style={{ height: 30, padding: "0 12px", borderRadius: 6, border: "1px solid #444", background: "#262626", color: "#d4d4d4" }}
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="inline-flex items-center justify-center gap-1.5"
            style={{ height: 30, padding: "0 12px", borderRadius: 6, border: "1px solid #7f2f2f", background: "#3a1f1f", color: "#fecaca" }}
          >
            <Trash2 size={13} />
            删除
          </button>
        </div>
      </div>
    </div>
  );
}

function RaceHistoryPanel({
  races,
  activeSessions,
  expandedRaceId,
  onToggle,
  onDelete,
  onBack,
  fullView = false,
}: {
  races: UsageRace[];
  activeSessions: Map<string, ActiveSession>;
  expandedRaceId: string | null;
  onToggle: (raceId: string) => void;
  onDelete: (raceId: string) => void;
  onBack?: () => void;
  fullView?: boolean;
}) {
  return (
    <div
      className="card p-0 overflow-hidden"
      style={fullView ? { minHeight: "calc(100vh - 150px)", display: "flex", flexDirection: "column" } : undefined}
    >
      <div className="px-4 py-3 flex items-center justify-between gap-3" style={{ borderBottom: "1px solid #3a3a3a" }}>
        <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
          {onBack && (
            <button
              type="button"
              title="返回主页"
              onClick={onBack}
              className="inline-flex items-center justify-center"
              style={{ width: 30, height: 30, borderRadius: 6, border: "1px solid #3a3a3a", background: "#202020", color: "#d1d5db", flexShrink: 0 }}
            >
              <ArrowLeft size={15} />
            </button>
          )}
          <History size={15} style={{ color: "#aaa", flexShrink: 0 }} />
          <span className="text-sm font-semibold" style={{ color: "#ddd" }}>历史记录</span>
        </div>
        <span className="text-[11px]" style={{ color: "#858585", flexShrink: 0 }}>{races.length} 条</span>
      </div>
      {races.length === 0 ? (
        <div className="py-10 text-center text-xs" style={{ color: "#777" }}>还没有小目标竞赛记录</div>
      ) : (
        <div className="divide-y" style={{ borderColor: "#2e2e2e", overflowY: fullView ? "auto" : undefined, flex: fullView ? 1 : undefined }}>
          {races.map((race) => {
            const completed = race.segments.filter((segment) => segment.completedAt != null).length;
            const session = activeSessions.get(race.accountKey);
            const consumed = raceConsumedDelta(race, session);
            const expanded = expandedRaceId === race.id;
            return (
              <div key={race.id}>
                <div className="px-4 py-3 flex items-center gap-2" style={{ background: "#202020" }}>
                  <button
                    type="button"
                    onClick={() => onToggle(race.id)}
                    className="flex items-center gap-3"
                    style={{ flex: 1, minWidth: 0, border: 0, background: "transparent", textAlign: "left", cursor: "pointer", padding: 0 }}
                  >
                    <ChevronRight
                      size={14}
                      style={{
                        color: "#858585",
                        transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
                        transition: "transform 120ms ease",
                        flexShrink: 0,
                      }}
                    />
                    <StatusBadge status={race.status} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="text-xs font-semibold truncate" style={{ color: "#ddd" }}>{race.alias}</div>
                      <div className="text-[10px]" style={{ color: "#858585" }}>
                        {providerLabel(race.provider)} · {formatLocalTime(race.startedAt)} · {formatShortDuration(race.durationSeconds)}
                      </div>
                    </div>
                    <div className="text-right font-mono" style={{ flexShrink: 0 }}>
                      <div className="text-xs" style={{ color: providerColor(race.provider) }}>{formatWhole(consumed)} / {formatWholePct(race.targetDeltaPct)}</div>
                      <div className="text-[10px]" style={{ color: "#858585" }}>{completed}/{race.segments.length}</div>
                    </div>
                  </button>
                  <button
                    type="button"
                    title="删除这条竞赛记录"
                    onClick={() => onDelete(race.id)}
                    className="inline-flex items-center justify-center"
                    style={{ width: 26, height: 26, borderRadius: 6, border: "1px solid #443333", background: "#251f1f", color: "#fca5a5", flexShrink: 0 }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                {expanded && (
                  <div className="px-4 pb-3" style={{ background: "#202020" }}>
                    <SegmentList race={race} compact />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SegmentList({
  race,
  compact,
  nowMs,
  currentDeltaPct = null,
}: {
  race: UsageRace;
  compact: boolean;
  nowMs?: number;
  currentDeltaPct?: number | null;
}) {
  const currentOpen = openSegment(race);
  const latestCompletedIndex = [...race.segments].reverse().find((segment) => segment.completedAt != null)?.index ?? null;
  const latestCompletedRef = useRef<HTMLDivElement | null>(null);
  const visibleCount = Math.max(16, latestCompletedIndex ?? 0);
  const visibleSegments = compact ? race.segments : race.segments.slice(0, visibleCount);

  useEffect(() => {
    if (latestCompletedIndex == null) return;
    latestCompletedRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [latestCompletedIndex, race.id]);

  return (
    <div className="space-y-1.5">
      {visibleSegments.map((segment) => {
        const timing = segmentTiming(race, segment, nowMs);
        const hasTiming = timing.elapsedSeconds != null && timing.totalElapsedSeconds != null;
        const segmentTimeColor = !hasTiming ? RECORD_PENDING_COLOR : timing.isSegmentOver ? TIMER_OVER_COLOR : RECORD_OK_COLOR;
        const totalTimeColor = !hasTiming ? RECORD_PENDING_COLOR : timing.isTotalOver ? TIMER_OVER_COLOR : RECORD_OK_COLOR;
        const isCurrent = currentOpen?.index === segment.index && race.status === "active";
        const isLatestCompleted = segment.index === latestCompletedIndex;
        const previousSegment = segment.index > 1 ? race.segments[segment.index - 2] : null;
        const segmentStartPct = previousSegment?.cumulativeDeltaPct ?? 0;
        const currentSegmentProgress = isCurrent && currentDeltaPct != null && segment.targetDeltaPct > 0
          ? clamp((currentDeltaPct - segmentStartPct) / segment.targetDeltaPct * 100, 0, 100)
          : null;
        const baseBackground = isLatestCompleted ? "#173024" : segment.completedAt ? "#263126" : isCurrent ? "#2c261d" : "#272727";
        const rowBackground = currentSegmentProgress != null
          ? `linear-gradient(90deg, rgba(74, 222, 128, 0.28) 0%, rgba(74, 222, 128, 0.28) ${currentSegmentProgress}%, ${baseBackground} ${currentSegmentProgress}%, ${baseBackground} 100%)`
          : baseBackground;
        return (
          <div
            key={segment.index}
            ref={(node) => {
              if (isLatestCompleted) latestCompletedRef.current = node;
            }}
            className="flex items-center gap-2 text-[11px]"
            style={{
              minHeight: compact ? 30 : 34,
              padding: "5px 7px",
              borderRadius: 6,
              background: rowBackground,
              border: `1px solid ${isLatestCompleted ? "#4ade80" : segment.completedAt ? "#355a35" : isCurrent ? "#5d4621" : "#383838"}`,
              boxShadow: isLatestCompleted ? "0 0 0 1px rgba(74, 222, 128, 0.22), 0 0 18px rgba(74, 222, 128, 0.16)" : undefined,
              color: segment.completedAt ? "#c9f7c9" : "#aaa",
            }}
          >
            <span className="inline-flex items-center justify-center" style={{ width: 16, flexShrink: 0, color: isCurrent ? "#f6c177" : undefined }}>
              {segment.completedAt ? <Trophy size={12} /> : <Flag size={12} />}
            </span>
            <span className="font-mono" style={{ width: compact ? 52 : 58, flexShrink: 0 }}>
              #{segment.index} +{formatWholePct(segment.targetDeltaPct)}
            </span>
            <span className="font-mono" style={{ flex: 1, minWidth: 0 }}>
              到 {formatWholePct(segment.cumulativeDeltaPct)}
            </span>
            {!compact && isLatestCompleted && (
              <span className="font-semibold" style={{ color: "#4ade80", flexShrink: 0 }}>新完成！</span>
            )}
            <span className="font-mono inline-flex items-center justify-end gap-1" style={{ width: compact ? 86 : 104, flexShrink: 0 }}>
              <span style={{ color: "#858585" }}>用时</span>
              <span style={{ color: segmentTimeColor }}>{hasTiming ? formatShortDuration(timing.elapsedSeconds) : "等待"}</span>
            </span>
            <span className="font-mono inline-flex items-center justify-end gap-1" style={{ width: compact ? 86 : 104, flexShrink: 0 }}>
              <span style={{ color: "#858585" }}>累计</span>
              <span style={{ color: totalTimeColor }}>{hasTiming ? formatShortDuration(timing.totalElapsedSeconds) : "-"}</span>
            </span>
          </div>
        );
      })}
      {!compact && race.segments.length > visibleSegments.length && (
        <div className="text-[11px] text-center" style={{ color: "#858585" }}>还有 {race.segments.length - visibleSegments.length} 个分卷在历史里</div>
      )}
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max = Infinity,
  step = 1,
  suffix,
  precision = 0,
  tone = "normal",
  onChange,
}: {
  label?: string;
  value: string;
  min: number;
  max?: number;
  step?: number;
  suffix?: string;
  precision?: number;
  tone?: "normal" | "danger";
  onChange: (value: string) => void;
}) {
  const currentValue = parseDraftNumber(value, min);
  const danger = tone === "danger";
  const applyValue = (nextValue: number) => {
    const clamped = clamp(nextValue, min, max);
    onChange(formatDraftNumber(clamped, precision));
  };
  const adjust = (direction: 1 | -1) => applyValue(currentValue + direction * step);

  return (
    <label style={{ minWidth: 0 }}>
      {label && <span className="block text-[11px] mb-1 font-medium" style={{ color: "#d4d4d4" }}>{label}</span>}
      <div className="flex items-stretch" style={{ minWidth: 0 }}>
        <div className="flex flex-col" style={{ flexShrink: 0, border: "1px solid #383838", borderRight: 0, borderRadius: "7px 0 0 7px", overflow: "hidden" }}>
          <button
            type="button"
            title="增加"
            onClick={() => adjust(1)}
            className="inline-flex items-center justify-center"
            style={{ width: 22, height: 17, border: 0, borderBottom: "1px solid #383838", background: "#252525", color: "#aaa", cursor: "pointer" }}
          >
            <ChevronUp size={12} />
          </button>
          <button
            type="button"
            title="减少"
            onClick={() => adjust(-1)}
            className="inline-flex items-center justify-center"
            style={{ width: 22, height: 17, border: 0, background: "#252525", color: "#aaa", cursor: "pointer" }}
          >
            <ChevronDown size={12} />
          </button>
        </div>
        <div style={{ position: "relative", minWidth: 0, flex: 1 }}>
          <input
            type="text"
            inputMode="decimal"
            value={value}
            onChange={(event) => {
              const next = event.target.value;
              if (next === "" || /^\d+$/.test(next)) onChange(next);
            }}
            onBlur={() => applyValue(currentValue)}
            className="input-field"
            style={{
              height: 34,
              padding: suffix ? "0 24px 0 8px" : "0 8px",
              borderRadius: "0 7px 7px 0",
              borderColor: danger ? "#7f2f2f" : undefined,
              color: danger ? TIMER_OVER_COLOR : undefined,
              boxShadow: danger ? "0 0 0 1px rgba(248, 113, 113, 0.25)" : undefined,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              appearance: "none",
            }}
          />
          {suffix && (
            <span
              className="text-[10px]"
              style={{
                position: "absolute",
                right: 8,
                top: "50%",
                transform: "translateY(-50%)",
                color: danger ? TIMER_OVER_COLOR : "#858585",
                pointerEvents: "none",
              }}
            >
              {suffix}
            </span>
          )}
        </div>
      </div>
    </label>
  );
}

function IconActionButton({
  title,
  disabled = false,
  color = "#d4d4d4",
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  color?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex items-center justify-center"
      style={{
        width: 22,
        height: 20,
        borderRadius: 5,
        border: "1px solid #383838",
        background: "#252525",
        color: disabled ? "#5f5f5f" : color,
        cursor: disabled ? "not-allowed" : "pointer",
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}

function FocusTimerCard({
  label,
  seconds,
  subtext,
  targetText,
  targetColor,
  color,
  showHours,
}: {
  label: string;
  seconds: number | null;
  subtext: string;
  targetText: string;
  targetColor: string;
  color: string;
  showHours: boolean;
}) {
  const value = formatRaceClockParts(seconds, showHours);
  const fontSize = value.main.length > 5 ? 31 : 36;
  return (
    <div
      className="text-center"
      style={{
        minHeight: 118,
        borderRadius: 8,
        border: "1px solid #383838",
        background: "#202020",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "12px 10px",
        minWidth: 0,
      }}
    >
      <div className="text-xs font-medium mb-2" style={{ color: "#d4d4d4" }}>{label}</div>
      <div
        style={{
          display: "inline-flex",
          alignItems: "baseline",
          justifyContent: "center",
          alignSelf: "center",
          maxWidth: "100%",
          borderRadius: 8,
          border: "1px solid #3a2f42",
          background: "#151515",
          padding: "7px 10px",
          boxShadow: `0 0 18px ${color}22, inset 0 0 12px ${color}10`,
        }}
      >
        <span
          className="font-mono font-bold"
          style={{
            color,
            fontSize,
            lineHeight: 1,
            letterSpacing: 0,
            fontVariantNumeric: "tabular-nums",
            whiteSpace: "nowrap",
            textShadow: `0 0 12px ${color}88`,
          }}
        >
          {value.main}
        </span>
        {value.centis && (
          <span
            className="font-mono font-bold"
            style={{
              color,
              fontSize: Math.max(16, Math.floor(fontSize * 0.58)),
              lineHeight: 1,
              opacity: 0.82,
              marginLeft: 2,
              letterSpacing: 0,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {value.centis}
          </span>
        )}
      </div>
      <div
        className="inline-flex items-center justify-center self-center font-mono"
        style={{
          marginTop: 8,
          minHeight: 22,
          padding: "2px 8px",
          borderRadius: 999,
          border: `1px solid ${targetColor}55`,
          background: `${targetColor}16`,
          color: targetColor,
          fontSize: 11,
          whiteSpace: "nowrap",
          maxWidth: "100%",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {targetText}
      </div>
      <div className="text-[11px] mt-1 truncate" style={{ color: "#858585" }}>{subtext}</div>
    </div>
  );
}

function ProviderBadge({ provider, color }: { provider: string; color: string }) {
  return (
    <span
      title={providerLabel(provider)}
      className="inline-flex items-center justify-center"
      style={{
        width: 30,
        height: 30,
        borderRadius: 6,
        background: `${color}22`,
        border: `1px solid ${color}66`,
        color,
        flexShrink: 0,
      }}
    >
      <ProviderIcon provider={provider} size={18} />
    </span>
  );
}

function ProviderIcon({ provider, size = 18 }: { provider: string; size?: number }) {
  if (provider === "codex") {
    return (
      <svg viewBox="0 0 600 600" width={size} height={size} aria-hidden="true">
        <path fill="currentColor" d="M557 245.5a150 150 0 0 0-12.8-122.7 151 151 0 0 0-162.8-72.5 151.6 151.6 0 0 0-256.9 54.2 150 150 0 0 0-100 72.5 151 151 0 0 0 18.6 177.5c-13.6 40.8-9 85.6 12.8 122.7 32.8 57 98.6 86.3 162.9 72.5a151.4 151.4 0 0 0 257-54.9A151.4 151.4 0 0 0 557 245.6M331.5 560.7c-26.3 0-51.7-9.1-72-26l3.6-2 119.5-69c6-3.5 9.8-10 9.8-17V278.3l50.5 29.2q.8.4 1 1.3v139.6c-.2 62-50.4 112.2-112.4 112.3M90 457.6a112 112 0 0 1-13.4-75.3l3.6 2 119.5 69c6 3.6 13.5 3.6 19.6 0l146-84.2v58.3a2 2 0 0 1-.8 1.6l-121 69.8A112.5 112.5 0 0 1 90 457.6M58.5 197.4c13.3-23 34.2-40.4 59.2-49.3V290c-.1 7 3.6 13.5 9.7 17l145.3 83.8-50.5 29.2q-.8.5-1.8 0L99.7 350.3a112.6 112.6 0 0 1-41.2-153.5zm415 96.4-146-84.7 50.5-29q.8-.6 1.8 0l120.7 69.7a112.4 112.4 0 0 1-16.9 202.6v-142c-.2-6.9-4-13.2-10.2-16.6m50.2-75.6-3.6-2.1-119.3-69.6c-6-3.5-13.6-3.5-19.6 0l-146 84.2v-58.3q0-1 .7-1.5l120.8-69.7a112.5 112.5 0 0 1 167 116.5zm-316 103.4-50.5-29.1a2 2 0 0 1-1-1.4V151.9a112.5 112.5 0 0 1 184.4-86.4l-3.5 2-119.5 69c-6 3.5-9.8 10-9.8 17zm27.4-59.2 65-37.4 65.2 37.4v75l-65 37.5-65-37.5z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path fill="currentColor" d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 0 1-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" />
    </svg>
  );
}

function pointOnCircle(center: number, radius: number, pct: number) {
  const angle = (pct / 100) * Math.PI * 2 - Math.PI / 2;
  return {
    x: center + radius * Math.cos(angle),
    y: center + radius * Math.sin(angle),
  };
}

function describePercentArc(center: number, radius: number, startPct: number, endPct: number) {
  const start = pointOnCircle(center, radius, startPct);
  const end = pointOnCircle(center, radius, endPct);
  const largeArc = endPct - startPct > 50 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

function CircularPercent({
  pct,
  color,
  size = 44,
  targetStartPct,
  targetEndPct,
}: {
  pct: number;
  color: string;
  size?: number;
  targetStartPct?: number;
  targetEndPct?: number;
}) {
  const safePct = clamp(pct, 0, 100);
  const hasTarget = targetStartPct != null && targetEndPct != null && targetEndPct > targetStartPct;
  const safeTargetStart = hasTarget ? clamp(targetStartPct, 0, 100) : 0;
  const safeTargetEnd = hasTarget ? clamp(targetEndPct, 0, 100) : 0;
  const targetArcVisible = hasTarget && safeTargetEnd > safeTargetStart;
  const targetArcFull = targetArcVisible && safeTargetEnd - safeTargetStart >= 99.5;
  const strokeWidth = 4;
  const center = size / 2;
  const radius = (size - strokeWidth - 6) / 2;
  const targetStrokeWidth = Math.max(2, strokeWidth - 1.4);
  const targetStartPoint = targetArcVisible ? pointOnCircle(center, radius, safeTargetStart) : null;
  const targetEndPoint = targetArcVisible ? pointOnCircle(center, radius, safeTargetEnd) : null;
  const circumference = 2 * Math.PI * radius;
  const dash = circumference * safePct / 100;
  return (
    <span
      className="inline-flex items-center justify-center font-mono"
      style={{ position: "relative", width: size, height: size, color, flexShrink: 0 }}
      title={formatWholePct(safePct)}
    >
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true" style={{ position: "absolute", inset: 0 }}>
        <circle cx={center} cy={center} r={radius} fill="none" stroke="#3a3a3a" strokeWidth={strokeWidth} />
        {targetArcVisible && (targetArcFull ? (
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke="#f3f4f6"
            strokeWidth={targetStrokeWidth}
            strokeLinecap="round"
            strokeDasharray="2 3"
            opacity={0.42}
          />
        ) : (
          <path
            d={describePercentArc(center, radius, safeTargetStart, safeTargetEnd)}
            fill="none"
            stroke="#f3f4f6"
            strokeWidth={targetStrokeWidth}
            strokeLinecap="round"
            strokeDasharray="2 3"
            opacity={0.42}
          />
        ))}
        {targetArcVisible && !targetArcFull && targetStartPoint != null && targetEndPoint != null && (
          <>
            <circle cx={targetStartPoint.x} cy={targetStartPoint.y} r={2.2} fill="#151515" stroke="#f3f4f6" strokeWidth={1.2} />
            <circle cx={targetEndPoint.x} cy={targetEndPoint.y} r={2.2} fill="#151515" stroke="#f3f4f6" strokeWidth={1.2} />
          </>
        )}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference - dash}`}
          transform={`rotate(-90 ${center} ${center})`}
        />
      </svg>
      <span className="font-bold" style={{ color: "#f3f4f6", fontSize: size <= 38 ? 10 : 11 }}>{Math.round(safePct)}%</span>
    </span>
  );
}

function StatusBadge({ status }: { status: RaceStatus }) {
  const style = status === "completed"
    ? { color: "#9ae6a1", border: "#2f6b38", background: "#1d2b20", label: "完成" }
    : status === "expired"
      ? { color: "#fca5a5", border: "#6b2f2f", background: "#2b1d1d", label: "结束" }
      : status === "lost"
        ? { color: "#fb7185", border: "#7f2f2f", background: "#2b1d1d", label: "战败" }
        : { color: "#f6c177", border: "#6b522c", background: "#2b261d", label: "进行" };
  return (
    <span
      className="text-[10px] font-semibold"
      style={{
        color: style.color,
        border: `1px solid ${style.border}`,
        background: style.background,
        borderRadius: 999,
        padding: "2px 6px",
        flexShrink: 0,
      }}
    >
      {style.label}
    </span>
  );
}
