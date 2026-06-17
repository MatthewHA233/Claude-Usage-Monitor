import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { Flag } from "lucide-react";
import type { UsageSnapshot, Recommendation, AccountAnalysis, LocalUsageStatus, PluginUsageStatus } from "../types";
import { formatPct, formatHours, formatLocalTime, remaining, hoursUntil } from "../utils/format";
import ProgressBar from "./ProgressBar";
import { useHistory, useHistorySince, useAllHistories, useAccountColors, useAccountPauseStates } from "../hooks/useData";
import { useResetAlarm } from "../hooks/useResetAlarm";
import InboxBadge from "./InboxPanel";
import PlanOverrideSelect from "./PlanOverrideSelect";
import { tierPresets } from "../utils/planTiers";
import { AlarmBell } from "./AlarmBell";
import { loadStoredQuotaRaces, QUOTA_RACE_UPDATED_EVENT, type StoredQuotaRace } from "../utils/quotaRaceStorage";

const PLUGIN_STATUS_FRESH_MS = 90_000;
const SESSION_HOURS = 5;
const PX_PER_HOUR = 30;
const LABEL_W = 72;
const ROW_H = 64;
const HEADER_H = 28;
const ACCOUNT_COLORS = ["#cc785c", "#4a9eff", "#4ade80"];

const accountKey = (snap: Pick<UsageSnapshot, "provider" | "account_alias">) =>
  `${snap.provider ?? "claude_code"}::${snap.account_alias}`;
const keyFromParts = (provider: string | undefined, alias: string) => `${provider ?? "claude_code"}::${alias}`;
const providerFromKey = (key: string) => key.includes("::") ? (key.split("::")[0] || "claude_code") : "claude_code";
const aliasFromKey = (key: string) => key.split("::").slice(1).join("::") || key;
const providerLabel = (provider?: string) => provider === "codex" ? "Codex" : "Claude Code";
const STORAGE_KEY = (alias: string) => `sprint_blocks_${alias}`;
const quotaMultiplierFromSnapshot = (snap?: UsageSnapshot | null) =>
  Math.max(snap?.session_total_pct ?? 100, snap?.weekly_total_pct ?? 100) / 100;
const accountTypeLabel = (provider?: string, snap?: UsageSnapshot | null) => {
  const multiplier = quotaMultiplierFromSnapshot(snap);
  if (provider === "codex") {
    if (multiplier >= 20) return "Pro (x20)";
    if (multiplier >= 5) return "Pro (x5)";
    return "Plus";
  }
  if (provider === "claude_code") {
    if (multiplier >= 20) return "Max (x20)";
    if (multiplier >= 5) return "Max (x5)";
    return "Pro";
  }
  return null;
};
function ProviderIcon({ provider, size = 18 }: { provider?: string; size?: number }) {
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

interface Block { id: number; wallHour: number; startMs: number; }
interface Persisted { blocks: Block[]; nextId: number; weeklyResetDate: string; }

// ── Props ─────────────────────────────────────────────────
interface Props {
  snapshots: UsageSnapshot[];
  recommendation: Recommendation | null;
  analysis: AccountAnalysis[];
  localUsageStatuses: LocalUsageStatus[];
  pluginUsageStatuses: PluginUsageStatus[];
  onOpenRace: (raceId?: string, accountKey?: string) => void;
  onRefresh: () => void;
}

const DEFAULT_COLOR = "#cc785c";

function sessionResetColor(h: number | null) {
  if (h === null) return "#bbb";
  if (h < 1) return "#f87171";
  if (h < 2) return "#f0a500";
  return "#bbb";
}
function weeklyResetColor(h: number | null) {
  if (h === null) return "#bbb";
  if (h < 24) return "#f87171";
  if (h < 48) return "#f0a500";
  return "#bbb";
}

// ── 换算率计算（30天全量 phase 数据，按 session 消耗加权）─────
interface AccountRate { alias: string; provider: string; rate: number; sessionUnits: number; }
interface PauseInfo { paused: boolean; paused_at: string | null; }

function computeAccountRates(histories: Record<string, UsageSnapshot[]>, pauseStates: Record<string, PauseInfo>): AccountRate[] {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const result: AccountRate[] = [];
  for (const [key, records] of Object.entries(histories)) {
    const pause = pauseStates[key];
    const effectiveCutoff = pause?.paused && pause.paused_at && pause.paused_at > cutoff ? pause.paused_at : cutoff;
    const recent = records.filter(r => r.collected_at >= effectiveCutoff);
    if (recent.length === 0) continue;
    const ann = computeTableAnnotations(recent);
    // weeklyIncrease 按各 phase 自身总额归一化为「周额度百分比」，
    // 跨刻度（Pro 100 / Max20 2000 / Codex 500）可比、可加权平均
    let totalWeeklyIncreasePct = 0;
    let totalSessionUnits = 0;
    for (const phase of ann.weeklyPhases.values()) {
      if (phase.weeklyIncrease != null && phase.weeklyIncrease > 0 && phase.sessionUnits > 0) {
        totalWeeklyIncreasePct += (phase.weeklyIncrease / (phase.weeklyTotalPct || 100)) * 100;
        totalSessionUnits += phase.sessionUnits;
      }
    }
    if (totalSessionUnits > 0 && totalWeeklyIncreasePct > 0) {
      result.push({
        alias: aliasFromKey(key),
        provider: providerFromKey(key),
        // 每次完整 session 消耗本账号周额度的百分比（无刻度）
        rate: totalWeeklyIncreasePct / totalSessionUnits,
        sessionUnits: totalSessionUnits,
      });
    }
  }
  return result;
}

function computeProviderAvgCosts(accountRates: AccountRate[]): Record<string, number> {
  const grouped: Record<string, { weighted: number; units: number }> = {};
  for (const rate of accountRates) {
    const entry = grouped[rate.provider] ?? { weighted: 0, units: 0 };
    entry.weighted += rate.rate * rate.sessionUnits;
    entry.units += rate.sessionUnits;
    grouped[rate.provider] = entry;
  }
  return Object.fromEntries(
    Object.entries(grouped)
      .filter(([, value]) => value.units > 0)
      .map(([provider, value]) => [provider, value.weighted / value.units]),
  );
}

// ── StatusCards ───────────────────────────────────────────
export default function StatusCards({ snapshots, recommendation, analysis, localUsageStatuses, pluginUsageStatuses, onOpenRace, onRefresh }: Props) {
  const { colors, setColor } = useAccountColors();
  const { pauseStates, setPaused } = useAccountPauseStates();
  const { histories } = useAllHistories();
  const alarm = useResetAlarm(snapshots);
  const snapshotMap = Object.fromEntries(snapshots.map((s) => [accountKey(s), s]));
  const [storedRaces, setStoredRaces] = useState(() => loadStoredQuotaRaces());

  useEffect(() => {
    const reloadRaces = () => setStoredRaces(loadStoredQuotaRaces());
    window.addEventListener(QUOTA_RACE_UPDATED_EVENT, reloadRaces);
    window.addEventListener("storage", reloadRaces);
    return () => {
      window.removeEventListener(QUOTA_RACE_UPDATED_EVENT, reloadRaces);
      window.removeEventListener("storage", reloadRaces);
    };
  }, []);

  const orderedKeys = (() => {
    const seen = new Set<string>();
    const result: string[] = [];
    if (recommendation?.recommended_key) {
      result.push(recommendation.recommended_key);
      seen.add(recommendation.recommended_key);
    }
    for (const key of recommendation?.account_summaries.map((s) => s.key ?? keyFromParts(s.provider, s.alias)) ?? []) {
      if (!seen.has(key)) { result.push(key); seen.add(key); }
    }
    for (const key of snapshots.map((s) => accountKey(s))) {
      if (!seen.has(key)) { result.push(key); seen.add(key); }
    }
    return result;
  })();

  const accountRates = useMemo(() => computeAccountRates(histories, pauseStates), [histories, pauseStates]);
  const providerAvgCosts = useMemo(() => computeProviderAvgCosts(accountRates), [accountRates]);
  const activeRaceByAccount = useMemo(() => {
    const result = new Map<string, StoredQuotaRace>();
    for (const race of storedRaces) {
      if (race.status !== "active") continue;
      const current = result.get(race.accountKey);
      if (!current || race.startedAt > current.startedAt) result.set(race.accountKey, race);
    }
    return result;
  }, [storedRaces]);

  const validCosts = analysis
    .map((a) => a.weekly_cost_per_session_24h)
    .filter((v): v is number => v !== null && v > 0);
  const avgCost = validCosts.length > 0
    ? validCosts.reduce((a, b) => a + b, 0) / validCosts.length
    : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold" style={{ color: "#ddd" }}>账号状态总览</h2>
        <div className="flex items-center gap-2 ml-auto">
          <RateInfoBadge accountRates={accountRates} />
          <button onClick={onRefresh} className="btn-ghost flex items-center gap-1.5 text-xs">
            <span>↺</span>刷新
          </button>
        </div>
      </div>

      {orderedKeys.length === 0 ? (
        <div className="card text-center py-10 text-sm" style={{ color: "#888" }}>
          暂无数据，请在扩展中配置账号并上报
        </div>
      ) : (
        orderedKeys.map((key) => {
          const snap = snapshotMap[key];
          const sum = recommendation?.account_summaries.find((s) => (s.key ?? keyFromParts(s.provider, s.alias)) === key);
          const alias = snap?.account_alias ?? sum?.alias ?? aliasFromKey(key);
          const provider = snap?.provider ?? sum?.provider ?? providerFromKey(key);
          const cliLoggedIn = localUsageStatuses.some((status) =>
            status.ok && status.provider === provider && status.account_alias === alias
          );
          const pluginCollecting = pluginUsageStatuses.some((status) =>
            status.provider === provider &&
            status.account_alias === alias &&
            Date.now() - new Date(status.updated_at).getTime() <= PLUGIN_STATUS_FRESH_MS
          );
          const pause = pauseStates[key];
          const isPaused = pause?.paused ?? false;
          return (
            <AccountCard
              key={key}
              accountKey={key}
              provider={provider}
              alias={alias}
              snap={snap}
              sessionHours={sum?.session_remaining_hours ?? hoursUntil(snap?.session_reset_at ?? null)}
              weeklyHours={sum?.weekly_remaining_hours ?? hoursUntil(snap?.weekly_reset_at ?? null)}
              isRecommended={recommendation?.recommended_key === key && !isPaused}
              isPaused={isPaused}
              cliLoggedIn={cliLoggedIn}
              pluginCollecting={pluginCollecting}
              activeRace={activeRaceByAccount.get(key) ?? null}
              pausedAt={pause?.paused_at ?? null}
              onOpenRace={onOpenRace}
              onTogglePaused={async () => {
                await setPaused(provider, alias, !isPaused);
                onRefresh();
              }}
              avgCost={providerAvgCosts[provider] ?? avgCost}
              avgCostsByProvider={providerAvgCosts}
              allSnapshots={snapshots}
              accountHistory={histories[key] ?? []}
              colors={colors}
              setColor={setColor}
              alarmEnabled={alarm.isEnabled(key)}
              alarmRinging={alarm.ringingAliases.includes(key)}
              onToggleAlarm={() => alarm.toggle(key)}
              onStopAlarm={alarm.stopAll}
            />
          );
        })
      )}
    </div>
  );
}

