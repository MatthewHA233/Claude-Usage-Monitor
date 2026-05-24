import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronRight,
  Flag,
  History,
  RefreshCw,
  Target,
  TimerReset,
  Trophy,
  X,
} from "lucide-react";
import type { PluginUsageStatus, Recommendation, UsageSnapshot } from "../types";
import { useAccountColors, useAllHistories } from "../hooks/useData";
import ProgressBar from "./ProgressBar";
import { formatLocalTime } from "../utils/format";

const RACES_STORAGE_KEY = "claude_usage_monitor_quota_races_v1";
const SELECTED_STORAGE_KEY = "claude_usage_monitor_quota_race_selected";
const SESSION_HOURS = 5;
const PX_PER_HOUR = 72;
const LABEL_W = 178;
const ROW_H = 58;
const HEADER_H = 26;
const DEFAULT_STEP_PCT = 2;
const MAX_SAVED_RACES = 120;
const PROVIDER_ORDER = ["claude_code", "codex"];
const ACCOUNT_COLORS = ["#cc785c", "#4a9eff", "#4ade80", "#f0a500", "#a78bfa"];
const PLUGIN_STATUS_FRESH_MS = 90_000;

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

type RaceStatus = "active" | "completed" | "expired";

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

function formatClock(seconds: number | null) {
  if (seconds == null || !Number.isFinite(seconds)) return "--:--";
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
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

function shortAlias(alias: string) {
  if (!alias.includes("@")) return alias;
  return alias.split("@")[0];
}

function rawFromNorm(normPct: number, totalPct: number) {
  return normPct * totalPct / 100;
}

function loadRaces(): UsageRace[] {
  try {
    const raw = localStorage.getItem(RACES_STORAGE_KEY);
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

function buildActiveSessions(
  snapshots: UsageSnapshot[],
  histories: Record<string, UsageSnapshot[]>,
  nowMs: number,
  colors: Record<string, string>,
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
      if (currentNormPct >= 99) return null;
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

function findCrossingTime(samples: Sample[], targetNormPct: number, fallbackMs: number) {
  if (samples.length === 0) return fallbackMs;
  let previous: Sample | null = null;
  for (const sample of samples) {
    if (sample.normPct >= targetNormPct) {
      if (!previous || sample.normPct <= previous.normPct) return sample.atMs;
      const ratio = (targetNormPct - previous.normPct) / (sample.normPct - previous.normPct);
      return previous.atMs + clamp(ratio, 0, 1) * (sample.atMs - previous.atMs);
    }
    previous = sample;
  }
  return fallbackMs;
}

function updateRaceProgress(races: UsageRace[], sessionsByKey: Map<string, ActiveSession>, nowMs: number) {
  let changed = false;
  const updated = races.map((race) => {
    if (race.status !== "active") return race;
    const deadlineMs = new Date(race.startedAt).getTime() + race.durationSeconds * 1000;
    const session = sessionsByKey.get(race.accountKey);
    const nextRace: UsageRace = { ...race, segments: race.segments.map((segment) => ({ ...segment })) };

    if (session && session.resetKey === race.resetKey) {
      const currentDelta = Math.max(0, session.currentNormPct - race.startNormPct);
      for (const segment of nextRace.segments) {
        if (segment.completedAt != null) continue;
        if (currentDelta + 0.001 < segment.cumulativeDeltaPct) continue;
        const targetNormPct = race.startNormPct + segment.cumulativeDeltaPct;
        const completedMs = findCrossingTime(session.samples, targetNormPct, nowMs);
        segment.completedAt = new Date(completedMs).toISOString();
        segment.elapsedSeconds = Math.max(0, Math.round((completedMs - new Date(race.startedAt).getTime()) / 1000));
        segment.actualDeltaPct = round2(Math.min(currentDelta, segment.cumulativeDeltaPct));
        changed = true;
      }
      if (nextRace.segments.every((segment) => segment.completedAt != null)) {
        nextRace.status = "completed";
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

function raceDeadlineMs(race: UsageRace) {
  return new Date(race.startedAt).getTime() + race.durationSeconds * 1000;
}

function nextOpenSegment(race: UsageRace) {
  return race.segments.find((segment) => segment.completedAt == null) ?? race.segments[race.segments.length - 1] ?? null;
}

function segmentStartMs(race: UsageRace, segment: RaceSegment | null) {
  if (!segment || segment.index <= 1) return new Date(race.startedAt).getTime();
  const previous = race.segments[segment.index - 2];
  return previous?.completedAt ? new Date(previous.completedAt).getTime() : new Date(race.startedAt).getTime();
}

export default function SessionRacePanel({ snapshots, recommendation: _recommendation, pluginUsageStatuses, onRefresh }: Props) {
  void _recommendation;
  const { colors } = useAccountColors();
  const { histories, refetch: refetchHistories, loading: historiesLoading } = useAllHistories();
  const [nowMs, setNowMs] = useState(Date.now());
  const [races, setRaces] = useState<UsageRace[]>(() => loadRaces());
  const [selectedKey, setSelectedKey] = useState<string | null>(() => localStorage.getItem(SELECTED_STORAGE_KEY));
  const [historyKey, setHistoryKey] = useState<string | null>(() => localStorage.getItem(SELECTED_STORAGE_KEY));
  const [expandedRaceId, setExpandedRaceId] = useState<string | null>(null);
  const [draftSeedKey, setDraftSeedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<RaceDraft>({ durationMinutes: "300", targetPct: "", stepPct: String(DEFAULT_STEP_PCT) });

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const activeSessions = useMemo(
    () => buildActiveSessions(snapshots, histories, nowMs, colors),
    [snapshots, histories, nowMs, colors],
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
    localStorage.setItem(SELECTED_STORAGE_KEY, selectedKey);
    setHistoryKey(selectedKey);
  }, [selectedKey]);

  useEffect(() => {
    localStorage.setItem(RACES_STORAGE_KEY, JSON.stringify(races.slice(0, MAX_SAVED_RACES)));
  }, [races]);

  useEffect(() => {
    setRaces((previous) => updateRaceProgress(previous, sessionsByKey, nowMs));
  }, [nowMs, sessionsByKey]);

  useEffect(() => {
    const session = selectedKey ? sessionsByKey.get(selectedKey) : null;
    if (!session) return;
    const seedKey = `${session.key}:${session.resetKey}`;
    if (draftSeedKey === seedKey) return;
    setDraft({
      durationMinutes: String(Math.max(5, Math.ceil(session.remainingSeconds / 60))),
      targetPct: round1(Math.max(0.1, session.remainingNormPct)).toString(),
      stepPct: String(DEFAULT_STEP_PCT),
    });
    setDraftSeedKey(seedKey);
  }, [draftSeedKey, selectedKey, sessionsByKey]);

  const selectedSession = selectedKey ? sessionsByKey.get(selectedKey) ?? null : null;
  const activeRace = useMemo(
    () => races.find((race) => race.status === "active" && race.accountKey === selectedKey) ?? null,
    [races, selectedKey],
  );
  const historyRaces = useMemo(
    () => races.filter((race) => race.accountKey === (historyKey ?? selectedKey)),
    [historyKey, races, selectedKey],
  );

  const refreshAll = useCallback(() => {
    void refetchHistories();
    onRefresh();
  }, [onRefresh, refetchHistories]);

  const selectSession = useCallback((key: string) => {
    setSelectedKey(key);
    setHistoryKey(key);
  }, []);

  const startRace = useCallback(() => {
    if (!selectedSession) return;
    const durationMinutes = clamp(parseDraftNumber(draft.durationMinutes, 300), 1, 24 * 60);
    const targetPct = clamp(parseDraftNumber(draft.targetPct, selectedSession.remainingNormPct), 0.1, Math.max(0.1, selectedSession.remainingNormPct));
    const stepPct = clamp(parseDraftNumber(draft.stepPct, DEFAULT_STEP_PCT), 0.1, 20);
    const nowIso = new Date().toISOString();
    const race: UsageRace = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      provider: selectedSession.provider,
      alias: selectedSession.alias,
      accountKey: selectedSession.key,
      createdAt: nowIso,
      startedAt: nowIso,
      durationSeconds: Math.round(durationMinutes * 60),
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
    setHistoryKey(selectedSession.key);
  }, [draft, selectedSession]);

  const stopRace = useCallback((raceId: string) => {
    setRaces((previous) => previous.map((race) => (
      race.id === raceId && race.status === "active" ? { ...race, status: "expired" } : race
    )));
  }, []);

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
            onDraftChange={setDraft}
            onStart={startRace}
          />
          {activeRace && (
            <ActiveRacePanel
              race={activeRace}
              session={sessionsByKey.get(activeRace.accountKey)}
              nowMs={nowMs}
              onStop={() => stopRace(activeRace.id)}
            />
          )}
          <RaceHistoryPanel
            races={historyRaces}
            activeSessions={sessionsByKey}
            expandedRaceId={expandedRaceId}
            onToggle={(raceId) => setExpandedRaceId((current) => current === raceId ? null : raceId)}
          />
        </div>
      </div>
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
  const activeRaceKeys = new Set(races.filter((race) => race.status === "active").map((race) => race.accountKey));
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
                const activeRace = activeRaceKeys.has(session.key);
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
                      {activeRace && (
                        <div className="inline-flex items-center gap-1 text-[10px]" style={{ color: session.color }}>
                          <Flag size={10} />
                          进行中
                        </div>
                      )}
                    </div>
                    <CircularPercent pct={session.currentNormPct} color={session.color} size={38} />
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
                        border: `${selected ? 2 : 1}px dashed ${session.color}${selected ? "" : "99"}`,
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
  onDraftChange,
  onStart,
}: {
  session: ActiveSession | null;
  draft: RaceDraft;
  activeRace: UsageRace | null;
  onDraftChange: (draft: RaceDraft) => void;
  onStart: () => void;
}) {
  const targetPct = session ? clamp(parseDraftNumber(draft.targetPct, session.remainingNormPct), 0, Math.max(0.1, session.remainingNormPct)) : 0;
  const targetRaw = session ? rawFromNorm(targetPct, session.totalPct) : 0;
  return (
    <div className="card p-0 overflow-hidden">
      <div className="px-4 py-2.5 flex items-center gap-2" style={{ borderBottom: "1px solid #3a3a3a" }}>
        <Target size={15} style={{ color: session?.color ?? "#aaa" }} />
        <span className="text-sm font-semibold" style={{ color: "#ddd" }}>建立额度使用小目标竞赛</span>
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
              <div className="text-xs" style={{ color: session.color }}>{session.currentNormPct.toFixed(1)}% / 100%</div>
              <div className="text-[10px]" style={{ color: "#858585" }}>{session.currentRawPct.toFixed(0)} / {session.totalPct.toFixed(0)}</div>
            </div>
          </div>

          <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
            <NumberField
              label="倒计时 min"
              value={draft.durationMinutes}
              min={1}
              onChange={(value) => onDraftChange({ ...draft, durationMinutes: value })}
            />
            <NumberField
              label="用掉 %"
              value={draft.targetPct}
              min={0.1}
              step={0.1}
              onChange={(value) => onDraftChange({ ...draft, targetPct: value })}
            />
            <NumberField
              label="分卷 %"
              value={draft.stepPct}
              min={0.1}
              step={0.1}
              onChange={(value) => onDraftChange({ ...draft, stepPct: value })}
            />
          </div>

          <div className="flex items-center justify-between gap-2 text-[11px]" style={{ color: "#a3a3a3" }}>
            <span>默认每 {draft.stepPct || DEFAULT_STEP_PCT}% 自动记录一次</span>
            <span className="font-mono" style={{ color: session.color }}>映射 {targetRaw.toFixed(1)} / {session.totalPct.toFixed(0)}</span>
          </div>

          <button
            type="button"
            className="btn-primary w-full inline-flex items-center justify-center gap-2"
            disabled={activeRace != null || session.remainingNormPct <= 0}
            onClick={onStart}
          >
            <Flag size={14} />
            <span>{activeRace ? "这个账号已有进行中竞赛" : "开始竞赛"}</span>
          </button>
        </div>
      )}
    </div>
  );
}

function ActiveRacePanel({
  race,
  session,
  nowMs,
  onStop,
}: {
  race: UsageRace;
  session: ActiveSession | undefined;
  nowMs: number;
  onStop: () => void;
}) {
  const consumed = raceConsumedDelta(race, session);
  const progress = race.targetDeltaPct > 0 ? (consumed / race.targetDeltaPct) * 100 : 0;
  const nextSegment = nextOpenSegment(race);
  const currentSegmentStartMs = segmentStartMs(race, nextSegment);
  const currentSegmentElapsed = nextSegment?.completedAt ? nextSegment.elapsedSeconds : (nowMs - currentSegmentStartMs) / 1000;
  const totalRemaining = (raceDeadlineMs(race) - nowMs) / 1000;
  const completedCount = race.segments.filter((segment) => segment.completedAt != null).length;

  return (
    <div style={{ background: "#202020", border: "1px solid #3a3a3a", borderRadius: 8, overflow: "hidden" }}>
      <div className="px-3 py-2 flex items-center justify-between gap-2" style={{ borderBottom: "1px solid #333" }}>
        <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
          <TimerReset size={15} style={{ color: providerColor(race.provider) }} />
          <span className="text-sm font-semibold truncate" style={{ color: "#eee" }}>进行中的竞赛</span>
        </div>
        <button
          type="button"
          title="停止记录"
          onClick={onStop}
          className="inline-flex items-center justify-center"
          style={{ width: 24, height: 24, borderRadius: 6, border: "1px solid #444", background: "#2a2a2a", color: "#aaa" }}
        >
          <X size={13} />
        </button>
      </div>

      <div className="p-3 space-y-3">
        <div className="grid gap-2" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <Stopwatch label="当前分卷" value={formatClock(currentSegmentElapsed)} color={providerColor(race.provider)} />
          <Stopwatch label="总倒计时" value={formatClock(totalRemaining)} color={totalRemaining < 0 ? "#f87171" : "#f3f4f6"} />
        </div>
        <div>
          <div className="flex items-center justify-between text-[11px] mb-1">
            <span style={{ color: "#a3a3a3" }}>{completedCount} / {race.segments.length} 个小目标</span>
            <span className="font-mono" style={{ color: providerColor(race.provider) }}>{consumed.toFixed(1)} / {race.targetDeltaPct.toFixed(1)}%</span>
          </div>
          <ProgressBar pct={progress} total={100} />
        </div>
        <SegmentList race={race} compact={false} />
      </div>
    </div>
  );
}

function RaceHistoryPanel({
  races,
  activeSessions,
  expandedRaceId,
  onToggle,
}: {
  races: UsageRace[];
  activeSessions: Map<string, ActiveSession>;
  expandedRaceId: string | null;
  onToggle: (raceId: string) => void;
}) {
  return (
    <div className="card p-0 overflow-hidden">
      <div className="px-4 py-2.5 flex items-center gap-2" style={{ borderBottom: "1px solid #3a3a3a" }}>
        <History size={15} style={{ color: "#aaa" }} />
        <span className="text-sm font-semibold" style={{ color: "#ddd" }}>历史竞赛</span>
      </div>
      {races.length === 0 ? (
        <div className="py-8 text-center text-xs" style={{ color: "#777" }}>这个账号还没有小目标记录</div>
      ) : (
        <div className="divide-y" style={{ borderColor: "#2e2e2e" }}>
          {races.slice(0, 12).map((race) => {
            const completed = race.segments.filter((segment) => segment.completedAt != null).length;
            const session = activeSessions.get(race.accountKey);
            const consumed = raceConsumedDelta(race, session);
            const expanded = expandedRaceId === race.id;
            return (
              <div key={race.id}>
                <button
                  type="button"
                  onClick={() => onToggle(race.id)}
                  className="w-full px-4 py-3 flex items-center gap-3"
                  style={{ border: 0, background: "#202020", textAlign: "left", cursor: "pointer" }}
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
                    <div className="text-[10px]" style={{ color: "#858585" }}>{formatLocalTime(race.startedAt)} · {formatShortDuration(race.durationSeconds)}</div>
                  </div>
                  <div className="text-right font-mono" style={{ flexShrink: 0 }}>
                    <div className="text-xs" style={{ color: providerColor(race.provider) }}>{consumed.toFixed(1)} / {race.targetDeltaPct.toFixed(1)}%</div>
                    <div className="text-[10px]" style={{ color: "#858585" }}>{completed}/{race.segments.length}</div>
                  </div>
                </button>
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

function SegmentList({ race, compact }: { race: UsageRace; compact: boolean }) {
  const visibleSegments = compact ? race.segments : race.segments.slice(0, 16);
  return (
    <div className="space-y-1.5">
      {visibleSegments.map((segment) => (
        <div
          key={segment.index}
          className="flex items-center gap-2 text-[11px]"
          style={{
            minHeight: 24,
            padding: "4px 7px",
            borderRadius: 6,
            background: segment.completedAt ? "#263126" : "#272727",
            border: `1px solid ${segment.completedAt ? "#355a35" : "#383838"}`,
            color: segment.completedAt ? "#c9f7c9" : "#aaa",
          }}
        >
          <span className="inline-flex items-center justify-center" style={{ width: 16, flexShrink: 0 }}>
            {segment.completedAt ? <Trophy size={12} /> : <Flag size={12} />}
          </span>
          <span className="font-mono" style={{ width: 58, flexShrink: 0 }}>
            #{segment.index} +{segment.targetDeltaPct.toFixed(1)}%
          </span>
          <span className="font-mono" style={{ flex: 1, minWidth: 0 }}>
            到 {segment.cumulativeDeltaPct.toFixed(1)}%
          </span>
          <span className="font-mono" style={{ width: 62, textAlign: "right", flexShrink: 0 }}>
            {segment.completedAt ? formatShortDuration(segment.elapsedSeconds) : "等待"}
          </span>
        </div>
      ))}
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
  step = 1,
  onChange,
}: {
  label: string;
  value: string;
  min: number;
  step?: number;
  onChange: (value: string) => void;
}) {
  return (
    <label style={{ minWidth: 0 }}>
      <span className="block text-[11px] mb-1" style={{ color: "#858585" }}>{label}</span>
      <input
        type="number"
        min={min}
        step={step}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="input-field"
        style={{ height: 34, padding: "0 9px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
      />
    </label>
  );
}

function Stopwatch({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ background: "#242424", border: "1px solid #383838", borderRadius: 8, padding: "9px 10px", minWidth: 0 }}>
      <div className="text-[11px]" style={{ color: "#858585" }}>{label}</div>
      <div className="text-2xl font-bold font-mono truncate" style={{ color, letterSpacing: 0 }}>{value}</div>
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

function CircularPercent({ pct, color, size = 44 }: { pct: number; color: string; size?: number }) {
  const safePct = clamp(pct, 0, 100);
  const strokeWidth = 4;
  const center = size / 2;
  const radius = (size - strokeWidth - 6) / 2;
  const circumference = 2 * Math.PI * radius;
  const dash = circumference * safePct / 100;
  return (
    <span
      className="inline-flex items-center justify-center font-mono"
      style={{ position: "relative", width: size, height: size, color, flexShrink: 0 }}
      title={`${safePct.toFixed(1)}%`}
    >
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true" style={{ position: "absolute", inset: 0 }}>
        <circle cx={center} cy={center} r={radius} fill="none" stroke="#3a3a3a" strokeWidth={strokeWidth} />
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
