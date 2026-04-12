import { useState, useCallback, useEffect } from "react";
import type { UsageSnapshot, Recommendation, AccountAnalysis } from "../types";
import { formatPct, formatHours, formatLocalTime, remaining, hoursUntil } from "../utils/format";
import ProgressBar from "./ProgressBar";
import { useHistory } from "../hooks/useData";

// ── 时间轴常量 ────────────────────────────────────────────
const SESSION_HOURS = 5;
const PX_PER_HOUR = 30;
const LABEL_W = 72;     // 账号标签列宽（px）
const ROW_H = 64;       // 每个账号行高（px）
const HEADER_H = 28;    // 时间标题行高（px）

const ACCOUNT_COLORS = ["#cc785c", "#4a9eff", "#4ade80"];

const STORAGE_KEY = (alias: string) => `sprint_blocks_${alias}`;
interface Block { id: number; wallHour: number; }
// 只取日期部分（"2026-04-09"），避免毫秒级抖动导致误判为新周
interface Persisted { blocks: Block[]; nextId: number; weeklyResetDate: string; }

// ── Props ─────────────────────────────────────────────────
interface Props {
  snapshots: UsageSnapshot[];
  recommendation: Recommendation | null;
  analysis: AccountAnalysis[];
  onRefresh: () => void;
}

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

// ── StatusCards ───────────────────────────────────────────
export default function StatusCards({ snapshots, recommendation, analysis, onRefresh }: Props) {
  const snapshotMap = Object.fromEntries(snapshots.map((s) => [s.account_alias, s]));

  const orderedAliases = (() => {
    const seen = new Set<string>();
    const result: string[] = [];
    if (recommendation?.recommended_alias) {
      result.push(recommendation.recommended_alias);
      seen.add(recommendation.recommended_alias);
    }
    for (const a of recommendation?.account_summaries.map((s) => s.alias) ?? []) {
      if (!seen.has(a)) { result.push(a); seen.add(a); }
    }
    for (const a of snapshots.map((s) => s.account_alias)) {
      if (!seen.has(a)) { result.push(a); seen.add(a); }
    }
    return result;
  })();

  const validCosts = analysis
    .map((a) => a.weekly_cost_per_session_24h)
    .filter((v): v is number => v !== null && v > 0);
  const avgCost = validCosts.length > 0
    ? validCosts.reduce((a, b) => a + b, 0) / validCosts.length
    : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold" style={{ color: "#ddd" }}>账号状态总览</h2>
        <button onClick={onRefresh} className="btn-ghost flex items-center gap-1.5 text-xs">
          <span>↺</span>刷新
        </button>
      </div>

      {orderedAliases.length === 0 ? (
        <div className="card text-center py-10 text-sm" style={{ color: "#888" }}>
          暂无数据，请在扩展中配置账号并上报
        </div>
      ) : (
        orderedAliases.map((alias) => {
          const snap = snapshotMap[alias];
          const sum = recommendation?.account_summaries.find((s) => s.alias === alias);
          return (
            <AccountCard
              key={alias}
              alias={alias}
              snap={snap}
              sessionHours={sum?.session_remaining_hours ?? hoursUntil(snap?.session_reset_at ?? null)}
              weeklyHours={sum?.weekly_remaining_hours ?? hoursUntil(snap?.weekly_reset_at ?? null)}
              isRecommended={recommendation?.recommended_alias === alias}
              avgCost={avgCost}
              allSnapshots={snapshots}
            />
          );
        })
      )}
    </div>
  );
}

// ── AccountCard ───────────────────────────────────────────
interface CardProps {
  alias: string;
  snap: UsageSnapshot | undefined;
  sessionHours: number | null;
  weeklyHours: number | null;
  isRecommended: boolean;
  avgCost: number | null;
  allSnapshots: UsageSnapshot[];
}

