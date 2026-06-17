import { useState, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import type { TimelineRowWithSource } from "./types";
import { dayLabel, todayYmd } from "./format";
import { laneKey, assignLanesPacked } from "./lanes";

const ROW_H = 14; // 单行点阵的行高
const ROW_H2 = 26; // 双行点阵(某格 >5 条)的行高
const COL_W = 35; // 每轨道列宽
const HOUR_W = 30; // 小时列宽（合并单元格）
const MIN_W = 24; // 分钟列宽
const TIME_W = HOUR_W + MIN_W;
// 插队会话色（Notion 标签风：柔和中明度实心色，标签填充 + 白字），按同轨插队顺序循环
const PALETTE = ["#6b5b9a", "#3f8290", "#4f8b60", "#8c7440", "#96587a", "#4e6f9c"];
const pad2 = (n: number) => String(n).padStart(2, "0");

interface Props {
  date: string;
  rows: TimelineRowWithSource[];
  loading: boolean;
}

type Tip = { x: number; y: number; big?: number; title: string; sub?: string; lines?: string[] } | null;

// 密度点阵：≤5 单行；6–10 双行折半(第一行 ceil、第二行 floor)。横向间距放宽，不挤。
function DotCell({ n }: { n: number }) {
  const shown = Math.min(10, n);
  if (shown === 0) return null;
  const dot = (k: number) => <span key={k} style={{ width: 4.5, height: 4.5, borderRadius: "50%", background: "#ef9d77" }} />;
  if (shown <= 5) {
    return (
      <div className="flex items-center justify-center" style={{ gap: 3 }}>
        {Array.from({ length: shown }, (_, i) => dot(i))}
      </div>
    );
  }
  const top = Math.ceil(shown / 2);
  return (
    <div className="flex flex-col items-center justify-center" style={{ gap: 3 }}>
      <div className="flex" style={{ gap: 3 }}>{Array.from({ length: top }, (_, i) => dot(i))}</div>
      <div className="flex" style={{ gap: 3 }}>{Array.from({ length: shown - top }, (_, i) => dot(i))}</div>
    </div>
  );
}

// 竖排迷你时间轴：纵向时间(小时合并列 + 分钟列两级表头)，横向轨道列(会话, 与卡片同序同列)。
// 配色融入左栏(暗基调)，表头/字/点提亮保持清晰。hover 十字标定 + 悬浮面板。连续空小时折叠。
export default function SessionTimeline({ date, rows, loading }: Props) {
  // 时间轴专用「紧凑」轨道分配（最少轨道 + 充实轨在左）。卡片流仍用 SessionsApp 传下来的旧分配。
  const { laneOf, laneCount, labelsByLane } = useMemo(() => assignLanesPacked(rows), [rows]);
  const [tip, setTip] = useState<Tip>(null);
  const [hb, setHb] = useState<number | null>(null);
  const [hl, setHl] = useState<number | null>(null);
  const [hh, setHh] = useState<number | null>(null);
  const [hseg, setHseg] = useState<{ lane: number; label: string } | null>(null); // hover 的插队会话段
  const clear = () => {
    setHb(null);
    setHl(null);
    setHh(null);
    setHseg(null);
    setTip(null);
  };

  // 贴边表头用 imperative DOM 更新：滚动时直接改表头 top，绕开 React 重渲染，
  // 避免每帧整树（数百格子 + 点阵）重画造成的卡顿与「过冲再闪回」。
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const layoutRef = useRef<() => void>(() => {});
  useLayoutEffect(() => layoutRef.current()); // 每次渲染后同步一次表头位置
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const fn = () => layoutRef.current();
    el.addEventListener("scroll", fn, { passive: true });
    const ro = new ResizeObserver(fn);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", fn);
      ro.disconnect();
    };
  }, [date]);

  let minB = Infinity;
  let maxB = -Infinity;
  const cell: Record<number, Record<number, { n: number; row: TimelineRowWithSource }>> = {};
  const laneRows: Record<number, TimelineRowWithSource[]> = {};
  const hourTotals: Record<number, number> = {};
  const bucketMax: Record<number, number> = {}; // 每桶跨轨道的最大句数(>5 则该行双行)
  for (const r of rows) {
    const lane = laneOf[laneKey(r.source_id, r.session_id)] ?? 0;
    (laneRows[lane] ??= []).push(r);
    for (const bk of r.buckets) {
      if (bk.b < minB) minB = bk.b;
      if (bk.b > maxB) maxB = bk.b;
      (cell[lane] ??= {})[bk.b] = { n: bk.n, row: r };
      hourTotals[Math.floor(bk.b / 6)] = (hourTotals[Math.floor(bk.b / 6)] ?? 0) + bk.n;
      bucketMax[bk.b] = Math.max(bucketMax[bk.b] ?? 0, bk.n);
    }
  }

  // 占轨复用：每轨道按首发排序，[0]=主线(独占列标头)，其余=插队(主题色按顺序循环)
  const mainByLane: Record<number, TimelineRowWithSource | undefined> = {};
  // (lane, bucket) → 插队会话框线信息（覆盖该会话整个时间段, 含中间无发言桶）
  const coverMeta: Record<number, Record<number, { color: string; isFirst: boolean; isLast: boolean; label: string; row: TimelineRowWithSource }>> = {};
  const segsRaw: { lane: number; color: string; label: string; row: TimelineRowWithSource; fb: number; lb: number }[] = [];
  for (const laneStr of Object.keys(laneRows)) {
    const lane = Number(laneStr);
    const sorted = [...laneRows[lane]].sort((a, b) => (a.first_unix ?? 0) - (b.first_unix ?? 0));
    mainByLane[lane] = sorted[0];
    sorted.forEach((r, idx) => {
      if (idx === 0) return; // 主线不画框（独占列标头）
      const color = PALETTE[(idx - 1) % PALETTE.length];
      const bs = r.buckets.map((bk) => bk.b).sort((a, b) => a - b); // 仅有发言的桶
      const fb = bs[0];
      const lb = bs[bs.length - 1];
      const label = r.project_seq != null && r.session_seq != null ? `${r.project_seq}-${r.session_seq}` : "—";
      segsRaw.push({ lane, color, label, row: r, fb, lb });
      const m = (coverMeta[lane] ??= {});
      // 框圈整段 fb..lb（中间空白格也圈住）；唯独被主轨道/他人占用的格让位、归其司管
      for (let b = fb; b <= lb; b++) {
        const occ = cell[lane]?.[b];
        if (occ && occ.row !== r) continue;
        m[b] = { color, isFirst: b === fb, isLast: b === lb, label, row: r };
      }
    });
  }

  const hasData = rows.length > 0 && minB !== Infinity;
  const isToday = date === todayYmd();
  const nowHour = isToday ? new Date().getHours() : -1;
  const startHour = hasData ? Math.floor(minB / 6) : 0;
  let endHour = hasData ? Math.floor(maxB / 6) : 0;
  if (isToday && nowHour > endHour) endHour = nowHour;
  const hours: number[] = [];
  for (let h = startHour; h <= endHour; h++) hours.push(h);

  type HourGroup = { type: "data"; h: number } | { type: "empty"; from: number; to: number };
  const groups: HourGroup[] = [];
  for (const h of hours) {
    const empty = (hourTotals[h] ?? 0) === 0 && h !== nowHour;
    if (empty) {
      const last = groups[groups.length - 1];
      if (last && last.type === "empty") last.to = h;
      else groups.push({ type: "empty", from: h, to: h });
    } else {
      groups.push({ type: "data", h });
    }
  }

  const hoverHour = hh ?? (hb != null ? Math.floor(hb / 6) : null);
  const seqLabel = (r: TimelineRowWithSource) =>
    r.project_seq != null && r.session_seq != null ? `${r.project_seq}-${r.session_seq}` : "—";
  const showTip = (e: React.MouseEvent, t: Omit<NonNullable<Tip>, "x" | "y">) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setTip({ ...t, x: rect.right, y: (rect.top + rect.bottom) / 2 });
  };
  // 适应性行高：某桶 >5 条则该行双行；小时块高 = 其 6 行高之和
  const rowH = (b: number) => (Math.min(10, bucketMax[b] ?? 0) > 5 ? ROW_H2 : ROW_H);
  const hourH = (h: number) => [0, 1, 2, 3, 4, 5].reduce((s, i) => s + rowH(h * 6 + i), 0);

  // 每 bucket 的 y 位置（相对滚动内容顶：列标头 24 + 折叠条 18 + 小时块 borderTop 2 + 各行高）
  const COLHEAD_H = 24;
  const bucketY: Record<number, number> = {};
  {
    let y = COLHEAD_H;
    for (const g of groups) {
      if (g.type === "empty") {
        y += 18;
        continue;
      }
      y += 2;
      for (let i = 0; i < 6; i++) {
        bucketY[g.h * 6 + i] = y;
        y += rowH(g.h * 6 + i);
      }
    }
  }
  // 插队段：y 跨度（首格上方一格 → 段底）。topY 上移 ROW_H，表头静止时落在首格「上方」空格。
  const segs = segsRaw.map((s) => {
    const topY = (bucketY[s.fb] ?? 0) - ROW_H;
    const bottomY = (bucketY[s.lb] ?? 0) + rowH(s.lb);
    return { ...s, topY, height: bottomY - topY };
  });

  // imperative 贴边布局：直接改表头 DOM 的 top/display，不触发 React 重渲染。
  // 段在视野=首格上方；段顶滚到视口上方=贴顶；段在视口下方=贴底（位置即方向，实色无透明无箭头）。
  // 同列同方向多段只显示最接近视口的一个，避免标签互相叠住。
  layoutRef.current = () => {
    const el = scrollRef.current;
    if (!el) return;
    const vTop = el.scrollTop + COLHEAD_H;
    const vBot = el.scrollTop + el.clientHeight;
    const info = segs.map((s, i) => {
      const topY = s.topY;
      const botY = s.topY + s.height;
      const headerTop = Math.max(vTop, Math.min(topY, vBot - ROW_H));
      return { i, lane: s.lane, topY, botY, headerTop, atTop: topY < vTop, atBot: topY > vBot - ROW_H };
    });
    const byLane: Record<number, typeof info> = {};
    info.forEach((p) => (byLane[p.lane] ??= []).push(p));
    const visible = new Set<number>();
    for (const k of Object.keys(byLane)) {
      const arr = byLane[Number(k)];
      arr.filter((p) => !p.atTop && !p.atBot).forEach((p) => visible.add(p.i)); // 视口内全显示
      const tops = arr.filter((p) => p.atTop);
      const bots = arr.filter((p) => p.atBot);
      if (tops.length) visible.add(tops.reduce((a, b) => (a.botY >= b.botY ? a : b)).i); // 贴顶留最接近视口顶
      if (bots.length) visible.add(bots.reduce((a, b) => (a.topY <= b.topY ? a : b)).i); // 贴底留最接近视口底
    }
    info.forEach((p) => {
      const h = headerRefs.current[p.i];
      if (!h) return;
      h.style.display = visible.has(p.i) ? "flex" : "none";
      if (visible.has(p.i)) h.style.top = `${p.headerTop}px`;
    });
  };

  return (
    <div className="flex flex-col h-full" style={{ background: "#1b1b1b", borderTop: "1px solid #2a2a2a" }}>
      {/* 头部（无收缩） */}
      <div className="flex items-center gap-2 px-4 py-2 shrink-0" style={{ borderBottom: "1px solid #242424" }}>
        <span className="text-xs font-semibold" style={{ color: "#f3f4f6" }}>{dayLabel(date)} 时间轴</span>
        <span className="text-[11px]" style={{ color: "#aab0ba" }}>{rows.length} 会话</span>
      </div>

      {!hasData ? (
        <div className="flex items-center justify-center text-xs py-6" style={{ color: "#969db0" }}>
          {loading ? "加载中…" : "这一天没有发言"}
        </div>
      ) : (
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto">
          <div style={{ width: TIME_W + laneCount * COL_W, position: "relative" }}>
            {/* 列标头：时间区表头 + 轨道编号，sticky 顶 */}
            <div className="flex sticky top-0" style={{ zIndex: 15 }}>
              <div className="shrink-0 sticky left-0 flex items-center justify-center font-mono" style={{ width: TIME_W, height: 24, fontSize: 10, color: "#aab0ba", background: "#34343c", zIndex: 16, borderBottom: "1px solid #3a3a40" }}>
                时·分
              </div>
              {Array.from({ length: laneCount }, (_, lane) => {
                const main = mainByLane[lane];
                const on = hl === lane;
                return (
                  <div
                    key={lane}
                    className="shrink-0 flex items-center justify-center font-mono truncate"
                    style={{ width: COL_W, height: 24, fontSize: 11, fontWeight: 600, color: on ? "#fff" : "#e5e7eb", background: on ? "#2f2f33" : "#34343c", borderLeft: "1px solid #2a2a2a", borderBottom: `2px solid ${on ? "#e08a6a" : "#3a3a40"}`, transition: "background .1s, border-color .1s, color .1s" }}
                    onMouseEnter={(e) => {
                      if (!main) return;
                      setHl(lane);
                      setHb(null);
                      setHh(null);
                      // 列标头只司管它负责的主线会话 → 统一的单会话面板（与格子/插队段一致），不再列整轨
                      showTip(e, { big: main.count, title: `${seqLabel(main)}  ${main.title || main.session_id.slice(0, 8)}`, sub: `${main.project_name || "—"} · ${main.source_label}` });
                    }}
                    onMouseLeave={clear}
                  >
                    {main ? seqLabel(main) : (labelsByLane[lane] ?? []).join(" ")}
                  </div>
                );
              })}
            </div>

            {groups.map((g, gi) => {
              // 连续空小时：精致折叠条（细线 + 居中小字）
              if (g.type === "empty") {
                return (
                  <div key={`e${gi}`} className="flex items-center" style={{ height: 18 }}>
                    <div className="shrink-0 sticky left-0 font-mono flex items-center justify-center" style={{ width: TIME_W, height: 18, fontSize: 9, color: "#8d929c", background: "#1b1b1b", zIndex: 4 }}>
                      {g.from === g.to ? pad2(g.from) : `${pad2(g.from)}–${pad2(g.to)}`}
                    </div>
                    <div className="flex items-center" style={{ flex: 1, height: 18, gap: 7, paddingRight: 8 }}>
                      <div style={{ flex: 1, height: 1, background: "#343439" }} />
                      <span style={{ fontSize: 8.5, color: "#7d818a", letterSpacing: "0.6px", whiteSpace: "nowrap" }}>无发言</span>
                      <div style={{ flex: 1, height: 1, background: "#343439" }} />
                    </div>
                  </div>
                );
              }
              const h = g.h;
              const hourOn = hoverHour === h;
              const isNow = h === nowHour;
              const hTot = hourTotals[h] ?? 0;
              return (
                <div key={h} className="flex" style={{ borderTop: "2px solid transparent", borderImage: "linear-gradient(90deg, #c8825a 0%, #57575f 26%, #3a3a40 100%) 1" }}>
                  {/* 小时合并单元格：小时 + 该小时综合句数 */}
                  <div
                    className="shrink-0 sticky left-0 flex flex-col items-center justify-center font-mono"
    style={{ width: HOUR_W, height: hourH(h), color: hourOn ? "#f0b489" : isNow ? "#9ec3e6" : "#e2e5ea", background: hourOn ? "#2c2c30" : "#2b2b32", zIndex: 4, borderRight: "1px solid #2a2a2a", transition: "background .1s, color .1s" }}
                    onMouseEnter={(e) => {
                      setHh(h);
                      setHb(null);
                      setHl(null);
                      if (hTot) showTip(e, { big: hTot, title: `${pad2(h)}:00–${pad2(h)}:59`, sub: "全部会话综合" });
                    }}
                    onMouseLeave={clear}
                  >
                    <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.1 }}>{pad2(h)}</div>
                    <div style={{ fontSize: 9, color: hTot ? "#d98c6a" : "#969db0", marginTop: 1 }}>{hTot}</div>
                  </div>

                  {/* 该小时的 6 行 */}
                  <div className="flex flex-col">
                    {[0, 1, 2, 3, 4, 5].map((i) => {
                      const b = h * 6 + i;
                      const rowOn = hb === b;
                      const minOn = rowOn || hh === h;
                      return (
                        <div key={i} className="flex">
                          {/* 分钟列 */}
                          <div
                            className="shrink-0 sticky font-mono flex items-center justify-center"
                            style={{ width: MIN_W, height: rowH(b), left: HOUR_W, fontSize: 10, fontWeight: 600, color: minOn ? "#f0b489" : "#b9bfc9", background: minOn ? "#2a2a2e" : "#28282e", zIndex: 3, transition: "background .1s, color .1s" }}
                            onMouseEnter={(e) => {
                              setHb(b);
                              setHl(null);
                              setHh(null);
                              const lineN = Object.values(cell).reduce((s, m) => s + (m[b]?.n ?? 0), 0);
                              if (lineN) showTip(e, { big: lineN, title: `${pad2(h)}:${pad2(i * 10)}–${pad2(h)}:${pad2(i * 10 + 9)}`, sub: "该 10 分钟综合" });
                            }}
                            onMouseLeave={clear}
                          >
                            {pad2(i * 10)}
                          </div>
                          {/* 轨道密度格 */}
                          {Array.from({ length: laneCount }, (_, lane) => {
                            const info = cell[lane]?.[b];
                            const n = info?.n ?? 0;
                            const cov = coverMeta[lane]?.[b];
                            const interFirst = cov?.isFirst ?? false;
                            const interLast = cov?.isLast ?? false;
                            const cross = hb === b && hl === lane;
                            const colOn = hl === lane;
                            const segOn = hseg != null && cov != null && hseg.lane === lane && hseg.label === cov.label; // hover 悬浮表头掌控的段
                            // 插队整段内框（左右竖线每格 + 首尾横线），用柔和主题色
                            const interShadow = cov
                              ? [`inset 1px 0 0 ${cov.color}`, `inset -1px 0 0 ${cov.color}`, interFirst ? `inset 0 1px 0 ${cov.color}` : "", interLast ? `inset 0 -1px 0 ${cov.color}` : ""].filter(Boolean).join(", ")
                              : "";
                            const boxShadow = [interShadow, cross ? "inset 0 0 0 1px #ef9d77" : ""].filter(Boolean).join(", ") || undefined;
                            const bg = segOn
                              ? `${cov!.color}44`
                              : cross
                              ? "rgba(224,138,106,0.30)"
                              : isNow
                              ? "rgba(96,165,250,0.12)"
                              : rowOn || (colOn && !cov) || hh === h
                              ? "rgba(255,255,255,0.05)"
                              : n > 0
                              ? "rgba(224,138,106,0.18)"
                              : b % 2 === 1
                              ? "rgba(255,255,255,0.05)"
                              : "transparent";
                            return (
                              <div
                                key={lane}
                                className="shrink-0 flex items-center justify-center"
                                style={{ width: COL_W, height: rowH(b), background: bg, borderLeft: `1px solid ${isNow ? "#314a60" : "#343439"}`, boxShadow, transition: "background .1s, box-shadow .1s" }}
                                onMouseEnter={(e) => {
                                  setHb(b);
                                  setHl(lane);
                                  setHh(null);
                                  if (!info) return;
                                  const r = info.row;
                                  showTip(e, { big: info.n, title: `${seqLabel(r)}  ${r.title || r.session_id.slice(0, 8)}`, sub: `${pad2(h)}:${pad2(i * 10)}–${pad2(h)}:${pad2(i * 10 + 9)} · ${r.project_name || "—"} · ${r.source_label}` });
                                }}
                                onMouseLeave={clear}
                              >
                                <DotCell n={n} />
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {/* 贴边表头：位置由 layoutRef imperative 设置（top/display 滚动时直接改 DOM）。
                实色 pill、不透明、无箭头——贴在视口顶=上方有，贴底=下方有，居中=在视野，位置即方向。 */}
            {segs.map((s, si) => {
              const segHover = hseg?.lane === s.lane && hseg?.label === s.label;
              return (
                <div
                  key={`h${si}`}
                  ref={(el) => {
                    headerRefs.current[si] = el;
                  }}
                  onMouseEnter={(e) => {
                    setHseg({ lane: s.lane, label: s.label });
                    setHb(null);
                    setHl(null);
                    setHh(null);
                    const rect = e.currentTarget.getBoundingClientRect();
                    setTip({ x: rect.right, y: (rect.top + rect.bottom) / 2, big: s.row.count, title: `${s.label}  ${s.row.title || s.row.session_id.slice(0, 8)}`, sub: `${s.row.project_name || "—"} · ${s.row.source_label}` });
                  }}
                  onMouseLeave={clear}
                  style={{ position: "absolute", top: s.topY, left: TIME_W + s.lane * COL_W, width: COL_W, height: ROW_H, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 600, fontFamily: "ui-monospace, monospace", color: "#fff", background: s.color, borderRadius: 3, cursor: "default", whiteSpace: "nowrap", zIndex: 9, transform: segHover ? "translateY(-1px)" : "none", filter: segHover ? "brightness(1.12)" : "none", boxShadow: segHover ? `0 2px 7px ${s.color}aa` : "0 1px 3px rgba(0,0,0,0.45)", transition: "transform .12s, filter .12s, box-shadow .12s" }}
                >
                  {s.label}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 悬浮面板：紧贴元素右侧、垂直居中、clamp 防溢出 */}
      {tip && (
        <div
          style={{
            position: "fixed",
            left: Math.min(tip.x + 8, window.innerWidth - 280),
            top: Math.min(Math.max(tip.y, 50), window.innerHeight - 70),
            transform: "translateY(-50%)",
            zIndex: 60,
            pointerEvents: "none",
            background: "#22232b",
            border: "1px solid #3a3b46",
            borderRadius: 9,
            boxShadow: "0 10px 28px rgba(0,0,0,0.55)",
            padding: "8px 13px",
            textAlign: "center",
            minWidth: 76,
            maxWidth: 260,
          }}
        >
          {tip.big != null && (
            <div style={{ fontSize: 21, fontWeight: 700, lineHeight: 1, color: "#e08a6a", fontFamily: "ui-monospace, monospace" }}>
              {tip.big}
              <span style={{ fontSize: 11, fontWeight: 500, color: "#c7ccd1", marginLeft: 3 }}>句</span>
            </div>
          )}
          <div style={{ fontSize: 11, color: "#e5e7eb", marginTop: tip.big != null ? 5 : 0, lineHeight: 1.4, letterSpacing: "0.2px", wordBreak: "break-word", fontWeight: 600 }}>
            {tip.title}
          </div>
          {tip.sub && <div style={{ fontSize: 9.5, color: "#b3b9c3", marginTop: 3, wordBreak: "break-word" }}>{tip.sub}</div>}
          {tip.lines && (
            <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid #34353f", textAlign: "left" }}>
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
