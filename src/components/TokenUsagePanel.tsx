import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import type { TokenUsageDay, TokenUsageReport } from "../types";
import NetworkButton from "../sessions/NetworkButton";
import { machineColor as sourceColor } from "../colors"; // 机器配色与会话时间轴共用

interface Props {
  report: TokenUsageReport | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

const providerLabel = (provider: string) => {
  if (provider === "codex") return "Codex";
  if (provider === "claude_code") return "Claude Code";
  return provider;
};

// 表格来源列用短名（省宽、不换行）
const providerShort = (provider: string) => (provider === "codex" ? "Codex" : "Claude");

const compact = (value: number) => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
};

// Provider 品牌色：Claude=橙、Codex=蓝紫（对齐两者桌面端图标配色）
const providerColor = (provider: string) => provider === "codex" ? "#7c6cf0" : "#cc785c";

// 机器配色见 ../colors.ts（machineColor，本机蓝 + 远程青/粉/琥珀/玫红，避开绿/紫/橙）。
// 用于表格圆点 + 条形图「整柱边框」——靠边框色区分机器；会话时间轴共用同一函数保证同色。

// 条形图：Provider 用品牌色填充（Claude 橙 / Codex 蓝紫）；
// 机器用「整柱边框色」区分（本机绿框、各远程不同色框），支持任意多台。

// 机器排序：本机优先，其余按名字
const sortSources = (a: string, b: string) =>
  a === "本机" ? -1 : b === "本机" ? 1 : a.localeCompare(b);

const monthKey = (date: string) => date.slice(0, 7); // YYYY-MM
const fmtMonth = (m: string) => {
  const [y, mo] = m.split("-");
  return `${y} 年 ${parseInt(mo, 10)} 月`;
};

const navBtnStyle = (disabled: boolean): React.CSSProperties => ({
  width: 28,
  height: 28,
  borderRadius: 6,
  border: "1px solid #3a3a3a",
  background: "#202020",
  color: disabled ? "#555" : "#d1d5db",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: disabled ? "default" : "pointer",
  opacity: disabled ? 0.5 : 1,
});

