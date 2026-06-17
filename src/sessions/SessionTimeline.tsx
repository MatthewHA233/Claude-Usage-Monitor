import { useEffect, useRef } from "react";
import { FolderGit2, Monitor, ChevronUp, ChevronDown } from "lucide-react";
import type { CSSProperties } from "react";
import type { TimelineRowWithSource } from "./types";
import { dayLabel, todayYmd } from "./format";

const CELL = 10; // 每 10 分钟一格的像素宽
const HOUR_W = CELL * 6; // 一小时 = 6 个 10 分钟格
const LABEL_W = 220;
// 冻结标题列的右分隔（仿 Notion）
const FREEZE: CSSProperties = { borderRight: "1px solid #303030", boxShadow: "3px 0 6px rgba(0,0,0,0.3)" };

interface Props {
  date: string;
  rows: TimelineRowWithSource[];
  loading: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

// 纯展示时间轴（筛选已撤）：行=会话、列=小时、单元格=10 分钟点阵。Step B 将改为左栏竖排。
export default function SessionTimeline({ date, rows, loading, collapsed, onToggleCollapse }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  let minB = Infinity;
  let maxB = -Infinity;
  const hourTotals = new Map<number, number>();
  for (const r of rows) {
    for (const bk of r.buckets) {
      if (bk.b < minB) minB = bk.b;
      if (bk.b > maxB) maxB = bk.b;
      const h = Math.floor(bk.b / 6);
      hourTotals.set(h, (hourTotals.get(h) || 0) + bk.n);
    }
  }
  const hasData = rows.length > 0 && minB !== Infinity;
  const isToday = date === todayYmd();
  const nowHour = isToday ? new Date().getHours() : -1;
  const startHour = hasData ? Math.floor(minB / 6) : 0;
  let endHour = hasData ? Math.floor(maxB / 6) : 0;
  if (isToday && nowHour > endHour) endHour = nowHour; // 含当前小时（即便还没数据）
  const hours: number[] = [];
  for (let h = startHour; h <= endHour; h++) hours.push(h);
  const stripWidth = hours.length * HOUR_W;

  // 切日期后横向滚到最新小时
  const needScrollRef = useRef(true);
  useEffect(() => {
    needScrollRef.current = true;
  }, [date]);
  useEffect(() => {
    const c = scrollRef.current;
    if (collapsed || !c || !needScrollRef.current) return;
    needScrollRef.current = false;
    c.scrollLeft = c.scrollWidth;
  }, [rows, collapsed]);

  return (
    <div className="flex flex-col shrink-0" style={{ background: "#1a1a1a", borderBottom: "1px solid #2a2a2a" }}>
      {/* 头部 */}
      <div className="flex items-center gap-2 px-3 py-2 shrink-0" style={{ borderBottom: "1px solid #242424" }}>
        <button
          type="button"
          onClick={onToggleCollapse}
          title={collapsed ? "展开时间轴" : "收起时间轴"}
          className="inline-flex items-center justify-center"
          style={{ width: 24, height: 24, borderRadius: 6, color: "#9ca3af", background: "#232323", border: "1px solid #333", cursor: "pointer" }}
        >
          {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
        <span className="text-sm font-semibold" style={{ color: "#f3f4f6" }}>{dayLabel(date)} 时间轴</span>
        <span className="text-xs" style={{ color: "#7a8086" }}>{rows.length} 个会话</span>
      </div>

      {collapsed ? null : !hasData ? (
        <div className="flex items-center justify-center text-sm py-5" style={{ color: "#6b7280" }}>
          {loading ? "加载中…" : "这一天没有发言记录"}
        </div>
      ) : (
        <div ref={scrollRef} style={{ maxHeight: 240, overflow: "auto" }}>
          <div style={{ width: LABEL_W + stripWidth, minWidth: "100%" }}>
            {/* 小时表头 */}
            <div className="flex sticky top-0 z-10" style={{ background: "#1a1a1a", borderBottom: "1px solid #2a2a2a" }}>
              <div className="shrink-0" style={{ width: LABEL_W, position: "sticky", left: 0, zIndex: 11, background: "#202024", ...FREEZE }} />
              <div className="flex" style={{ width: stripWidth }}>
                {hours.map((h) => {
                  const isNow = h === nowHour;
                  const total = hourTotals.get(h) || 0;
                  return (
                    <div
                      key={h}
                      className="flex items-center justify-center font-mono"
                      style={{
                        width: HOUR_W,
                        height: 28,
                        fontSize: 13,
                        borderLeft: `2px solid ${isNow ? "#3b6ea5" : "#4a4a4a"}`,
                        background: isNow ? "rgba(96,165,250,0.18)" : "transparent",
                        color: isNow ? "#8fb3d3" : total > 0 ? "#c7ccd1" : "#6b7280",
                      }}
                    >
                      {pad2(h)}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 会话行 */}
            {rows.map((r) => {
              const bmap = new Map(r.buckets.map((x) => [x.b, x.n]));
              return (
                <div key={`${r.source_id}:${r.session_id}`} className="flex items-stretch" style={{ borderBottom: "1px solid #242424" }}>
                  {/* 会话名(行头) */}
                  <div
                    className="shrink-0 px-3 py-2 text-left"
                    style={{
                      width: LABEL_W,
                      background: "#202024",
                      borderRight: "1px solid #303030",
                      boxShadow: "3px 0 6px rgba(0,0,0,0.3)",
                      position: "sticky",
                      left: 0,
                      zIndex: 2,
                    }}
                  >
                    <div className="text-[12px] font-medium truncate" style={{ color: "#e5e7eb" }}>{r.title}</div>
                    <div className="flex items-center gap-2 mt-0.5 text-[10px]" style={{ color: "#8b9298" }}>
                      <span className="inline-flex items-center gap-0.5 shrink-0 whitespace-nowrap">
                        <FolderGit2 size={9} className="shrink-0" /> {r.project_name || "—"}
                      </span>
                      <span className="inline-flex items-center gap-0.5 truncate min-w-0">
                        <Monitor size={9} className="shrink-0" /> <span className="truncate">{r.source_label}</span>
                      </span>
                    </div>
                  </div>

                  {/* 小时单元格 */}
                  <div className="flex" style={{ width: stripWidth }}>
                    {hours.map((h) => {
                      const hourCount = [0, 1, 2, 3, 4, 5].reduce((s, i) => s + (bmap.get(h * 6 + i) || 0), 0);
                      const isNow = h === nowHour;
                      const bg = isNow
                        ? "rgba(96,165,250,0.13)"
                        : hourCount > 0
                        ? "rgba(224,138,106,0.12)"
                        : h % 2 === 0
                        ? "transparent"
                        : "rgba(0,0,0,0.1)";
                      return (
                        <div
                          key={h}
                          className="flex items-center"
                          style={{ width: HOUR_W, height: 40, background: bg, borderLeft: `2px solid ${isNow ? "#3b6ea5" : "#4a4a4a"}` }}
                        >
                          {[0, 1, 2, 3, 4, 5].map((i) => {
                            const sub = h * 6 + i;
                            const n = bmap.get(sub) || 0;
                            const dots = Math.min(5, n); // 该 10 分钟内的句数，最多叠 5 个
                            return (
                              <span
                                key={i}
                                className="flex flex-col items-center justify-center"
                                style={{ width: CELL, height: "100%", gap: 1.5, background: sub % 2 === 0 ? "transparent" : "rgba(0,0,0,0.28)" }}
                              >
                                {Array.from({ length: dots }).map((_, di) => (
                                  <span key={di} style={{ width: 5, height: 5, borderRadius: "50%", background: "#e08a6a" }} />
                                ))}
                              </span>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
