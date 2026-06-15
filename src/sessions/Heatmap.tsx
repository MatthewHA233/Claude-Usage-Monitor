import { useEffect, useRef } from "react";
import type { DailyStat } from "./types";
import { ymdLocal, todayYmd } from "./format";

const DEFAULT_WEEKS = 16; // 至少展示约 4 个月
const CELL = 12;
const GAP = 2; // 同月内列间距
const MONTH_GAP = 6; // 月份组之间的间距

// 0..4 档绿色（仿 flomo/GitHub）；最亮(档 4)= 100 句及以上
const COLORS = ["#1f1f1f", "#173a24", "#1f6b38", "#2f9e54", "#48c66b"];

function level(count: number): number {
  if (count <= 0) return 0;
  if (count < 25) return 1;
  if (count < 50) return 2;
  if (count < 100) return 3;
  return 4;
}

interface Cell {
  ymd: string;
  future: boolean;
}

interface Props {
  days: DailyStat[];
  selectedDate: string;
  onSelect: (ymd: string) => void;
}

function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/** 每天发言数的热力图：列=周(竖着 7 天)，按月分组。
 *  区间从「最早有发言的那天」到今天，横向可滚动、默认停在最新；向左看更早。 */
export default function Heatmap({ days, selectedDate, onSelect }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolledRef = useRef(false);

  const counts = new Map<string, number>();
  let minDate = todayYmd();
  for (const d of days) {
    counts.set(d.date, d.count);
    if (d.date < minDate) minDate = d.date;
  }
  const todayStr = todayYmd();

  // 起点 = min(最早有发言那天, 今天往前 DEFAULT_WEEKS 周)，再回退到所在周的周日
  const defaultStart = new Date();
  defaultStart.setHours(0, 0, 0, 0);
  defaultStart.setDate(defaultStart.getDate() - (DEFAULT_WEEKS * 7 - 1));
  const earliest = parseYmd(minDate);
  const start = earliest < defaultStart ? earliest : defaultStart;
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay());

  // 从 start 逐周生成到今天，按周日所在月份分组
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const groups: { month: number; cols: Cell[][] }[] = [];
  const cur = new Date(start);
  while (cur <= today) {
    const month = cur.getMonth();
    const col: Cell[] = [];
    for (let r = 0; r < 7; r++) {
      const ymd = ymdLocal(cur);
      col.push({ ymd, future: ymd > todayStr });
      cur.setDate(cur.getDate() + 1);
    }
    const last = groups[groups.length - 1];
    if (last && last.month === month) last.cols.push(col);
    else groups.push({ month, cols: [col] });
  }

  // 数据首次到位时滚到最右（最新），只做一次，之后尊重用户滚动位置
  useEffect(() => {
    if (!scrolledRef.current && scrollRef.current && days.length > 0) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
      scrolledRef.current = true;
    }
  }, [days.length]);

  return (
    <div ref={scrollRef} className="heatmap-scroll" style={{ display: "flex", gap: MONTH_GAP }}>
      {groups.map((g, gi) => (
        <div key={gi} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <div style={{ fontSize: 9, color: "#9ca3af", fontFamily: "monospace", height: 11, lineHeight: "11px" }}>
            {g.month + 1}月
          </div>
          <div style={{ display: "flex", gap: GAP }}>
            {g.cols.map((col, ci) => (
              <div key={ci} style={{ display: "flex", flexDirection: "column", gap: GAP }}>
                {col.map((cell) =>
                  cell.future ? (
                    <div key={cell.ymd} style={{ width: CELL, height: CELL }} />
                  ) : (
                    <button
                      key={cell.ymd}
                      type="button"
                      title={`${(counts.get(cell.ymd) || 0) > 0 ? `${counts.get(cell.ymd)} 句` : "无发言"} · ${cell.ymd}`}
                      onClick={() => onSelect(cell.ymd)}
                      style={{
                        width: CELL,
                        height: CELL,
                        borderRadius: 2,
                        background: COLORS[level(counts.get(cell.ymd) || 0)],
                        border: cell.ymd === selectedDate ? "1.5px solid #f0b59e" : "1px solid transparent",
                        cursor: "pointer",
                        padding: 0,
                        flexShrink: 0,
                      }}
                    />
                  )
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
