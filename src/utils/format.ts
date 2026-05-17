export function formatLocalTime(isoStr: string | null): string {
  if (!isoStr) return "-";
  try {
    return new Date(isoStr).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return isoStr;
  }
}

export function formatHours(hours: number | null): string {
  if (hours === null || hours < 0) return "-";
  if (hours < 1) return `${Math.round(hours * 60)}min`;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  const d = Math.floor(hours / 24);
  const h = Math.round(hours % 24);
  return h > 0 ? `${d}d${h}h` : `${d}d`;
}

export function formatPct(pct: number | null): string {
  if (pct === null) return "-";
  return `${Math.round(pct)}%`;
}

export function remaining(pct: number | null, total = 100): number | null {
  if (pct === null) return null;
  return Math.max(0, total - pct);
}

export function pctColor(pct: number | null): string {
  if (pct === null) return "text-gray-500";
  if (pct >= 90) return "text-red-400";
  if (pct >= 70) return "text-amber-400";
  if (pct >= 40) return "text-yellow-300";
  return "text-emerald-400";
}

export function barColor(pct: number | null): string {
  if (pct === null) return "bg-gray-700";
  if (pct >= 90) return "bg-red-500";
  if (pct >= 70) return "bg-amber-500";
  if (pct >= 40) return "bg-yellow-400";
  return "bg-emerald-500";
}

export function hoursUntil(isoStr: string | null): number | null {
  if (!isoStr) return null;
  const diff = new Date(isoStr).getTime() - Date.now();
  if (diff <= 0) return 0;
  return diff / 3600000;
}
