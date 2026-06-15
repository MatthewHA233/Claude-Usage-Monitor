//! 局域网 mDNS 发现：浏览 `_claude-relay._tcp.local`，列出在线的会话中继，
//! 供「添加会话来源」零配置发现 macOS/其它机器（对端用 Bonjour/dns-sd 广播）。
//!
//! 纯客户端浏览，不广播本机；只读不改物化库。独立成模块，避免与 session_store 撞车。

use std::collections::HashMap;
use std::time::{Duration, Instant};

use mdns_sd::{ServiceDaemon, ServiceEvent};
use serde::Serialize;

const SERVICE_TYPE: &str = "_claude-relay._tcp.local.";

#[derive(Serialize)]
pub struct DiscoveredRelay {
    pub hostname: String,
    pub os: String,
    pub base_url: String,
    pub ip: String,
    pub port: u16,
}

/// 浏览局域网内的会话中继，timeout 毫秒（默认 2500，区间 [500, 8000]）。
#[tauri::command]
pub async fn session_discover_relays(timeout: Option<u64>) -> Result<Vec<DiscoveredRelay>, String> {
    let dur = Duration::from_millis(timeout.unwrap_or(2500).clamp(500, 8000));
    tokio::task::spawn_blocking(move || browse(dur))
        .await
        .map_err(|e| e.to_string())?
}

fn browse(timeout: Duration) -> Result<Vec<DiscoveredRelay>, String> {
    let mdns = ServiceDaemon::new().map_err(|e| format!("mDNS 启动失败: {e}"))?;
    let receiver = mdns
        .browse(SERVICE_TYPE)
        .map_err(|e| format!("mDNS 浏览失败: {e}"))?;

    let deadline = Instant::now() + timeout;
    // 按 IP 去重（一台机器多网卡会解析出多个地址）
    let mut found: HashMap<String, DiscoveredRelay> = HashMap::new();

    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match receiver.recv_timeout(remaining) {
            Ok(ServiceEvent::ServiceResolved(info)) => {
                let port = info.get_port();
                let host = info.get_hostname().trim_end_matches('.').to_string();
                let os = info
                    .get_properties()
                    .get_property_val_str("os")
                    .unwrap_or("")
                    .to_string();
                for addr in info.get_addresses() {
                    if addr.is_ipv4() {
                        let ip = addr.to_string();
                        let base_url = format!("http://{ip}:{port}");
                        found.entry(ip.clone()).or_insert_with(|| DiscoveredRelay {
                            hostname: host.clone(),
                            os: os.clone(),
                            base_url,
                            ip,
                            port,
                        });
                    }
                }
            }
            Ok(_) => {}
            Err(_) => break, // 超时或通道关闭
        }
    }

    let _ = mdns.shutdown();
    let mut list: Vec<DiscoveredRelay> = found.into_values().collect();
    list.sort_by(|a, b| a.hostname.cmp(&b.hostname).then(a.ip.cmp(&b.ip)));
    Ok(list)
}
