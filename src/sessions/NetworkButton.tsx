import { useCallback, useEffect, useState } from "react";
import { Wifi, WifiOff } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import NetworkPanel from "./NetworkPanel";
import { getSources, saveSources, fetchStatus, normalizeBaseUrl } from "./api";
import { probeSource } from "./discovery";
import type { SessionSource, SourceStatus } from "./types";

// 本机隐式来源（不计入「远程离线」判断）
const LOCAL_IDS = new Set(["local", "history"]);
const POLL_MS = 15_000;

/**
 * 自包含「连接管理」入口：wifi 状态按钮 + 弹出 NetworkPanel（跨机器源的增删改 / 局域网发现）。
 * token 用量与会话共用同一份 session_sources，故主窗口、会话窗口都能直接放一个本组件。
 * 自己轮询 session_status、自己读写 session_sources，不依赖外部状态。
 */
export default function NetworkButton() {
  const [statuses, setStatuses] = useState<SourceStatus[]>([]);
  const [open, setOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; label: string } | null>(null);

  const refresh = useCallback(() => {
    fetchStatus()
      .then((ss) => setStatuses(ss.filter((s) => s.id !== "history")))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const anyRemoteOffline = statuses.some((s) => !LOCAL_IDS.has(s.id) && !s.online);

  const onAdd = useCallback(
    async (label: string, address: string, machineId?: string) => {
      const base_url = normalizeBaseUrl(address);
      if (!base_url) return;
      const current = await getSources().catch(() => [] as SessionSource[]);
      // 机器稳定 id：发现路径直接带；手动填地址则连一下 /api/info 拿。拿到就用它当源的绑定 id。
      let mid = machineId || "";
      if (!mid) mid = await probeSource(base_url).then((p) => p.machine_id).catch(() => "");
      // 已配对：machine_id 命中已有源 → 同一台设备(只是换了 IP)，只更新 base_url、不新增、历史数据不丢
      if (mid) {
        const exist = current.find((s) => s.id === mid);
        if (exist) {
          if (exist.base_url !== base_url) {
            await saveSources(current.map((s) => (s.id === mid ? { ...s, base_url } : s))).catch(() => undefined);
          }
          refresh();
          return;
        }
      }
      if (current.some((s) => s.base_url === base_url)) return; // 同地址去重
      const id = mid || crypto.randomUUID();
      const next = [...current, { id, label: label || base_url.replace(/^https?:\/\//, ""), base_url }];
      await saveSources(next).catch(() => undefined);
      refresh();
    },
    [refresh],
  );

  const onRename = useCallback(
    async (id: string, label: string) => {
      const current = await getSources().catch(() => [] as SessionSource[]);
      await saveSources(current.map((s) => (s.id === id ? { ...s, label } : s))).catch(() => undefined);
      refresh();
    },
    [refresh],
  );

  // 删除先弹确认（清掉它在会话物化库 + token 缓存里的全部数据），确认后落实
  const confirmDelete = useCallback(async () => {
    const pd = pendingDelete;
    setPendingDelete(null);
    if (!pd) return;
    await invoke("session_purge_source", { sourceId: pd.id }).catch(() => undefined);
    await invoke("token_purge_source", { sourceId: pd.id }).catch(() => undefined);
    const current = await getSources().catch(() => [] as SessionSource[]);
    await saveSources(current.filter((s) => s.id !== pd.id)).catch(() => undefined);
    refresh();
  }, [pendingDelete, refresh]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={anyRemoteOffline ? "有机器离线 · 连接管理" : "连接管理"}
        className="inline-flex items-center justify-center"
        style={{ width: 30, height: 30, borderRadius: 6, border: "1px solid #3a3a3a", background: "#202020", cursor: "pointer" }}
      >
        {anyRemoteOffline ? <WifiOff size={15} style={{ color: "#f87171" }} /> : <Wifi size={15} style={{ color: "#4ade80" }} />}
      </button>

      {open && (
        <NetworkPanel
          sourceStatuses={statuses}
          onAdd={onAdd}
          onRename={onRename}
          onDelete={(id, label) => setPendingDelete({ id, label })}
          onClose={() => setOpen(false)}
        />
      )}

      {pendingDelete && (
        <div
          className="fixed inset-0 flex items-center justify-center"
          style={{ zIndex: 210, background: "rgba(0,0,0,0.55)" }}
          onClick={() => setPendingDelete(null)}
        >
          <div
            className="rounded-xl p-5"
            style={{ width: 360, background: "#1f1f1f", border: "1px solid #333" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-semibold mb-2" style={{ color: "#f3f4f6" }}>删除来源</div>
            <div className="text-xs mb-4" style={{ color: "#9ca3af", lineHeight: 1.6 }}>
              删除「<span style={{ color: "#e5e7eb" }}>{pendingDelete.label}</span>」及其
              <b style={{ color: "#f87171" }}>全部已采集数据</b>?此操作不可撤销。
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className="text-sm px-3 py-1.5 rounded-md"
                style={{ color: "#cbd5e1", background: "#262626", border: "1px solid #333", cursor: "pointer" }}
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void confirmDelete()}
                className="text-sm px-3 py-1.5 rounded-md font-semibold"
                style={{ color: "#fff", background: "#b9402f", border: 0, cursor: "pointer" }}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
