import { RefreshCw } from "lucide-react";
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

export default function TokenUsagePanel({ report, loading, error, onRefresh }: Props) {
  const rows = report?.days ?? [];

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-base font-semibold" style={{ color: "#f3f4f6" }}>Token 用量</div>
          <div className="text-xs" style={{ color: "#858585" }}>
            {report ? `${report.since} 至 ${report.until} · 检查 ${report.scanned_files} 个日志 · 解析 ${report.parsed_files} 个变更` : "点击刷新后增量扫描本机 Codex / Claude Code 日志"}
          </div>
        </div>
        <button
          onClick={onRefresh}
          title="刷新 token 用量"
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

      {error && <div className="text-xs mb-2" style={{ color: "#f87171" }}>{error}</div>}

      {report && (
        <>
          <div className="grid grid-cols-4 gap-2 mb-3">
            <Metric label="Input" value={compact(report.summary.input_tokens)} />
            <Metric label="Cache" value={compact(report.summary.cache_read_tokens + report.summary.cache_creation_tokens)} />
            <Metric label="Output" value={compact(report.summary.output_tokens)} />
            <Metric label="Total" value={compact(report.summary.total_tokens)} />
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
                <td colSpan={7} className="px-3 py-5 text-center" style={{ color: "#777" }}>
                  {loading ? "扫描中..." : "尚未扫描 token 日志"}
                </td>
              </tr>
            ) : rows.map((row) => (
              <TokenRow key={`${row.provider}:${row.date}`} row={row} />
            ))}
          </tbody>
        </table>
      </div>

      {report && report.errors.length > 0 && (
        <div className="mt-2 text-xs" style={{ color: "#fbbf24" }}>
          {report.errors.length} 个日志读取失败，已跳过。
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

function TokenUsageChart({ rows }: { rows: TokenUsageDay[] }) {
  const dates = [...new Set(rows.map((row) => row.date))].sort((a, b) => b.localeCompare(a));
  const providers = ["claude_code", "codex"];
  const byDate = new Map<string, Record<string, number>>();
  for (const date of dates) byDate.set(date, {});
  for (const row of rows) {
    const bucket = byDate.get(row.date) ?? {};
    bucket[row.provider] = (bucket[row.provider] ?? 0) + row.total_tokens;
    byDate.set(row.date, bucket);
  }
  const max = Math.max(1, ...dates.map((date) => providers.reduce((sum, provider) => sum + (byDate.get(date)?.[provider] ?? 0), 0)));
  const leftPad = 40;
  const rightPad = 24;
  const width = Math.max(560, leftPad + rightPad + dates.length * 58);
  const height = 210;
  const chartTop = 18;
  const chartBottom = 168;
  const barWidth = 14;
  const plotWidth = width - leftPad - rightPad;
  const step = plotWidth / Math.max(1, dates.length);

  if (rows.length === 0) return null;

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
        {dates.map((date, index) => {
          const x = leftPad + 10 + index * step;
          let yCursor = chartBottom;
          return (
            <g key={date}>
              {providers.map((provider) => {
                const value = byDate.get(date)?.[provider] ?? 0;
                const h = Math.max(0, (value / max) * (chartBottom - chartTop));
                yCursor -= h;
                return (
                  <rect
                    key={provider}
                    x={x}
                    y={yCursor}
                    width={barWidth}
                    height={h}
                    rx={2}
                    fill={providerColor(provider)}
                  >
                    <title>{`${date} ${providerLabel(provider)} ${compact(value)}`}</title>
                  </rect>
                );
              })}
              <text x={x + barWidth / 2} y={190} fontSize={10} fill="#9ca3af" textAnchor="middle">{date.slice(5)}</text>
            </g>
          );
        })}
        <g>
          <circle cx={width - 170} cy={18} r={4} fill={providerColor("claude_code")} />
          <text x={width - 160} y={22} fontSize={11} fill="#cbd5e1">Claude Code</text>
          <circle cx={width - 76} cy={18} r={4} fill={providerColor("codex")} />
          <text x={width - 66} y={22} fontSize={11} fill="#cbd5e1">Codex</text>
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
