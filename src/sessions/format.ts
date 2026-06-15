// 时间格式化（会话窗口用）

export function clock(unix: number | null): string {
  if (!unix) return "";
  const d = new Date(unix * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "06-15 09:12" 完整时间戳（发言流用） */
export function stamp(unix: number | null): string {
  if (!unix) return "";
  const d = new Date(unix * 1000);
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${mo}-${da} ${hh}:${mm}`;
}

/** 本地 YYYY-MM-DD */
export function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export function todayYmd(): string {
  return ymdLocal(new Date());
}

/** 在 YYYY-MM-DD 上加减天数 */
export function shiftYmd(ymdStr: string, delta: number): string {
  const [y, m, d] = ymdStr.split("-").map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  dt.setDate(dt.getDate() + delta);
  return ymdLocal(dt);
}

/** 今天 / 昨天 / YYYY-MM-DD */
export function dayLabel(ymdStr: string): string {
  if (ymdStr === todayYmd()) return "今天";
  if (ymdStr === shiftYmd(todayYmd(), -1)) return "昨天";
  return ymdStr;
}

/** 数字千分位 */
export function nfmt(n: number): string {
  return n.toLocaleString("zh-CN");
}

/** 某本地日期 YYYY-MM-DD 的当天 [起, 止] unix 秒（本地时区） */
export function dayRange(ymdStr: string): { since: number; until: number } {
  const [y, m, d] = ymdStr.split("-").map(Number);
  const since = Math.floor(new Date(y, (m || 1) - 1, d || 1, 0, 0, 0).getTime() / 1000);
  return { since, until: since + 86399 };
}