export default function TokenUsagePanel({ report, loading, error, onRefresh }: Props) {
  const allDays = report?.days ?? [];

  // 全部有数据的月份（YYYY-MM），新→旧
  const months = useMemo(
    () => [...new Set(allDays.map((d) => monthKey(d.date)))].sort((a, b) => b.localeCompare(a)),
    [allDays],
  );
  const [picked, setPicked] = useState<string | null>(null);
  const month = picked && months.includes(picked) ? picked : months[0] ?? null;

  // 选中月的行
  const rows = useMemo(
    () => (month ? allDays.filter((d) => monthKey(d.date) === month) : []),
    [allDays, month],
  );

  // 选中月的汇总（所有机器 + provider 总计）
  const summary = useMemo(
    () =>
      rows.reduce(
        (acc, r) => {
          acc.input += r.input_tokens;
          acc.cache += r.cache_read_tokens + r.cache_creation_tokens;
          acc.output += r.output_tokens;
          acc.total += r.total_tokens;
          return acc;
        },
        { input: 0, cache: 0, output: 0, total: 0 },
      ),
    [rows],
  );

  // 是否有多台机器：决定是否显示机器区分（条形图边框/图例 + 表格「机器」列）。只有本机时全隐藏。
  const multiSource = useMemo(() => new Set(allDays.map((d) => d.source)).size > 1, [allDays]);

  // 表格行：按 日期↓ / 机器 / provider 排序；同日期多行时首行 dateRowSpan=组内行数（合并日期单元格），其余 0。
  const tableRows = useMemo(() => {
    const sorted = [...rows].sort(
      (a, b) =>
        b.date.localeCompare(a.date) || sortSources(a.source, b.source) || a.provider.localeCompare(b.provider),
    );
    const counts = new Map<string, number>();
    sorted.forEach((r) => counts.set(r.date, (counts.get(r.date) ?? 0) + 1));
    const seen = new Set<string>();
    return sorted.map((row) => {
      const span = seen.has(row.date) ? 0 : counts.get(row.date) ?? 1;
      seen.add(row.date);
      return { row, span };
    });
  }, [rows]);

  const idx = month ? months.indexOf(month) : -1;
  const hasPrev = idx >= 0 && idx < months.length - 1; // 更早的月
  const hasNext = idx > 0; // 更晚的月

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-base font-semibold" style={{ color: "#f3f4f6" }}>Token 用量</div>
          <div className="text-xs" style={{ color: "#858585" }}>
            {report
              ? `${multiSource ? "本机 + 远程分机器统计" : "本机统计"} · 检查 ${report.scanned_files} 个日志 · 解析 ${report.parsed_files} 个变更`
              : "点击刷新后增量扫描本机 Codex / Claude Code 日志"}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* 连接管理：token 与会话共用 session_sources，这里直接复用会话窗口那套面板 */}
          <NetworkButton />
          <button
            onClick={onRefresh}
            title="刷新 token 用量（扫本机 + 拉远程）"
            className="inline-flex items-center justify-center"
            style={{
              width: 30,
              height: 30,
              borderRadius: 6,
              border: "1px solid #3a3a3a",
              background: "#202020",
              color: "#d1d5db",
            }}
          >
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {/* 月份导航：默认最新月，可翻历史月 */}
      {month && (
        <div className="flex items-center justify-center gap-3 mb-3">
          <button
            onClick={() => hasPrev && setPicked(months[idx + 1])}
            disabled={!hasPrev}
            title="上一月"
            style={navBtnStyle(!hasPrev)}
          >
            <ChevronLeft size={16} />
          </button>
          <span style={{ color: "#e5e7eb", fontSize: 13, fontWeight: 600, minWidth: 110, textAlign: "center" }}>
            {fmtMonth(month)}
          </span>
          <button
            onClick={() => hasNext && setPicked(months[idx - 1])}
            disabled={!hasNext}
            title="下一月"
            style={navBtnStyle(!hasNext)}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      )}

      {error && <div className="text-xs mb-2" style={{ color: "#f87171" }}>{error}</div>}

      {report && month && (
        <>
          <div className="grid grid-cols-4 gap-2 mb-3">
            <Metric label="Input" value={compact(summary.input)} />
            <Metric label="Cache" value={compact(summary.cache)} />
            <Metric label="Output" value={compact(summary.output)} />
            <Metric label="Total" value={compact(summary.total)} />
          </div>
          <ProviderSummary rows={rows} />
          <TokenUsageChart rows={rows} multiSource={multiSource} />
        </>
      )}

      <div className="overflow-x-auto" style={{ border: "1px solid #303030", borderRadius: 8 }}>
        <table className="w-full text-xs" style={{ borderCollapse: "collapse", minWidth: "max-content" }}>
          <thead style={{ background: "#202020", color: "#9ca3af" }}>
            <tr>
              <Th>日期</Th>
              {multiSource && <Th>机器</Th>}
              <Th>来源</Th>
              <Th align="right">Input</Th>
              <Th align="right">Cache</Th>
              <Th align="right">Output</Th>
              <Th align="right">Total</Th>
              <Th>模型</Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={multiSource ? 8 : 7} className="px-3 py-5 text-center" style={{ color: "#777" }}>
                  {loading ? "扫描中..." : month ? "本月无数据" : "尚未扫描 token 日志"}
                </td>
              </tr>
            ) : (
              tableRows.map(({ row, span }) => (
                <TokenRow
                  key={`${row.source}:${row.provider}:${row.date}`}
                  row={row}
                  showSource={multiSource}
                  dateRowSpan={span}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {report && report.errors.length > 0 && (
        <div className="mt-2 text-xs" style={{ color: "#fbbf24" }}>
          {report.errors.length} 条读取/远程拉取失败，已跳过。
        </div>
      )}
    </section>
  );
}

function ProviderSummary({ rows }: { rows: TokenUsageDay[] }) {
  const grouped = rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.provider] = (acc[row.provider] ?? 0) + row.total_tokens;
    return acc;
  }, {});
  const total = Object.values(grouped).reduce((sum, value) => sum + value, 0);
  const providers = ["codex", "claude_code"].filter((provider) => grouped[provider] != null);
  if (providers.length === 0) return null;

  return (
    <div className="grid grid-cols-2 gap-2 mb-3">
      {providers.map((provider) => {
        const value = grouped[provider] ?? 0;
        const pct = total > 0 ? Math.round(value / total * 100) : 0;
        return (
          <div key={provider} style={{ border: "1px solid #303030", borderRadius: 8, padding: 10, background: "#1f1f1f" }}>
            <div className="flex items-center justify-between text-xs">
              <span style={{ color: "#d1d5db" }}>
                <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 8, background: providerColor(provider), marginRight: 7 }} />
                {providerLabel(provider)}
              </span>
              <span style={{ color: "#9ca3af" }}>{pct}%</span>
            </div>
            <div className="mt-1 text-lg font-semibold" style={{ color: "#f9fafb" }}>{compact(value)}</div>
          </div>
        );
      })}
    </div>
  );
}

