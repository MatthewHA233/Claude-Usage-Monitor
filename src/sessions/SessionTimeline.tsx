import { useState } from "react";
import { ChevronUp, ChevronDown } from "lucide-react";
import type { TimelineRowWithSource } from "./types";
import { dayLabel, todayYmd } from "./format";
import { laneKey } from "./lanes";

const ROW_H = 12; // 每 10 分钟一行的像素高
const COL_W = 34; // 每轨道列宽（窄，容一排 5 点）
const TIME_W = 32; // 左侧时间刻度列宽
const pad2 = (n: number) => String(n).padStart(2, "0");

interface Props {
  date: string;
  rows: TimelineRowWithSource[];
  loading: boolean;
  laneOf: Record<string, number>;
  laneCount: number;
  labelsByLane: string[][];
  collapsed: boolean;
  onToggleCollapse: () => void;
}

type Tip = { x: number; y: number; big?: number; title: string; sub?: string; lines?: string[] } | null;

// 竖排迷你时间轴：纵向=时间(每 10 分钟一行)，横向=轨道列(会话, 与卡片同序同列)，列标头=「项目号-会话号」。
// 表头简化为编号，详情靠 hover 悬浮面板（含整点小时综合句数）。斑马 + 整点刻度 + 当前小时高亮，超左栏宽横滚。
export default function SessionTimeline({
  date,
  rows,
  loading,
  laneOf,
  laneCount,
  labelsByLane,
  collapsed,
  onToggleCollapse,
}: Props) {
  const [tip, setTip] = useState<Tip>(null);

  let minB = Infinity;
  let maxB = -Infinity;
  const cell: Record<number, Record<number, { n: number; row: TimelineRowWithSource }>> = {};
  const laneRows: Record<number, TimelineRowWithSource[]> = {};
  const hourTotals: Record<number, number> = {}; // 每小时全部会话综合句数
  for (const r of rows) {
    const lane = laneOf[laneKey(r.source_id, r.session_id)] ?? 0;
    (laneRows[lane] ??= []).push(r);
    for (const bk of r.buckets) {
      if (bk.b < minB) minB = bk.b;
      if (bk.b > maxB) maxB = bk.b;
      (cell[lane] ??= {})[bk.b] = { n: bk.n, row: r };
      const h = Math.floor(bk.b / 6);
      hourTotals[h] = (hourTotals[h] ?? 0) + bk.n;
    }
  }
  const hasData = rows.length > 0 && minB !== Infinity;
  const isToday = date === todayYmd();
  const nowHour = isToday ? new Date().getHours() : -1;
  const buckets: number[] = [];
  if (hasData) for (let b = minB; b <= maxB; b++) buckets.push(b);

  const seqLabel = (r: TimelineRowWithSource) =>
    r.project_seq != null && r.session_seq != null ? `${r.project_seq}-${r.session_seq}` : "—";
  // 悬浮面板统一显示在元素右侧、垂直居中，避免在窄左栏里溢出
  const showTip = (e: React.MouseEvent, t: Omit<NonNullable<Tip>, "x" | "y">) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setTip({ ...t, x: rect.right, y: (rect.top + rect.bottom) / 2 });
  };

  return (
    <div className="flex flex-col h-full" style={{ background: "#26262c", borderTop: "1px solid #34343c" }}>
      {/* 头部 */}
      <div className="flex items-center gap-2 px-3 py-2 shrink-0" style={{ borderBottom: "1px solid #34343c" }}>
        <button
          type="button"
          onClick={onToggleCollapse}
          title={collapsed ? "展开时间轴" : "收起时间轴"}
          className="inline-flex items-center justify-center"
          style={{ width: 22, height: 22, borderRadius: 6, color: "#cbd5e1", background: "#33333b", border: "1px solid #44444e", cursor: "pointer" }}
        >
          {collapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
        </button>
        <span className="text-xs font-semibold" style={{ color: "#f0f1f3" }}>{dayLabel(date)} 时间轴</span>
        <span className="text-[11px]" style={{ color: "#9098a3" }}>{rows.length} 会话</span>
      </div>

      {collapsed ? null : !hasData ? (
        <div className="flex items-center justify-center text-xs py-6" style={{ color: "#8b93a0" }}>
          {loading ? "加载中…" : "这一天没有发言"}
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto">
          <div style={{ width: TIME_W + laneCount * COL_W }}>
            {/* 列标头：轨道编号，sticky 顶；hover 出该列会话详情 */}
            <div className="flex sticky top-0" style={{ zIndex: 12 }}>
              <div className="shrink-0 sticky left-0" style={{ width: TIME_W, height: 24, background: "#33333b", zIndex: 13, borderBottom: "1px solid #3d3d46" }} />
              {Array.from({ length: laneCount }, (_, lane) => {
                const lr = laneRows[lane] ?? [];
                return (
                  <div
                    key={lane}
                    className="shrink-0 flex items-center justify-center font-mono truncate"
                    style={{ width: COL_W, height: 24, fontSize: 11, fontWeight: 600, color: "#eceef1", background: "#33333b", borderLeft: "1px solid #3d3d46", borderBottom: "1px solid #3d3d46" }}
                    onMouseEnter={(e) => {
                      if (!lr.length) return;
                      if (lr.length === 1) {
                        const r = lr[0];
                        showTip(e, { big: r.count, title: `${seqLabel(r)}  ${r.title || r.session_id.slice(0, 8)}`, sub: `${r.project_name || "—"} · ${r.source_label}` });
                      } else {
                        showTip(e, { title: `轨道 · ${lr.length} 个会话`, lines: lr.map((r) => `${seqLabel(r)}  ${r.title || r.session_id.slice(0, 8)} · ${r.count}句`) });
                      }
                    }}
                    onMouseLeave={() => setTip(null)}
                  >
                    {(labelsByLane[lane] ?? []).join(" ")}
                  </div>
                );
              })}
            </div>

            {/* 每 10 分钟一行：左时间刻度(整点明显居中, hover 出小时综合) + 各轨道密度点格 */}
            {buckets.map((b) => {
              const hour = Math.floor(b / 6);
              const isHourStart = b % 6 === 0;
              const isNow = hour === nowHour;
              return (
                <div key={b} className="flex" style={{ borderTop: isHourStart ? "1px solid #45454f" : undefined }}>
                  <div
                    className="shrink-0 sticky left-0 font-mono flex items-center justify-center"
                    style={{
                      width: TIME_W,
                      height: ROW_H,
                      fontSize: 12,
                      fontWeight: 700,
                      color: isNow ? "#9ec3e6" : "#d6dae0",
                      background: "#2c2c33",
                      zIndex: 1,
                      cursor: isHourStart && (hourTotals[hour] ?? 0) > 0 ? "default" : undefined,
                    }}
                    onMouseEnter={(e) => {
                      const tot = hourTotals[hour] ?? 0;
                      if (!tot) return;
                      showTip(e, { big: tot, title: `${pad2(hour)}:00–${pad2(hour)}:59`, sub: "全部会话综合" });
                    }}
                    onMouseLeave={() => setTip(null)}
                  >
                    {isHourStart ? pad2(hour) : ""}
                  </div>
                  {Array.from({ length: laneCount }, (_, lane) => {
                    const info = cell[lane]?.[b];
                    const n = info?.n ?? 0;
                    const dots = Math.min(5, n);
                    const bg = isNow
                      ? "rgba(96,165,250,0.14)"
                      : n > 0
                      ? "rgba(224,138,106,0.10)"
                      : b % 2 === 1
                      ? "rgba(255,255,255,0.028)"
                      : "transparent";
                    return (
                      <div
                        key={lane}
                        className="shrink-0 flex items-center justify-center"
                        style={{ width: COL_W, height: ROW_H, gap: 2, background: bg, borderLeft: `1px solid ${isNow ? "#3a5570" : "#34343c"}` }}
                        onMouseEnter={(e) => {
                          if (!info) return;
                          const r = info.row;
                          showTip(e, { big: info.n, title: `${seqLabel(r)}  ${r.title || r.session_id.slice(0, 8)}`, sub: `${pad2(hour)}:${pad2((b % 6) * 10)} · ${r.project_name || "—"} · ${r.source_label}` });
                        }}
                        onMouseLeave={() => setTip(null)}
                      >
                        {Array.from({ length: dots }).map((_, i) => (
                          <span key={i} style={{ width: 4.5, height: 4.5, borderRadius: "50%", background: "#ef9d77" }} />
                        ))}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 悬浮面板：显示在元素右侧、垂直居中，clamp 防溢出 */}
      {tip && !collapsed && (
        <div
          style={{
            position: "fixed",
            left: Math.min(tip.x + 8, window.innerWidth - 280),
            top: Math.min(Math.max(tip.y, 50), window.innerHeight - 70),
            transform: "translateY(-50%)",
            zIndex: 60,
            pointerEvents: "none",
            background: "#2b2c34",
            border: "1px solid #43444f",
            borderRadius: 9,
            boxShadow: "0 10px 28px rgba(0,0,0,0.55)",
            padding: "8px 13px",
            textAlign: "center",
            minWidth: 76,
            maxWidth: 260,
          }}
        >
          {tip.big != null && (
            <div style={{ fontSize: 21, fontWeight: 700, lineHeight: 1, color: "#ef9d77", fontFamily: "ui-monospace, monospace" }}>
              {tip.big}
              <span style={{ fontSize: 11, fontWeight: 500, color: "#cdd2d8", marginLeft: 3 }}>句</span>
            </div>
          )}
          <div style={{ fontSize: 11, color: "#e6e9ed", marginTop: tip.big != null ? 5 : 0, lineHeight: 1.4, letterSpacing: "0.2px", wordBreak: "break-word", fontWeight: 600 }}>
            {tip.title}
          </div>
          {tip.sub && <div style={{ fontSize: 9.5, color: "#a6adb8", marginTop: 3, wordBreak: "break-word" }}>{tip.sub}</div>}
          {tip.lines && (
            <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid #3d3e48", textAlign: "left" }}>
              {tip.lines.map((l, i) => (
                <div key={i} style={{ fontSize: 10, color: "#b6bcc6", marginTop: i ? 3 : 0, wordBreak: "break-word", lineHeight: 1.4 }}>
                  {l}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
