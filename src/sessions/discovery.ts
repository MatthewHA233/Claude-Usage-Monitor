import { invoke } from "@tauri-apps/api/core";

/** 局域网 mDNS 发现到的一台会话中继 */
export interface DiscoveredRelay {
  hostname: string;
  os: string;
  base_url: string;
  ip: string;
  port: number;
}

/** 浏览局域网内在线的会话中继（对端需用 Bonjour/dns-sd 广播 _claude-relay._tcp） */
export function discoverRelays(timeout = 2500): Promise<DiscoveredRelay[]> {
  return invoke<DiscoveredRelay[]>("session_discover_relays", { timeout });
}
