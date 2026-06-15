import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Filter, X, PanelLeftOpen } from "lucide-react";
import Sidebar from "./Sidebar";
import SessionTimeline from "./SessionTimeline";
import MessageStream from "./MessageStream";
import DraftBar, { type SessionOption } from "./DraftBar";
import AddSourceDialog from "./AddSourceDialog";
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
  StreamFilter,
} from "./types";
import { shiftYmd, todayYmd, dayRange } from "./format";

const POLL_INTERVAL_MS = 15_000;

export default function SessionsApp() {
  const [sourceStatuses, setSourceStatuses] = useState<SourceStatus[]>([]);
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [date, setDate] = useState<string>(todayYmd());
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [timelineCollapsed, setTimelineCollapsed] = useState(false);

  const [stream, setStream] = useState<StreamMessage[]>([]);
  const [rows, setRows] = useState<TimelineRowWithSource[]>([]);
  const [statsDays, setStatsDays] = useState<DailyStat[]>([]);
  // 选中某会话时，该会话的逐日句数（热力图按它紫色标记有记录的日期）
  const [sessionDays, setSessionDays] = useState<DailyStat[]>([]);

  // 预备发言/待办（仅本机私有，用户产生，不随轮询刷新——仅本窗口编辑）。
  // 落库走「差异化按行 CRUD」：对比新旧数组，只 upsert 变化的、只 delete 真正移除的，
  // 绝不整表覆盖——即使加载扑空(drafts=[])，新增也只 upsert 一条，不会误删库里已有行。
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

  // 会话时间轴点击产生的过滤（会话 / 小时），在当天范围内进一步收窄卡片
  const [streamFilter, setStreamFilter] = useState<StreamFilter | null>(null);

  const dateRef = useRef(date);
  const sourceRef = useRef<string | null>(null);
  const filterRef = useRef<StreamFilter | null>(null);
  const sessionDaysRef = useRef<DailyStat[]>([]);

  useEffect(() => {
    dateRef.current = date;
    sourceRef.current = activeSourceId;
    filterRef.current = streamFilter;
  }, [date, activeSourceId, streamFilter]);

  useEffect(() => {
    sessionDaysRef.current = sessionDays;
  }, [sessionDays]);

  // 选中某会话 → 拉该会话的逐日句数（供热力图紫色标记）；未选会话则清空
  const selSession = streamFilter?.session ?? null;
  const selSource = streamFilter?.source ?? undefined;
  useEffect(() => {
    if (!selSession) {
      setSessionDays([]);
      return;
    }
    let cancelled = false;
    fetchStats(selSource, selSession)
      .then((r) => {
        if (!cancelled) setSessionDays(r.days);
      })
      .catch(() => {
        if (!cancelled) setSessionDays([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selSession, selSource]);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      const baseSource = sourceRef.current ?? undefined;
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

      // 当天会话时间轴
      const tl = await fetchTimeline(d, baseSource).catch(() => null);
      setRows((tl?.sessions ?? []).map((r) => ({ ...r, source_label: labelMap[r.source_id] ?? r.source_id })));

      // 当天卡片：默认整天范围；会话时间轴选了小时则收窄到那一小时
      const day = dayRange(d);
      const cards = await fetchMyMessages(2000, 0, {
        source: sf?.source ?? baseSource,
        session: sf?.session,
        since: sf?.since ?? day.since,
        until: sf?.until ?? day.until,
      }).catch(() => null);
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
  }, [date, activeSourceId, streamFilter, refreshAll, syncing]);

  // 顶部统计（全局累计）
  const totalCount = useMemo(() => statsDays.reduce((s, d) => s + d.count, 0), [statsDays]);
  const dayCount = statsDays.length;
  const sessionCount = useMemo(() => {
    if (activeSourceId) return sourceStatuses.find((s) => s.id === activeSourceId)?.session_count ?? 0;
    return sourceStatuses.reduce((s, x) => s + x.session_count, 0);
  }, [sourceStatuses, activeSourceId]);

  // 当天统计：句数取自按天统计，会话数 = 当天时间轴行数
  const daySentences = useMemo(() => statsDays.find((d) => d.date === date)?.count ?? 0, [statsDays, date]);
  const daySessions = rows.length;

  // 左侧项目标签：从当天会话数据(rows)派生，不随时间轴筛选收窄
  const projects = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of rows) {
      const name = r.project_name || "—";
      map.set(name, (map.get(name) || 0) + r.count);
    }
    return Array.from(map, ([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  }, [rows]);

  // 项目筛选(客户端)同时作用于卡片与时间轴显示
  const visibleCards = useMemo(
    () => (activeProject ? stream.filter((m) => (m.project_name || "—") === activeProject) : stream),
    [stream, activeProject]
  );
  const visibleRows = useMemo(
    () => (activeProject ? rows.filter((r) => (r.project_name || "—") === activeProject) : rows),
    [rows, activeProject]
  );
  // 会话 id → 标题（卡片的会话标签用）
  const sessionTitles = useMemo(
    () => Object.fromEntries(rows.map((r) => [r.session_id, r.title])) as Record<string, string>,
    [rows]
  );

  // 预备发言「归属」下拉：当天会话（被项目筛选收窄后的）作为可选项
  const sessionOptions = useMemo<SessionOption[]>(
    () =>
      visibleRows.map((r) => ({
        source_id: r.source_id,
        session_id: r.session_id,
        title: r.title,
        project_name: r.project_name || "",
      })),
    [visibleRows]
  );
  // 新待办默认归属 = 当前时间轴选中的会话
  const draftTarget = useMemo<SessionOption | null>(() => {
    const sid = streamFilter?.session;
    if (!sid) return null;
    const r = rows.find((x) => x.session_id === sid);
    return r
      ? { source_id: r.source_id, session_id: r.session_id, title: r.title, project_name: r.project_name || "" }
      : null;
  }, [streamFilter, rows]);

  const selectDate = useCallback((ymd: string) => {
    setDate(ymd);
    setActiveProject(null);
    // 正高亮某会话、且新日期该会话有发言 → 保留会话筛选（只去掉小时收窄，看整天该会话）；
    // 否则切日期即退出高亮、回到全部。
    const sf = filterRef.current;
    if (sf?.session && sessionDaysRef.current.some((d) => d.date === ymd)) {
      setStreamFilter({ source: sf.source, session: sf.session, label: sf.label });
    } else {
      setStreamFilter(null);
    }
  }, []);

  // 再点同一来源 = 取消，回到全部
  const selectSource = useCallback((id: string | null) => {
    setActiveSourceId((prev) => (id !== null && prev === id ? null : id));
    setStreamFilter(null);
    setActiveProject(null);
  }, []);

  // 项目与时间轴筛选互斥；再点同一项目 = 取消，回到全部项目
  const selectProject = useCallback((name: string | null) => {
    setActiveProject((prev) => (name !== null && prev === name ? null : name));
    setStreamFilter(null);
  }, []);

  // 再点同一会话/小时/单元格 = 取消，回到当天全部
  const handleTimelineFilter = useCallback((f: StreamFilter) => {
    setStreamFilter((prev) =>
      prev &&
      prev.session === f.session &&
      prev.since === f.since &&
      prev.until === f.until &&
      prev.source === f.source
        ? null
        : f
    );
    setActiveProject(null);
  }, []);

  // 卡片上的会话标签 → 等同时间轴点会话名（toggle）
  const onFilterSession = useCallback(
    (sourceId: string, sessionId: string, title: string) =>
      handleTimelineFilter({ source: sourceId, session: sessionId, label: title }),
    [handleTimelineFilter]
  );

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
        <Sidebar
          totalCount={totalCount}
          sessionCount={sessionCount}
          dayCount={dayCount}
          days={statsDays}
          sessionDays={sessionDays}
          selectedDate={date}
          onSelectDate={selectDate}
          onPrevDay={() => selectDate(shiftYmd(date, -1))}
          onNextDay={() => selectDate(shiftYmd(date, 1))}
          onToday={() => selectDate(todayYmd())}
          daySentences={daySentences}
          daySessions={daySessions}
          sourceStatuses={sourceStatuses}
          activeSourceId={activeSourceId}
          onSelectSource={selectSource}
          projects={projects}
          activeProject={activeProject}
          onSelectProject={selectProject}
          onAddRemote={() => setAddOpen(true)}
          onRefresh={() => void refreshAll()}
          onToggleCollapse={() => setSidebarCollapsed(true)}
          refreshing={refreshing}
          syncing={syncing}
        />
      )}

      <div className="flex-1 flex flex-col min-w-0">
        <SessionTimeline
          date={date}
          rows={visibleRows}
          loading={syncing || refreshing}
          collapsed={timelineCollapsed}
          activeFilter={streamFilter}
          onToggleCollapse={() => setTimelineCollapsed((v) => !v)}
          onFilter={handleTimelineFilter}
        />

        {streamFilter && (
          <div
            className="flex items-center gap-2 px-5 py-1.5 shrink-0 text-xs"
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
          <MessageStream
            messages={visibleCards}
            loading={(syncing || refreshing) && stream.length === 0}
            sessionTitles={sessionTitles}
            activeSourceId={activeSourceId}
            activeProject={activeProject}
            activeSession={streamFilter?.session ?? null}
            onFilterSource={selectSource}
            onFilterProject={selectProject}
            onFilterSession={onFilterSession}
          />
        </div>
      </div>

      {addOpen && <AddSourceDialog onCancel={() => setAddOpen(false)} onConfirm={handleAdd} />}

      {/* 预备发言：左下角悬浮 HUD（position:fixed，不占文档流） */}
      <DraftBar
        drafts={drafts}
        onChange={persistDrafts}
        sessions={sessionOptions}
        defaultTarget={draftTarget}
      />
    </div>
  );
}
