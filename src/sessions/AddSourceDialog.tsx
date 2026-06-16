import { useCallback, useEffect, useState } from "react";
import { X, RefreshCw, Wifi, Monitor, Search } from "lucide-react";
import { getSources, normalizeBaseUrl } from "./api";
import { discoverRelays, type DiscoveredRelay } from "./discovery";

interface Props {
  onCancel: () => void;
  onConfirm: (label: string, address: string) => void;
}

export default function AddSourceDialog({ onCancel, onConfirm }: Props) {
  // 局域网发现（mDNS）：打开即扫描，列出在线中继，点一下直接添加
  const [found, setFound] = useState<DiscoveredRelay[]>([]);
  const [scanning, setScanning] = useState(false);
  const [existing, setExisting] = useState<string[]>([]); // 已添加来源的 base_url（去重用）

  useEffect(() => {
    void getSources().then((ss) => setExisting(ss.map((s) => s.base_url))).catch(() => undefined);
  }, []);

  const scan = useCallback(() => {
    setScanning(true);
    discoverRelays()
      .then(setFound)
      .catch(() => setFound([]))
      .finally(() => setScanning(false));
  }, []);

  useEffect(() => {
    scan();
  }, [scan]);

  return (
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 200, background: "rgba(0,0,0,0.55)" }}
      onClick={onCancel}
    >
      <div
        className="rounded-xl p-5"
        style={{ width: 440, background: "#1f1f1f", border: "1px solid #333" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="text-sm font-semibold" style={{ color: "#f3f4f6" }}>添加会话来源</div>
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center justify-center"
            style={{ width: 24, height: 24, borderRadius: 6, color: "#9ca3af", background: "transparent", border: 0, cursor: "pointer" }}
          >
            <X size={14} />
          </button>
        </div>

        {/* 局域网发现 */}
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-1.5 text-xs" style={{ color: "#9ca3af" }}>
            <Search size={13} /> 局域网发现
          </div>
          <button
            type="button"
            onClick={scan}
            disabled={scanning}
            className="inline-flex items-center gap-1 text-[11px]"
            style={{ color: "#9ca3af", background: "#262626", border: "1px solid #333", borderRadius: 6, padding: "2px 8px", cursor: scanning ? "default" : "pointer" }}
          >
            <RefreshCw size={11} className={scanning ? "animate-spin" : undefined} /> {scanning ? "扫描中" : "重新扫描"}
          </button>
        </div>
        <div
          className="rounded-md mb-3 overflow-auto"
          style={{ background: "#161616", border: "1px solid #2a2a2a", maxHeight: 168 }}
        >
          {found.length === 0 ? (
            <div className="text-[11px] px-3 py-4 text-center" style={{ color: "#6b7280" }}>
              {scanning ? "正在扫描局域网…" : "未发现在线中继。确保对端 Claude 启动器已运行（会自动开中继）。"}
            </div>
          ) : (
            found.map((r) => {
              const matched = existing.includes(normalizeBaseUrl(r.base_url));
              return (
                <button
                  key={r.ip}
                  type="button"
                  disabled={matched}
                  onClick={() => { if (!matched) onConfirm(r.hostname || r.ip, r.base_url); }}
                  className="flex items-center gap-2 w-full text-left px-3 py-2"
                  style={{ background: "transparent", border: 0, borderBottom: "1px solid #222", cursor: matched ? "default" : "pointer", opacity: matched ? 0.55 : 1 }}
                  onMouseEnter={(e) => { if (!matched) e.currentTarget.style.background = "#202020"; }}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <Monitor size={14} style={{ color: matched ? "#6b7280" : "#4ade80", flexShrink: 0 }} />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs truncate" style={{ color: "#e5e7eb" }}>
                      {r.hostname || r.ip}
                      {r.os ? <span style={{ color: "#6b7280" }}> · {r.os}</span> : null}
                    </div>
                    <div className="text-[10px] font-mono truncate" style={{ color: "#6b7280" }}>{r.ip}:{r.port}</div>
                  </div>
                  {matched
                    ? <span className="text-[10px] shrink-0" style={{ color: "#6b7280" }}>已匹配</span>
                    : <Wifi size={13} style={{ color: "#4ade80", flexShrink: 0 }} />}
                </button>
              );
            })
          )}
        </div>

        <div className="text-[11px] mb-1" style={{ color: "#6b7280" }}>
          找不到机器?确保对端 Claude 启动器已运行(会自动开中继),再点「重新扫描」。
        </div>

        <div className="flex justify-end mt-4">
          <button
            type="button"
            onClick={onCancel}
            className="text-sm px-3 py-1.5 rounded-md"
            style={{ color: "#cbd5e1", background: "#262626", border: "1px solid #333", cursor: "pointer" }}
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
