import type { CSSProperties } from "react";
import { ChevronLeft, ChevronRight, FolderGit2, Monitor } from "lucide-react";
import type { TimelineRowWithSource, StreamFilter } from "./types";
import { dayLabel } from "./format";

const CELL = 10; // 每 10 分钟一格的像素宽
const HOUR_W = CELL * 6; // 一小时 = 6 个 10 分钟格

interface Props {
  date: string;
  rows: TimelineRowWithSource[];
  loading: boolean;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  /** 点击会话行 / 小时单元格 → 过滤发言流 */
  onFilter: (filter: StreamFilter) => void;
}

const navBtn: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 7,
  color: "#9ca3af",
  background: "#232323",
  border: "1px solid #333",
  cursor: "pointer",
};

/** 某本地日期某小时的 unix 区间 [整点, 整点+3599] */
function hourRange(date: string, hour: number): { since: number; until: number } {
  const [y, mo, d] = date.split("-").map(Number);
  const start = Math.floor(new Date(y, (mo || 1) - 1, d || 1, hour, 0, 0).getTime() / 1000);
  return { since: start, until: start + 3599 };
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 会话时间轴：作为发言流的过滤器。一行=一个会话，横轴按小时。
 *  点会话名 → 过滤到该会话；点某个小时格 → 过滤到该会话的那一小时。 */
export default function SessionTimeline({ date, rows, loading, onPrev, onNext, onToday, onFilter }: Props) {
  let minB = Infinity;
  let maxB = -Infinity;
  for (const r of rows) {
    for (const bk of r.buckets) {
      if (bk.b < minB) minB = bk.b;
      if (bk.b > maxB) maxB = bk.b;
    }
  }
  const hasData = rows.length > 0 && minB !== Infinity;
  const startHour = hasData ? Math.floor(minB / 6) : 0;
  const endHour = hasData ? Math.floor(maxB / 6) : 0;
  const hours: number[] = [];
  for (let h = startHour; h <= endHour; h++) hours.push(h);
  const stripWidth = hours.length * HOUR_W;

  return (
    <div className="flex flex-col h-full">
      {/* 日期切换 */}
      <div className="flex items-center gap-2 px-4 py-2 shrink-0" style={{ borderBottom: "1px solid #232323" }}>
        <button type="button" onClick={onPrev} title="前一天" className="inline-flex items-center justify-center" style={navBtn}>
          <ChevronLeft size={15} />
        </button>
        <span className="text-sm font-semibold" style={{ color: "#f3f4f6", minWidth: 92, textAlign: "center" }}>
          {dayLabel(date)}
        </span>
        <button type="button" onClick={onNext} title="后一天" className="inline-flex items-center justify-center" style={navBtn}>
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
        <span className="text-xs ml-2" style={{ color: "#6b7280" }}>
          {rows.length} 个会话 · 点会话名筛该会话 · 点小时格筛那一小时
        </span>
      </div>

      {!hasData ? (
        <div className="flex-1 flex items-center justify-center text-sm" style={{ color: "#6b7280" }}>
          {loading ? "加载中…" : "这一天没有发言记录"}
        </div>
      ) : (
        <div className="flex-1 overflow-auto">
          <div style={{ width: 220 + stripWidth, minWidth: "100%" }}>
            {/* 小时刻度 */}
            <div className="flex items-end sticky top-0 z-10" style={{ background: "#181818", borderBottom: "1px solid #232323" }}>
              <div className="shrink-0" style={{ width: 220 }} />
              <div className="flex" style={{ width: stripWidth }}>
                {hours.map((h) => (
                  <div key={h} style={{ width: HOUR_W, height: 22, borderLeft: "1px solid #333", position: "relative" }}>
                    <span className="text-[9px] font-mono absolute" style={{ color: "#6b7280", left: 2, bottom: 2 }}>
                      {pad2(h)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* 会话行 */}
            {rows.map((r) => {
              const bmap = new Map(r.buckets.map((x) => [x.b, x.n]));
              const maxN = Math.max(1, ...r.buckets.map((x) => x.n));
              return (
                <div key={`${r.source_id}:${r.session_id}`} className="flex items-stretch" style={{ borderBottom: "1px solid #202020" }}>
                  {/* 会话名 → 过滤整个会话 */}
                  <button
                    type="button"
                    onClick={() => onFilter({ source: r.source_id, session: r.session_id, label: r.title })}
                    title={`${r.title} · ${r.count} 句（点击只看该会话）`}
                    className="shrink-0 px-3 py-2 text-left tl-hour"
                    style={{ width: 220, cursor: "pointer", background: "transparent", border: 0 }}
                  >
                    <div className="text-[12px] font-medium truncate" style={{ color: "#e5e7eb" }}>{r.title}</div>
                    <div className="flex items-center gap-2 mt-0.5 text-[10px]" style={{ color: "#8b9298" }}>
                      <span className="inline-flex items-center gap-0.5 truncate min-w-0">
                        <FolderGit2 size={9} /> {r.project_name || "—"}
                      </span>
                      <span className="inline-flex items-center gap-0.5 shrink-0">
                        <Monitor size={9} /> {r.source_label}
                      </span>
                    </div>
                  </button>

                  {/* 小时格 → 过滤该会话的那一小时 */}
                  <div className="flex" style={{ width: stripWidth }}>
                    {hours.map((h) => {
                      const hourCount = [0, 1, 2, 3, 4, 5].reduce((s, i) => s + (bmap.get(h * 6 + i) || 0), 0);
                      const { since, until } = hourRange(date, h);
                      return (
                        <button
                          key={h}
                          type="button"
                          disabled={hourCount === 0}
                          onClick={() =>
                            onFilter({
                              source: r.source_id,
                              session: r.session_id,
                              since,
                              until,
                              label: `${r.title} · ${date} ${pad2(h)}时`,
                            })
                          }
                          title={hourCount > 0 ? `${pad2(h)}:00–${pad2(h)}:59 · ${hourCount} 句（点击筛这一小时）` : undefined}
                          className="flex items-center tl-hour"
                          style={{
                            width: HOUR_W,
                            height: 38,
                            borderLeft: "1px solid #222",
                            background: "transparent",
                            border: 0,
                            cursor: hourCount > 0 ? "pointer" : "default",
                          }}
                        >
                          {[0, 1, 2, 3, 4, 5].map((i) => {
                            const n = bmap.get(h * 6 + i) || 0;
                            const size = n > 0 ? 6 + Math.min(4, (n / maxN) * 4) : 0;
                            return (
                              <span key={i} className="flex items-center justify-center" style={{ width: CELL, height: "100%" }}>
                                {n > 0 && (
                                  <span
                                    style={{
                                      width: size,
                                      height: size,
                                      borderRadius: "50%",
                                      background: "#cc785c",
                                      opacity: 0.45 + 0.55 * (n / maxN),
                                    }}
                                  />
                                )}
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
    </div>
  );
}
