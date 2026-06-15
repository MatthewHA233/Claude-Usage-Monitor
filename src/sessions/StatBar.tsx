import type { ReactNode } from "react";
import { MessageSquareText, CalendarDays, Type, TrendingUp } from "lucide-react";
import type { DailyStat } from "./types";
import { todayYmd, nfmt } from "./format";

interface Props {
  days: DailyStat[];
  loading: boolean;
}

/** 顶部统计条：总句数 / 今日句数 / 总字数 / 按天趋势 */
export default function StatBar({ days, loading }: Props) {
  const totalCount = days.reduce((s, d) => s + d.count, 0);
  const totalChars = days.reduce((s, d) => s + d.chars, 0);
  const today = todayYmd();
  const todayCount = days.find((d) => d.date === today)?.count ?? 0;

  // 趋势：最近 14 天（日期升序）
  const recent = [...days].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-14);
  const maxN = Math.max(1, ...recent.map((d) => d.count));

  return (
    <div
      className="flex items-stretch gap-2 px-4 py-2 shrink-0"
      style={{ borderBottom: "1px solid #2a2a2a", background: "#1a1a1a" }}
    >
      <Stat icon={<MessageSquareText size={14} />} label="总句数" value={nfmt(totalCount)} accent="#cc785c" loading={loading} />
      <Stat icon={<CalendarDays size={14} />} label="今日句数" value={nfmt(todayCount)} accent="#4ade80" loading={loading} />
      <Stat icon={<Type size={14} />} label="总字数" value={nfmt(totalChars)} accent="#60a5fa" loading={loading} />

      <div
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg flex-1 min-w-0"
        style={{ background: "#202020", border: "1px solid #2c2c2c" }}
      >
        <TrendingUp size={14} style={{ color: "#a78bfa" }} />
        <span className="text-[11px] shrink-0" style={{ color: "#8b9298" }}>按天趋势</span>
        <div className="flex items-end gap-[3px] h-6 flex-1 min-w-0 overflow-hidden">
          {recent.map((d) => (
            <div
              key={d.date}
              title={`${d.date} · ${d.count} 句`}
              style={{
                width: 6,
                height: `${Math.max(2, (d.count / maxN) * 24)}px`,
                background: d.date === today ? "#cc785c" : "#3f6f55",
                borderRadius: 2,
              }}
            />
          ))}
          {recent.length === 0 && (
            <span className={`text-[11px] ${loading ? "animate-pulse" : ""}`} style={{ color: "#6b7280" }}>
              {loading ? "初始化中…" : "暂无数据"}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  accent,
  loading,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  accent: string;
  loading: boolean;
}) {
  return (
    <div
      className="flex items-center gap-2.5 px-3 py-1.5 rounded-lg"
      style={{ background: "#202020", border: "1px solid #2c2c2c", minWidth: 118 }}
    >
      <span style={{ color: accent }}>{icon}</span>
      <div className="leading-tight">
        <div className="text-[11px]" style={{ color: "#8b9298" }}>{label}</div>
        <div className="text-base font-semibold tabular-nums" style={{ color: loading ? "#6b7280" : "#f3f4f6" }}>
          {value}
        </div>
      </div>
    </div>
  );
}
