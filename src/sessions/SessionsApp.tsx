import { useCallback, useEffect, useRef, useState } from "react";
import { Filter, X } from "lucide-react";
import SourceBar, { type SessionView } from "./SourceBar";
import StatBar from "./StatBar";
import MessageStream from "./MessageStream";
import SessionTimeline from "./SessionTimeline";
import AddSourceDialog from "./AddSourceDialog";
import {
  getSources,
  saveSources,
  fetchStatus,
  fetchSyncState,
  fetchMyMessages,
  fetchTimeline,
  fetchStats,
  normalizeBaseUrl,
} from "./api";
import type {
  SessionSource,
  SourceStatus,
  StreamMessage,
  TimelineRowWithSource,
  DailyStat,
  StreamFilter,
} from "./types";
import { shiftYmd, todayYmd } from "./format";

const POLL_INTERVAL_MS = 15_000;

export default function SessionsApp() {
  const [sourceStatuses, setSourceStatuses] = useState<SourceStatus[]>([]);
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  const [view, setView] = useState<SessionView>("stream");
  const [date, setDate] = useState<string>(todayYmd());
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const [stream, setStream] = useState<StreamMessage[]>([]);
  const [rows, setRows] = useState<TimelineRowWithSource[]>([]);
  const [statsDays, setStatsDays] = useState<DailyStat[]>([]);

  // 来自会话时间轴点击的过滤器（会话 / 1 小时单元格），仅作用于发言流
  const [streamFilter, setStreamFilter] = useState<StreamFilter | null>(null);

  const activeSourceIdRef = useRef<string | null>(null);
  const viewRef = useRef<SessionView>("stream");
  const dateRef = useRef<string>(date);
  const filterRef = useRef<StreamFilter | null>(null);

  useEffect(() => {
    activeSourceIdRef.current = activeSourceId;
    viewRef.current = view;
    dateRef.current = date;
    filterRef.current = streamFilter;
  }, [activeSourceId, view, date, streamFilter]);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      const baseSource = activeSourceIdRef.current ?? undefined;
      const v = viewRef.current;
      const d = dateRef.current;
      const sf = filterRef.current;

      const [statuses, days, sync] = await Promise.all([
        fetchStatus().catch(() => [] as SourceStatus[]),
        fetchStats(baseSource).then((r) => r.days).catch(() => [] as DailyStat[]),
        fetchSyncState().catch(() => ({ syncing: false, total: 0 })),
      ]);
      setSourceStatuses(statuses);
      setStatsDays(days);
      setSyncing(sync.syncing);

      const labelMap: Record<string, string> = {};
      for (const s of statuses) labelMap[s.id] = s.label;

      if (v === "stream") {
        const res = await fetchMyMessages(400, 0, {
          source: sf?.source ?? baseSource,
          session: sf?.session,
          since: sf?.since,
          until: sf?.until,
        }).catch(() => null);
        setStream(
          (res?.items ?? []).map((it) => ({ ...it, source_label: labelMap[it.source_id] ?? it.source_id }))
        );
      } else {
        const res = await fetchTimeline(d, baseSource).catch(() => null);
        setRows(
          (res?.sessions ?? []).map((r) => ({ ...r, source_label: labelMap[r.source_id] ?? r.source_id }))
        );
      }
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refreshAll();
    const interval = syncing ? 2_000 : POLL_INTERVAL_MS;
    const timer = window.setInterval(() => void refreshAll(), interval);
    return () => window.clearInterval(timer);
  }, [view, activeSourceId, date, streamFilter, refreshAll, syncing]);

  // 会话时间轴点击 → 设过滤器并切到发言流
  const handleFilter = useCallback((f: StreamFilter) => {
    setStreamFilter(f);
    setActiveSourceId(f.source);
    setView("stream");
  }, []);

  const handleSelectSource = useCallback((id: string | null) => {
    setActiveSourceId(id);
    setStreamFilter(null); // 切换来源即清掉会话/小时过滤
  }, []);

  const handleAdd = useCallback(
    async (label: string, address: string) => {
      const base_url = normalizeBaseUrl(address);
      if (!base_url) return;
      const current = await getSources().catch(() => [] as SessionSource[]);
      const id = crypto.randomUUID();
      const next = [...current, { id, label: label || base_url.replace(/^https?:\/\//, ""), base_url }];
      await saveSources(next).catch(() => undefined);
      setAddOpen(false);
      void refreshAll();
    },
    [refreshAll]
  );

  const handleRemove = useCallback(
    async (id: string) => {
      const current = await getSources().catch(() => [] as SessionSource[]);
      await saveSources(current.filter((s) => s.id !== id)).catch(() => undefined);
      if (activeSourceIdRef.current === id) {
        setActiveSourceId(null);
        setStreamFilter(null);
      }
      void refreshAll();
    },
    [refreshAll]
  );

  return (
    <div className="h-screen flex flex-col" style={{ background: "#181818" }}>
      <SourceBar
        sourceStatuses={sourceStatuses}
        activeSourceId={activeSourceId}
        view={view}
        refreshing={refreshing}
        onChangeView={setView}
        onSelectSource={handleSelectSource}
        onAdd={() => setAddOpen(true)}
        onRemove={handleRemove}
        onRefresh={() => void refreshAll()}
      />

      <StatBar days={statsDays} loading={(syncing || refreshing) && statsDays.length === 0} />

      {view === "stream" && streamFilter && (
        <div
          className="flex items-center gap-2 px-4 py-1.5 shrink-0 text-xs"
          style={{ background: "#20262a", borderBottom: "1px solid #2a2a2a", color: "#cbd5e1" }}
        >
          <Filter size={12} style={{ color: "#8fb3d3" }} />
          <span className="truncate">筛选：{streamFilter.label}</span>
          <button
            type="button"
            onClick={() => setStreamFilter(null)}
            className="inline-flex items-center gap-0.5 ml-1 shrink-0"
            style={{ color: "#9ca3af", background: "#2a2a2a", border: 0, borderRadius: 6, padding: "1px 7px", cursor: "pointer" }}
          >
            <X size={11} /> 清除
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0">
        {view === "stream" ? (
          <MessageStream messages={stream} loading={(syncing || refreshing) && stream.length === 0} />
        ) : (
          <SessionTimeline
            date={date}
            rows={rows}
            loading={syncing || refreshing}
            onPrev={() => setDate((d) => shiftYmd(d, -1))}
            onNext={() => setDate((d) => shiftYmd(d, 1))}
            onToday={() => setDate(todayYmd())}
            onFilter={handleFilter}
          />
        )}
      </div>

      {addOpen && <AddSourceDialog onCancel={() => setAddOpen(false)} onConfirm={handleAdd} />}
    </div>
  );
}
