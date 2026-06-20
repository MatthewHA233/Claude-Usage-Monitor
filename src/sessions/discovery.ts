import { invoke } from "@tauri-apps/api/core";

/** 局域网 mDNS 发现到的一台会话中继 */
export interface DiscoveredRelay {
  hostname: string;
  os: string;
  machine_id: string; // 机器稳定 id（mDNS TXT 的 mid）：换 IP 也是同一设备
  base_url: string;
  ip: string;
  port: number;
}

/** 浏览局域网内在线的会话中继（对端需用 Bonjour/dns-sd 广播 _claude-relay._tcp） */
export function discoverRelays(timeout = 2500): Promise<DiscoveredRelay[]> {
  return invoke<DiscoveredRelay[]>("session_discover_relays", { timeout });
}

/** 探测一个中继地址：在线则返回 machine_id+hostname+os（手动添加来源时拿稳定绑定 id 用） */
export interface SourceProbe {
  online: boolean;
  machine_id: string;
  hostname: string;
  os: string;
}
export function probeSource(base_url: string): Promise<SourceProbe> {
  return invoke<SourceProbe>("session_probe", { baseUrl: base_url });
}
