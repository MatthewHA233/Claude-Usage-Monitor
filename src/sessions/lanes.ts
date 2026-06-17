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
