import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useProxySettings } from "../hooks/useData";

interface Props {
  onClose: () => void;
  onSaved?: () => void;
}

const DEFAULT_PROXY_URL = "http://127.0.0.1:7890";

export default function SettingsModal({ onClose, onSaved }: Props) {
  const { settings, saving, error, save } = useProxySettings();
  const [enabled, setEnabled] = useState(true);
  const [url, setUrl] = useState(DEFAULT_PROXY_URL);
  const [hydrated, setHydrated] = useState(false);
  const [savedTick, setSavedTick] = useState(false);

  // 首次拿到后端配置后填充表单
  useEffect(() => {
    if (settings && !hydrated) {
      setEnabled(settings.enabled);
      setUrl(settings.url || DEFAULT_PROXY_URL);
      setHydrated(true);
    }
  }, [settings, hydrated]);

  const handleSave = async () => {
    const ok = await save(enabled, url.trim() || DEFAULT_PROXY_URL);
    if (ok) {
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 1400);
      onSaved?.();
    }
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 300, background: "rgba(0,0,0,0.55)" }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(440px, calc(100vw - 32px))",
          background: "#1c1c1c",
          border: "1px solid #3a3a3a",
          borderRadius: 12,
          boxShadow: "0 24px 70px rgba(0,0,0,0.6)",
          overflow: "hidden",
        }}
      >
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: "1px solid #2e2e2e" }}>
          <span className="text-sm font-semibold" style={{ color: "#eee" }}>设置 · 网络代理</span>
          <button
            onClick={onClose}
            className="inline-flex items-center justify-center"
            style={{ width: 26, height: 26, border: 0, background: "transparent", color: "#999", cursor: "pointer" }}
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-4 py-4 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm" style={{ color: "#ddd" }}>本应用请求走代理</div>
              <div className="text-xs mt-0.5" style={{ color: "#888" }}>
                CLI 采集（Claude / Codex 额度）的请求经此代理发出
              </div>
            </div>
            <button
              onClick={() => setEnabled((v) => !v)}
              role="switch"
              aria-checked={enabled}
              style={{
                width: 44,
                height: 24,
                borderRadius: 999,
                border: "none",
                cursor: "pointer",
                background: enabled ? "#4ade80" : "#444",
                position: "relative",
                transition: "background 0.2s",
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  position: "absolute",
                  top: 2,
                  left: enabled ? 22 : 2,
                  width: 20,
                  height: 20,
                  borderRadius: "50%",
                  background: "#fff",
                  transition: "left 0.2s",
                }}
              />
            </button>
          </div>

          <div>
            <label className="text-xs" style={{ color: "#aaa" }}>代理地址</label>
            <input
              type="text"
              value={url}
              disabled={!enabled}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={DEFAULT_PROXY_URL}
              spellCheck={false}
              style={{
                width: "100%",
                marginTop: 6,
                background: enabled ? "#141414" : "#1a1a1a",
                border: "1px solid #3a3a3a",
                borderRadius: 8,
                padding: "8px 10px",
                color: enabled ? "#e8e8e8" : "#666",
                fontSize: 13,
                fontFamily: "monospace",
                outline: "none",
              }}
            />
            <div className="text-xs mt-2" style={{ color: "#777", lineHeight: 1.6 }}>
              关闭后回退到系统/环境变量代理检测。<br />
              注：浏览器插件采集走浏览器自身的代理，不受此处控制。
            </div>
          </div>

          {error && (
            <div className="text-xs px-2 py-1.5 rounded" style={{ background: "#3d1a1a", color: "#f87171" }}>
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              onClick={onClose}
              className="text-xs px-3 py-1.5 rounded-md"
              style={{ background: "#2c2c2c", color: "#bbb", border: "1px solid #444", cursor: "pointer" }}
            >
              取消
            </button>
            <button
              onClick={() => void handleSave()}
              disabled={saving}
              className="text-xs px-3 py-1.5 rounded-md"
              style={{
                background: savedTick ? "#1f3a2c" : "#cc785c",
                color: savedTick ? "#86efac" : "#fff",
                border: "none",
                cursor: saving ? "not-allowed" : "pointer",
                opacity: saving ? 0.6 : 1,
                minWidth: 64,
              }}
            >
              {savedTick ? "已保存" : saving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