// ── RateInfoBadge ─────────────────────────────────────────
function RateInfoBadge({ accountRates }: { accountRates: AccountRate[] }) {
  const [open, setOpen] = useState(false);
  const badgeRef = useRef<HTMLDivElement>(null);
  const popRef  = useRef<HTMLDivElement>(null);

  // 关闭弹窗的点击外部检测（必须在 early return 之前，保证 hooks 顺序固定）
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!badgeRef.current?.contains(e.target as Node) && !popRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (accountRates.length === 0) return null;

  const providerOrder = ["codex", "claude_code"];
  const providerSummaries = Array.from(
    accountRates.reduce((map, rate) => {
      const current = map.get(rate.provider) ?? { provider: rate.provider, weighted: 0, units: 0, accounts: [] as AccountRate[] };
      current.weighted += rate.rate * rate.sessionUnits;
      current.units += rate.sessionUnits;
      current.accounts.push(rate);
      map.set(rate.provider, current);
      return map;
    }, new Map<string, { provider: string; weighted: number; units: number; accounts: AccountRate[] }>())
      .values()
  )
    .map((summary) => ({ ...summary, avg: summary.weighted / summary.units }))
    .sort((a, b) => {
      const ai = providerOrder.indexOf(a.provider);
      const bi = providerOrder.indexOf(b.provider);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });

  // 弹窗定位：badge 下方，超出右侧则右对齐
  const popStyle = (): React.CSSProperties => {
    if (!badgeRef.current) return { position: 'fixed', top: 0, left: 0 };
    const r = badgeRef.current.getBoundingClientRect();
    const popW = 320;
    const left = r.right - popW < 8 ? r.left : r.right - popW;
    return { position: 'fixed', top: r.bottom + 6, left: Math.max(8, left), width: popW, zIndex: 400 };
  };

  return (
    <>
      <div ref={badgeRef} onClick={() => setOpen(v => !v)}
        style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer',
          padding: '3px 10px', borderRadius: 20, border: '1px solid #444',
          background: open ? '#2a2a2a' : '#1e1e1e', userSelect: 'none' }}>
        <span style={{ fontSize: 11, color: '#bbb' }}>换算率</span>
        {providerSummaries.map((summary) => (
          <span key={summary.provider} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ color: '#cfcfcf', display: 'inline-flex' }}>
              <ProviderIcon provider={summary.provider} size={12} />
            </span>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#a78bfa', fontFamily: 'monospace' }}>
              {summary.avg.toFixed(2)}%
            </span>
          </span>
        ))}
        <span style={{ fontSize: 11, color: '#aaa' }}>周额度 / 次</span>
        <span style={{ fontSize: 11, color: open ? '#a78bfa' : '#888' }}>▾</span>
      </div>

      {open && (
        <div ref={popRef} style={{ ...popStyle(),
          background: '#161616', border: '1px solid #3a3a3a', borderRadius: 10,
          boxShadow: '0 16px 48px rgba(0,0,0,0.75)', overflow: 'hidden' }}>
          {/* 头部 */}
          <div style={{ padding: '11px 14px', borderBottom: '1px solid #2e2e2e', background: '#1c1c1c' }}>
            <div style={{ fontSize: 12, color: '#aaa', marginBottom: 6 }}>每次完整 Session 消耗周额度的 %（分类型加权，权重 = 近30天 Session 次数）</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              {providerSummaries.map((summary) => (
                <div key={summary.provider} style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{ color: '#ddd', display: 'inline-flex', transform: 'translateY(2px)' }}>
                    <ProviderIcon provider={summary.provider} size={16} />
                  </span>
                  <span style={{ fontSize: 22, fontWeight: 800, color: '#a78bfa', fontFamily: 'monospace' }}>
                    {summary.avg.toFixed(2)}%
                  </span>
                </div>
              ))}
              <span style={{ fontSize: 12, color: '#bbb' }}>周额度 / 次</span>
            </div>
          </div>
          {/* 各账号明细 */}
          <div style={{ padding: '6px 0' }}>
            {providerSummaries.map((summary) => (
              <div key={summary.provider}>
                <div style={{ padding: '7px 14px 3px', display: 'flex', alignItems: 'center', gap: 6, color: '#aaa', fontSize: 11, textTransform: 'uppercase' }}>
                  <ProviderIcon provider={summary.provider} size={12} />
                  {providerLabel(summary.provider)}
                </div>
                {[...summary.accounts].sort((a, b) => b.rate - a.rate).map(a => {
                  const w = a.sessionUnits / summary.units;
                  const key = keyFromParts(a.provider, a.alias);
                  return (
                    <div key={key} style={{ padding: '6px 14px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 13, color: '#ddd', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <ProviderIcon provider={a.provider} size={13} />
                          {a.alias}
                        </span>
                        <span style={{ fontSize: 14, fontWeight: 700, color: '#a78bfa', fontFamily: 'monospace' }}>
                          {a.rate.toFixed(2)}%
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <div style={{ flex: 1, height: 4, background: '#2e2e2e', borderRadius: 2, overflow: 'hidden' }}>
                          <div style={{ width: `${w * 100}%`, height: '100%', background: '#7c3aed', borderRadius: 2 }} />
                        </div>
                        <span style={{ fontSize: 11, color: '#bbb', fontFamily: 'monospace', whiteSpace: 'nowrap', flexShrink: 0 }}>
                          {a.sessionUnits.toFixed(1)} 次 · {(w * 100).toFixed(0)}%权
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
                  </div>
          {/* 公式 */}
          <div style={{ padding: '8px 14px', borderTop: '1px solid #2e2e2e', background: '#1c1c1c' }}>
            <span style={{ fontSize: 11, color: '#aaa', fontFamily: 'monospace' }}>
              单类均值 = Σ(周额度涨幅% ) ÷ Σ(完整 session 次数)
            </span>
          </div>
        </div>
      )}
    </>
  );
}

// ── AccountCard ───────────────────────────────────────────
interface CardProps {
  accountKey: string;
  provider: string;
  alias: string;
  snap: UsageSnapshot | undefined;
  sessionHours: number | null;
  weeklyHours: number | null;
  isRecommended: boolean;
  avgCost: number | null;
  avgCostsByProvider: Record<string, number>;
  allSnapshots: UsageSnapshot[];
  accountHistory: UsageSnapshot[];
  colors: Record<string, string>;
  setColor: (alias: string, color: string) => Promise<void>;
  isPaused: boolean;
  cliLoggedIn: boolean;
  pluginCollecting: boolean;
  activeRace: StoredQuotaRace | null;
  pausedAt: string | null;
  onOpenRace: (raceId?: string, accountKey?: string) => void;
  onTogglePaused: () => Promise<void>;
  alarmEnabled: boolean;
  alarmRinging: boolean;
  onToggleAlarm: () => void;
  onStopAlarm: () => void;
}

function CollectingSourceBadge({ cli, plugin }: { cli: boolean; plugin: boolean }) {
  if (!cli && !plugin) return null;
  const combined = cli && plugin;
  const label = cli ? "CLI 采集中" : "插件 采集中";
  return (
    <span
      title={cli && plugin ? "本机 CLI 与 Chrome 插件都在采集额度" : cli ? "本机 CLI 正在采集额度" : "Chrome 插件正在实时采集额度"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        height: 20,
        padding: "0 7px",
        borderRadius: 999,
        border: "1px solid #245c44",
        background: "#123326",
        color: "#86efac",
        fontSize: 10,
        fontWeight: 700,
        whiteSpace: "nowrap",
        gap: 3,
      }}
    >
      {combined ? (
        <>
          <span>CLI</span>
          <span style={{ fontSize: 9, opacity: 0.9 }}>和</span>
          <span>插件</span>
          <span>采集中</span>
        </>
      ) : label}
    </span>
  );
}

function AccountTypeBadge({ label, multiplier }: { label: string; multiplier: number }) {
  const tone = multiplier >= 20
    ? { color: "#c4b5fd", border: "#5b3a92", background: "#241b35" }
    : multiplier >= 5
      ? { color: "#fca5a5", border: "#7f2f2f", background: "#2b1d1d" }
      : { color: "#93c5fd", border: "#1d4f86", background: "#172638" };
  return (
    <span
      className="inline-flex items-center justify-center font-semibold"
      style={{
        color: tone.color,
        border: `1px solid ${tone.border}`,
        background: tone.background,
        borderRadius: 999,
        padding: "1px 5px",
        fontSize: 10,
        lineHeight: "14px",
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  );
}

function ActiveRaceBadge({ race, onOpen }: { race: StoredQuotaRace; onOpen: () => void }) {
  return (
    <button
      type="button"
      title={`${race.alias} 正在进行额度竞赛，点击回到竞赛界面`}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      className="inline-flex items-center justify-center gap-1 font-semibold"
      style={{
        height: 20,
        padding: "0 7px",
        borderRadius: 999,
        border: "1px solid #6b522c",
        background: "#2b261d",
        color: "#f6c177",
        fontSize: 10,
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      <Flag size={11} />
      竞赛中
    </button>
  );
}

function AccountCard({ accountKey: identityKey, provider, alias, snap, sessionHours, weeklyHours, isRecommended, avgCost, avgCostsByProvider, allSnapshots, accountHistory, colors, setColor, isPaused, cliLoggedIn, pluginCollecting, activeRace, pausedAt, onOpenRace, onTogglePaused, alarmEnabled, alarmRinging, onToggleAlarm, onStopAlarm }: CardProps) {
  const [modal, setModal] = useState<"history" | "sprint" | null>(null);
  const colorInputRef = useRef<HTMLInputElement>(null);
  const accountColor = colors[identityKey] ?? colors[alias] ?? DEFAULT_COLOR;

  const weeklyPct = snap?.weekly_pct ?? null;
  const weeklyTotal = snap?.weekly_total_pct ?? 100;
  const weeklyRemaining = weeklyPct != null ? weeklyTotal - weeklyPct : null;
  // avgCost = 每次完整 session 消耗周额度的百分比（无刻度），剩余量同样化为百分比再除
  const weeklyRemainingPctOfQuota = weeklyRemaining != null && weeklyTotal > 0
    ? (weeklyRemaining / weeklyTotal) * 100 : null;
  const sessionsLeft = avgCost != null && avgCost > 0 && weeklyRemainingPctOfQuota != null
    ? Math.ceil(weeklyRemainingPctOfQuota / avgCost) : null;
  const resetDays = weeklyHours != null ? weeklyHours / 24 : null;
  const periodLabel = "Weekly";
  const periodQuotaLabel = "周额度";
  const quotaMultiplier = quotaMultiplierFromSnapshot(snap);
  const accountType = accountTypeLabel(provider, snap);
  // Weekly 进度条上的「今日配速目标框」（起点=今天开头 weekly%，终点=满额平均/天）
  // 周额度本身已到 98%+（快用满）则不显示目标框
  const weeklyPaceTarget = useMemo(
    () => (weeklyPct != null && weeklyTotal > 0 && weeklyPct / weeklyTotal >= 0.98)
      ? null
      : computeWeeklyPaceTarget(accountHistory, weeklyTotal, resetDays),
    [accountHistory, weeklyTotal, weeklyPct, resetDays],
  );

  return (
    <>
      <div className="card" style={{
        ...(isRecommended ? { outline: `1px solid ${accountColor}88` } : {}),
        opacity: isPaused ? 0.62 : 1,
      }}>
        {/* Header */}
        <div className="flex items-center justify-between mb-3 gap-2">
          <div className="flex items-center gap-2 min-w-0" style={{ flex: 1 }}>
            <div
              title="点击设置颜色"
              onClick={() => colorInputRef.current?.click()}
              style={{
                width: 30, height: 30, borderRadius: 8, flexShrink: 0,
                background: accountColor,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 14, fontWeight: 700, color: "#fff", cursor: "pointer",
                position: "relative",
              }}
            >
              <ProviderIcon provider={provider} size={18} />
              <input
                ref={colorInputRef}
                type="color"
                value={accountColor}
                onChange={(e) => void setColor(identityKey, e.target.value)}
                style={{ position: "absolute", opacity: 0, width: 0, height: 0, pointerEvents: "none" }}
              />
            </div>
              <div className="flex items-center gap-2 min-w-0" style={{ flex: 1 }}>
                <div className="flex flex-col leading-tight min-w-0" style={{ flex: "1 1 auto" }}>
                  <span className="text-sm font-semibold truncate block" style={{ color: "#eee" }}>{alias}</span>
                  <span className="text-[11px] flex items-center gap-1.5 truncate" style={{ color: "#bfc7d5" }}>
                    <span>{providerLabel(provider)}</span>
                    {accountType && <AccountTypeBadge label={accountType} multiplier={quotaMultiplier} />}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <CollectingSourceBadge cli={cliLoggedIn} plugin={pluginCollecting} />
                  {activeRace && (
                    <ActiveRaceBadge
                      race={activeRace}
                      onOpen={() => onOpenRace(activeRace.id, identityKey)}
                    />
                  )}
                  {isRecommended && <span className="plan-badge" style={{ fontSize: 10 }}>推荐</span>}
                </div>
              </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={(e) => {
                e.stopPropagation();
                void onTogglePaused();
              }}
              title={isPaused ? "恢复推荐和 30 天总览统计" : "暂时停用：不进入推荐，并从 30 天总览中截断旧数据"}
              className="text-xs px-2 py-1 rounded-md"
              style={{
                background: isPaused ? "#1f3a2c" : "#2c2c2c",
                color: isPaused ? "#86efac" : "#bbb",
                border: `1px solid ${isPaused ? "#2d5a44" : "#444"}`,
              }}
            >
              {isPaused ? "恢复" : "暂停"}
            </button>
            {snap && <span className="text-xs" style={{ color: "#888" }}>{formatLocalTime(snap.collected_at)}</span>}
          </div>
        </div>

        {isPaused && (
          <div className="text-xs px-2 py-1 rounded mb-2" style={{ background: "#202020", color: "#999", border: "1px solid #333" }}>
            暂停于 {formatLocalTime(pausedAt)}
          </div>
        )}

        {snap?.error && (
          <div className="text-xs px-2 py-1 rounded mb-2" style={{ background: "#3d1a1a", color: "#f87171" }}>
            ✗ {snap.error}
          </div>
        )}
        {!snap && <div className="text-sm" style={{ color: "#888" }}>等待上报数据…</div>}

        {snap && !snap.error && (
          <div className="flex gap-3">
            {/* 左：进度条（点击→历史） */}
            <div
              className="flex-1 rounded-lg px-3 py-2.5 cursor-pointer"
              style={{ background: "#242424", border: "1px solid #383838" }}
              onClick={() => setModal("history")}
            >
              <div className="space-y-2.5">
                <UsageRow label="Session (5h)" pct={snap.session_pct ?? null} total={snap.session_total_pct ?? 100}
                  resetHours={sessionHours} resetAt={snap.session_reset_at} colorFn={sessionResetColor}
                  preciseCountdown
                  resetExtra={
                    <AlarmBell enabled={alarmEnabled} ringing={alarmRinging} onToggle={onToggleAlarm} onStop={onStopAlarm} />
                  }
                />
                <UsageRow label={periodLabel} pct={snap.weekly_pct ?? null} total={snap.weekly_total_pct ?? 100}
                  resetHours={weeklyHours} resetAt={snap.weekly_reset_at} colorFn={weeklyResetColor}
                  preciseCountdownBelowHours={24}
                  paceTarget={weeklyPaceTarget}
                />
              </div>
            </div>

            {/* 右：X次耗尽（点击→冲刺规划） */}
            <div
              className="rounded-lg px-3 py-2.5 cursor-pointer flex flex-col justify-center items-center text-center"
              style={{ background: "#242424", border: "1px solid #383838", minWidth: 90 }}
              title="打开规划时间轴"
              onClick={() => setModal("sprint")}
            >
              <div className="text-3xl font-bold font-mono" style={{ color: "#fff" }}>
                {sessionsLeft != null ? sessionsLeft : "—"}
              </div>
              <div className="text-xs mt-0.5" style={{ color: "#aaa" }}>次耗尽{periodQuotaLabel}</div>
              <div className="text-sm font-semibold mt-2"
                style={{ color: weeklyResetColor(weeklyHours) }}>
                {resetDays != null ? `${resetDays.toFixed(1)}天后重置` : "—"}
              </div>
            </div>
          </div>
        )}
      </div>

      {modal === "history" && (
        <Modal title={`历史记录 · ${providerLabel(provider)} · ${alias}`} onClose={() => setModal(null)}>
          <HistoryPanel
            provider={provider}
            alias={alias}
            allAliases={allSnapshots.map((s) => accountKey(s))}
            colors={colors}
          />
        </Modal>
      )}
      {modal === "sprint" && (
        <Modal title="规划时间轴" onClose={() => setModal(null)}>
          <SprintPanel snapshots={allSnapshots} avgCost={avgCost} avgCostsByProvider={avgCostsByProvider} colors={colors} />
        </Modal>
      )}
    </>
  );
}

// ── UsageRow ──────────────────────────────────────────────
function formatCountdownMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d${hours}h${minutes}m${seconds}s`;
  if (hours > 0) return `${hours}h${minutes}m${seconds}s`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

/** pct 占其 total 的百分比（0–100）；total 缺省 100。用于 5x/20x 账号的进度条/配色阈值 */
function ratioPct(pct: number | null | undefined, total: number | null | undefined): number {
  const t = total && total > 0 ? total : 100;
  return ((pct ?? 0) / t) * 100;
}

// ── 今日配速目标框（Weekly 进度条上的「满额平均」装饰）─────────
// 起点 = 今天开头的 weekly_pct（若今天是周重置日，今天第一条已是重置后的低值，天然满足）；
// 终点 = 起点 +（今天开头剩余额度 ÷ 距重置剩余天数）× 权重；权重默认 1，仅「今天发生周重置」时按今天已过比例缩减。返回 0–1 比例。
interface PaceTarget { startRatio: number; endRatio: number; targetPct: number; startPct: number; }

function computeWeeklyPaceTarget(records: UsageSnapshot[] | undefined, total: number, remainingDays: number | null): PaceTarget | null {
  if (!records || records.length === 0 || !total || total <= 0) return null;
  const valid = records
    .filter(r => r.error == null && r.weekly_pct != null && r.collected_at)
    .sort((a, b) => a.collected_at.localeCompare(b.collected_at));
  if (valid.length === 0) return null;
  const ld = (iso: string) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const now = new Date();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const todays = valid.filter(r => ld(r.collected_at) === today);
  const startPct = Math.max(0, todays.length > 0 ? todays[0].weekly_pct! : valid[valid.length - 1].weekly_pct!);
  // 每天应消耗 = 今天开头剩余额度 ÷ 距重置剩余天数。
  // 关键：剩余天数按「今天零点 → 周重置时刻」算（一整天内恒定），不能用实时递减的剩余小时——
  // 否则 days 在一天里不断变小、daily 变大，目标线会持续右移（本次修复点）。remainingDays 仅作兜底。
  const resetIso = todays.length > 0 ? todays[todays.length - 1].weekly_reset_at : valid[valid.length - 1].weekly_reset_at;
  let days = remainingDays != null && remainingDays > 0 ? remainingDays : 7;
  if (resetIso) {
    const d = (new Date(resetIso).getTime() - todayMidnight.getTime()) / 86_400_000;
    if (d > 0) days = d;
  }
  const daily = Math.max(0, (total - startPct) / days);
  // 权重默认 1（今天整段）；仅「今天发生了周重置」是部分天，才按今天已过比例缩减
  const normHour = (iso?: string | null) => (iso ? Math.round(new Date(iso).getTime() / 3_600_000) : null);
  const firstTodayIdx = valid.findIndex(r => ld(r.collected_at) === today);
  let todayHadReset = false;
  if (firstTodayIdx > 0) {
    const prev = valid[firstTodayIdx - 1], curr = valid[firstTodayIdx];
    const a = normHour(prev.weekly_reset_at), b = normHour(curr.weekly_reset_at);
    todayHadReset = a != null && b != null ? a !== b : curr.weekly_pct! < prev.weekly_pct! - 1;
  }
  let weight = 1;
  if (todayHadReset) {
    weight = Math.min(1, Math.max(0, (now.getTime() - todayMidnight.getTime()) / 86_400_000));
  }
  // 终点超出满额则 cap 到 total（落在 100% 进度处）
  const targetPct = Math.min(total, startPct + daily * weight);
  return { startRatio: startPct / total, endRatio: targetPct / total, targetPct, startPct };
}

function PaceTargetOverlay({ startRatio, endRatio, targetPct }: PaceTarget) {
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const left = clamp(startRatio) * 100;
  const right = clamp(endRatio) * 100;
  const width = Math.max(0, right - left);
  return (
    <div className="absolute inset-0 pointer-events-none">
      {/* 今天应推进的一段：斜线纹路填充，右边界=满额平均目标线 */}
      <div
        className="absolute top-0 bottom-0"
        style={{
          left: `${left}%`,
          width: `${width}%`,
          background: "rgba(217,140,255,0.14)",
          backgroundImage: "repeating-linear-gradient(45deg, rgba(217,140,255,0.72) 0px, rgba(217,140,255,0.72) 1.5px, transparent 1.5px, transparent 5px)",
          borderLeft: "1px dashed rgba(217,140,255,0.78)",
          borderRight: "1.5px solid #d98cff",
          borderRadius: 2,
          boxShadow: "0 0 0 0.5px rgba(0,0,0,0.35)",
          boxSizing: "border-box",
        }}
      />
      {/* 目标值：纯白，居中对齐右边界（终点/目标线），挨着进度条上边线 */}
      <div
        className="absolute font-mono font-semibold"
        style={{
          left: `${right}%`,
          top: -1,
          transform: "translate(-50%, -100%)",
          fontSize: 8,
          lineHeight: 1,
          color: "#d98cff",
          whiteSpace: "nowrap",
          textShadow: "0 1px 2px rgba(0,0,0,0.95), 0 0 2px rgba(0,0,0,0.9)",
        }}
      >
        目标 {Math.round(targetPct)}%
      </div>
    </div>
  );
}

function UsageRow({ label, pct, total, resetHours, resetAt, colorFn, resetExtra, preciseCountdown = false, preciseCountdownBelowHours, paceTarget }: {
  label: string; pct: number | null; total?: number | null;
  resetHours: number | null; resetAt: string | null;
  colorFn: (h: number | null) => string;
  resetExtra?: React.ReactNode;
  preciseCountdown?: boolean;
  preciseCountdownBelowHours?: number;
  paceTarget?: PaceTarget | null;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [peek, setPeek] = useState(false); // 悬浮临时看「占总%」（仅 5x/20x）

  useEffect(() => {
    if ((!preciseCountdown && preciseCountdownBelowHours == null) || !resetAt) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [preciseCountdown, preciseCountdownBelowHours, resetAt]);

  const totalPct = total ?? 100;
  const rem = remaining(pct, totalPct);
  const multiplied = totalPct > 100; // 5x/20x 账号
  const ofTotal = pct === null ? null : (pct / totalPct) * 100; // 占总额度百分比 0–100
  const resetMs = resetAt ? new Date(resetAt).getTime() - nowMs : null;
  const preciseLimitMs = preciseCountdownBelowHours != null ? preciseCountdownBelowHours * 3_600_000 : null;
  const shouldUsePrecise = preciseCountdown || (resetMs !== null && preciseLimitMs !== null && resetMs <= preciseLimitMs);
  const effectiveResetHours = resetMs !== null ? Math.max(0, resetMs / 3_600_000) : resetHours;
  const color = colorFn(effectiveResetHours);
  const resetText = shouldUsePrecise && resetMs !== null
    ? `${formatCountdownMs(resetMs)}后重置`
    : resetHours !== null ? `${formatHours(resetHours)}后重置` : formatLocalTime(resetAt);
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span style={{ color: "#aaa" }}>{label}</span>
        <div className="flex items-center gap-2">
          <span
            className="font-semibold font-mono"
            style={{ color: "#fff", cursor: multiplied ? "help" : "default" }}
            onMouseEnter={() => multiplied && setPeek(true)}
            onMouseLeave={() => setPeek(false)}
            title={multiplied ? "悬浮：占总额度的百分比" : undefined}
          >
            {peek && multiplied ? `${formatPct(ofTotal)} 占总` : `${formatPct(pct)} / ${totalPct.toFixed(0)}%`}
          </span>
          <span style={{ color: "#bbb" }}>余 {formatPct(rem)}</span>
        </div>
      </div>
      {paceTarget ? (
        <div className="relative">
          <ProgressBar pct={pct} total={totalPct} />
          <PaceTargetOverlay {...paceTarget} />
        </div>
      ) : (
        <ProgressBar pct={pct} total={totalPct} />
      )}
      <div className="text-xs mt-1 font-medium flex items-center gap-1.5" style={{ color }}>
        <span>{resetText}</span>
        {resetExtra}
      </div>
    </div>
  );
}

// ── Modal ─────────────────────────────────────────────────
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: "#181818" }}>
      <div className="flex items-center justify-between px-4 py-3 shrink-0" style={{ borderBottom: "1px solid #333" }}>
        <span className="text-sm font-semibold" style={{ color: "#eee" }}>{title}</span>
        <button onClick={onClose} className="text-sm px-3 py-1 rounded-lg"
          style={{ background: "#333", color: "#ccc", border: "1px solid #444" }}>关闭</button>
      </div>
      <div className="flex-1 overflow-auto p-3">{children}</div>
    </div>
  );
}

// ── Daily session stats ───────────────────────────────────
interface DayStats { date: string; consumed: number; total?: number; }

// session_reset_at / weekly_reset_at 整点±1分钟归一：四舍五入到最近整点
function normalizeToHour(isoStr: string): string {
  const d = new Date(isoStr);
  if (d.getMinutes() >= 30) d.setHours(d.getHours() + 1);
  d.setMinutes(0, 0, 0);
  // 用本地时间分量，避免 toISOString() 输出 UTC 导致时区偏差
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}`;
}

// 按 session_reset_at 整点分组，每组取最新值作为该 session 消耗量
function groupSessionsByResetHour(records: UsageSnapshot[]): Map<string, UsageSnapshot> {
  const valid = [...records]
    .filter(r => r.error == null && r.session_pct != null && r.session_reset_at != null)
    .sort((a, b) => a.collected_at.localeCompare(b.collected_at));
  const latest = new Map<string, UsageSnapshot>();
  for (const r of valid) {
    latest.set(normalizeToHour(r.session_reset_at!), r); // 后覆盖前 = 保留最新
  }
  return latest;
}

function computeDailyStats(records: UsageSnapshot[]): {
  days: DayStats[];
  weeklyResetDates: Set<string>;
} {
  const valid = [...records]
    .filter(r => r.error == null && r.session_pct != null && r.session_reset_at != null)
    .sort((a, b) => a.collected_at.localeCompare(b.collected_at));
  if (valid.length === 0) return { days: [], weeklyResetDates: new Set() };

  const dailySessionLatest = new Map<string, Map<string, UsageSnapshot>>();
  const dailySessionFirstSeen = new Map<string, Map<string, string>>();
  for (const r of valid) {
    const date = new Date(r.collected_at).toLocaleDateString("en-CA");
    const sKey = normalizeToHour(r.session_reset_at!);
    if (!dailySessionLatest.has(date)) dailySessionLatest.set(date, new Map());
    if (!dailySessionFirstSeen.has(date)) dailySessionFirstSeen.set(date, new Map());
    dailySessionLatest.get(date)!.set(sKey, r);
    if (!dailySessionFirstSeen.get(date)!.has(sKey)) {
      dailySessionFirstSeen.get(date)!.set(sKey, r.collected_at);
    }
  }

  const dayConsumed = new Map<string, number>();
  const weeklyResetDates = new Set<string>();
  let prevWeeklyKey: string | null = null;
  let prevDate: string | null = null;
  let prevLastSessionKey: string | null = null;

  for (const date of [...dailySessionLatest.keys()].sort()) {
    const latestBySession = dailySessionLatest.get(date)!;
    const firstSeen = dailySessionFirstSeen.get(date)!;
    const sessionKeys = [...latestBySession.keys()]
      .sort((a, b) => (firstSeen.get(a) ?? "").localeCompare(firstSeen.get(b) ?? ""));
    const firstSessionKey = sessionKeys[0] ?? null;

    let total = 0;
    for (const sKey of sessionKeys) {
      const latest = latestBySession.get(sKey)!;
      let consumed = latest.session_pct!;
      if (sKey === firstSessionKey && prevDate && prevLastSessionKey === sKey) {
        const prevLatest = dailySessionLatest.get(prevDate)?.get(sKey);
        if (prevLatest?.session_pct != null) {
          consumed = Math.max(0, latest.session_pct! - prevLatest.session_pct);
        }
      }
      total += consumed;
    }
    dayConsumed.set(date, total);

    const lastSession = latestBySession.get(sessionKeys[sessionKeys.length - 1]);
    const wKey = lastSession?.weekly_reset_at ? normalizeToHour(lastSession.weekly_reset_at) : null;
    if (prevWeeklyKey && wKey && wKey !== prevWeeklyKey) weeklyResetDates.add(date);
    if (wKey) prevWeeklyKey = wKey;
    prevDate = date;
    prevLastSessionKey = sessionKeys[sessionKeys.length - 1] ?? null;
  }

  // 从最早日期到今天构建完整序列，最多显示 30 天
  const sortedDates = [...dayConsumed.keys()].sort();
  const allDates: string[] = [];
  const cur = new Date(sortedDates[0] + "T00:00:00");
  const today = new Date(); today.setHours(23, 59, 59, 999);
  while (cur <= today) { allDates.push(cur.toLocaleDateString("en-CA")); cur.setDate(cur.getDate() + 1); }
  const displayDates = new Set(allDates.slice(-30));

  const days: DayStats[] = [];
  for (const date of allDates) {
    if (displayDates.has(date)) {
      days.push({ date, consumed: Math.round((dayConsumed.get(date) ?? 0) * 10) / 10 });
    }
  }
  return { days, weeklyResetDates };
}

// ── Daily weekly-quota stats ──────────────────────────────
// 每日「周额度」消耗：取当天最新一条的 weekly_pct，与前一天最新值作差；
// 跨周重置（weekly_reset_at 整点变化）当天取重置后的累计值本身。
function computeDailyWeeklyStats(records: UsageSnapshot[]): {
  days: DayStats[];
  weeklyResetDates: Set<string>;
} {
  const valid = [...records]
    .filter(r => r.error == null && r.weekly_pct != null && r.weekly_reset_at != null)
    .sort((a, b) => a.collected_at.localeCompare(b.collected_at));
  if (valid.length === 0) return { days: [], weeklyResetDates: new Set() };

  // 每天最新一条（后覆盖前 = 当天 collected_at 最新）
  const dailyLatest = new Map<string, UsageSnapshot>();
  for (const r of valid) {
    const date = new Date(r.collected_at).toLocaleDateString("en-CA");
    dailyLatest.set(date, r);
  }

  const dayConsumed = new Map<string, number>();
  const dayTotal = new Map<string, number>(); // 当天 weekly_total_pct（=100×倍率），用于「满额/天」参考线
  const weeklyResetDates = new Set<string>();
  let prevWeeklyKey: string | null = null;
  let prevWeeklyPct: number | null = null;

  for (const date of [...dailyLatest.keys()].sort()) {
    const r = dailyLatest.get(date)!;
    const wKey = normalizeToHour(r.weekly_reset_at!);
    const wPct = r.weekly_pct!;
    let consumed: number;
    if (prevWeeklyKey === wKey && prevWeeklyPct != null) {
      consumed = Math.max(0, wPct - prevWeeklyPct); // 同一周窗口：取增量
    } else {
      consumed = wPct; // 新的一周（或首日）：重置后的累计
      if (prevWeeklyKey != null) weeklyResetDates.add(date);
    }
    dayConsumed.set(date, consumed);
    dayTotal.set(date, r.weekly_total_pct ?? 100);
    prevWeeklyKey = wKey;
    prevWeeklyPct = wPct;
  }

  // 与 session 图一致：从最早日期补全到今天，最多显示 30 天
  const sortedDates = [...dayConsumed.keys()].sort();
  const allDates: string[] = [];
  const cur = new Date(sortedDates[0] + "T00:00:00");
  const today = new Date(); today.setHours(23, 59, 59, 999);
  while (cur <= today) { allDates.push(cur.toLocaleDateString("en-CA")); cur.setDate(cur.getDate() + 1); }
  const displayDates = new Set(allDates.slice(-30));

  const days: DayStats[] = [];
  for (const date of allDates) {
    if (displayDates.has(date)) {
      days.push({ date, consumed: Math.round((dayConsumed.get(date) ?? 0) * 10) / 10, total: dayTotal.get(date) });
    }
  }
  return { days, weeklyResetDates };
}

// ── Table annotations（历史表格高亮框 + 悬浮详情）──────────
// spanType: 1=session 完整在本阶段内  2=横跨两段（从前段延续）  3=横跨三段及以上（中间段）
interface SessionDetail {
  resetHour: string;
  startPct: number;     // 本阶段内该 session 首次出现时的 session_pct
  endPct: number;       // 本阶段内该 session 最后一次的 session_pct
  contribution: number; // endPct − startPct（本阶段内该 session 实际消耗）
  spanType: 1 | 2 | 3;
}

interface WeeklyPhaseDetail {
  sessions: SessionDetail[];
  sessionTotal: number;
  sessionUnits: number;
  weeklyLevel: number;
  weeklyIncrease: number | null;
  weeklyTotalPct: number;
  weeklyResetHour: string;
  phaseIndexInWeek: number;
  weekIndex: number;
}

interface TableAnnotations {
  dayFormulas: Map<string, string>;
  dayDetails: Map<string, SessionDetail[]>;
  dayOrder: Map<string, number>;
  weeklyPhases: Map<string, WeeklyPhaseDetail>;
  getDayKey: (r: UsageSnapshot) => string;
  getWeeklyKey: (r: UsageSnapshot) => string;
}

function computeTableAnnotations(records: UsageSnapshot[]): TableAnnotations {
  // ── Session-latest 用于 Day 分组（Session 列框） ──────────
  const sessionLatest = groupSessionsByResetHour(records);
  const sortedLatest = [...sessionLatest.values()]
    .sort((a, b) => a.collected_at.localeCompare(b.collected_at));

  const dayVals = new Map<string, number[]>();
  const dayDetails = new Map<string, SessionDetail[]>();
  for (const r of sortedLatest) {
    const date = new Date(r.collected_at).toLocaleDateString("en-CA");
    if (!dayVals.has(date)) { dayVals.set(date, []); dayDetails.set(date, []); }
    dayVals.get(date)!.push(r.session_pct!);
    // Day 详情只展示最终值，startPct=0, contribution=pct
    dayDetails.get(date)!.push({
      resetHour: normalizeToHour(r.session_reset_at!),
      startPct: 0, endPct: r.session_pct!, contribution: r.session_pct!, spanType: 1,
    });
  }
  const dayFormulas = new Map<string, string>();
  for (const [date, vals] of dayVals) {
    const total = Math.round(vals.reduce((a, b) => a + b, 0) * 10) / 10;
    const parts = vals.map(v => v.toFixed(0) + '%');
    dayFormulas.set(date, parts.length > 1
      ? (parts.length <= 5 ? parts.join('+') : `${parts.length}次`) + '=' + total.toFixed(0) + '%'
      : total.toFixed(0) + '%');
  }
  const dayOrder = new Map([...dayVals.keys()].sort().map((d, i) => [d, i]));

  // ── Weekly 阶段 ────────────────────────────────────────────
  // 分段规则：weekly_pct 整数值首次变化的那条记录是旧段的收尾（归入旧段），
  // 下一条同值记录才是新段的起点。
  // 例：31,31,31,32|32,32,...,34|34,34 → 第1段/第2段/当前段
  // weeklyIncrease = phaseWeeklyLast − phaseWeeklyFirst（最后段为 null）

  const localDate = (isoStr: string): string => {
    const d = new Date(isoStr);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  };

  const allSorted = [...records]
    .filter(r => r.weekly_pct != null && r.weekly_reset_at != null)
    .sort((a, b) => a.collected_at.localeCompare(b.collected_at));

  interface PhaseSessionEntry { startPct: number; endPct: number; }
  const phaseSessionMap = new Map<string, Map<string, PhaseSessionEntry>>();
  const phaseInsertOrder: string[] = [];
  const phaseWeeklyFirst = new Map<string, number>();
  const phaseWeeklyLast  = new Map<string, number>();
  const weekColorMap = new Map<string, number>();
  let weekColorCnt = 0;
  // collected_at → phaseKey（用于表格行查找，不能再用纯函数推导）
  const recordPhaseMap = new Map<string, string>();

  const globalSessionPct = new Map<string, number>();

  let curPhaseKey: string | null = null;
  let prevRound: number | null = null;
  let prevWDay: string | null = null;
  let phaseSeq = 0;

  const initPhase = (key: string, firstWeeklyPct: number) => {
    phaseSessionMap.set(key, new Map());
    phaseInsertOrder.push(key);
    phaseWeeklyFirst.set(key, firstWeeklyPct);
  };

  const addToPhase = (phaseKey: string, r: typeof allSorted[0]) => {
    recordPhaseMap.set(r.collected_at, phaseKey);
    phaseWeeklyLast.set(phaseKey, r.weekly_pct!);
    if (r.session_reset_at == null || r.session_pct == null) return;
    const sHour = normalizeToHour(r.session_reset_at);
    const sm = phaseSessionMap.get(phaseKey)!;
    if (!sm.has(sHour)) {
      sm.set(sHour, { startPct: globalSessionPct.get(sHour) ?? 0, endPct: r.session_pct });
    } else {
      sm.get(sHour)!.endPct = r.session_pct;
    }
    globalSessionPct.set(sHour, r.session_pct);
  };

  for (const r of allSorted) {
    const wDay = localDate(r.weekly_reset_at!);
    const wRound = Math.round(r.weekly_pct!);
    if (!weekColorMap.has(wDay)) weekColorMap.set(wDay, weekColorCnt++);

    const weekChanged = prevWDay !== null && wDay !== prevWDay;

    if (curPhaseKey === null || weekChanged) {
      // 新的一周，直接开新段
      curPhaseKey = `${wDay}_ph${phaseSeq++}`;
      initPhase(curPhaseKey, r.weekly_pct!);
      prevRound = wRound;
      prevWDay = wDay;
      addToPhase(curPhaseKey, r);
    } else if (wRound !== prevRound) {
      // 整数值首次变化：当前记录作为旧段收尾，然后开新段（当前记录不进新段）
      addToPhase(curPhaseKey, r);   // 收尾旧段
      const newKey = `${wDay}_ph${phaseSeq++}`;
      initPhase(newKey, r.weekly_pct!); // 新段首个值暂设为当前，会被下条覆盖
      curPhaseKey = newKey;
      prevRound = wRound;
      // 注意：当前记录已归入旧段，不再归入新段
    } else {
      addToPhase(curPhaseKey, r);
      prevRound = wRound;
    }
  }

  // 按周分组
  const phasesByWeek = new Map<string, string[]>();
  for (const pKey of phaseInsertOrder) {
    const wDay = pKey.split('_ph')[0];
    if (!phasesByWeek.has(wDay)) phasesByWeek.set(wDay, []);
    phasesByWeek.get(wDay)!.push(pKey);
  }

  // ── 后处理：≤1 条记录的段并入前一段 ─────────────────────────
  const phaseRecordCount = new Map<string, number>();
  for (const pk of recordPhaseMap.values()) {
    phaseRecordCount.set(pk, (phaseRecordCount.get(pk) ?? 0) + 1);
  }

  const mergePhaseInto = (from: string, into: string) => {
    for (const [ca, pk] of recordPhaseMap) {
      if (pk === from) recordPhaseMap.set(ca, into);
    }
    const fromSm = phaseSessionMap.get(from);
    const intoSm = phaseSessionMap.get(into);
    if (fromSm && intoSm) {
      for (const [sHour, entry] of fromSm) {
        if (intoSm.has(sHour)) intoSm.get(sHour)!.endPct = entry.endPct;
        else intoSm.set(sHour, entry);
      }
    }
    const fromLast = phaseWeeklyLast.get(from);
    if (fromLast != null) phaseWeeklyLast.set(into, fromLast);
  };

  for (const [wDay, phaseKeys] of phasesByWeek) {
    const toRemove = new Set<string>();
    let lastValidKey = phaseKeys[0];
    for (let i = 1; i < phaseKeys.length; i++) {
      const pKey = phaseKeys[i];
      if ((phaseRecordCount.get(pKey) ?? 0) <= 1) {
        mergePhaseInto(pKey, lastValidKey);
        toRemove.add(pKey);
      } else {
        lastValidKey = pKey;
      }
    }
    if (toRemove.size > 0) {
      phasesByWeek.set(wDay, phaseKeys.filter(k => !toRemove.has(k)));
    }
  }

  const weeklyPhases = new Map<string, WeeklyPhaseDetail>();
  for (const [wDay, phaseKeys] of phasesByWeek) {
    for (let i = 0; i < phaseKeys.length; i++) {
      const pKey = phaseKeys[i];
      const isLast = i === phaseKeys.length - 1;
      const nextPKey = phaseKeys[i + 1] ?? null;
      const sessionMap = phaseSessionMap.get(pKey)!;
      const nextSessionMap = nextPKey ? phaseSessionMap.get(nextPKey) : null;

      const sessions: SessionDetail[] = [];
      for (const [sHour, entry] of sessionMap) {
        const contribution = Math.round((entry.endPct - entry.startPct) * 10) / 10;
        const isCarried = entry.startPct > 2;
        const continuesNext = nextSessionMap?.has(sHour) ?? false;
        let spanType: 1 | 2 | 3;
        if (!isCarried && !continuesNext) spanType = 1;
        else if (isCarried && continuesNext) spanType = 3;
        else spanType = 2;
        if (contribution >= 0) {
          sessions.push({ resetHour: sHour, startPct: entry.startPct, endPct: entry.endPct, contribution, spanType });
        }
      }
      sessions.sort((a, b) => a.resetHour.localeCompare(b.resetHour));

      const sessionTotal = Math.round(sessions.reduce((s, d) => s + d.contribution, 0) * 10) / 10;
      const phaseRecords = allSorted.filter((r) => recordPhaseMap.get(r.collected_at) === pKey);
      const sessionTotalPct = phaseRecords
        .map((r) => r.session_total_pct ?? 100)
        .find((total) => total > 0) ?? 100;
      const weeklyTotalPct = phaseRecords
        .map((r) => r.weekly_total_pct ?? 100)
        .find((total) => total > 0) ?? 100;
      const sessionUnits = Math.round((sessionTotal / sessionTotalPct) * 1000) / 1000;
      // weeklyIncrease = 本段内 weekly 涨幅，最后段（进行中）= null
      const weeklyIncrease = isLast ? null
        : Math.round(((phaseWeeklyLast.get(pKey) ?? 0) - (phaseWeeklyFirst.get(pKey) ?? 0)) * 10) / 10;

      weeklyPhases.set(pKey, {
        sessions, sessionTotal, sessionUnits,
        weeklyLevel: Math.round((phaseWeeklyLast.get(pKey) ?? 0) * 10) / 10,
        weeklyIncrease,
        weeklyTotalPct,
        weeklyResetHour: wDay,
        phaseIndexInWeek: i,
        weekIndex: weekColorMap.get(wDay) ?? 0,
      });
    }
  }

  const getDayKey = (r: UsageSnapshot) => {
    if (!r.session_reset_at) return `isolated_${r.id ?? r.collected_at}`;
    return new Date(r.collected_at).toLocaleDateString("en-CA");
  };
  // 用 recordPhaseMap 查找，而非纯函数推导（同值不同段的情况用纯函数无法区分）
  const getWeeklyKey = (r: UsageSnapshot) => {
    if (!r.weekly_reset_at || r.weekly_pct == null) return `isolated_${r.id ?? r.collected_at}`;
    return recordPhaseMap.get(r.collected_at) ?? `isolated_${r.id ?? r.collected_at}`;
  };

  return { dayFormulas, dayDetails, dayOrder, weeklyPhases, getDayKey, getWeeklyKey };
}

// ── Session 分组调色板（冷色系，按天循环）─────────────────
const DAY_GROUP_PALETTE = [
  { bg: 'rgba(99,102,241,0.13)',  border: 'rgba(99,102,241,0.6)'  },  // indigo
  { bg: 'rgba(14,165,233,0.13)',  border: 'rgba(14,165,233,0.6)'  },  // sky
  { bg: 'rgba(16,185,129,0.13)',  border: 'rgba(16,185,129,0.6)'  },  // emerald
  { bg: 'rgba(217,70,239,0.13)',  border: 'rgba(217,70,239,0.6)'  },  // fuchsia
  { bg: 'rgba(239,68,68,0.13)',   border: 'rgba(239,68,68,0.6)'   },  // red
  { bg: 'rgba(59,130,246,0.13)',  border: 'rgba(59,130,246,0.6)'  },  // blue
];

// ── Weekly 分组调色板（暖色系，按周循环，虚线框区别于 Session）─
const WEEKLY_GROUP_PALETTE = [
  { bg: 'rgba(234,179,8,0.12)',   border: 'rgba(234,179,8,0.65)'   },  // yellow
  { bg: 'rgba(236,72,153,0.12)',  border: 'rgba(236,72,153,0.65)'  },  // pink
  { bg: 'rgba(249,115,22,0.12)',  border: 'rgba(249,115,22,0.65)'  },  // orange
  { bg: 'rgba(244,63,94,0.12)',   border: 'rgba(244,63,94,0.65)'   },  // rose
  { bg: 'rgba(168,85,247,0.12)',  border: 'rgba(168,85,247,0.65)'  },  // violet
  { bg: 'rgba(20,184,166,0.12)',  border: 'rgba(20,184,166,0.65)'  },  // teal
];

// ── GroupTooltip（跟随鼠标的悬浮详情面板）──────────────────
interface TooltipInfo {
  type: 'day' | 'weekly';
  key: string;
  currentSessionHour: string;
}

function SessionList({ details, currentHour, palette, showSpan = false }: {
  details: SessionDetail[];
  currentHour: string;
  palette: { bg: string; border: string };
  showSpan?: boolean;
}) {
  const color = palette.border.replace(/[\d.]+\)$/, '1)');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {details.map((d, i) => {
        const isCurrent = d.resetHour === currentHour;
        const hour = d.resetHour.substring(11);
        const spanTag = showSpan && d.spanType !== 1
          ? (d.spanType === 3 ? ' ↕' : d.startPct > 2 ? ' ←' : ' →')
          : '';
        const valueLabel = showSpan && d.spanType !== 1
          ? `${d.startPct.toFixed(0)}→${d.endPct.toFixed(0)}%`
          : `+${d.contribution.toFixed(0)}%`;
        return (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: isCurrent ? '3px 6px' : '0',
            borderRadius: isCurrent ? 4 : 0,
            background: isCurrent ? palette.bg : 'transparent',
            outline: isCurrent ? `1px solid ${palette.border}` : 'none',
          }}>
            <span style={{ fontSize: isCurrent ? 13 : 12, color: isCurrent ? '#ddd' : '#aaa', width: 46, flexShrink: 0, fontFamily: 'monospace', fontWeight: isCurrent ? 700 : 400 }}>
              {hour}:00{spanTag}
            </span>
            <div style={{ flex: 1, height: isCurrent ? 6 : 5, background: '#333', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ width: `${Math.min(100, d.contribution)}%`, height: '100%', borderRadius: 3,
                background: isCurrent ? color : palette.border.replace(/[\d.]+\)$/, '0.5)') }} />
            </div>
            <span style={{ fontSize: isCurrent ? 13 : 12, fontWeight: isCurrent ? 800 : 600,
              color: isCurrent ? color : '#bbb', fontFamily: 'monospace', width: 58, textAlign: 'right', flexShrink: 0 }}>
              {valueLabel}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// GroupTooltip 只负责内容渲染，不负责定位（由父组件的 ref+RAF 控制）
function GroupTooltip({ info, annotations }: {
  info: TooltipInfo;
  annotations: TableAnnotations;
}) {
  const isDay = info.type === 'day';

  if (isDay) {
    const details = annotations.dayDetails.get(info.key);
    if (!details || details.length === 0) return null;
    const palette = DAY_GROUP_PALETTE[(annotations.dayOrder.get(info.key) ?? 0) % DAY_GROUP_PALETTE.length];
    const color = palette.border.replace(/[\d.]+\)$/, '1)');
    const total = Math.round(details.reduce((a, b) => a + b.contribution, 0) * 10) / 10;
    const dayIdx = annotations.dayOrder.get(info.key) ?? 0;
    return (
      <div style={{ width: 260, background: '#141414', border: `1px solid ${palette.border}`, borderRadius: 10,
        boxShadow: '0 20px 60px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.04)', overflow: 'hidden' }}>
        <div style={{ background: palette.bg, borderBottom: `1px solid ${palette.border.replace(/[\d.]+\)$/, '0.25)')}`, padding: '9px 13px' }}>
          <div style={{ fontSize: 11, color: '#aaa', letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 3 }}>Day {dayIdx + 1} · Session 每日消耗</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#eee', fontFamily: 'monospace' }}>{info.key}</div>
        </div>
        <div style={{ padding: '10px 13px' }}>
          <SessionList details={details} currentHour={info.currentSessionHour} palette={palette} />
        </div>
        <div style={{ borderTop: `1px solid ${palette.border.replace(/[\d.]+\)$/, '0.25)')}`, padding: '8px 13px',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: palette.bg }}>
          <span style={{ fontSize: 12, color: '#ccc' }}>合计消耗</span>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
            <span style={{ fontSize: 19, fontWeight: 800, color, fontFamily: 'monospace', lineHeight: 1 }}>{total.toFixed(0)}</span>
            <span style={{ fontSize: 12, color: palette.border }}>%</span>
          </div>
        </div>
      </div>
    );
  }

  const phase = annotations.weeklyPhases.get(info.key);
  if (!phase) return null;
  const { sessions, sessionTotal, weeklyLevel, weeklyIncrease, weekIndex, phaseIndexInWeek } = phase;
  const palette = WEEKLY_GROUP_PALETTE[weekIndex % WEEKLY_GROUP_PALETTE.length];
  const color = palette.border.replace(/[\d.]+\)$/, '1)');
  const rate = weeklyIncrease != null && sessionTotal > 0
    ? Math.round(weeklyIncrease / sessionTotal * 1000) / 10
    : null;
  return (
    <div style={{ width: 276, background: '#141414', border: `1px dashed ${palette.border}`, borderRadius: 10,
      boxShadow: '0 20px 60px rgba(0,0,0,0.85), 0 0 0 1px rgba(255,255,255,0.04)', overflow: 'hidden' }}>
      <div style={{ background: palette.bg, borderBottom: `1px dashed ${palette.border.replace(/[\d.]+\)$/, '0.3)')}`, padding: '9px 13px' }}>
        <div style={{ fontSize: 11, color: '#aaa', letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 3 }}>
          Week {weekIndex + 1} · 第 {phaseIndexInWeek + 1} 段
        </div>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#eee', fontFamily: 'monospace' }}>
          Weekly ≈ {weeklyLevel.toFixed(0)}%
        </div>
      </div>
      <div style={{ padding: '10px 13px' }}>
        <div style={{ fontSize: 11, color: '#bbb', marginBottom: 7, letterSpacing: '0.04em' }}>本段 SESSION 消耗</div>
        <SessionList details={sessions} currentHour={info.currentSessionHour} palette={palette} showSpan={true} />
      </div>
      <div style={{ borderTop: `1px dashed ${palette.border.replace(/[\d.]+\)$/, '0.25)')}`, padding: '9px 13px',
        display: 'flex', flexDirection: 'column', gap: 6, background: palette.bg }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#ccc' }}>Session 消耗合计</span>
          <span style={{ fontSize: 14, fontWeight: 700, color, fontFamily: 'monospace' }}>{sessionTotal.toFixed(0)}%</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#ccc' }}>导致 Weekly 增加</span>
          {weeklyIncrease != null
            ? <span style={{ fontSize: 14, fontWeight: 700, color: '#f0a500', fontFamily: 'monospace' }}>+{weeklyIncrease.toFixed(1)}%</span>
            : <span style={{ fontSize: 12, color: '#bbb' }}>当前阶段</span>}
        </div>
        {rate != null && (
          <div style={{ marginTop: 2, padding: '6px 9px', borderRadius: 5,
            background: palette.border.replace(/[\d.]+\)$/, '0.15)'),
            border: `1px solid ${palette.border.replace(/[\d.]+\)$/, '0.35)')}` }}>
            <span style={{ fontSize: 11, color: '#ccc', letterSpacing: '0.04em' }}>换算率  </span>
            <span style={{ fontSize: 12, fontWeight: 800, color, fontFamily: 'monospace' }}>
              100% Session → {rate.toFixed(1)}% Weekly
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// 按周切分 days 数组，返回 [{startI, endI, weekIdx}]
function splitWeekBands(days: DayStats[], weeklyResetDates: Set<string>) {
  const bands: { startI: number; endI: number; weekIdx: number }[] = [];
  let weekIdx = 0, start = 0;
  for (let i = 1; i < days.length; i++) {
    if (weeklyResetDates.has(days[i].date)) {
      bands.push({ startI: start, endI: i - 1, weekIdx });
      weekIdx++;
      start = i;
    }
  }
  bands.push({ startI: start, endI: days.length - 1, weekIdx });
  return bands;
}

const BAND_FILLS = [
  "rgba(74,158,255,0.07)",
  "rgba(204,120,92,0.07)",
  "rgba(74,222,128,0.07)",
];

// ── DailySessionChartSvg（单账号折线，无外框） ───────────────
function DailySessionChartSvg({ days, weeklyResetDates, color = "#4a9eff" }: {
  days: DayStats[];
  weeklyResetDates: Set<string>;
  color?: string;
}) {
  if (days.length < 2) return <div className="py-6 text-center text-sm" style={{ color: "#888" }}>数据不足</div>;

  const VW = 600, VH = 130;
  const PAD = { top: 22, right: 12, bottom: 22, left: 38 };
  const cW = VW - PAD.left - PAD.right;
  const cH = VH - PAD.top - PAD.bottom;
  const n = days.length;

  // 「满额/天」参考线：该天 weekly_total/7（按各段倍率→阶梯横虚线）。仅周额度图的 days 带 total。
  const refs = days.map(d => (d.total != null && d.total > 0 ? d.total / 7 : null));
  const hasRef = refs.some(r => r != null);
  const maxVal = Math.max(...days.map(d => d.consumed), ...refs.filter((r): r is number => r != null), 50);
  const xOf = (i: number) => PAD.left + (n === 1 ? cW / 2 : (i / (n - 1)) * cW);
  const yOf = (v: number) => PAD.top + cH - (v / maxVal) * cH;

  const linePath = days.map((d, i) => `${i === 0 ? "M" : "L"}${xOf(i).toFixed(1)},${yOf(d.consumed).toFixed(1)}`).join(" ");
  const areaPath = linePath + ` L${xOf(n - 1).toFixed(1)},${(PAD.top + cH).toFixed(1)} L${xOf(0).toFixed(1)},${(PAD.top + cH).toFixed(1)} Z`;

  const bands = splitWeekBands(days, weeklyResetDates);
  const labelStep = Math.max(1, Math.ceil(n / 6));

  return (
    <div className="px-3 py-2">
      <svg viewBox={`0 0 ${VW} ${VH}`} style={{ width: "100%", height: 130 }}>
        {bands.map(({ startI, endI, weekIdx }) => {
          const x1 = startI === 0 ? PAD.left : xOf(startI);
          const x2 = endI === n - 1 ? PAD.left + cW : xOf(endI);
          return <rect key={weekIdx} x={x1} y={PAD.top} width={x2 - x1} height={cH} fill={BAND_FILLS[weekIdx % BAND_FILLS.length]} />;
        })}
        {[0, 0.5, 1].map(f => {
          const yv = yOf(f * maxVal);
          return (
            <g key={f}>
              <line x1={PAD.left} y1={yv} x2={PAD.left + cW} y2={yv} stroke="#2a2a2a" strokeWidth={1} />
              <text x={PAD.left - 4} y={yv + 4} textAnchor="end" fontSize={9} fill="#888">{Math.round(f * maxVal)}%</text>
            </g>
          );
        })}
        <path d={areaPath} fill={color} opacity={0.1} />
        {days.map((d, i) => weeklyResetDates.has(d.date) && (
          <g key={d.date}>
            <line x1={xOf(i)} y1={PAD.top} x2={xOf(i)} y2={PAD.top + cH} stroke="#f0a500" strokeWidth={1} strokeDasharray="3,3" opacity={0.8} />
            <text x={xOf(i) + 3} y={PAD.top + 9} fontSize={8} fill="#f0a500">周重置</text>
          </g>
        ))}
        {hasRef && days.map((_, i) => {
          const r = refs[i];
          if (r == null) return null;
          const xL = i === 0 ? PAD.left : (xOf(i - 1) + xOf(i)) / 2;
          const xR = i === n - 1 ? PAD.left + cW : (xOf(i) + xOf(i + 1)) / 2;
          const y = yOf(r);
          return <line key={`ref${i}`} x1={xL.toFixed(1)} y1={y.toFixed(1)} x2={xR.toFixed(1)} y2={y.toFixed(1)} stroke="#5fd3e0" strokeWidth={1} strokeDasharray="4,3" opacity={0.75} />;
        })}
        {hasRef && (() => {
          // 按满额值（=倍率）把连续相同的天聚成段，每段各自在右端标一个「满额/天 X%」
          const segs: { start: number; end: number; val: number }[] = [];
          refs.forEach((r, i) => {
            if (r == null) return;
            const last = segs[segs.length - 1];
            if (last && last.end === i - 1 && Math.abs(last.val - r) < 0.5) last.end = i;
            else segs.push({ start: i, end: i, val: r });
          });
          return segs.map((s, si) => {
            const xR = s.end === n - 1 ? PAD.left + cW : (xOf(s.end) + xOf(s.end + 1)) / 2;
            return (
              <text key={`reflbl${si}`} x={xR.toFixed(1)} y={(yOf(s.val) - 3).toFixed(1)} textAnchor="end" fontSize={8} fill="#5fd3e0">
                满额/天 {Math.round(s.val)}%
              </text>
            );
          });
        })()}
        <path d={linePath} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
        {days.map((d, i) => (
          <g key={i}>
            <circle cx={xOf(i)} cy={yOf(d.consumed)} r={2.5} fill={color} />
            {d.consumed > 0 && (
              <text x={xOf(i)} y={yOf(d.consumed) - 5} textAnchor="middle" fontSize={8} fill={color + "cc"}>{d.consumed}%</text>
            )}
          </g>
        ))}
        {days.map((d, i) => {
          if (i % labelStep !== 0 && i !== n - 1) return null;
          const [, mm, dd] = d.date.split("-");
          return <text key={i} x={xOf(i)} y={VH - 4} textAnchor="middle" fontSize={9} fill="#999">{parseInt(mm)}/{parseInt(dd)}</text>;
        })}
      </svg>
    </div>
  );
}

// ── computeAllDailyStats（多账号） ────────────────────────
function computeAllDailyStats(
  histories: Record<string, UsageSnapshot[]>,
  colors: Record<string, string>,
  metric: "session" | "weekly" = "session"
): {
  dates: string[];
  accountSeries: Array<{ key: string; provider: string; alias: string; color: string; values: number[] }>;
  totals: number[];
  weeklyResetDates: Set<string>;
} {
  const keys = Object.keys(histories);
  if (keys.length === 0) return { dates: [], accountSeries: [], totals: [], weeklyResetDates: new Set() };

  // 先算每个账号的每日数据，找到全局最早日期
  const perAccount: Array<{
    key: string;
    byDate: Map<string, number>;
    weeklyResetDates: Set<string>;
  }> = [];

  let globalEarliest: string | null = null;
  const computeOne = metric === "weekly" ? computeDailyWeeklyStats : computeDailyStats;

  for (const key of keys) {
    const { days, weeklyResetDates } = computeOne(histories[key]);
    const byDate = new Map(days.map(d => [d.date, d.consumed]));
    perAccount.push({ key, byDate, weeklyResetDates });
    if (days.length > 0) {
      const first = days[0].date;
      if (globalEarliest === null || first < globalEarliest) globalEarliest = first;
    }
  }

  if (globalEarliest === null) return { dates: [], accountSeries: [], totals: [], weeklyResetDates: new Set() };

  // 从最早账号的起始天到今天生成日期序列
  const dates: string[] = [];
  const todayStr = new Date().toLocaleDateString("en-CA");
  const cur = new Date(globalEarliest + "T00:00:00");
  const todayEnd = new Date(todayStr + "T00:00:00");
  while (cur <= todayEnd) {
    dates.push(cur.toLocaleDateString("en-CA"));
    cur.setDate(cur.getDate() + 1);
  }

  const allWeeklyResetDates = new Set<string>();
  const accountSeries: Array<{ key: string; provider: string; alias: string; color: string; values: number[] }> = [];

  for (const { key, byDate, weeklyResetDates } of perAccount) {
    const alias = aliasFromKey(key);
    for (const d of weeklyResetDates) allWeeklyResetDates.add(d);
    accountSeries.push({
      key,
      provider: providerFromKey(key),
      alias,
      color: colors[key] ?? colors[alias] ?? DEFAULT_COLOR,
      values: dates.map(date => byDate.get(date) ?? 0),
    });
  }

  const totals = dates.map((_, i) =>
    Math.round(accountSeries.reduce((sum, s) => sum + s.values[i], 0) * 10) / 10
  );

  return { dates, accountSeries, totals, weeklyResetDates: allWeeklyResetDates };
}

// ── TotalDailyChartSvg（堆叠彩带面积图） ─────────────────
function TotalDailyChartSvg({ dates, accountSeries, totals, weeklyResetDates, currentKey }: {
  dates: string[];
  accountSeries: Array<{ key: string; provider: string; alias: string; color: string; values: number[] }>;
  totals: number[];
  weeklyResetDates: Set<string>;
  currentKey: string;
}) {
  if (dates.length < 2 || accountSeries.length === 0)
    return <div className="py-6 text-center text-sm" style={{ color: "#888" }}>数据不足</div>;

  // 当前账号在最底层，其他随意叠上去
  const sorted = [
    ...accountSeries.filter(s => s.key === currentKey),
    ...accountSeries.filter(s => s.key !== currentKey),
  ];
  const groupedLegend = ["claude_code", "codex", ...Array.from(new Set(sorted.map(s => s.provider))).filter(p => p !== "claude_code" && p !== "codex")]
    .map(provider => ({ provider, items: sorted.filter(s => s.provider === provider) }))
    .filter(group => group.items.length > 0);

  const VW = 600, VH = 160;
  const PAD = { top: 22, right: 12, bottom: 22, left: 42 };
  const cW = VW - PAD.left - PAD.right;
  const cH = VH - PAD.top - PAD.bottom;
  const n = dates.length;
  const bottom = PAD.top + cH;

  const maxVal = Math.max(...totals, 50);
  const xOf = (i: number) => PAD.left + (i / (n - 1)) * cW;
  const yOf = (v: number) => PAD.top + cH - (v / maxVal) * cH;
  const labelStep = Math.max(1, Math.ceil(n / 6));

  // 每列的累计高度 stacks[j][i] = sorted[0..j] 在第 i 天的累计值
  const stacks: number[][] = sorted.map((_, j) =>
    dates.map((__, i) => sorted.slice(0, j + 1).reduce((s, a) => s + a.values[i], 0))
  );

  // 周色带
  const weekBands: { startI: number; endI: number; weekIdx: number }[] = [];
  let wk = 0, ws = 0;
  for (let i = 1; i < n; i++) {
    if (weeklyResetDates.has(dates[i])) { weekBands.push({ startI: ws, endI: i - 1, weekIdx: wk }); wk++; ws = i; }
  }
  weekBands.push({ startI: ws, endI: n - 1, weekIdx: wk });

  return (
    <div className="px-3 py-2">
      <svg viewBox={`0 0 ${VW} ${VH}`} style={{ width: "100%", height: 160 }}>
        {/* 周色带 */}
        {weekBands.map(({ startI, endI, weekIdx }) => {
          const x1 = startI === 0 ? PAD.left : xOf(startI);
          const x2 = endI === n - 1 ? PAD.left + cW : xOf(endI);
          return <rect key={weekIdx} x={x1} y={PAD.top} width={x2 - x1} height={cH} fill={BAND_FILLS[weekIdx % BAND_FILLS.length]} />;
        })}
        {/* Y 轴参考线 */}
        {[0, 0.5, 1].map(f => {
          const yv = yOf(f * maxVal);
          return (
            <g key={f}>
              <line x1={PAD.left} y1={yv} x2={PAD.left + cW} y2={yv} stroke="#2a2a2a" strokeWidth={1} />
              <text x={PAD.left - 4} y={yv + 4} textAnchor="end" fontSize={9} fill="#888">{Math.round(f * maxVal)}%</text>
            </g>
          );
        })}
        {/* 堆叠彩带：从底层到顶层依次绘制 */}
        {sorted.map(({ key, color }, j) => {
          const topStack = stacks[j];
          const prevStack = j > 0 ? stacks[j - 1] : null;
          // 顶部路径（左→右）
          const topPath = topStack.map((v, i) => `${i === 0 ? "M" : "L"}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(" ");
          // 底部路径（右→左，闭合彩带）
          const botPath = prevStack
            ? [...prevStack].reverse().map((v, ri) => `L${xOf(n - 1 - ri).toFixed(1)},${yOf(v).toFixed(1)}`).join(" ") + " Z"
            : ` L${xOf(n - 1).toFixed(1)},${bottom.toFixed(1)} L${xOf(0).toFixed(1)},${bottom.toFixed(1)} Z`;
          return (
            <g key={key}>
              <path d={topPath + " " + botPath} fill={color} opacity={0.55} />
              {/* 彩带顶边线 */}
              <path d={topPath} fill="none" stroke={color} strokeWidth={1.2} strokeLinejoin="round" opacity={0.9} />
              {/* 顶边节点 */}
              {topStack.map((v, i) => v > 0 && (
                <circle key={i} cx={xOf(i)} cy={yOf(v)} r={2} fill={color} opacity={0.95} />
              ))}
            </g>
          );
        })}
        {/* 总计节点数值（堆叠顶端） */}
        {totals.map((v, i) => v > 0 && (
          <text key={i} x={xOf(i)} y={yOf(v) - 4} textAnchor="middle" fontSize={8} fill="#ddd">{v}%</text>
        ))}
        {/* 周重置竖线 */}
        {dates.map((d, i) => weeklyResetDates.has(d) && (
          <line key={d} x1={xOf(i)} y1={PAD.top} x2={xOf(i)} y2={bottom} stroke="#f0a500" strokeWidth={1} strokeDasharray="3,3" opacity={0.7} />
        ))}
        {/* X 轴日期 */}
        {dates.map((d, i) => {
          if (i % labelStep !== 0 && i !== n - 1) return null;
          const [, mm, dd] = d.split("-");
          return <text key={i} x={xOf(i)} y={VH - 4} textAnchor="middle" fontSize={9} fill="#999">{parseInt(mm)}/{parseInt(dd)}</text>;
        })}
      </svg>
      {/* 图例（底层→顶层顺序） */}
      <div className="flex flex-wrap gap-3 px-1 pb-1" style={{ marginTop: -2 }}>
        {groupedLegend.map(({ provider, items }) => (
          <div key={provider} className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center justify-center" style={{ width: 14, height: 14, color: "#ddd" }}>
              <ProviderIcon provider={provider} size={13} />
            </span>
            {items.map(({ key, alias, color }) => (
              <div key={key} className="flex items-center gap-1.5">
                <div style={{ width: 10, height: 10, borderRadius: 2, background: color, opacity: 0.8 }} />
                <span style={{ fontSize: 10, color: "#aaa" }}>
                  {alias.split("@")[0]}{key === currentKey ? " (当前)" : ""}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── ConfirmDialog ─────────────────────────────────────────
function ConfirmDialog({ message, onConfirm, onCancel }: {
  message: string; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" style={{ background: "rgba(0,0,0,0.6)" }}>
      <div className="rounded-xl px-6 py-5 w-64 flex flex-col gap-4" style={{ background: "#2c2c2c", border: "1px solid #444" }}>
        <p className="text-sm text-center" style={{ color: "#eee" }}>{message}</p>
        <div className="flex gap-3 justify-center">
          <button onClick={onCancel} className="flex-1 py-1.5 rounded-lg text-sm"
            style={{ background: "#383838", color: "#ccc", border: "1px solid #4a4a4a" }}>取消</button>
          <button onClick={onConfirm} className="flex-1 py-1.5 rounded-lg text-sm font-semibold"
            style={{ background: "#7f1d1d", color: "#fca5a5", border: "1px solid #991b1b" }}>删除</button>
        </div>
      </div>
    </div>
  );
}

// 历史图表「Session / 周额度」指标偏好（跨账号、跨重开都记住）
const CHART_METRIC_KEY = "history.chartMetric";

// ── HistoryPanel ──────────────────────────────────────────
function HistoryPanel({ provider, alias, allAliases: _allAliases, colors }: {
  provider: string;
  alias: string;
  allAliases: string[];
  colors: Record<string, string>;
}) {
  const { history, loading, loadingMore, hasMore, loadMore, refetch } = useHistory(provider, alias);
  const { history: statsRecords, refetch: refetchStats } = useHistorySince(provider, alias, 31);
  const { histories, loading: allLoading, refetch: refetchAllHistories } = useAllHistories();
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [chartMode, setChartMode] = useState<"single" | "total">("single");
  const [metric, setMetric] = useState<"session" | "weekly">(
    () => (localStorage.getItem(CHART_METRIC_KEY) === "weekly" ? "weekly" : "session")
  );

  // 历史记录多选纠错：选中的 snapshot id + 拖拽/范围锚点（在时间列上拖拽或 Shift 选范围）
  const [selIds, setSelIds] = useState<Set<number>>(new Set());
  const [correctMult, setCorrectMult] = useState<number>(tierPresets(provider)[1]?.mult ?? 5);
  const selDragRef = useRef(false);
  const selAnchorRef = useRef<number | null>(null);
  const scrollElRef = useRef<HTMLElement | null>(null);

  const selectRange = useCallback((from: number, to: number, additive: boolean) => {
    const [a, b] = from <= to ? [from, to] : [to, from];
    setSelIds((prev) => {
      const next = additive ? new Set(prev) : new Set<number>();
      for (let k = a; k <= b; k++) {
        const id = history[k]?.id;
        if (id != null) next.add(id);
      }
      return next;
    });
  }, [history]);

  const onRowMouseDown = useCallback((e: React.MouseEvent, idx: number) => {
    e.preventDefault();
    if (e.shiftKey && selAnchorRef.current != null) {
      selectRange(selAnchorRef.current, idx, e.ctrlKey || e.metaKey);
      return;
    }
    selAnchorRef.current = idx;
    selDragRef.current = true;
    const id = history[idx]?.id;
    if (id == null) return;
    setSelIds((prev) => {
      if (e.ctrlKey || e.metaKey) {
        const n = new Set(prev);
        if (n.has(id)) n.delete(id); else n.add(id);
        return n;
      }
      return new Set([id]);
    });
  }, [history, selectRange]);

  const onRowMouseEnter = useCallback((idx: number) => {
    if (!selDragRef.current || selAnchorRef.current == null) return;
    selectRange(selAnchorRef.current, idx, false);
    if (idx >= history.length - 2 && hasMore) loadMore(); // 拖到已加载列表底部 → 自动加载更多
  }, [selectRange, history.length, hasMore, loadMore]);

  // 拖拽选择时：鼠标贴近滚动容器上/下边缘自动滚动（贴底再触发加载更多），可一路往下拖
  useEffect(() => {
    let raf = 0;
    let vel = 0;
    const onMove = (e: MouseEvent) => {
      if (!selDragRef.current || !scrollElRef.current) { vel = 0; return; }
      const r = scrollElRef.current.getBoundingClientRect();
      const edge = 48;
      if (e.clientY > r.bottom - edge) vel = Math.min(20, (e.clientY - (r.bottom - edge)) * 0.7);
      else if (e.clientY < r.top + edge) vel = -Math.min(20, (r.top + edge - e.clientY) * 0.7);
      else vel = 0;
    };
    const tick = () => {
      const el = scrollElRef.current;
      if (selDragRef.current && vel !== 0 && el) {
        el.scrollTop += vel;
        if (vel > 0 && hasMore && el.scrollHeight - el.scrollTop - el.clientHeight < 150) loadMore();
      }
      raf = requestAnimationFrame(tick);
    };
    const up = () => { selDragRef.current = false; vel = 0; };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", up);
    raf = requestAnimationFrame(tick);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", up);
      cancelAnimationFrame(raf);
    };
  }, [hasMore, loadMore]);

  const applyCorrection = useCallback(async () => {
    const ids = Array.from(selIds);
    if (!ids.length || correctMult <= 0) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke<number>("correct_history_snapshots", { ids, mult: correctMult });
      setSelIds(new Set());
      refetch();
      refetchStats();
      refetchAllHistories();
    } catch {
      /* ignore */
    }
  }, [selIds, correctMult, refetch, refetchStats, refetchAllHistories]);
  const [activeGroup, setActiveGroup] = useState<TooltipInfo | null>(null);
  // ref 控制悬浮面板 DOM 位置，mousemove 直接写 style 避免 setState 触发重渲染
  const tooltipElRef = useRef<HTMLDivElement>(null);
  const rafIdRef = useRef(0);
  const anchorRef = useRef<HTMLDivElement>(null);

  const { days, weeklyResetDates } =
    metric === "weekly" ? computeDailyWeeklyStats(statsRecords) : computeDailyStats(statsRecords);
  const identityKey = keyFromParts(provider, alias);
  const accountColor = colors[identityKey] ?? colors[alias] ?? DEFAULT_COLOR;
  const periodLabel = "Weekly";
  const { dates, accountSeries, totals, weeklyResetDates: allWeeklyResets } = computeAllDailyStats(histories, colors, metric);
  const annotations = useMemo(() => computeTableAnnotations(statsRecords), [statsRecords]);

  // 向上查找实际在滚动的祖先（scrollHeight > clientHeight），监听滚动
  useEffect(() => {
    let node: HTMLElement | null = anchorRef.current?.parentElement ?? null;
    while (node && node !== document.body) {
      if (node.scrollHeight > node.clientHeight + 1) break;
      node = node.parentElement;
    }
    const scrollEl = node ?? document.documentElement;
    scrollElRef.current = scrollEl;
    const handleScroll = () => {
      if (scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 150) {
        loadMore();
      }
    };
    scrollEl.addEventListener("scroll", handleScroll);
    return () => scrollEl.removeEventListener("scroll", handleScroll);
  }, [loadMore]);

  // 按 weekly_reset_at 分周，给每个周分配色带索引（旧→新顺序）
  const weekColorIdx = new Map<string, number>();
  let wci = 0;
  for (const snap of [...history].reverse()) {
    const key = (snap.weekly_reset_at ?? "").substring(0, 10);
    if (key && !weekColorIdx.has(key)) weekColorIdx.set(key, wci++);
  }
  const ROW_WEEK_COLORS = ["#1c1c2a", "#1c2220", "#221e1c"];
  const rowWeekBg = (snap: UsageSnapshot) => {
    const key = (snap.weekly_reset_at ?? "").substring(0, 10);
    return ROW_WEEK_COLORS[(weekColorIdx.get(key) ?? 0) % ROW_WEEK_COLORS.length];
  };

  const handleDelete = async (id: number) => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("delete_snapshot", { id });
    setConfirmId(null);
    refetch();
  };

  if (loading) return <div className="text-center py-8 text-sm" style={{ color: "#999" }}>加载中…</div>;
  if (history.length === 0) return <div className="text-center py-8 text-sm" style={{ color: "#999" }}>暂无历史数据</div>;
  return (
    <div ref={anchorRef}>
      <div className="flex justify-end items-center gap-2 mb-2">
        <PlanOverrideSelect provider={provider} alias={alias} />
        <InboxBadge aliasFilter={alias} onChanged={refetch} colors={colors} />
      </div>

      {/* 多选纠错浮条：选中历史记录后出现（全宽容器居中，避免被挤窄换行） */}
      {selIds.size > 0 && (
        <div className="fixed left-0 right-0 bottom-6 z-[110] flex justify-center" style={{ pointerEvents: "none" }}>
          <div
            className="flex items-center gap-3 px-4 py-2.5 rounded-xl whitespace-nowrap"
            style={{ background: "#22232b", border: "1px solid #3a3b46", boxShadow: "0 10px 30px rgba(0,0,0,0.6)", pointerEvents: "auto" }}
          >
            <span className="text-xs" style={{ color: "#ddd" }}>已选 <b style={{ color: "#cc785c" }}>{selIds.size}</b> 条记录</span>
            <span className="text-xs" style={{ color: "#888" }}>纠正为</span>
            <select
              value={String(correctMult)}
              onChange={(e) => setCorrectMult(Number(e.target.value))}
              className="text-xs"
              style={{ background: "#2c2c2c", color: "#ddd", border: "1px solid #3a3a3a", borderRadius: 6, padding: "3px 8px", cursor: "pointer" }}
            >
              {tierPresets(provider).map((p) => (
                <option key={p.mult} value={String(p.mult)}>{p.label} ({p.mult}x)</option>
              ))}
            </select>
            <button type="button" onClick={() => void applyCorrection()}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg"
              style={{ background: "#cc785c", color: "#fff", border: 0, cursor: "pointer" }}>应用纠正</button>
            <button type="button" onClick={() => setSelIds(new Set())}
              className="text-xs px-2.5 py-1.5 rounded-lg"
              style={{ background: "#383838", color: "#ccc", border: "1px solid #4a4a4a", cursor: "pointer" }}>清除</button>
          </div>
        </div>
      )}
      {/* 每日消耗图（可切换单账号/总览） */}
      <div className="card p-0 overflow-hidden mb-3">
        <div className="px-4 py-2.5 flex items-center justify-between" style={{ borderBottom: "1px solid #3a3a3a" }}>
          <div className="flex items-center gap-2">
            <div className="flex gap-1">
              {(["session", "weekly"] as const).map((mt) => (
                <button key={mt} onClick={() => { setMetric(mt); localStorage.setItem(CHART_METRIC_KEY, mt); }}
                  className="text-xs px-2.5 py-1 rounded-md font-semibold"
                  style={{
                    background: metric === mt ? "#3a3a3a" : "transparent",
                    color: metric === mt ? "#eee" : "#888",
                    border: metric === mt ? "1px solid #555" : "1px solid transparent",
                  }}>
                  {mt === "session" ? "每日 Session 消耗" : "每日周额度消耗"}
                </button>
              ))}
            </div>
            <span className="text-xs" style={{ color: "#666" }}>近30天</span>
          </div>
          <div className="flex gap-1">
            {(["single", "total"] as const).map((m) => (
              <button key={m} onClick={() => setChartMode(m)}
                className="text-xs px-2.5 py-1 rounded-md"
                style={{
                  background: chartMode === m ? "#3a3a3a" : "transparent",
                  color: chartMode === m ? "#eee" : "#888",
                  border: chartMode === m ? "1px solid #555" : "1px solid transparent",
                }}>
                {m === "single" ? "当前" : "总览"}
              </button>
            ))}
          </div>
        </div>
        {chartMode === "single"
          ? <DailySessionChartSvg days={days} weeklyResetDates={weeklyResetDates} color={accountColor} />
          : allLoading
            ? <div className="py-6 text-center text-sm" style={{ color: "#888" }}>加载中…</div>
            : <TotalDailyChartSvg dates={dates} accountSeries={accountSeries} totals={totals} weeklyResetDates={allWeeklyResets} currentKey={identityKey} />
        }
      </div>
      {confirmId !== null && (
        <ConfirmDialog
          message="确认删除这条记录？"
          onConfirm={() => void handleDelete(confirmId)}
          onCancel={() => setConfirmId(null)}
        />
      )}
      <div className="card overflow-hidden p-0">
        <div className="overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0" style={{ background: "#242424" }}>
              <tr style={{ color: "#bbb", borderBottom: "1px solid #3a3a3a" }}>
                <th className="text-left px-3 py-2.5 font-semibold">时间</th>
                <th className="text-left px-3 py-2.5 font-semibold">Session</th>
                <th className="text-left px-3 py-2.5 font-semibold">重置</th>
                <th className="text-left px-3 py-2.5 font-semibold">{periodLabel}</th>
                <th className="text-left px-3 py-2.5 font-semibold">重置</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {history.map((snap, i) => {
                const dayKey = annotations.getDayKey(snap);
                const weeklyKey = annotations.getWeeklyKey(snap);
                const prevSnap = i > 0 ? history[i - 1] : null;
                const nextSnap = i < history.length - 1 ? history[i + 1] : null;
                const isDayFirst = !prevSnap || annotations.getDayKey(prevSnap) !== dayKey;
                const isDayLast = !nextSnap || annotations.getDayKey(nextSnap) !== dayKey;
                const isWeeklyFirst = !prevSnap || annotations.getWeeklyKey(prevSnap) !== weeklyKey;
                const isWeeklyLast = !nextSnap || annotations.getWeeklyKey(nextSnap) !== weeklyKey;
                const hasDayGroup = annotations.dayFormulas.has(dayKey);
                const hasWeeklyGroup = annotations.weeklyPhases.has(weeklyKey);

                const dayPalette = hasDayGroup
                  ? DAY_GROUP_PALETTE[(annotations.dayOrder.get(dayKey) ?? 0) % DAY_GROUP_PALETTE.length]
                  : null;
                const weeklyPhase = hasWeeklyGroup ? annotations.weeklyPhases.get(weeklyKey)! : null;
                const weeklyPalette = weeklyPhase
                  ? WEEKLY_GROUP_PALETTE[weeklyPhase.weekIndex % WEEKLY_GROUP_PALETTE.length]
                  : null;

                // boxShadow inset 方案：完全不受 border-collapse 影响，上下边界始终可见
                const isDayHovered = activeGroup?.type === 'day' && activeGroup.key === dayKey;
                const isWeeklyHovered = activeGroup?.type === 'weekly' && activeGroup.key === weeklyKey;

                const makeDayCellStyle = (
                  p: { bg: string; border: string } | null,
                  isFirst: boolean, isLast: boolean,
                  hovered: boolean,
                ): React.CSSProperties => p ? {
                  padding: '5px 10px', cursor: 'default',
                  background: hovered ? p.border.replace(/[\d.]+\)$/, '0.22)') : p.bg,
                  boxShadow: [
                    `inset 2px 0 0 ${p.border}`,
                    `inset -2px 0 0 ${p.border}`,
                    isFirst ? `inset 0 2px 0 ${p.border}` : null,
                    isLast  ? `inset 0 -2px 0 ${p.border}` : null,
                  ].filter(Boolean).join(', '),
                  ...(isFirst ? { borderTopLeftRadius: 5, borderTopRightRadius: 5 } : {}),
                  ...(isLast  ? { borderBottomLeftRadius: 5, borderBottomRightRadius: 5 } : {}),
                } : { padding: '5px 10px' };

                const makeWeeklyCellStyle = (
                  p: { bg: string; border: string } | null,
                  isFirst: boolean, isLast: boolean,
                  hovered: boolean,
                ): React.CSSProperties => p ? {
                  padding: '5px 10px', cursor: 'default',
                  background: hovered ? p.border.replace(/[\d.]+\)$/, '0.22)') : p.bg,
                  boxShadow: [
                    `inset 2px 0 0 ${p.border}`,
                    `inset -2px 0 0 ${p.border}`,
                    isFirst ? `inset 0 2px 0 ${p.border}` : null,
                    isLast  ? `inset 0 -2px 0 ${p.border}` : null,
                  ].filter(Boolean).join(', '),
                  ...(isFirst ? { borderTopLeftRadius: 4, borderTopRightRadius: 4 } : {}),
                  ...(isLast  ? { borderBottomLeftRadius: 4, borderBottomRightRadius: 4 } : {}),
                } : { padding: '5px 10px' };

                const currentSessionHour = snap.session_reset_at
                  ? normalizeToHour(snap.session_reset_at) : '';

                const posTooltip = (x: number, y: number) => {
                  const el = tooltipElRef.current;
                  if (!el) return;
                  const w = el.offsetWidth || 276, h = el.offsetHeight || 200;
                  el.style.left = (x + 16 + w > window.innerWidth - 6 ? x - w - 8 : x + 16) + 'px';
                  el.style.top  = (y + 16 + h > window.innerHeight - 6 ? y - h - 8 : y + 16) + 'px';
                };

                const handleDayEnter = hasDayGroup
                  ? (e: React.MouseEvent) => {
                      setActiveGroup({ type: 'day', key: dayKey, currentSessionHour });
                      posTooltip(e.clientX, e.clientY);
                    }
                  : undefined;
                const handleWeeklyEnter = hasWeeklyGroup
                  ? (e: React.MouseEvent) => {
                      setActiveGroup({ type: 'weekly', key: weeklyKey, currentSessionHour });
                      posTooltip(e.clientX, e.clientY);
                    }
                  : undefined;
                const handleMove = (e: React.MouseEvent) => {
                  cancelAnimationFrame(rafIdRef.current);
                  const x = e.clientX, y = e.clientY;
                  rafIdRef.current = requestAnimationFrame(() => posTooltip(x, y));
                };
                const handleLeave = () => { cancelAnimationFrame(rafIdRef.current); setActiveGroup(null); };

                return (
                  <tr key={snap.id ?? i}
                    style={{
                      borderBottom: "1px solid #2e2e2e",
                      background: (snap.id != null && selIds.has(snap.id)) ? "rgba(204,120,92,0.16)" : rowWeekBg(snap),
                      boxShadow: (snap.id != null && selIds.has(snap.id)) ? "inset 3px 0 0 #cc785c" : undefined,
                    }}
                    className="hover:brightness-110">
                    <td className="px-3 py-2 whitespace-nowrap select-none"
                      style={{ color: "#ccc", cursor: "pointer" }}
                      title="按住在时间列拖拽多选 / 点一条再 Shift 点另一条选范围 → 底部纠正倍率"
                      onMouseDown={(e) => onRowMouseDown(e, i)}
                      onMouseEnter={() => onRowMouseEnter(i)}
                    >{formatLocalTime(snap.collected_at)}</td>
                    <td style={makeDayCellStyle(dayPalette, isDayFirst, isDayLast, isDayHovered)}
                      onMouseEnter={handleDayEnter}
                      onMouseMove={hasDayGroup ? handleMove : undefined}
                      onMouseLeave={hasDayGroup ? handleLeave : undefined}
                    >
                      <div className="flex items-center gap-2 min-w-[90px]">
                        <span className="font-mono font-semibold w-12"
                          style={{ color: ratioPct(snap.session_pct, snap.session_total_pct) >= 80 ? "#f87171" : ratioPct(snap.session_pct, snap.session_total_pct) >= 60 ? "#f0a500" : "#7ab8f5" }}>
                          {formatPct(snap.session_pct)}
                        </span>
                        <ProgressBar pct={snap.session_pct} total={snap.session_total_pct ?? 100} className="flex-1" />
                      </div>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap" style={{ color: "#aaa" }}>{formatLocalTime(snap.session_reset_at)}</td>
                    <td style={makeWeeklyCellStyle(weeklyPalette, isWeeklyFirst, isWeeklyLast, isWeeklyHovered)}
                      onMouseEnter={handleWeeklyEnter}
                      onMouseMove={hasWeeklyGroup ? handleMove : undefined}
                      onMouseLeave={hasWeeklyGroup ? handleLeave : undefined}
                    >
                      <div className="flex items-center gap-2 min-w-[90px]">
                        <span className="font-mono font-semibold w-12"
                          style={{ color: ratioPct(snap.weekly_pct, snap.weekly_total_pct) >= 80 ? "#f87171" : ratioPct(snap.weekly_pct, snap.weekly_total_pct) >= 60 ? "#f0a500" : "#4ade80" }}>
                          {formatPct(snap.weekly_pct)}
                        </span>
                        <ProgressBar pct={snap.weekly_pct} total={snap.weekly_total_pct ?? 100} className="flex-1" />
                      </div>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap" style={{ color: "#aaa" }}>{formatLocalTime(snap.weekly_reset_at)}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => snap.id != null && setConfirmId(snap.id)}
                        style={{ color: "#777", fontSize: 12, background: "none", border: "none", cursor: "pointer", padding: "2px 4px", borderRadius: 4 }}
                        onMouseEnter={(e) => (e.currentTarget.style.color = "#f87171")}
                        onMouseLeave={(e) => (e.currentTarget.style.color = "#777")}
                        title="删除此记录"
                      >✕</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="py-3 text-center">
            {loadingMore ? (
              <span className="text-xs" style={{ color: "#888" }}>加载中…</span>
            ) : hasMore ? (
              <button onClick={loadMore} className="text-xs px-4 py-1.5 rounded-lg"
                style={{ background: "#2c2c2c", color: "#aaa", border: "1px solid #444" }}>
                加载更多
              </button>
            ) : (
              <span className="text-xs" style={{ color: "#666" }}>已加载全部</span>
            )}
          </div>
        </div>
      </div>
      {/* 悬浮面板：始终挂载，ref 直接写 style.left/top，避免 mousemove 触发重渲染 */}
      <div ref={tooltipElRef} style={{ position: 'fixed', left: 0, top: 0, zIndex: 300, pointerEvents: 'none',
        visibility: activeGroup ? 'visible' : 'hidden' }}>
        {activeGroup && <GroupTooltip info={activeGroup} annotations={annotations} />}
      </div>
    </div>
  );
}

// ── SprintPanel（多账号共用时间轴）────────────────────────
function SprintPanel({ snapshots, avgCost, avgCostsByProvider, colors }: {
  snapshots: UsageSnapshot[];
  avgCost: number | null;
  avgCostsByProvider: Record<string, number>;
  colors: Record<string, string>;
}) {
  const [allBlocks, setAllBlocks] = useState<Record<string, Block[]>>(() => {
    const result: Record<string, Block[]> = {};
    for (const snap of snapshots) {
      const key = accountKey(snap);
      const weeklyResetDate = (snap.weekly_reset_at ?? "").substring(0, 10);
      try {
        const raw = localStorage.getItem(STORAGE_KEY(key));
        if (raw) {
          const saved: Persisted = JSON.parse(raw);
          if (saved.weeklyResetDate === weeklyResetDate) {
            result[key] = saved.blocks;
            continue;
          }
        }
      } catch { /* ignore */ }
      result[key] = [];
    }
    return result;
  });
  const [allNextId, setAllNextId] = useState<Record<string, number>>(() => {
    const result: Record<string, number> = {};
    for (const snap of snapshots) {
      const key = accountKey(snap);
      const weeklyResetDate = (snap.weekly_reset_at ?? "").substring(0, 10);
      try {
        const raw = localStorage.getItem(STORAGE_KEY(key));
        if (raw) {
          const saved: Persisted = JSON.parse(raw);
          if (saved.weeklyResetDate === weeklyResetDate) {
            result[key] = saved.nextId;
            continue;
          }
        }
      } catch { /* ignore */ }
      result[key] = 0;
    }
    return result;
  });

  useEffect(() => {
    for (const snap of snapshots) {
      const key = accountKey(snap);
      const weeklyResetDate = (snap.weekly_reset_at ?? "").substring(0, 10);
      const blocks = allBlocks[key] ?? [];
      const nextId = allNextId[key] ?? 0;
      localStorage.setItem(STORAGE_KEY(key), JSON.stringify({ blocks, nextId, weeklyResetDate }));
    }
  }, [allBlocks, allNextId, snapshots]);

  useEffect(() => {
    const cleanup = () => {
      const now = Date.now();
      setAllBlocks((prev) => {
        let changed = false;
        const next: Record<string, Block[]> = {};
        for (const key of Object.keys(prev)) {
          let filtered = (prev[key] ?? []).filter((b) => b.startMs != null && b.startMs > now);
          const snap = snapshots.find((s) => accountKey(s) === key);
          if (snap?.session_reset_at) {
            const sessionEndMs = new Date(snap.session_reset_at).getTime();
            if (sessionEndMs > now) {
              filtered = filtered.filter((b) => b.startMs >= sessionEndMs);
            }
          }
          if (filtered.length !== (prev[key] ?? []).length) changed = true;
          next[key] = filtered;
        }
        return changed ? next : prev;
      });
    };
    cleanup();
    const timer = setInterval(cleanup, 60_000);
    return () => clearInterval(timer);
  }, [snapshots]);

  const nowMs = Date.now();
  const nowDate = new Date(nowMs);
  const nowWallHour = nowDate.getHours() + nowDate.getMinutes() / 60 + nowDate.getSeconds() / 3600;

  const maxResetHours = Math.max(
    24,
    ...snapshots.map((s) =>
      s.weekly_reset_at
        ? Math.max(0, (new Date(s.weekly_reset_at).getTime() - nowMs) / 3_600_000)
        : 0
    )
  );
  const timelineHours = Math.ceil(maxResetHours) + 2;
  const timelineWidth = timelineHours * PX_PER_HOUR;

  const addBlock = useCallback((key: string, wallHour: number) => {
    setAllBlocks((prev) => {
      const existing = prev[key] ?? [];
      const overlaps = existing.some(
        (b) => wallHour < b.wallHour + SESSION_HOURS && wallHour + SESSION_HOURS > b.wallHour
      );
      if (overlaps) return prev;
      const id = (allNextId[key] ?? 0);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const startMs = today.getTime() + wallHour * 3_600_000;
      setAllNextId((p) => ({ ...p, [key]: id + 1 }));
      return { ...prev, [key]: [...existing, { id, wallHour, startMs }] };
    });
  }, [allNextId]);

  const removeBlock = useCallback((key: string, id: number) => {
    setAllBlocks((prev) => ({
      ...prev,
      [key]: (prev[key] ?? []).filter((b) => b.id !== id),
    }));
  }, []);

  const clearAll = useCallback(() => {
    setAllBlocks(Object.fromEntries(snapshots.map((s) => [accountKey(s), []])));
  }, [snapshots]);

  const minutesPastHour = nowDate.getMinutes() + nowDate.getSeconds() / 60;
  const hoursToNextHour = minutesPastHour === 0 ? 0 : 1 - minutesPastHour / 60;

  const hourTicks: { offsetHour: number; label: string }[] = [];
  for (let i = 0; i <= timelineHours; i++) {
    const offsetHour = hoursToNextHour + i;
    if (offsetHour > timelineHours) break;
    const d = new Date(nowMs + offsetHour * 3_600_000);
    hourTicks.push({ offsetHour, label: `${d.getHours().toString().padStart(2, "0")}:00` });
  }

  const midnightMarkers: { offsetHour: number; label: string }[] = [];
  const hoursToMidnight = 24 - (nowDate.getHours() + nowDate.getMinutes() / 60 + nowDate.getSeconds() / 3600);
  for (let d = 0; d * 24 + hoursToMidnight <= timelineHours; d++) {
    const offsetHour = hoursToMidnight + d * 24;
    const date = new Date(nowMs + offsetHour * 3_600_000);
    const mm = (date.getMonth() + 1).toString().padStart(2, "0");
    const dd = date.getDate().toString().padStart(2, "0");
    midnightMarkers.push({ offsetHour, label: `${mm}/${dd}` });
  }

  const predictionRows = snapshots.map((snap, si) => {
    const key = accountKey(snap);
    const provider = snap.provider ?? "claude_code";
    const accountAvgCost = avgCostsByProvider[provider] ?? avgCost;
    const color = colors[key] ?? colors[snap.account_alias] ?? ACCOUNT_COLORS[si % ACCOUNT_COLORS.length];
    const blocks = allBlocks[key] ?? [];
    const weeklyUsed = snap.weekly_pct ?? null;
    const weeklyTotal = snap.weekly_total_pct ?? 100;
    const sessionTotal = snap.session_total_pct ?? 100;
    const sessionRemainingHours = snap.session_reset_at
      ? (new Date(snap.session_reset_at).getTime() - nowMs) / 3_600_000 : null;
    const hasActiveSession = sessionRemainingHours != null && sessionRemainingHours > 0;
    const sessionRemainingPct = hasActiveSession && snap.session_pct != null ? Math.max(0, sessionTotal - snap.session_pct) : null;
    // accountAvgCost 是「周额度% / 次」（无刻度），换算回本账号刻度的点数
    const costPointsPerSession = accountAvgCost != null ? (accountAvgCost / 100) * weeklyTotal : null;
    const currCost = costPointsPerSession != null && sessionRemainingPct != null
      ? (sessionRemainingPct / sessionTotal) * costPointsPerSession : null;
    const placed = (currCost ?? 0) + blocks.length * (costPointsPerSession ?? 0);
    const projected = weeklyUsed != null ? Math.min(weeklyTotal, weeklyUsed + placed) : null;
    return { key, snap, color, weeklyUsed, weeklyTotal, placed, projected };
  });

  return (
    <div className="space-y-3">
      <div className="card p-0 overflow-hidden">
        <div className="px-4 py-2.5 flex items-center justify-between" style={{ borderBottom: "1px solid #3a3a3a" }}>
          <span className="text-sm font-semibold" style={{ color: "#ddd" }}>
            规划时间轴
            <span className="text-xs font-normal ml-2" style={{ color: "#888" }}>点击行内放置 5h Session</span>
          </span>
          <button onClick={clearAll} className="text-xs px-2 py-1 rounded"
            style={{ color: "#aaa", background: "#333", border: "1px solid #444" }}>全部清空</button>
        </div>

        <div className="overflow-x-auto" style={{ paddingBottom: 4 }}>
          <div style={{ display: "flex", minWidth: LABEL_W + timelineWidth }}>
            <div style={{ width: LABEL_W, flexShrink: 0 }}>
              <div style={{ height: HEADER_H, borderBottom: "1px solid #2e2e2e" }} />
              {snapshots.map((snap, si) => {
                const key = accountKey(snap);
                const color = colors[key] ?? colors[snap.account_alias] ?? ACCOUNT_COLORS[si % ACCOUNT_COLORS.length];
                return (
                  <div key={key} style={{
                    height: ROW_H, display: "flex", flexDirection: "column",
                    justifyContent: "center", paddingLeft: 12,
                    borderBottom: "1px solid #2e2e2e",
                  }}>
                    <div className="flex items-center gap-1" style={{ color, marginBottom: 4 }}>
                      <ProviderIcon provider={snap.provider} size={12} />
                    </div>
                    <span style={{ fontSize: 10, color: "#ccc", lineHeight: 1.2, maxWidth: LABEL_W - 16, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {snap.account_alias.split("@")[0]}
                    </span>
                  </div>
                );
              })}
            </div>

            <div style={{ position: "relative", width: timelineWidth, flexShrink: 0 }}>
              <div style={{ position: "relative", height: HEADER_H, background: "#222", borderBottom: "1px solid #2e2e2e" }}>
                <span style={{ position: "absolute", bottom: 4, left: 4, fontSize: 10, color: "#cc785c", fontWeight: 700 }}>现在</span>
                {hourTicks.map(({ offsetHour, label }) => (
                  <span key={label} style={{
                    position: "absolute", bottom: 4,
                    left: offsetHour * PX_PER_HOUR + 3,
                    fontSize: 9, color: "#888", whiteSpace: "nowrap", pointerEvents: "none",
                  }}>{label}</span>
                ))}
                {midnightMarkers.map(({ offsetHour, label }) => (
                  <span key={label} style={{
                    position: "absolute", top: 3,
                    left: offsetHour * PX_PER_HOUR + 4,
                    fontSize: 10, color: "#7ab8f5", fontWeight: 700, whiteSpace: "nowrap",
                  }}>{label}</span>
                ))}
              </div>

              {snapshots.map((snap, si) => {
                const key = accountKey(snap);
                const color = colors[key] ?? colors[snap.account_alias] ?? ACCOUNT_COLORS[si % ACCOUNT_COLORS.length];
                const blocks = allBlocks[key] ?? [];
                const sortedBlocks = [...blocks].sort((a, b) => a.wallHour - b.wallHour);
                const sessionRemainingHours = snap.session_reset_at
                  ? Math.max(0, (new Date(snap.session_reset_at).getTime() - nowMs) / 3_600_000) : null;
                const weeklyResetHours = snap.weekly_reset_at
                  ? Math.max(0, (new Date(snap.weekly_reset_at).getTime() - nowMs) / 3_600_000) : null;

                const handleRowClick = (e: React.MouseEvent<HTMLDivElement>) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const clickOffsetHour = (e.clientX - rect.left) / PX_PER_HOUR;
                  const now2 = new Date();
                  const nwh = now2.getHours() + now2.getMinutes() / 60 + now2.getSeconds() / 3600;
                  const wallHour = Math.max(Math.ceil(nwh), Math.floor(nwh + clickOffsetHour));
                  if (wallHour - nwh + SESSION_HOURS > timelineHours) return;
                  addBlock(key, wallHour);
                };

                return (
                  <div key={key} onClick={handleRowClick}
                    style={{
                      position: "relative", height: ROW_H, cursor: "crosshair",
                      background: si % 2 === 0 ? "#1e1e1e" : "#1a1a1a",
                      borderBottom: "1px solid #2e2e2e",
                    }}
                  >
                    {hourTicks.map(({ offsetHour, label }) => (
                      <div key={label} style={{
                        position: "absolute", left: offsetHour * PX_PER_HOUR,
                        top: 0, bottom: 0,
                        borderLeft: "1px solid #2a2a2a",
                        pointerEvents: "none",
                      }} />
                    ))}

                    {midnightMarkers.map(({ offsetHour, label }) => (
                      <div key={label} style={{
                        position: "absolute", left: offsetHour * PX_PER_HOUR,
                        top: 0, bottom: 0,
                        borderLeft: "1px solid #3a4a5a",
                        pointerEvents: "none", zIndex: 1,
                      }} />
                    ))}

                    {weeklyResetHours != null && weeklyResetHours <= timelineHours && (
                      <div style={{
                        position: "absolute", left: weeklyResetHours * PX_PER_HOUR,
                        top: 0, bottom: 0,
                        borderLeft: `2px dashed ${color}88`,
                        pointerEvents: "none", zIndex: 2,
                      }} />
                    )}

                    {sessionRemainingHours != null && sessionRemainingHours > 0 && (
                      <div onClick={(e) => e.stopPropagation()} style={{
                        position: "absolute", left: 1, top: 8,
                        width: Math.min(sessionRemainingHours, timelineHours) * PX_PER_HOUR - 2,
                        height: ROW_H - 18,
                        background: `${color}15`,
                        border: `1px dashed ${color}88`,
                        borderRadius: 4, zIndex: 3,
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}>
                        <span style={{ fontSize: 10, color, fontWeight: 600 }}>
                          进行中 {sessionRemainingHours.toFixed(1)}h
                        </span>
                      </div>
                    )}

                    {sortedBlocks.map((b, idx) => {
                      const offsetHour = b.wallHour - nowWallHour;
                      const overDeadline = weeklyResetHours != null && offsetHour + SESSION_HOURS > weeklyResetHours;
                      return (
                        <div key={b.id} onClick={(e) => e.stopPropagation()} style={{
                          position: "absolute",
                          left: offsetHour * PX_PER_HOUR + 1,
                          top: 8, width: SESSION_HOURS * PX_PER_HOUR - 4, height: ROW_H - 18,
                          background: overDeadline ? "#3d1a1a" : `${color}22`,
                          border: `1px solid ${overDeadline ? "#f87171" : color}`,
                          borderRadius: 4, zIndex: 5,
                          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                          userSelect: "none",
                        }}>
                          <span style={{ fontSize: 11, color: overDeadline ? "#f87171" : color, fontWeight: 700 }}>S{idx + 1}</span>
                          <button onClick={(e) => { e.stopPropagation(); removeBlock(key, b.id); }}
                            style={{ position: "absolute", top: 1, right: 3, fontSize: 10, color: "#aaa", background: "none", border: "none", cursor: "pointer" }}>×</button>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="card p-0 overflow-hidden">
        <div className="px-4 py-2.5" style={{ borderBottom: "1px solid #3a3a3a" }}>
          <span className="text-sm font-semibold" style={{ color: "#ddd" }}>周期额度预测</span>
        </div>
        <div className="divide-y" style={{ borderColor: "#2e2e2e" }}>
          {predictionRows.map(({ key, snap, color, weeklyUsed, weeklyTotal, placed, projected }) => {
            const usedWidth = weeklyUsed != null ? Math.min(100, (weeklyUsed / weeklyTotal) * 100) : 0;
            const placedWidth = weeklyUsed != null && placed > 0
              ? Math.min(100 - usedWidth, (Math.min(placed, weeklyTotal - weeklyUsed) / weeklyTotal) * 100)
              : 0;
            return (
              <div key={key} className="px-4 py-3 flex items-center gap-3">
                <span className="inline-flex items-center justify-center" style={{ width: 14, height: 14, color, flexShrink: 0 }}>
                  <ProviderIcon provider={snap.provider} size={14} />
                </span>
                <span className="text-xs" style={{ color: "#bbb", width: 100, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {snap.account_alias}
                </span>
                <div style={{ flex: 1, position: "relative", height: 8, background: "#444", borderRadius: 4, overflow: "hidden" }}>
                  {weeklyUsed != null && (
                    <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${usedWidth}%`, background: color, opacity: 0.9 }} />
                  )}
                  {weeklyUsed != null && placed > 0 && (
                    <div style={{ position: "absolute", left: `${usedWidth}%`, top: 0, bottom: 0, width: `${placedWidth}%`, background: color, opacity: 0.4 }} />
                  )}
                </div>
                <span className="text-xs font-mono" style={{ color: "#999", width: 36, textAlign: "right", flexShrink: 0 }}>
                  {weeklyUsed?.toFixed(0) ?? "—"}%
                </span>
                {projected != null && (
                  <span className="text-xs font-semibold font-mono" style={{ color, width: 44, textAlign: "right", flexShrink: 0 }}>
                    → {projected.toFixed(0)}%
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
