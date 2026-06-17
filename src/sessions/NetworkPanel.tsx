import { useCallback, useEffect, useState } from "react";
import { X, RefreshCw, Wifi, WifiOff, Monitor, Search, Pencil, Trash2, Check } from "lucide-react";
import { getSources, normalizeBaseUrl } from "./api";
import { discoverRelays, type DiscoveredRelay } from "./discovery";
import type { SourceStatus } from "./types";

// 本机隐式来源（不可改名/删除）
const LOCAL_IDS = new Set(["local", "history"]);

interface Props {
  sourceStatuses: SourceStatus[];
  onAdd: (label: string, address: string) => void;
  onRename: (id: string, label: string) => void;
  onDelete: (id: string, label: string) => void;
  onClose: () => void;
}

/** 连接管理：跨机器状态总览 + 本机/已添加列表（改名/删除）+ 局域网发现新建，全在一个面板 */
export default function NetworkPanel({ sourceStatuses, onAdd, onRename, onDelete, onClose }: Props) {
  const [found, setFound] = useState<DiscoveredRelay[]>([]);
  const [scanning, setScanning] = useState(false);
  const [existing, setExisting] = useState<string[]>([]); // 已添加来源的 base_url（去重）
  const [editId, setEditId] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");

  // sourceStatuses 变化（添加/删除后）重取已添加地址，发现列表据此过滤掉已匹配的
  useEffect(() => {
    void getSources().then((ss) => setExisting(ss.map((s) => s.base_url))).catch(() => undefined);
  }, [sourceStatuses]);

  const scan = useCallback(() => {
    setScanning(true);
    discoverRelays().then(setFound).catch(() => setFound([])).finally(() => setScanning(false));
  }, []);
  useEffect(() => {
    scan();
  }, [scan]);

  const remotes = sourceStatuses.filter((s) => !LOCAL_IDS.has(s.id));
  const onlineRemotes = remotes.filter((s) => s.online);
  const freshFound = found.filter((r) => !existing.includes(normalizeBaseUrl(r.base_url)));

  let statusText: string;
  let statusColor: string;
  if (onlineRemotes.length > 0) {
    statusText = `已连接 ${onlineRemotes.length} 台其它机器`;
    statusColor = "#4ade80";
  } else if (remotes.length > 0) {
    statusText = `已配置 ${remotes.length} 台 · 当前都离线`;
    statusColor = "#f59e0b";
  } else if (freshFound.length > 0) {
    statusText = `发现 ${freshFound.length} 台可连接`;
    statusColor = "#60a5fa";
  } else {
    statusText = "未发现其它机器";
    statusColor = "#6b7280";
  }

  const commitEdit = () => {
    if (editId && editVal.trim()) onRename(editId, editVal.trim());
    setEditId(null);
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center" style={{ zIndex: 200, background: "rgba(0,0,0,0.55)" }} onClick={onClose}>
      <div
        className="rounded-xl p-5"
        style={{ width: 460, maxHeight: "82vh", overflow: "auto", background: "#1f1f1f", border: "1px solid #333" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <div className="text-sm font-semibold" style={{ color: "#f3f4f6" }}>连接管理</div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center"
            style={{ width: 24, height: 24, borderRadius: 6, color: "#9ca3af", background: "transparent", border: 0, cursor: "pointer" }}
          >
            <X size={14} />
          </button>
        </div>

        {/* 状态总览 */}
        <div className="flex items-center gap-1.5 mb-4 text-xs">
          <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: 7, background: statusColor }} />
          <span style={{ color: statusColor }}>{statusText}</span>
        </div>

        {/* 本机 / 已添加 */}
        <div className="text-[11px] mb-1.5" style={{ color: "#6b7280" }}>本机 / 已添加</div>
        <div className="rounded-md mb-4 overflow-hidden" style={{ border: "1px solid #2a2a2a", background: "#161616" }}>
          {sourceStatuses.map((s) => {
            const editable = !LOCAL_IDS.has(s.id);
            if (editId === s.id) {
              return (
                <div key={s.id} className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: "1px solid #222" }}>
                  <input
                    autoFocus
                    value={editVal}
                    onChange={(e) => setEditVal(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEdit();
                      else if (e.key === "Escape") setEditId(null);
                    }}
                    onBlur={commitEdit}
                    className="flex-1 rounded px-2 py-1 text-xs outline-none"
                    style={{ background: "#232323", color: "#eee", border: "1px solid #5fd3e0" }}
                  />
                  <button type="button" onClick={commitEdit} className="inline-flex items-center" style={{ color: "#4ade80", background: "transparent", border: 0, cursor: "pointer" }}>
                    <Check size={14} />
                  </button>
                </div>
              );
            }
            return (
              <div key={s.id} className="group flex items-center gap-2 px-3 py-2" style={{ borderBottom: "1px solid #222" }}>
                {s.online ? (
                  <Wifi size={14} style={{ color: "#4ade80", flexShrink: 0 }} />
                ) : (
                  <WifiOff size={14} style={{ color: "#f87171", flexShrink: 0 }} />
                )}
                <span className="truncate flex-1 text-xs" style={{ color: "#e5e7eb" }}>{s.label}</span>
                <span className="text-[10px] tabular-nums group-hover:hidden" style={{ color: "#6b7280" }}>
                  {s.online ? `${s.session_count} 会话` : "离线"}
                </span>
                {editable && (
                  <span className="hidden group-hover:inline-flex items-center gap-2 shrink-0">
                    <button type="button" title="改名" onClick={() => { setEditId(s.id); setEditVal(s.label); }} className="inline-flex items-center" style={{ color: "#9ca3af", background: "transparent", border: 0, cursor: "pointer" }}>
                      <Pencil size={12} />
                    </button>
                    <button type="button" title="删除该机器（含全部数据）" onClick={() => onDelete(s.id, s.label)} className="inline-flex items-center" style={{ color: "#f87171", background: "transparent", border: 0, cursor: "pointer" }}>
                      <Trash2 size={13} />
                    </button>
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* 局域网发现 → 新建连接 */}
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-1.5 text-xs" style={{ color: "#9ca3af" }}>
            <Search size={13} /> 新建连接（局域网发现）
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
        <div className="rounded-md overflow-auto" style={{ background: "#161616", border: "1px solid #2a2a2a", maxHeight: 168 }}>
          {freshFound.length === 0 ? (
            <div className="text-[11px] px-3 py-4 text-center" style={{ color: "#6b7280" }}>
              {scanning ? "正在扫描局域网…" : "未发现可添加的中继。确保对端 Claude 启动器已运行（会自动开中继）。"}
            </div>
          ) : (
            freshFound.map((r) => (
              <button
                key={r.ip}
                type="button"
                onClick={() => onAdd(r.hostname || r.ip, r.base_url)}
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
      </div>
    </div>
  );
}
