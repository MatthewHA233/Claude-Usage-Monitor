import { invoke } from "@tauri-apps/api/core";
import type {
  SessionSource,
  MyMessagesResponse,
  TimelineResponse,
  StatsResponse,
  SourceStatus,
  StreamFilter,
  SyncState,
} from "./types";

// 远程薄中继默认端口（添加来源时补全用）
export const DEFAULT_PORT = 47800;

export function getSources(): Promise<SessionSource[]> {
  return invoke<SessionSource[]>("session_sources_get");
}

export function saveSources(sources: SessionSource[]): Promise<void> {
  return invoke<void>("session_sources_save", { sources });
}

/** 各来源在线状态 + 计数（本机恒在线，远程实时心跳） */
export function fetchStatus(): Promise<SourceStatus[]> {
  return invoke<SourceStatus[]>("session_status");
}

/** 物化库同步状态（首次全量解析时 syncing=true，供「初始化中」提示） */
export function fetchSyncState(): Promise<SyncState> {
  return invoke<SyncState>("session_sync_state");
}

/** 发言流（已在 Rust 侧跨源合并、倒序）。filter 来自会话时间轴的会话/小时过滤。 */
export function fetchMyMessages(
  limit = 400,
  offset = 0,
  filter: Partial<StreamFilter> = {}
) {
  return invoke<MyMessagesResponse>("session_my_messages", {
    limit,
    offset,
    source: filter.source ?? null,
    session: filter.session ?? null,
    since: filter.since ?? null,
    until: filter.until ?? null,
  });
}

/** 会话时间轴（某本地日期） */
export function fetchTimeline(date: string, source?: string) {
  return invoke<TimelineResponse>("session_timeline", { date, source: source ?? null });
}

/** 按天发言统计 */
export function fetchStats(source?: string) {
  return invoke<StatsResponse>("session_stats", { source: source ?? null });
}

/** 读取本机图片为 data URL（[Image #N] 悬浮预览） */
export function fetchImage(path: string): Promise<string> {
  return invoke<string>("session_image", { path });
}

/** 把用户输入（ip、ip:port、http://...）规整为远程中继 base_url */
export function normalizeBaseUrl(input: string): string {
  let s = input.trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) {
    s = `http://${s}`;
  }
  const withoutScheme = s.replace(/^https?:\/\//i, "");
  if (!withoutScheme.includes(":")) {
    s = `${s}:${DEFAULT_PORT}`;
  }
  return s.replace(/\/+$/, "");
}
