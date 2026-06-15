import type { CSSProperties, ReactNode } from "react";
import { Plus, RefreshCw, Wifi, WifiOff, FolderGit2, Hash, ChevronLeft, ChevronRight, PanelLeftClose } from "lucide-react";
import type { DailyStat, SourceStatus } from "./types";
import { nfmt } from "./format";
import Heatmap from "./Heatmap";

const LOCAL_SOURCE = "local";

interface Props {
  totalCount: number;
  sessionCount: number;
  dayCount: number;
  days: DailyStat[];
  /** 选中会话的逐日句数（热力图紫色标记） */
  sessionDays?: DailyStat[];
  selectedDate: string;
  onSelectDate: (ymd: string) => void;
  onPrevDay: () => void;
  onNextDay: () => void;
  onToday: () => void;
  daySentences: number;
  daySessions: number;
  sourceStatuses: SourceStatus[];
  activeSourceId: string | null;
  onSelectSource: (id: string | null) => void;
  projects: { name: string; count: number }[];
  activeProject: string | null;
  onSelectProject: (name: string | null) => void;
  onAddRemote: () => void;
  onRefresh: () => void;
  onToggleCollapse: () => void;
  refreshing: boolean;
  syncing: boolean;
}

export default function Sidebar({
  totalCount,
  sessionCount,
  dayCount,
  days,
  sessionDays,
  selectedDate,
  onSelectDate,
  onPrevDay,
  onNextDay,
  onToday,
  daySentences,
  daySessions,
  sourceStatuses,
  activeSourceId,
  onSelectSource,
  projects,
  activeProject,
  onSelectProject,
  onAddRemote,
  onRefresh,
  onToggleCollapse,
  refreshing,
  syncing,
}: Props) {
  return (
    <div
      className="shrink-0 flex flex-col h-full overflow-y-auto"
      style={{ width: 300, background: "#1b1b1b", borderRight: "1px solid #2a2a2a" }}
      data-tauri-drag-region
    >
      {/* 标题 + 操作 */}
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold" style={{ color: "#f3f4f6" }}>会话发言</span>
          {syncing && <span className="text-[10px] animate-pulse" style={{ color: "#8b9298" }}>初始化中…</span>}
        </div>
        <div className="flex items-center gap-1">
          <button type="button" title="添加远程" onClick={onAddRemote} className="inline-flex items-center justify-center" style={iconBtn}>
            <Plus size={14} />
          </button>
          <button type="button" title="刷新" onClick={onRefresh} className="inline-flex items-center justify-center" style={iconBtn}>
            <RefreshCw size={13} className={refreshing ? "animate-spin" : undefined} />
          </button>
          <button type="button" title="收起侧栏" onClick={onToggleCollapse} className="inline-flex items-center justify-center" style={iconBtn}>
            <PanelLeftClose size={14} />
          </button>
        </div>
      </div>

      {/* 统计 */}
      <div className="flex items-stretch gap-2 px-4 pb-3">
        <Stat value={nfmt(totalCount)} label="总句数" />
        <Stat value={nfmt(sessionCount)} label="会话数" />
        <Stat value={nfmt(dayCount)} label="天数" />
      </div>

      {/* 热力图 */}
      <div className="px-4 pb-2">
        <Heatmap days={days} sessionDays={sessionDays} selectedDate={selectedDate} onSelect={onSelectDate} />
      </div>

      {/* 选中日期切换 + 当天统计 */}
      <div className="px-4 pb-3">
        <div className="flex items-center gap-1.5 mb-1.5">
          <button type="button" title="前一天" onClick={onPrevDay} className="inline-flex items-center justify-center" style={navBtn}>
            <ChevronLeft size={15} />
          </button>
          <span className="flex-1 text-center text-sm font-semibold tabular-nums" style={{ color: "#f3f4f6" }}>
            {selectedDate}
          </span>
          <button type="button" title="后一天" onClick={onNextDay} className="inline-flex items-center justify-center" style={navBtn}>
            <ChevronRight size={15} />
          </button>
          <button
            type="button"
            onClick={onToday}
            className="text-xs px-2 py-1 rounded-md"
            style={{ color: "#9ca3af", background: "#232323", border: "1px solid #333", cursor: "pointer" }}
          >
            今天
          </button>
        </div>
        <div className="text-xs text-center" style={{ color: "#8b9298" }}>
          当天 <span style={{ color: "#cbd5e1" }}>{nfmt(daySentences)}</span> 句 ·{" "}
          <span style={{ color: "#cbd5e1" }}>{nfmt(daySessions)}</span> 会话
        </div>
      </div>

      <div style={{ height: 1, background: "#262626", margin: "0 16px 8px" }} />

      {/* 来源 */}
      <div className="px-2">
        <SideItem
          active={activeSourceId === null}
          onClick={() => onSelectSource(null)}
          icon={<FolderGit2 size={14} />}
          label="全部发言"
        />
        {sourceStatuses.map((s) => (
          <SideItem
            key={s.id}
            active={activeSourceId === s.id}
            onClick={() => onSelectSource(s.id)}
            icon={s.online ? <Wifi size={14} style={{ color: "#4ade80" }} /> : <WifiOff size={14} style={{ color: "#f87171" }} />}
            label={s.label + (s.id === LOCAL_SOURCE ? "" : "")}
            count={s.online ? s.session_count : undefined}
          />
        ))}
      </div>

      {/* 项目标签 */}
      {projects.length > 0 && (
        <>
          <div className="px-4 pt-3 pb-1 text-[11px]" style={{ color: "#6b7280" }}>项目（当天）</div>
          <div className="px-2 pb-4">
            <SideItem
              active={activeProject === null}
              onClick={() => onSelectProject(null)}
              icon={<Hash size={13} />}
              label="全部项目"
            />
            {projects.map((p) => (
              <SideItem
                key={p.name}
                active={activeProject === p.name}
                onClick={() => onSelectProject(p.name)}
                icon={<Hash size={13} />}
                label={p.name}
                count={p.count}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const iconBtn: CSSProperties = {
  width: 28,
  height: 26,
  borderRadius: 7,
  color: "#9ca3af",
  background: "#232323",
  border: "1px solid #333",
  cursor: "pointer",
};

const navBtn: CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: 7,
  color: "#9ca3af",
  background: "#232323",
  border: "1px solid #333",
  cursor: "pointer",
};

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex-1 rounded-lg px-2 py-1.5 text-center" style={{ background: "#202020", border: "1px solid #2a2a2a" }}>
      <div className="text-base font-semibold tabular-nums" style={{ color: "#f3f4f6" }}>{value}</div>
      <div className="text-[10px]" style={{ color: "#8b9298" }}>{label}</div>
    </div>
  );
}

function SideItem({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 w-full text-left rounded-md px-2.5 py-1.5 text-xs"
      style={{
        color: active ? "#f9fafb" : "#cbd5e1",
        background: active ? "#2f6f4f" : "transparent",
        border: 0,
        cursor: "pointer",
      }}
    >
      <span className="shrink-0 inline-flex" style={{ color: active ? "#fff" : "#8b9298" }}>{icon}</span>
      <span className="truncate flex-1">{label}</span>
      {count !== undefined && <span className="shrink-0 tabular-nums" style={{ color: active ? "#d1fae5" : "#6b7280" }}>{count}</span>}
    </button>
  );
}
