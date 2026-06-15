// 会话数据类型：均对应 Rust 物化层命令的返回（snake_case 与后端一致）

export interface SessionSource {
  id: string;
  label: string;
  base_url: string;
}

// ---- 发言流（session_my_messages） ----

export interface MyMessage {
  session_id: string;
  source_id: string;
  project_name: string;
  project_path: string;
  ts: string;
  ts_unix: number | null;
  local_date: string;
  text: string;
  chars: number;
  reply: string;
  reply_chars: number;
  images: string[];
}

export interface MyMessagesResponse {
  total: number;
  offset: number;
  limit: number;
  items: MyMessage[];
}

/** 附上来源显示名（前端按 source_id 解析后塞入） */
export interface StreamMessage extends MyMessage {
  source_label: string;
}

// ---- 会话时间轴（session_timeline，单日对齐） ----

export interface TimelineBucket {
  b: number; // 当天第几个 10 分钟（0..143）
  n: number; // 该桶内我的发言条数
}

export interface TimelineRow {
  session_id: string;
  source_id: string;
  title: string;
  project_name: string;
  project_path: string;
  first_unix: number | null;
  last_unix: number | null;
  count: number;
  buckets: TimelineBucket[];
}

export interface TimelineResponse {
  date: string;
  sessions: TimelineRow[];
}

export interface TimelineRowWithSource extends TimelineRow {
  source_label: string;
}

// ---- 统计（session_stats） ----

export interface DailyStat {
  date: string;
  count: number;
  chars: number;
}

export interface StatsResponse {
  days: DailyStat[];
}

// ---- 来源状态（session_status） ----

export interface SourceStatus {
  id: string;
  label: string;
  online: boolean;
  hostname: string;
  os: string;
  session_count: number;
  project_count: number;
}

// ---- 同步状态（session_sync_state） ----

export interface SyncState {
  syncing: boolean;
  total: number;
}

// ---- 发言流过滤器（来自会话时间轴的点击） ----

export interface StreamFilter {
  source?: string; // 来源 id（小时表头=全局，不限来源时省略）
  session?: string; // 单会话过滤
  since?: number; // 时间区间（1 小时单元格 / 整列）
  until?: number;
  label: string; // 顶部 banner 展示
}
