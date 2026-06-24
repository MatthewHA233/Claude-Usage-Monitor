import type { TimelineRow } from "./types";

// 轨道(列)分配的稳定 key：source + session（跨机器 session_id 不撞，但加 source 更稳）
export const laneKey = (sourceId: string, sessionId: string) => `${sourceId}::${sessionId}`;

export interface LaneAssignment {
  laneOf: Record<string, number>; // laneKey → 列索引
  laneCount: number;
  // 每条轨道(列)上的会话编号集合（按列内首发时间序），列标头展示用
  labelsByLane: string[][];
}

/**
 * 会话 → 轨道(列)：每会话固定一轨；≤3 会话按时间跨度降序(最左=跨度最久=主线, 越右越碎)；
 * >3 占轨复用(时间不重叠的会话共用一轨, git-lane 贪心放最左空闲轨)。
 * 时间轴与卡片流共用同一套，保证轨道严格同序同列。
 */
export function assignLanes(rows: TimelineRow[]): LaneAssignment {
  const sess = rows.map((r) => ({
    key: laneKey(r.source_id, r.session_id),
    start: r.first_unix ?? 0,
    end: r.last_unix ?? 0,
    span: (r.last_unix ?? 0) - (r.first_unix ?? 0),
    label: r.project_seq != null && r.session_seq != null ? `${r.project_seq}-${r.session_seq}` : "—",
  }));
  sess.sort((a, b) => b.span - a.span || a.start - b.start); // 跨度降序，左=久

  const laneOf: Record<string, number> = {};
  const labelsByLane: string[][] = [];
  const pushLabel = (lane: number, label: string) => {
    (labelsByLane[lane] ??= []).push(label);
  };

  if (sess.length <= 3) {
    sess.forEach((s, i) => {
      laneOf[s.key] = i;
      pushLabel(i, s.label);
    });
    return { laneOf, laneCount: Math.max(1, sess.length), labelsByLane };
  }

  // >3：占轨复用——放进最左一条「已空闲(end ≤ 本会话 start)」的轨道
  const laneEnd: number[] = [];
  for (const s of sess) {
    let placed = laneEnd.findIndex((e) => e <= s.start);
    if (placed === -1) {
      laneEnd.push(s.end);
      placed = laneEnd.length - 1;
    } else {
      laneEnd[placed] = s.end;
    }
    laneOf[s.key] = placed;
    pushLabel(placed, s.label);
  }
  return { laneOf, laneCount: Math.max(1, laneEnd.length), labelsByLane };
}

/**
 * 时间轴专用「紧凑」轨道分配（实验中，先只用于左下角缩略图）：
 *  1. 按 first_unix 升序贪心着色，放进最左「已空闲(end ≤ start)」的轨 → 轨道数 = 最大同时重叠，理论最少；
 *  2. 按轨道「充实度」降序重排左右：轨内最充实会话(句数)为主、轨总句数 / 总跨度为次 →
 *     越靠左 = 当天越充实的轨，越靠右 = 越拼凑的碎片轨。
 * 不再对 ≤3 特殊处理（统一复用，进一步压少轨道数）。
 */
export function assignLanesPacked(rows: TimelineRow[]): LaneAssignment {
  const sess = rows.map((r) => {
    const bs = (r.buckets ?? []).map((x) => x.b);
    return {
      key: laneKey(r.source_id, r.session_id),
      start: r.first_unix ?? 0,
      // 占轨用「桶」粒度（10 分钟格），不用秒——否则同格的细小会话(时间不重叠)会被塞进同一轨、撞格
      fb: bs.length ? Math.min(...bs) : 0, // 首桶
      lb: bs.length ? Math.max(...bs) : 0, // 末桶
      span: (r.last_unix ?? 0) - (r.first_unix ?? 0),
      count: r.count ?? 0,
      label: r.project_seq != null && r.session_seq != null ? `${r.project_seq}-${r.session_seq}` : "—",
    };
  });
  if (sess.length === 0) return { laneOf: {}, laneCount: 1, labelsByLane: [] };

  // 1. 最优着色：按起点升序，放最左空闲轨。「空闲」= 轨末桶 ≤ 本会话首桶-2，即两会话至少隔 2 桶(20 分钟)——
  //    留出首桶上方那 1 桶空格给浮动表头(标题)摆放；否则同桶/相邻桶的细小会话标题会没位置、撞一起。
  const byStart = [...sess].sort((a, b) => a.start - b.start || b.span - a.span);
  const laneEnd: number[] = []; // 每轨最后占用的「桶」
  const laneSess: (typeof sess)[] = [];
  const colorLane: Record<string, number> = {};
  for (const s of byStart) {
    let lane = laneEnd.findIndex((e) => e <= s.fb - 2);
    if (lane === -1) {
      lane = laneEnd.length;
      laneEnd.push(s.lb);
      laneSess.push([]);
    } else {
      laneEnd[lane] = s.lb;
    }
    colorLane[s.key] = lane;
    laneSess[lane].push(s);
  }

  // 2. 轨道充实度排序（充实→左）
  const scoreOf = (arr: typeof sess) => ({
    maxCount: Math.max(...arr.map((s) => s.count)),
    sumCount: arr.reduce((a, s) => a + s.count, 0),
    sumSpan: arr.reduce((a, s) => a + s.span, 0),
  });
  const scores = laneSess.map(scoreOf);
  const order = laneSess
    .map((_, i) => i)
    .sort(
      (a, b) =>
        scores[b].maxCount - scores[a].maxCount ||
        scores[b].sumCount - scores[a].sumCount ||
        scores[b].sumSpan - scores[a].sumSpan,
    );
  const remap = new Map<number, number>();
  order.forEach((orig, newIdx) => remap.set(orig, newIdx));

  // 3. 重映射到充实序的新轨号
  const laneOf: Record<string, number> = {};
  for (const s of sess) laneOf[s.key] = remap.get(colorLane[s.key]) ?? 0;
  const labelsByLane: string[][] = laneSess.map(() => []);
  laneSess.forEach((arr, orig) => {
    const nl = remap.get(orig) ?? 0;
    labelsByLane[nl] = [...arr].sort((a, b) => a.start - b.start).map((s) => s.label);
  });

  return { laneOf, laneCount: Math.max(1, laneEnd.length), labelsByLane };
}
