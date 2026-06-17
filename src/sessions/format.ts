// 时间格式化（会话窗口用）

export function clock(unix: number | null): string {
  if (!unix) return "";
  const d = new Date(unix * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 从完整 ISO 时间戳取「秒.毫秒」(比时:分更细的精度)，无毫秒则 ms="000" */
export function subSecond(iso: string | null): { ss: string; ms: string } {
  if (!iso) return { ss: "", ms: "" };
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { ss: "", ms: "" };
  return {
    ss: String(d.getSeconds()).padStart(2, "0"),
    ms: String(d.getMilliseconds()).padStart(3, "0"),
  };
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

/** unix → 在所属 10 分钟桶内的偏移秒数（0..599），用于桶内按精确时间微错落 */
export function secInBucket(unix: number | null): number {
  if (!unix) return 0;
  const d = new Date(unix * 1000);
  return (d.getMinutes() % 10) * 60 + d.getSeconds();
}

/** unix → 当天第几个 10 分钟桶（0..143，本地时区）；无效返回 -1 */
export function bucketOf(unix: number | null): number {
  if (!unix) return -1;
  const d = new Date(unix * 1000);
  return d.getHours() * 6 + Math.floor(d.getMinutes() / 10);
}

/** 某本地日期 YYYY-MM-DD 的当天 [起, 止] unix 秒（本地时区） */
export function dayRange(ymdStr: string): { since: number; until: number } {
  const [y, m, d] = ymdStr.split("-").map(Number);
  const since = Math.floor(new Date(y, (m || 1) - 1, d || 1, 0, 0, 0).getTime() / 1000);
  return { since, until: since + 86399 };
}
