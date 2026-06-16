import { useEffect, useRef, useState } from "react";
import { FolderGit2, Monitor, ChevronUp, ChevronDown } from "lucide-react";
import type { CSSProperties } from "react";
import type { TimelineRowWithSource, StreamFilter } from "./types";
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
  activeFilter: StreamFilter | null;
  onToggleCollapse: () => void;
  /** 点击会话名(行) / 小时表头(列) / 单元格 → 过滤发言流 */
  onFilter: (filter: StreamFilter) => void;
}

function hourRange(date: string, hour: number): { since: number; until: number } {
  const [y, mo, d] = date.split("-").map(Number);
  const start = Math.floor(new Date(y, (mo || 1) - 1, d || 1, hour, 0, 0).getTime() / 1000);
  return { since: start, until: start + 3599 };
}

const pad2 = (n: number) => String(n).padStart(2, "0");

export default function SessionTimeline({ date, rows, loading, collapsed, activeFilter, onToggleCollapse, onFilter }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const selRowRef = useRef<HTMLDivElement>(null); // 高亮会话的那一行，切日期时纵向滚到它
  // 悬浮单元格 / 小时表头 / 会话名 时显示的统一美化浮层（替代原生 title 提示）
  const [tip, setTip] = useState<
    { cx: number; top: number; bottom: number; big: number; title: string; sub?: string; hint?: string } | null
  >(null);

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

  // 当前选中（表格表头式高亮）：会话(行) / 小时(列) / 单元格
  const selSession = activeFilter?.session ?? null;
  const selHour = activeFilter?.since != null ? new Date(activeFilter.since * 1000).getHours() : null;
  const cellMode = selSession != null && selHour != null;
  const rowMode = selSession != null && selHour == null;
  const colMode = selHour != null && selSession == null;

  // 切日期 / 切选中会话 时标记需重新定位（避免后台轮询时也乱滚）
  const needScrollRef = useRef(true);
  useEffect(() => {
    needScrollRef.current = true;
  }, [date, selSession]);

  // rows 到位后若有待定位标记：横向滚到最新小时 + 纵向滚到高亮会话那一行
  useEffect(() => {
    const c = scrollRef.current;
    if (collapsed || !c || !needScrollRef.current) return;
    needScrollRef.current = false;
    c.scrollLeft = c.scrollWidth;
    const row = selRowRef.current;
    if (row) {
      const headerH = 30; // sticky 小时表头高度
      c.scrollTop += row.getBoundingClientRect().top - c.getBoundingClientRect().top - headerH;
    }
  }, [rows, collapsed]);

  return (
    <div className="flex flex-col shrink-0" style={{ background: "#1a1a1a", borderBottom: "1px solid #2a2a2a" }}>
      {/* 头部：收起按钮 + 日期 + 提示 */}
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
        <span className="text-xs" style={{ color: "#7a8086" }}>
          {rows.length} 个会话 · 点会话名 / 小时表头 / 单元格 筛选
        </span>
      </div>

      {collapsed ? null : !hasData ? (
        <div className="flex items-center justify-center text-sm py-5" style={{ color: "#6b7280" }}>
          {loading ? "加载中…" : "这一天没有发言记录"}
        </div>
      ) : (
        <div ref={scrollRef} style={{ maxHeight: 240, overflow: "auto" }}>
          <div style={{ width: LABEL_W + stripWidth, minWidth: "100%" }}>
            {/* 小时表头（可点击，居中加大；点击筛该小时全部会话） */}
            <div className="flex sticky top-0 z-10" style={{ background: "#1a1a1a", borderBottom: "1px solid #2a2a2a" }}>
              <div className="shrink-0" style={{ width: LABEL_W, position: "sticky", left: 0, zIndex: 11, background: "#202024", ...FREEZE }} />
              <div className="flex" style={{ width: stripWidth }}>
                {hours.map((h) => {
                  const sel = selHour === h;
                  const isNow = h === nowHour;
                  const total = hourTotals.get(h) || 0;
                  const { since, until } = hourRange(date, h);
                  return (
                    <button
                      key={h}
                      type="button"
                      disabled={total === 0}
                      onClick={() => onFilter({ since, until, label: `${date} ${pad2(h)}:00–${pad2(h)}:59 · 全部会话` })}
                      onMouseEnter={(e) => {
                        if (total === 0) return;
                        const rect = e.currentTarget.getBoundingClientRect();
                        setTip({
                          cx: rect.left + rect.width / 2,
                          top: rect.top,
                          bottom: rect.bottom,
                          big: total,
                          title: `${pad2(h)}:00–${pad2(h)}:59 · 全部会话`,
                          hint: "点击筛这一小时全部会话",
                        });
                      }}
                      onMouseLeave={() => setTip(null)}
                      className="tl-hour flex items-center justify-center font-mono"
                      style={{
                        width: HOUR_W,
                        height: 28,
                        fontSize: 13,
                        borderTop: 0,
                        borderRight: 0,
                        borderBottom: 0,
                        borderLeft: `2px solid ${isNow ? "#3b6ea5" : "#4a4a4a"}`,
                        background: sel ? "rgba(167,139,250,0.28)" : isNow ? "rgba(96,165,250,0.18)" : "transparent",
                        color: sel ? "#c4b5fd" : isNow ? "#8fb3d3" : total > 0 ? "#c7ccd1" : "#6b7280",
                        cursor: total > 0 ? "pointer" : "default",
                      }}
                    >
                      {pad2(h)}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 会话行 */}
            {rows.map((r) => {
              const bmap = new Map(r.buckets.map((x) => [x.b, x.n]));
              const rowSel = selSession === r.session_id;
              return (
                <div ref={rowSel ? selRowRef : undefined} key={`${r.source_id}:${r.session_id}`} className="flex items-stretch" style={{ borderBottom: "1px solid #242424" }}>
                  {/* 会话名(行头) → 过滤整个会话；选中高亮整行 */}
                  <button
                    type="button"
                    onClick={() => onFilter({ source: r.source_id, session: r.session_id, label: r.title })}
                    onMouseEnter={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      setTip({
                        cx: rect.left + rect.width / 2,
                        top: rect.top,
                        bottom: rect.bottom,
                        big: r.count,
                        title: r.title,
                        sub: `${r.project_name || "—"} · ${r.source_label}`,
                        hint: "点击只看该会话",
                      });
                    }}
                    onMouseLeave={() => setTip(null)}
                    className="shrink-0 px-3 py-2 text-left tl-label"
                    style={{
                      width: LABEL_W,
                      cursor: "pointer",
                      background: rowSel ? "#262338" : "#202024",
                      borderTop: 0,
                      borderBottom: 0,
                      borderLeft: 0,
                      borderRight: "1px solid #303030",
                      boxShadow: rowSel
                        ? "3px 0 6px rgba(0,0,0,0.3), inset 4px 0 0 #a78bfa"
                        : "3px 0 6px rgba(0,0,0,0.3)",
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
                  </button>

                  {/* 小时单元格 → 过滤该会话那一小时；行/列/单元格高亮 */}
                  <div className="flex" style={{ width: stripWidth }}>
                    {hours.map((h) => {
                      const hourCount = [0, 1, 2, 3, 4, 5].reduce((s, i) => s + (bmap.get(h * 6 + i) || 0), 0);
                      const { since, until } = hourRange(date, h);
                      const cellSel = rowSel && selHour === h;
                      const isNow = h === nowHour;
                      const highlighted = cellMode ? cellSel : rowMode ? rowSel : colMode ? selHour === h : false;
                      const bg = highlighted
                        ? cellSel
                          ? "rgba(167,139,250,0.38)"
                          : "rgba(167,139,250,0.18)"
                        : isNow
                        ? "rgba(96,165,250,0.13)"
                        : hourCount > 0
                        ? "rgba(224,138,106,0.12)"
                        : h % 2 === 0
                        ? "transparent"
                        : "rgba(0,0,0,0.1)";
                      return (
                        <button
                          key={h}
                          type="button"
                          disabled={hourCount === 0}
                          onClick={() =>
                            onFilter({ source: r.source_id, session: r.session_id, since, until, label: `${r.title} · ${date} ${pad2(h)}时` })
                          }
                          onMouseEnter={(e) => {
                            if (hourCount === 0) return;
                            const rect = e.currentTarget.getBoundingClientRect();
                            setTip({
                              cx: rect.left + rect.width / 2,
                              top: rect.top,
                              bottom: rect.bottom,
                              big: hourCount,
                              title: `${pad2(h)}:00–${pad2(h)}:59`,
                              hint: "点击只看该会话这一小时",
                            });
                          }}
                          onMouseLeave={() => setTip(null)}
                          className="flex items-center tl-hour"
                          style={{
                            width: HOUR_W,
                            height: 40,
                            background: bg,
                            borderTop: 0,
                            borderRight: 0,
                            borderBottom: 0,
                            borderLeft: `2px solid ${isNow ? "#3b6ea5" : "#4a4a4a"}`,
                            cursor: hourCount > 0 ? "pointer" : "default",
                          }}
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
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {tip && !collapsed && (
        <div
          style={{
            position: "fixed",
            left: tip.cx,
            top: tip.top > 84 ? tip.top - 8 : tip.bottom + 8,
            transform: tip.top > 84 ? "translate(-50%, -100%)" : "translate(-50%, 0)",
            zIndex: 60,
            pointerEvents: "none",
            background: "#22232b",
            border: "1px solid #3a3b46",
            borderRadius: 10,
            boxShadow: "0 10px 28px rgba(0,0,0,0.55)",
            padding: "10px 18px",
            textAlign: "center",
            minWidth: 86,
            maxWidth: 280,
          }}
        >
          <div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1, color: "#e08a6a", fontFamily: "ui-monospace, monospace" }}>
            {tip.big}
            <span style={{ fontSize: 13, fontWeight: 500, color: "#c7ccd1", marginLeft: 3 }}>句</span>
          </div>
          <div
            style={{ fontSize: 11.5, color: "#d3d7dc", marginTop: 6, lineHeight: 1.4, letterSpacing: "0.3px", wordBreak: "break-word" }}
          >
            {tip.title}
          </div>
          {tip.sub && (
            <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 3, wordBreak: "break-word" }}>{tip.sub}</div>
          )}
          {tip.hint && (
            <div
              style={{
                fontSize: 10,
                color: "#8fb3d3",
                marginTop: 7,
                paddingTop: 6,
                borderTop: "1px solid #34353f",
                letterSpacing: "0.3px",
              }}
            >
              {tip.hint}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
