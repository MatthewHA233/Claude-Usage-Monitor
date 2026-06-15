import type { ReactNode } from "react";
import { Plus, RefreshCw, Trash2, Wifi, WifiOff, MessagesSquare, CalendarRange } from "lucide-react";
import type { SourceStatus } from "./types";

export type SessionView = "stream" | "timeline";

const LOCAL_SOURCE = "local";

interface Props {
  sourceStatuses: SourceStatus[];
  activeSourceId: string | null;
  view: SessionView;
  refreshing: boolean;
  onChangeView: (v: SessionView) => void;
  onSelectSource: (id: string | null) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onRefresh: () => void;
}

export default function SourceBar({
  sourceStatuses,
  activeSourceId,
  view,
  refreshing,
  onChangeView,
  onSelectSource,
  onAdd,
  onRemove,
  onRefresh,
}: Props) {
  return (
    <div
      className="flex items-center gap-2 px-4 py-2.5 shrink-0 flex-wrap"
      style={{ borderBottom: "1px solid #2a2a2a", background: "#1c1c1c" }}
      data-tauri-drag-region
    >
      {/* 视图切换：我的发言 / 会话时间轴 */}
      <div className="flex items-center gap-1 mr-1" style={{ background: "#202020", border: "1px solid #333", borderRadius: 8, padding: 3 }}>
        <ViewTab active={view === "stream"} onClick={() => onChangeView("stream")} icon={<MessagesSquare size={13} />} label="我的发言" />
        <ViewTab active={view === "timeline"} onClick={() => onChangeView("timeline")} icon={<CalendarRange size={13} />} label="会话时间轴" />
      </div>

      <button
        type="button"
        onClick={() => onSelectSource(null)}
        className="text-xs px-2.5 py-1 rounded-md"
        style={{
          color: activeSourceId === null ? "#f9fafb" : "#9ca3af",
          background: activeSourceId === null ? "#343434" : "transparent",
          border: "1px solid #333",
          cursor: "pointer",
        }}
      >
        全部
      </button>

      {sourceStatuses.map((s) => {
        const active = activeSourceId === s.id;
        const isLocal = s.id === LOCAL_SOURCE;
        return (
          <div
            key={s.id}
            className="group flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md"
            style={{
              color: active ? "#f9fafb" : "#cbd5e1",
              background: active ? "#343434" : "#232323",
              border: `1px solid ${s.online ? "#2f5f3a" : "#4a2a2a"}`,
              cursor: "pointer",
            }}
            onClick={() => onSelectSource(s.id)}
            title={
              s.online
                ? `${s.hostname || s.label} · ${s.session_count} 会话 · ${s.project_count} 项目`
                : "离线 / 连接失败"
            }
          >
            {s.online ? (
              <Wifi size={12} style={{ color: "#4ade80" }} />
            ) : (
              <WifiOff size={12} style={{ color: "#f87171" }} />
            )}
            <span className="font-medium">{s.label}</span>
            {s.online && <span style={{ color: "#6b7280" }}>· {s.session_count}</span>}
            {!isLocal && (
              <button
                type="button"
                title="移除来源"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(s.id);
                }}
                className="opacity-0 group-hover:opacity-100"
                style={{ color: "#9ca3af", background: "transparent", border: 0, cursor: "pointer", lineHeight: 0 }}
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        );
      })}

      <button
        type="button"
        onClick={onAdd}
        className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-md"
        style={{ color: "#9ca3af", background: "#232323", border: "1px dashed #3a3a3a", cursor: "pointer" }}
      >
        <Plus size={12} /> 添加远程
      </button>

      <div className="flex-1" />

      <button
        type="button"
        title="刷新"
        onClick={onRefresh}
        className="inline-flex items-center justify-center"
        style={{ width: 30, height: 28, borderRadius: 7, color: "#9ca3af", background: "#232323", border: "1px solid #333", cursor: "pointer" }}
      >
        <RefreshCw size={14} className={refreshing ? "animate-spin" : undefined} />
      </button>
    </div>
  );
}

function ViewTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md transition-colors"
      style={{
        color: active ? "#f9fafb" : "#9ca3af",
        background: active ? "#cc785c" : "transparent",
        border: 0,
        cursor: "pointer",
        fontWeight: active ? 600 : 400,
      }}
    >
      {icon}
      {label}
    </button>
  );
}