// 每日并排双机柱：每天每台机器一根柱（柱内 Claude/Codex 同色系深浅），整柱色调区分机器。
// Y 轴刻度固定在左列，只柱图区域横向滚动；右侧是最新日期，默认滚到最右。
function TokenUsageChart({ rows, multiSource }: { rows: TokenUsageDay[]; multiSource: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const providers = ["claude_code", "codex"];
  const sources = [...new Set(rows.map((r) => r.source))].sort(sortSources);
  const dates = [...new Set(rows.map((r) => r.date))].sort((a, b) => a.localeCompare(b));

  const keyOf = (d: string, s: string, p: string) => `${d}|${s}|${p}`;
  const cell = new Map<string, number>();
  for (const r of rows) {
    const k = keyOf(r.date, r.source, r.provider);
    cell.set(k, (cell.get(k) ?? 0) + r.total_tokens);
  }
  const sourceTotal = (d: string, s: string) =>
    providers.reduce((sum, p) => sum + (cell.get(keyOf(d, s, p)) ?? 0), 0);
  const max = Math.max(1, ...dates.flatMap((d) => sources.map((s) => sourceTotal(d, s))));

  const barWidth = sources.length > 1 ? 12 : 16;
  const barGap = 3; // 同一天机器柱间距
  const groupWidth = sources.length * barWidth + (sources.length - 1) * barGap;
  const groupGap = 18; // 天与天之间
  const innerPad = 12;
  const chartWidth = Math.max(360, innerPad * 2 + dates.length * (groupWidth + groupGap));
  const AXIS_W = 46; // 固定 Y 轴列宽
  const height = 220;
  const chartTop = 14;
  const chartBottom = 178;
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  // 每次柱图变可见（首次进入 / 从别的 tab 切回 Token）都把横向滚动条停到最右——
  // 右侧是最新日期。App 用 display:none 切 tab（不卸载），故靠 IntersectionObserver 捕捉「重新可见」。
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const toRight = () => {
      el.scrollLeft = el.scrollWidth;
    };
    toRight();
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) toRight();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [chartWidth]);

  if (rows.length === 0) return null;

  return (
    <div className="mb-3">
      {/* 图例：Provider 品牌色填充（Claude 橙 / Codex 蓝紫）+ 机器边框色（本机绿框、各远程不同色框） */}
      <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mb-2 text-[11px]">
        <span className="inline-flex items-center gap-1.5" style={{ color: "#cbd5e1" }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: providerColor("claude_code") }} />
          Claude
        </span>
        <span className="inline-flex items-center gap-1.5" style={{ color: "#cbd5e1" }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: providerColor("codex") }} />
          Codex
        </span>
        {multiSource && (
          <>
            <span style={{ color: "#6b7280" }}>·</span>
            {sources.map((s) => (
              <span key={s} className="inline-flex items-center gap-1.5" style={{ color: "#9ca3af" }} title={s || "本机"}>
                <span style={{ width: 11, height: 11, borderRadius: 2, background: "transparent", boxShadow: `inset 0 0 0 1.5px ${sourceColor(s)}`, flexShrink: 0 }} />
                {(s || "本机").replace(/\.local$/i, "")}
              </span>
            ))}
          </>
        )}
      </div>

      <div className="flex" style={{ border: "1px solid #303030", borderRadius: 8, background: "#1f1f1f", overflow: "hidden" }}>
        {/* 固定 Y 轴刻度 */}
        <svg width={AXIS_W} height={height} style={{ flexShrink: 0 }}>
          {ticks.map((t) => {
            const y = chartBottom - (chartBottom - chartTop) * t;
            return (
              <text key={t} x={AXIS_W - 6} y={y + 3} fontSize={10} fill="#aab0ba" textAnchor="end">
                {compact(Math.round(max * t))}
              </text>
            );
          })}
        </svg>

        {/* 横向滚动柱图区 */}
        <div ref={scrollRef} className="overflow-x-auto" style={{ flex: 1 }}>
          <svg width={chartWidth} height={height} role="img" aria-label="Token usage chart">
            {ticks.map((t) => {
              const y = chartBottom - (chartBottom - chartTop) * t;
              return <line key={t} x1={0} x2={chartWidth} y1={y} y2={y} stroke="#2a2a2a" />;
            })}
            {dates.map((date, di) => {
              const groupX = innerPad + di * (groupWidth + groupGap);
              return (
                <g key={date}>
                  {sources.map((src, si) => {
                    const barX = groupX + si * (barWidth + barGap);
                    const totalH = Math.max(0, (sourceTotal(date, src) / max) * (chartBottom - chartTop));
                    let yCursor = chartBottom;
                    return (
                      <g key={src}>
                        {providers.map((p) => {
                          const value = cell.get(keyOf(date, src, p)) ?? 0;
                          const h = Math.max(0, (value / max) * (chartBottom - chartTop));
                          yCursor -= h;
                          return (
                            <rect key={p} x={barX} y={yCursor} width={barWidth} height={h} fill={providerColor(p)}>
                              <title>{`${date} · ${src || "本机"} · ${providerLabel(p)} ${compact(value)}`}</title>
                            </rect>
                          );
                        })}
                        {/* 整柱机器色边框：靠边框色区分机器（仅多机器时显示） */}
                        {multiSource && totalH > 0.5 && (
                          <rect
                            x={barX - 0.25}
                            y={chartBottom - totalH}
                            width={barWidth + 0.5}
                            height={totalH}
                            rx={2}
                            fill="none"
                            stroke={sourceColor(src)}
                            strokeWidth={1.5}
                          />
                        )}
                      </g>
                    );
                  })}
                  <text x={groupX + groupWidth / 2} y={chartBottom + 20} fontSize={10} fill="#9ca3af" textAnchor="middle">
                    {date.slice(8)}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>
    </div>
  );
}

function TokenRow({ row, showSource, dateRowSpan }: { row: TokenUsageDay; showSource: boolean; dateRowSpan: number }) {
  const cache = row.cache_read_tokens + row.cache_creation_tokens;
  const topModels = row.models.slice(0, 3).map((item) => item.model).join(", ");
  const dot = (color: string) => (
    <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: 7, background: color, marginRight: 6, flexShrink: 0 }} />
  );

  return (
    // 日期组首行用明显分隔线、组内行（同日期多机器）用淡线 → 日期块边界清晰
    <tr style={{ borderTop: dateRowSpan > 0 ? "1px solid #3f3f47" : "1px solid #242428", color: "#e5e7eb" }}>
      {/* 同日期多机器行：日期单元格合并（rowSpan），仅组内首行渲染 */}
      {dateRowSpan > 0 && (
        <Td rowSpan={dateRowSpan} align="center" title={row.date}>
          <span style={{ fontVariantNumeric: "tabular-nums", color: "#cbd5e1", fontWeight: 600 }}>{row.date.slice(5)}</span>
        </Td>
      )}
      {showSource && (
        <Td title={row.source || "本机"}>
          <div style={{ display: "flex", alignItems: "center", maxWidth: 160, minWidth: 0 }}>
            {dot(sourceColor(row.source))}
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {(row.source || "本机").replace(/\.local$/i, "")}
            </span>
          </div>
        </Td>
      )}
      <Td>
        {dot(providerColor(row.provider))}
        {providerShort(row.provider)}
      </Td>
      <Td align="right">{compact(row.input_tokens)}</Td>
      <Td align="right">{compact(cache)}</Td>
      <Td align="right">{compact(row.output_tokens)}</Td>
      <Td align="right">{compact(row.total_tokens)}</Td>
      <Td nowrap={false} title={row.models.map((item) => `${item.model}: ${compact(item.total_tokens)}`).join("\n")}>
        <div style={{ maxWidth: 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#9ca3af" }}>
          {topModels || "-"}
        </div>
      </Td>
    </tr>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ border: "1px solid #303030", borderRadius: 8, padding: "8px 10px", background: "#1f1f1f" }}>
      <div className="text-[11px]" style={{ color: "#858585" }}>{label}</div>
      <div className="text-sm font-semibold" style={{ color: "#f3f4f6" }}>{value}</div>
    </div>
  );
}

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return <th className="px-2 py-2 font-medium" style={{ textAlign: align, whiteSpace: "nowrap" }}>{children}</th>;
}

function Td({
  children,
  align = "left",
  title,
  nowrap = true,
  rowSpan,
}: {
  children: React.ReactNode;
  align?: "left" | "right" | "center";
  title?: string;
  nowrap?: boolean;
  rowSpan?: number;
}) {
  return (
    <td
      className="px-2 py-2 align-middle"
      style={{ textAlign: align, whiteSpace: nowrap ? "nowrap" : undefined }}
      title={title}
      rowSpan={rowSpan}
    >
      {children}
    </td>
  );
}
