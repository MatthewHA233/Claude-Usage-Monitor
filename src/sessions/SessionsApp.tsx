import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelLeftOpen } from "lucide-react";
import Sidebar from "./Sidebar";
import SessionTimeline from "./SessionTimeline";
import MessageStream from "./MessageStream";
import DraftBar, { type SessionOption } from "./DraftBar";
import NetworkPanel from "./NetworkPanel";
import {
  getSources,
  saveSources,
  fetchStatus,
  fetchSyncState,
  fetchMyMessages,
  fetchTimeline,
  fetchStats,
  getDrafts,
  upsertDraft,
  deleteDraft,
  normalizeBaseUrl,
} from "./api";
import type {
  SessionSource,
  SessionDraft,
  SourceStatus,
  StreamMessage,
  TimelineRowWithSource,
  DailyStat,
} from "./types";
import { shiftYmd, todayYmd, dayRange } from "./format";
import { assignLanes } from "./lanes";

const POLL_INTERVAL_MS = 15_000;

export default function SessionsApp() {
  const [sourceStatuses, setSourceStatuses] = useState<SourceStatus[]>([]);
  const [date, setDate] = useState<string>(todayYmd());
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [networkOpen, setNetworkOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [timelineCollapsed, setTimelineCollapsed] = useState(false);

  const [stream, setStream] = useState<StreamMessage[]>([]);
  const [rows, setRows] = useState<TimelineRowWithSource[]>([]);
  const [statsDays, setStatsDays] = useState<DailyStat[]>([]);

  // 预备发言/待办（仅本机私有，用户产生，不随轮询刷新——仅本窗口编辑）。
  // 落库走「差异化按行 CRUD」：对比新旧数组，只 upsert 变化的、只 delete 真正移除的，绝不整表覆盖。
  const [drafts, setDrafts] = useState<SessionDraft[]>([]);
  const draftsRef = useRef<SessionDraft[]>([]);
  const setDraftsBoth = useCallback((next: SessionDraft[]) => {
    draftsRef.current = next;
    setDrafts(next);
  }, []);
  useEffect(() => {
    void getDrafts().then(setDraftsBoth).catch(() => undefined);
  }, [setDraftsBoth]);
  const persistDrafts = useCallback(
    (next: SessionDraft[]) => {
      const prev = draftsRef.current;
      setDraftsBoth(next);
      const prevById = new Map(prev.map((d) => [d.id, d] as const));
      const nextIds = new Set(next.map((d) => d.id));
      for (const d of next) {
        const p = prevById.get(d.id);
        if (!p || JSON.stringify(p) !== JSON.stringify(d)) void upsertDraft(d).catch(() => undefined);
      }
      for (const d of prev) {
        if (!nextIds.has(d.id)) void deleteDraft(d.id).catch(() => undefined);
      }
    },
    [setDraftsBoth]
  );

  const dateRef = useRef(date);
  useEffect(() => {
    dateRef.current = date;
  }, [date]);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      const d = dateRef.current;

      const [statuses, days, sync] = await Promise.all([
        fetchStatus().catch(() => [] as SourceStatus[]),
        fetchStats().then((r) => r.days).catch(() => [] as DailyStat[]),
        fetchSyncState().catch(() => ({ syncing: false, total: 0 })),
      ]);
      setSourceStatuses(statuses.filter((s) => s.id !== "history")); // 本机·历史不再作为独立来源
      setStatsDays(days);
      setSyncing(sync.syncing);

      const labelMap: Record<string, string> = {};
      for (const s of statuses) labelMap[s.id] = s.label;

      // 当天会话时间轴
      const tl = await fetchTimeline(d).catch(() => null);
      setRows((tl?.sessions ?? []).map((r) => ({ ...r, source_label: labelMap[r.source_id] ?? r.source_id })));

      // 当天卡片：整天范围（不再有时间轴/来源/项目筛选）
      const day = dayRange(d);
      const cards = await fetchMyMessages(2000, 0, { since: day.since, until: day.until }).catch(() => null);
      setStream((cards?.items ?? []).map((it) => ({ ...it, source_label: labelMap[it.source_id] ?? it.source_id })));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refreshAll();
    const interval = syncing ? 2_000 : POLL_INTERVAL_MS;
    const timer = window.setInterval(() => void refreshAll(), interval);
    return () => window.clearInterval(timer);
  }, [date, refreshAll, syncing]);

  // 顶部统计
  const totalCount = useMemo(() => statsDays.reduce((s, d) => s + d.count, 0), [statsDays]);
  const dayCount = statsDays.length;
  const sessionCount = useMemo(() => sourceStatuses.reduce((s, x) => s + x.session_count, 0), [sourceStatuses]);
  const daySentences = useMemo(() => statsDays.find((d) => d.date === date)?.count ?? 0, [statsDays, date]);
  const daySessions = rows.length;

  // 网络按钮状态：有任何「别的机器」(非本机)离线 → 红色断开图标
  const anyRemoteOffline = useMemo(
    () => sourceStatuses.some((s) => s.id !== "local" && !s.online),
    [sourceStatuses]
  );

  // 会话 id → 标题（卡片的会话标签用）
  const sessionTitles = useMemo(
    () => Object.fromEntries(rows.map((r) => [r.session_id, r.title])) as Record<string, string>,
    [rows]
  );

  // 轨道分配（时间轴 + 卡片共用一套，保证轨道严格同序同列）
  const lanes = useMemo(() => assignLanes(rows), [rows]);

  // 预备发言「归属」下拉：当天会话作为可选项
  const sessionOptions = useMemo<SessionOption[]>(
    () =>
      rows.map((r) => ({
        source_id: r.source_id,
        session_id: r.session_id,
        title: r.title,
        project_name: r.project_name || "",
      })),
    [rows]
  );

  const selectDate = useCallback((ymd: string) => setDate(ymd), []);

  const handleAdd = useCallback(
    async (label: string, address: string) => {
      const base_url = normalizeBaseUrl(address);
      if (!base_url) return;
      const current = await getSources().catch(() => [] as SessionSource[]);
      if (current.some((s) => s.base_url === base_url)) return; // 已存在同地址来源，不重复添加
      const id = crypto.randomUUID();
      const next = [...current, { id, label: label || base_url.replace(/^https?:\/\//, ""), base_url }];
      await saveSources(next).catch(() => undefined);
      void refreshAll();
    },
    [refreshAll]
  );

  // 改远程机器名：更新 session_sources 里对应 id 的 label
  const handleRenameSource = useCallback(
    async (id: string, label: string) => {
      const current = await getSources().catch(() => [] as SessionSource[]);
      const next = current.map((s) => (s.id === id ? { ...s, label } : s));
      await saveSources(next).catch(() => undefined);
      void refreshAll();
    },
    [refreshAll]
  );

  // 删除某机器来源：先弹自定义确认框，确认后清掉它在物化库的全部数据
  const [pendingDelete, setPendingDelete] = useState<{ id: string; label: string } | null>(null);
  const handleDeleteSource = useCallback((id: string, label: string) => setPendingDelete({ id, label }), []);
  const confirmDeleteSource = useCallback(async () => {
    const pd = pendingDelete;
    setPendingDelete(null);
    if (!pd) return;
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("session_purge_source", { sourceId: pd.id }).catch(() => undefined);
    const current = await getSources().catch(() => [] as SessionSource[]);
    await saveSources(current.filter((s) => s.id !== pd.id)).catch(() => undefined);
    void refreshAll();
  }, [pendingDelete, refreshAll]);

  return (
    <div className="h-screen flex" style={{ background: "#181818" }}>
      {sidebarCollapsed ? (
        <div
          className="shrink-0 flex flex-col items-center pt-3"
          style={{ width: 42, background: "#1b1b1b", borderRight: "1px solid #2a2a2a" }}
          data-tauri-drag-region
        >
          <button
            type="button"
            title="展开侧栏"
            onClick={() => setSidebarCollapsed(false)}
            className="inline-flex items-center justify-center"
            style={{ width: 28, height: 28, borderRadius: 7, color: "#9ca3af", background: "#232323", border: "1px solid #333", cursor: "pointer" }}
          >
            <PanelLeftOpen size={16} />
          </button>
        </div>
      ) : (
        <div className="shrink-0 flex flex-col h-full" style={{ width: 300, background: "#1b1b1b", borderRight: "1px solid #2a2a2a" }}>
          <Sidebar
            totalCount={totalCount}
            sessionCount={sessionCount}
            dayCount={dayCount}
            days={statsDays}
            selectedDate={date}
            onSelectDate={selectDate}
            onPrevDay={() => selectDate(shiftYmd(date, -1))}
            onNextDay={() => selectDate(shiftYmd(date, 1))}
            onToday={() => selectDate(todayYmd())}
            daySentences={daySentences}
            daySessions={daySessions}
            networkOffline={anyRemoteOffline}
            onOpenNetwork={() => setNetworkOpen(true)}
            onRefresh={() => void refreshAll()}
            onToggleCollapse={() => setSidebarCollapsed(true)}
            refreshing={refreshing}
            syncing={syncing}
          />
          {/* 竖排迷你时间轴：左栏下方，轨道序与卡片同 */}
          <div className="flex-1 min-h-0">
            <SessionTimeline
              date={date}
              rows={rows}
              loading={syncing || refreshing}
              laneOf={lanes.laneOf}
              laneCount={lanes.laneCount}
              labelsByLane={lanes.labelsByLane}
              collapsed={timelineCollapsed}
              onToggleCollapse={() => setTimelineCollapsed((v) => !v)}
            />
          </div>
        </div>
      )}

      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 min-h-0">
          <MessageStream
            messages={stream}
            loading={(syncing || refreshing) && stream.length === 0}
            sessionTitles={sessionTitles}
            laneOf={lanes.laneOf}
            laneCount={lanes.laneCount}
          />
        </div>
      </div>

      {networkOpen && (
        <NetworkPanel
          sourceStatuses={sourceStatuses}
          onAdd={handleAdd}
          onRename={handleRenameSource}
          onDelete={handleDeleteSource}
          onClose={() => setNetworkOpen(false)}
        />
      )}

      {pendingDelete && (
        <div
          className="fixed inset-0 flex items-center justify-center"
          style={{ zIndex: 210, background: "rgba(0,0,0,0.55)" }}
          onClick={() => setPendingDelete(null)}
        >
          <div
            className="rounded-xl p-5"
            style={{ width: 360, background: "#1f1f1f", border: "1px solid #333" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-semibold mb-2" style={{ color: "#f3f4f6" }}>删除来源</div>
            <div className="text-xs mb-4" style={{ color: "#9ca3af", lineHeight: 1.6 }}>
              删除「<span style={{ color: "#e5e7eb" }}>{pendingDelete.label}</span>」及其
              <b style={{ color: "#f87171" }}>全部已采集数据</b>?此操作不可撤销。
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className="text-sm px-3 py-1.5 rounded-md"
                style={{ color: "#cbd5e1", background: "#262626", border: "1px solid #333", cursor: "pointer" }}
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void confirmDeleteSource()}
                className="text-sm px-3 py-1.5 rounded-md font-semibold"
                style={{ color: "#fff", background: "#b9402f", border: 0, cursor: "pointer" }}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 预备发言：右上角悬浮 HUD（position:fixed，不占文档流） */}
      <DraftBar drafts={drafts} onChange={persistDrafts} sessions={sessionOptions} defaultTarget={null} />
    </div>
  );
}
