import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import type { TokenUsageDay, TokenUsageReport } from "../types";

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

const compact = (value: number) => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
};

const providerColor = (provider: string) => provider === "codex" ? "#4a9eff" : "#cc785c";

// 机器配色：本机固定绿，远程按名字 hash 取一个稳定的非绿色
const REMOTE_COLORS = ["#c084fc", "#f472b6", "#fbbf24", "#38bdf8", "#a3e635"];
const sourceColor = (source: string) => {
  if (source === "本机" || source === "") return "#4ade80";
  let h = 0;
  for (let i = 0; i < source.length; i++) h = (h * 31 + source.charCodeAt(i)) >>> 0;
  return REMOTE_COLORS[h % REMOTE_COLORS.length];
};

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
              ? `本机 + 远程分机器统计 · 检查 ${report.scanned_files} 个日志 · 解析 ${report.parsed_files} 个变更`
              : "点击刷新后增量扫描本机 Codex / Claude Code 日志"}
          </div>
        </div>
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
          <TokenUsageChart rows={rows} />
        </>
      )}

      <div className="overflow-hidden" style={{ border: "1px solid #303030", borderRadius: 8 }}>
        <table className="w-full text-xs" style={{ borderCollapse: "collapse" }}>
          <thead style={{ background: "#202020", color: "#9ca3af" }}>
            <tr>
              <Th>日期</Th>
              <Th>机器</Th>
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
                <td colSpan={8} className="px-3 py-5 text-center" style={{ color: "#777" }}>
                  {loading ? "扫描中..." : month ? "本月无数据" : "尚未扫描 token 日志"}
                </td>
              </tr>
            ) : (
              [...rows]
                .sort(
                  (a, b) =>
                    b.date.localeCompare(a.date) ||
                    sortSources(a.source, b.source) ||
                    a.provider.localeCompare(b.provider),
                )
                .map((row) => <TokenRow key={`${row.source}:${row.provider}:${row.date}`} row={row} />)
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

// 每日并排双机柱：每天每台机器一根柱（柱内 provider 堆叠），柱下方机器色条区分本机/远程
function TokenUsageChart({ rows }: { rows: TokenUsageDay[] }) {
  if (rows.length === 0) return null;
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

  const barWidth = sources.length > 1 ? 11 : 14;
  const barGap = 3; // 同一天机器柱间距
  const groupWidth = sources.length * barWidth + (sources.length - 1) * barGap;
  const groupGap = 16; // 天与天之间
  const leftPad = 42;
  const rightPad = 24;
  const width = Math.max(560, leftPad + rightPad + dates.length * (groupWidth + groupGap));
  const height = 224;
  const chartTop = 18;
  const chartBottom = 168;

  return (
    <div className="mb-3 overflow-x-auto" style={{ border: "1px solid #303030", borderRadius: 8, background: "#1f1f1f" }}>
      <svg width={width} height={height} role="img" aria-label="Token usage chart">
        {[0, 0.25, 0.5, 0.75, 1].map((tick) => {
          const y = chartBottom - (chartBottom - chartTop) * tick;
          return (
            <g key={tick}>
              <line x1={leftPad} x2={width - rightPad} y1={y} y2={y} stroke="#2d2d2d" />
              <text x={8} y={y + 4} fontSize={10} fill="#777">{compact(Math.round(max * tick))}</text>
            </g>
          );
        })}
        {dates.map((date, di) => {
          const groupX = leftPad + 10 + di * (groupWidth + groupGap);
          return (
            <g key={date}>
              {sources.map((src, si) => {
                const barX = groupX + si * (barWidth + barGap);
                let yCursor = chartBottom;
                return (
                  <g key={src}>
                    {providers.map((p) => {
                      const value = cell.get(keyOf(date, src, p)) ?? 0;
                      const h = Math.max(0, (value / max) * (chartBottom - chartTop));
                      yCursor -= h;
                      return (
                        <rect key={p} x={barX} y={yCursor} width={barWidth} height={h} rx={1} fill={providerColor(p)}>
                          <title>{`${date} · ${src} · ${providerLabel(p)} ${compact(value)}`}</title>
                        </rect>
                      );
                    })}
                    {/* 机器色底标 */}
                    <rect x={barX} y={chartBottom + 2} width={barWidth} height={3} rx={1} fill={sourceColor(src)} />
                  </g>
                );
              })}
              <text x={groupX + groupWidth / 2} y={chartBottom + 22} fontSize={10} fill="#9ca3af" textAnchor="middle">{date.slice(8)}</text>
            </g>
          );
        })}
        {/* 图例：provider 填充色 + 机器色条 */}
        <g>
          <circle cx={leftPad + 6} cy={11} r={4} fill={providerColor("claude_code")} />
          <text x={leftPad + 14} y={15} fontSize={10} fill="#cbd5e1">Claude</text>
          <circle cx={leftPad + 66} cy={11} r={4} fill={providerColor("codex")} />
          <text x={leftPad + 74} y={15} fontSize={10} fill="#cbd5e1">Codex</text>
          {sources.map((src, i) => (
            <g key={src} transform={`translate(${leftPad + 130 + i * 64}, 0)`}>
              <rect x={0} y={8} width={12} height={5} rx={1} fill={sourceColor(src)} />
              <text x={16} y={15} fontSize={10} fill="#cbd5e1">{src}</text>
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}

function TokenRow({ row }: { row: TokenUsageDay }) {
  const cache = row.cache_read_tokens + row.cache_creation_tokens;
  const topModels = row.models.slice(0, 3).map((item) => item.model).join(", ");

  return (
    <tr style={{ borderTop: "1px solid #2a2a2a", color: "#e5e7eb" }}>
      <Td>{row.date}</Td>
      <Td>
        <span
          style={{
            display: "inline-block",
            width: 7,
            height: 7,
            borderRadius: 7,
            background: sourceColor(row.source),
            marginRight: 6,
          }}
        />
        {row.source || "本机"}
      </Td>
      <Td>
        <span
          style={{
            display: "inline-block",
            width: 7,
            height: 7,
            borderRadius: 7,
            background: providerColor(row.provider),
            marginRight: 6,
          }}
        />
        {providerLabel(row.provider)}
      </Td>
      <Td align="right">{compact(row.input_tokens)}</Td>
      <Td align="right">{compact(cache)}</Td>
      <Td align="right">{compact(row.output_tokens)}</Td>
      <Td align="right">{compact(row.total_tokens)}</Td>
      <Td title={row.models.map((item) => `${item.model}: ${compact(item.total_tokens)}`).join("\n")}>
        <span style={{ color: "#9ca3af" }}>{topModels || "-"}</span>
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
  return <th className="px-3 py-2 font-medium" style={{ textAlign: align }}>{children}</th>;
}

function Td({ children, align = "left", title }: { children: React.ReactNode; align?: "left" | "right"; title?: string }) {
  return <td className="px-3 py-2 align-top" style={{ textAlign: align }} title={title}>{children}</td>;
}