function AccountCard({ alias, snap, sessionHours, weeklyHours, isRecommended, avgCost, allSnapshots }: CardProps) {
  const [modal, setModal] = useState<"history" | "sprint" | null>(null);

  const weeklyPct = snap?.weekly_pct ?? null;
  const weeklyRemaining = weeklyPct != null ? 100 - weeklyPct : null;
  const sessionsLeft = avgCost != null && weeklyRemaining != null
    ? Math.ceil(weeklyRemaining / avgCost) : null;
  const resetDays = weeklyHours != null ? weeklyHours / 24 : null;

  return (
    <>
      <div className="card" style={isRecommended ? { outline: "1px solid #cc785c88" } : {}}>
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div style={{
              width: 30, height: 30, borderRadius: 8, flexShrink: 0,
              background: "linear-gradient(135deg, #cc785c, #d4956b)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 14, fontWeight: 700, color: "#fff",
            }}>
              {alias[0]?.toUpperCase() ?? "?"}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold" style={{ color: "#eee" }}>{alias}</span>
              {isRecommended && <span className="plan-badge" style={{ fontSize: 10 }}>推荐</span>}
            </div>
          </div>
          {snap && <span className="text-xs" style={{ color: "#888" }}>{formatLocalTime(snap.collected_at)}</span>}
        </div>

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
                <UsageRow label="Session (5h)" pct={snap.session_pct ?? null}
                  resetHours={sessionHours} resetAt={snap.session_reset_at} colorFn={sessionResetColor} />
                <UsageRow label="Weekly" pct={snap.weekly_pct ?? null}
                  resetHours={weeklyHours} resetAt={snap.weekly_reset_at} colorFn={weeklyResetColor} />
              </div>
            </div>

            {/* 右：X次耗尽（点击→冲刺规划） */}
            <div
              className="rounded-lg px-3 py-2.5 cursor-pointer flex flex-col justify-center items-center text-center"
              style={{ background: "#242424", border: "1px solid #383838", minWidth: 90 }}
              onClick={() => setModal("sprint")}
            >
              <div className="text-3xl font-bold font-mono" style={{ color: "#fff" }}>
                {sessionsLeft != null ? sessionsLeft : "—"}
              </div>
              <div className="text-xs mt-0.5" style={{ color: "#aaa" }}>次耗尽周额度</div>
              <div className="text-sm font-semibold mt-2"
                style={{ color: weeklyResetColor(weeklyHours) }}>
                {resetDays != null ? `${resetDays.toFixed(1)}天后重置` : "—"}
              </div>
            </div>
          </div>
        )}
      </div>

      {modal === "history" && (
        <Modal title={`历史记录 · ${alias}`} onClose={() => setModal(null)}>
          <HistoryPanel alias={alias} />
        </Modal>
      )}
      {modal === "sprint" && (
        <Modal title="规划时间轴" onClose={() => setModal(null)}>
          <SprintPanel snapshots={allSnapshots} avgCost={avgCost} />
        </Modal>
      )}
    </>
  );
}

