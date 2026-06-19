import { type CSSProperties } from "react";
import { Wifi, WifiOff, RefreshCw, ChevronLeft, ChevronRight, PanelLeftClose, ListTodo } from "lucide-react";
import type { DailyStat } from "./types";
import { nfmt } from "./format";
import Heatmap from "./Heatmap";

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
  /** 有任何别的机器离线 → 网络按钮显示红色断开 */
  networkOffline: boolean;
  /** 打开「连接管理」面板（跨机器状态/列表/新建/重命名） */
  onOpenNetwork: () => void;
  onRefresh: () => void;
  onToggleCollapse: () => void;
  refreshing: boolean;
  syncing: boolean;
  /** 「预备发言」待办数（徽章） */
  draftCount?: number;
  /** 「预备发言」面板是否展开（高亮按钮） */
  draftOpen?: boolean;
  /** 开/收「预备发言」面板 */
  onToggleDrafts?: () => void;
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
  networkOffline,
  onOpenNetwork,
  onRefresh,
  onToggleCollapse,
  refreshing,
  syncing,
  draftCount = 0,
  draftOpen = false,
  onToggleDrafts,
}: Props) {
  return (
    <div className="shrink-0 flex flex-col" data-tauri-drag-region>
      {/* 标题 + 操作 */}
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold" style={{ color: "#f3f4f6" }}>会话发言</span>
          {syncing && <span className="text-[10px] animate-pulse" style={{ color: "#8b9298" }}>初始化中…</span>}
        </div>
        <div className="flex items-center gap-1">
          {/* 预备发言入口（受控展开，面板悬浮于右上） */}
          <button
            type="button"
            data-draft-trigger
            title="预备发言：提前写好未来要发给 Claude 的话"
            onClick={onToggleDrafts}
            className="inline-flex items-center justify-center gap-1"
            style={{
              height: 26,
              width: draftCount > 0 ? undefined : 28,
              padding: draftCount > 0 ? "0 7px" : 0,
              borderRadius: 7,
              color: draftOpen ? "#06131a" : "#5fd3e0",
              background: draftOpen ? "#5fd3e0" : "rgba(95,211,224,0.10)",
              border: `1px solid ${draftOpen ? "#5fd3e0" : "rgba(95,211,224,0.34)"}`,
              cursor: "pointer",
            }}
          >
            <ListTodo size={14} />
            {draftCount > 0 && (
              <span className="tabular-nums" style={{ fontSize: 10.5, fontWeight: 700, lineHeight: 1 }}>{draftCount}</span>
            )}
          </button>
          <button
            type="button"
            title={networkOffline ? "连接管理（有机器离线）" : "连接管理（跨机器）"}
            onClick={onOpenNetwork}
            className="inline-flex items-center justify-center"
            style={iconBtn}
          >
            {networkOffline ? <WifiOff size={14} style={{ color: "#f87171" }} /> : <Wifi size={14} style={{ color: "#4ade80" }} />}
          </button>
          <button type="button" title="刷新" onClick={onRefresh} className="inline-flex items-center justify-center" style={iconBtn}>
            <RefreshCw size={13} className={refreshing ? "animate-spin" : undefined} />
          </button>
          <button type="button" title="收起侧栏" onClick={onToggleCollapse} className="inline-flex items-center justify-center" style={iconBtn}>
            <PanelLeftClose size={14} />
          </button>
        </div>
      </div>

      {/* 统计：句数 / 会话 = 当天 / 总计；天数为单值 */}
      <div className="flex items-stretch gap-2 px-4 pb-3">
        <Stat today={nfmt(daySentences)} value={nfmt(totalCount)} label="句数" />
        <Stat today={nfmt(daySessions)} value={nfmt(sessionCount)} label="会话" />
        <Stat value={nfmt(dayCount)} label="天数" />
      </div>

      {/* 热力图 */}
      <div className="px-4 pb-2">
        <Heatmap days={days} sessionDays={sessionDays} selectedDate={selectedDate} onSelect={onSelectDate} />
      </div>

      {/* 选中日期切换 */}
      <div className="px-4 pb-3">
        <div className="flex items-center gap-1.5">
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
      </div>
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

// 句数/会话：当天数(亮) / 总计(暗)；天数：单值
function Stat({ value, today, label }: { value: string; today?: string; label: string }) {
  return (
    <div className="flex-1 rounded-lg px-2 py-1.5 text-center" style={{ background: "#202020", border: "1px solid #2a2a2a" }}>
      <div className="text-base font-semibold tabular-nums" style={{ color: "#f3f4f6" }}>
        {today !== undefined ? (
          <>
            <span>{today}</span>
            <span style={{ color: "#6b7280", fontSize: 12, fontWeight: 500 }}>/{value}</span>
          </>
        ) : (
          value
        )}
      </div>
      <div className="text-[10px]" style={{ color: "#8b9298" }}>{label}</div>
    </div>
  );
}
