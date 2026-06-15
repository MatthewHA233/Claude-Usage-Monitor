import { useState } from "react";
import { X } from "lucide-react";
import { DEFAULT_PORT } from "./api";

interface Props {
  onCancel: () => void;
  onConfirm: (label: string, address: string) => void;
}

export default function AddSourceDialog({ onCancel, onConfirm }: Props) {
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");

  const canConfirm = address.trim().length > 0;

  return (
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 200, background: "rgba(0,0,0,0.55)" }}
      onClick={onCancel}
    >
      <div
        className="rounded-xl p-5"
        style={{ width: 420, background: "#1f1f1f", border: "1px solid #333" }}
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
          autoFocus
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