// ── UsageRow ──────────────────────────────────────────────
function UsageRow({ label, pct, resetHours, resetAt, colorFn }: {
  label: string; pct: number | null;
  resetHours: number | null; resetAt: string | null;
  colorFn: (h: number | null) => string;
}) {
  const rem = remaining(pct);
  const color = colorFn(resetHours);
  const resetText = resetHours !== null ? `${formatHours(resetHours)}后重置` : formatLocalTime(resetAt);
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span style={{ color: "#aaa" }}>{label}</span>
        <div className="flex items-center gap-2">
          <span className="font-semibold font-mono" style={{ color: "#fff" }}>{formatPct(pct)}</span>
          <span style={{ color: "#bbb" }}>余 {formatPct(rem)}</span>
        </div>
      </div>
      <ProgressBar pct={pct} />
      <div className="text-xs mt-1 font-medium" style={{ color }}>{resetText}</div>
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

// ── HistoryPanel ──────────────────────────────────────────
function HistoryPanel({ alias }: { alias: string }) {
  const { history, loading, refetch } = useHistory(alias);
  const [confirmId, setConfirmId] = useState<number | null>(null);

  const handleDelete = async (id: number) => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("delete_snapshot", { id });
    setConfirmId(null);
    refetch();
  };

  if (loading) return <div className="text-center py-8 text-sm" style={{ color: "#888" }}>加载中…</div>;
  if (history.length === 0) return <div className="text-center py-8 text-sm" style={{ color: "#888" }}>暂无历史数据</div>;
  return (
    <>
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
              <tr style={{ color: "#aaa", borderBottom: "1px solid #3a3a3a" }}>
                <th className="text-left px-3 py-2.5 font-semibold">时间</th>
                <th className="text-left px-3 py-2.5 font-semibold">Session</th>
                <th className="text-left px-3 py-2.5 font-semibold">重置</th>
                <th className="text-left px-3 py-2.5 font-semibold">Weekly</th>
                <th className="text-left px-3 py-2.5 font-semibold">重置</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {history.map((snap, i) => (
                <tr key={snap.id ?? i} style={{ borderBottom: "1px solid #333" }} className="hover:bg-white/5">
                  <td className="px-3 py-2 whitespace-nowrap" style={{ color: "#bbb" }}>{formatLocalTime(snap.collected_at)}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2 min-w-[90px]">
                      <span className="font-mono font-semibold w-12"
                        style={{ color: (snap.session_pct ?? 0) >= 80 ? "#f87171" : (snap.session_pct ?? 0) >= 60 ? "#f0a500" : "#7ab8f5" }}>
                        {formatPct(snap.session_pct)}
                      </span>
                      <ProgressBar pct={snap.session_pct} className="flex-1" />
                    </div>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap" style={{ color: "#999" }}>{formatLocalTime(snap.session_reset_at)}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2 min-w-[90px]">
                      <span className="font-mono font-semibold w-12"
                        style={{ color: (snap.weekly_pct ?? 0) >= 80 ? "#f87171" : (snap.weekly_pct ?? 0) >= 60 ? "#f0a500" : "#4ade80" }}>
                        {formatPct(snap.weekly_pct)}
                      </span>
                      <ProgressBar pct={snap.weekly_pct} className="flex-1" />
                    </div>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap" style={{ color: "#999" }}>{formatLocalTime(snap.weekly_reset_at)}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => snap.id != null && setConfirmId(snap.id)}
                      style={{ color: "#666", fontSize: 12, background: "none", border: "none", cursor: "pointer", padding: "2px 4px", borderRadius: 4 }}
                      onMouseEnter={(e) => (e.currentTarget.style.color = "#f87171")}
                      onMouseLeave={(e) => (e.currentTarget.style.color = "#666")}
                      title="删除此记录"
                    >✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// ── SprintPanel（多账号共用时间轴）────────────────────────
function SprintPanel({ snapshots, avgCost }: { snapshots: UsageSnapshot[]; avgCost: number | null }) {
  // 同步从 localStorage 初始化，避免 effect 时序覆盖问题
  const [allBlocks, setAllBlocks] = useState<Record<string, Block[]>>(() => {
    const result: Record<string, Block[]> = {};
    for (const snap of snapshots) {
      const alias = snap.account_alias;
      const weeklyResetDate = (snap.weekly_reset_at ?? "").substring(0, 10);
      try {
        const raw = localStorage.getItem(STORAGE_KEY(alias));
        if (raw) {
          const saved: Persisted = JSON.parse(raw);
          if (saved.weeklyResetDate === weeklyResetDate) {
            result[alias] = saved.blocks;
            continue;
          }
        }
      } catch { /* ignore */ }
      result[alias] = [];
    }
    return result;
  });
  const [allNextId, setAllNextId] = useState<Record<string, number>>(() => {
    const result: Record<string, number> = {};
    for (const snap of snapshots) {
      const alias = snap.account_alias;
      const weeklyResetDate = (snap.weekly_reset_at ?? "").substring(0, 10);
      try {
        const raw = localStorage.getItem(STORAGE_KEY(alias));
        if (raw) {
          const saved: Persisted = JSON.parse(raw);
          if (saved.weeklyResetDate === weeklyResetDate) {
            result[alias] = saved.nextId;
            continue;
          }
        }
      } catch { /* ignore */ }
      result[alias] = 0;
    }
    return result;
  });

  // 持久化（blocks 变化时保存，初始值已从 localStorage 读取，不存在覆盖问题）
  useEffect(() => {
    for (const snap of snapshots) {
      const alias = snap.account_alias;
      const weeklyResetDate = (snap.weekly_reset_at ?? "").substring(0, 10);
      const blocks = allBlocks[alias] ?? [];
      const nextId = allNextId[alias] ?? 0;
      localStorage.setItem(STORAGE_KEY(alias), JSON.stringify({ blocks, nextId, weeklyResetDate }));
    }
  }, [allBlocks, allNextId, snapshots]);

  // 时间基准
  const nowMs = Date.now();
  const nowDate = new Date(nowMs);
  const nowWallHour = nowDate.getHours() + nowDate.getMinutes() / 60 + nowDate.getSeconds() / 3600;

  // 时间轴长度：延伸到最晚周重置 + 2h 缓冲，最少 24h
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

  const addBlock = useCallback((alias: string, wallHour: number) => {
    setAllBlocks((prev) => {
      const existing = prev[alias] ?? [];
      const overlaps = existing.some(
        (b) => wallHour < b.wallHour + SESSION_HOURS && wallHour + SESSION_HOURS > b.wallHour
      );
      if (overlaps) return prev;
      const id = (allNextId[alias] ?? 0);
      setAllNextId((p) => ({ ...p, [alias]: id + 1 }));
      return { ...prev, [alias]: [...existing, { id, wallHour }] };
    });
  }, [allNextId]);

  const removeBlock = useCallback((alias: string, id: number) => {
    setAllBlocks((prev) => ({
      ...prev,
      [alias]: (prev[alias] ?? []).filter((b) => b.id !== id),
    }));
  }, []);

  const clearAll = useCallback(() => {
    setAllBlocks(Object.fromEntries(snapshots.map((s) => [s.account_alias, []])));
  }, [snapshots]);

  // ── 整点刻度 & 日期分隔 ───────────────────────────────────
  const minutesPastHour = nowDate.getMinutes() + nowDate.getSeconds() / 60;
  const hoursToNextHour = minutesPastHour === 0 ? 0 : 1 - minutesPastHour / 60;

  const hourTicks: { offsetHour: number; label: string }[] = [];
  for (let i = 0; i <= timelineHours; i++) {
    const offsetHour = hoursToNextHour + i;
    if (offsetHour > timelineHours) break;
    const d = new Date(nowMs + offsetHour * 3_600_000);
    hourTicks.push({ offsetHour, label: `${d.getHours().toString().padStart(2, "0")}:00` });
  }

  // 午夜分隔（00:00）——标日期
  const midnightMarkers: { offsetHour: number; label: string }[] = [];
  const hoursToMidnight = 24 - (nowDate.getHours() + nowDate.getMinutes() / 60 + nowDate.getSeconds() / 3600);
  for (let d = 0; d * 24 + hoursToMidnight <= timelineHours; d++) {
    const offsetHour = hoursToMidnight + d * 24;
    const date = new Date(nowMs + offsetHour * 3_600_000);
    const mm = (date.getMonth() + 1).toString().padStart(2, "0");
    const dd = date.getDate().toString().padStart(2, "0");
    midnightMarkers.push({ offsetHour, label: `${mm}/${dd}` });
  }

  // 预测卡片数据（时间轴下方用）
  const predictionRows = snapshots.map((snap, si) => {
    const color = ACCOUNT_COLORS[si % ACCOUNT_COLORS.length];
    const blocks = allBlocks[snap.account_alias] ?? [];
    const weeklyUsed = snap.weekly_pct ?? null;
    const sessionRemainingPct = snap.session_pct != null ? 100 - snap.session_pct : null;
    const currCost = avgCost != null && sessionRemainingPct != null
      ? (sessionRemainingPct / 100) * avgCost : null;
    const placed = (currCost ?? 0) + blocks.length * (avgCost ?? 0);
    const projected = weeklyUsed != null ? Math.min(100, weeklyUsed + placed) : null;
    return { snap, color, weeklyUsed, placed, projected };
  });

  return (
    <div className="space-y-3">
      {/* 多账号时间轴 */}
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
            {/* 标签列（不滚动） */}
            <div style={{ width: LABEL_W, flexShrink: 0 }}>
              {/* 标题行占位 */}
              <div style={{ height: HEADER_H, borderBottom: "1px solid #2e2e2e" }} />
              {snapshots.map((snap, si) => {
                const color = ACCOUNT_COLORS[si % ACCOUNT_COLORS.length];
                return (
                  <div key={snap.account_alias} style={{
                    height: ROW_H, display: "flex", flexDirection: "column",
                    justifyContent: "center", paddingLeft: 12,
                    borderBottom: "1px solid #2e2e2e",
                  }}>
                    <div style={{ width: 6, height: 6, borderRadius: "50%", background: color, marginBottom: 4 }} />
                    <span style={{ fontSize: 10, color: "#ccc", lineHeight: 1.2, maxWidth: LABEL_W - 16, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {snap.account_alias.split("@")[0]}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* 时间轴区域 */}
            <div style={{ position: "relative", width: timelineWidth, flexShrink: 0 }}>
              {/* 时间标题行 */}
              <div style={{ position: "relative", height: HEADER_H, background: "#222", borderBottom: "1px solid #2e2e2e" }}>
                <span style={{ position: "absolute", bottom: 4, left: 4, fontSize: 10, color: "#cc785c", fontWeight: 700 }}>现在</span>
                {hourTicks.map(({ offsetHour, label }) => (
                  <span key={label} style={{
                    position: "absolute", bottom: 4,
                    left: offsetHour * PX_PER_HOUR + 3,
                    fontSize: 9, color: "#888", whiteSpace: "nowrap", pointerEvents: "none",
                  }}>{label}</span>
                ))}
                {/* 日期分隔标签 */}
                {midnightMarkers.map(({ offsetHour, label }) => (
                  <span key={label} style={{
                    position: "absolute", top: 3,
                    left: offsetHour * PX_PER_HOUR + 4,
                    fontSize: 10, color: "#7ab8f5", fontWeight: 700, whiteSpace: "nowrap",
                  }}>{label}</span>
                ))}
              </div>

              {/* 账号行 */}
              {snapshots.map((snap, si) => {
                const color = ACCOUNT_COLORS[si % ACCOUNT_COLORS.length];
                const alias = snap.account_alias;
                const blocks = allBlocks[alias] ?? [];
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
                  addBlock(alias, wallHour);
                };

                return (
                  <div key={alias} onClick={handleRowClick}
                    style={{
                      position: "relative", height: ROW_H, cursor: "crosshair",
                      background: si % 2 === 0 ? "#1e1e1e" : "#1a1a1a",
                      borderBottom: "1px solid #2e2e2e",
                    }}
                  >
                    {/* 整点分隔线 */}
                    {hourTicks.map(({ offsetHour, label }) => (
                      <div key={label} style={{
                        position: "absolute", left: offsetHour * PX_PER_HOUR,
                        top: 0, bottom: 0,
                        borderLeft: `1px solid #2a2a2a`,
                        pointerEvents: "none",
                      }} />
                    ))}

                    {/* 日期分隔线（更粗更亮） */}
                    {midnightMarkers.map(({ offsetHour, label }) => (
                      <div key={label} style={{
                        position: "absolute", left: offsetHour * PX_PER_HOUR,
                        top: 0, bottom: 0,
                        borderLeft: "1px solid #3a4a5a",
                        pointerEvents: "none", zIndex: 1,
                      }} />
                    ))}

                    {/* 周重置线 */}
                    {weeklyResetHours != null && weeklyResetHours <= timelineHours && (
                      <div style={{
                        position: "absolute", left: weeklyResetHours * PX_PER_HOUR,
                        top: 0, bottom: 0,
                        borderLeft: `2px dashed ${color}88`,
                        pointerEvents: "none", zIndex: 2,
                      }} />
                    )}

                    {/* 当前 session 进行中块 */}
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

                    {/* 已规划的 session 块 */}
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
                          <button onClick={(e) => { e.stopPropagation(); removeBlock(alias, b.id); }}
                            style={{ position: "absolute", top: 1, right: 3, fontSize: 10, color: "#aaa", background: "none", border: "none", cursor: "pointer" }}>✕</button>
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

      {/* 周额度预测：时间轴下方，每账号一行 */}
      <div className="card p-0 overflow-hidden">
        <div className="px-4 py-2.5" style={{ borderBottom: "1px solid #3a3a3a" }}>
          <span className="text-sm font-semibold" style={{ color: "#ddd" }}>周额度预测</span>
        </div>
        <div className="divide-y" style={{ borderColor: "#2e2e2e" }}>
          {predictionRows.map(({ snap, color, weeklyUsed, placed, projected }) => (
            <div key={snap.account_alias} className="px-4 py-3 flex items-center gap-3">
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }} />
              <span className="text-xs" style={{ color: "#bbb", width: 100, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {snap.account_alias}
              </span>
              <div style={{ flex: 1, position: "relative", height: 8, background: "#444", borderRadius: 4, overflow: "hidden" }}>
                {weeklyUsed != null && (
                  <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${weeklyUsed}%`, background: color, opacity: 0.9 }} />
                )}
                {weeklyUsed != null && placed > 0 && (
                  <div style={{ position: "absolute", left: `${weeklyUsed}%`, top: 0, bottom: 0, width: `${Math.min(placed, 100 - weeklyUsed)}%`, background: color, opacity: 0.4 }} />
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
          ))}
        </div>
      </div>
    </div>
  );
}
