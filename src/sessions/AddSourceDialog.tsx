import { useCallback, useEffect, useState } from "react";
import { X, RefreshCw, Wifi, Monitor, Search } from "lucide-react";
import { DEFAULT_PORT } from "./api";
import { discoverRelays, type DiscoveredRelay } from "./discovery";

interface Props {
  onCancel: () => void;
  onConfirm: (label: string, address: string) => void;
}

export default function AddSourceDialog({ onCancel, onConfirm }: Props) {
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");

  // 局域网发现（mDNS）：打开即扫描，列出在线中继，点一下直接添加
  const [found, setFound] = useState<DiscoveredRelay[]>([]);
  const [scanning, setScanning] = useState(false);

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

  const canConfirm = address.trim().length > 0;

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
            found.map((r) => (
              <button
                key={r.ip}
                type="button"
                onClick={() => onConfirm(r.hostname || r.ip, r.base_url)}
                className="flex items-center gap-2 w-full text-left px-3 py-2"
                style={{ background: "transparent", border: 0, borderBottom: "1px solid #222", cursor: "pointer" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#202020")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <Monitor size={14} style={{ color: "#4ade80", flexShrink: 0 }} />
                <div className="min-w-0 flex-1">
                  <div className="text-xs truncate" style={{ color: "#e5e7eb" }}>
                    {r.hostname || r.ip}
                    {r.os ? <span style={{ color: "#6b7280" }}> · {r.os}</span> : null}
                  </div>
                  <div className="text-[10px] font-mono truncate" style={{ color: "#6b7280" }}>{r.ip}:{r.port}</div>
                </div>
                <Wifi size={13} style={{ color: "#4ade80", flexShrink: 0 }} />
              </button>
            ))
          )}
        </div>

        <div className="text-[11px] mb-3 text-center" style={{ color: "#4b5563" }}>— 或手动填写 —</div>

        <label className="block text-xs mb-1" style={{ color: "#9ca3af" }}>名称（可选）</label>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="例如 我的 MacBook"
          className="w-full text-sm rounded-md px-3 py-2 mb-3 outline-none"
          style={{ background: "#161616", border: "1px solid #333", color: "#f3f4f6" }}
        />

        <label className="block text-xs mb-1" style={{ color: "#9ca3af" }}>地址（IP 或 IP:端口）</label>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder={`例如 192.168.1.20:${DEFAULT_PORT}`}
          className="w-full text-sm rounded-md px-3 py-2 outline-none"
          style={{ background: "#161616", border: "1px solid #333", color: "#f3f4f6" }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canConfirm) onConfirm(label.trim(), address.trim());
          }}
        />
        <div className="text-[11px] mt-1.5" style={{ color: "#6b7280" }}>
          只填 IP 会自动补端口 {DEFAULT_PORT}。目标机器需运行 session_api_server.py。
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button
            type="button"
            onClick={onCancel}
            className="text-sm px-3 py-1.5 rounded-md"
            style={{ color: "#cbd5e1", background: "#262626", border: "1px solid #333", cursor: "pointer" }}
          >
            取消
          </button>
          <button
            type="button"
            disabled={!canConfirm}
            onClick={() => onConfirm(label.trim(), address.trim())}
            className="text-sm px-3 py-1.5 rounded-md"
            style={{
              color: "#fff",
              background: canConfirm ? "#cc785c" : "#3a3a3a",
              border: "1px solid #333",
              cursor: canConfirm ? "pointer" : "not-allowed",
            }}
          >
            添加
          </button>
        </div>
      </div>
    </div>
  );
}
