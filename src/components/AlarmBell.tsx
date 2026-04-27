import { Bell, BellOff, BellRing } from "lucide-react";

interface BellProps {
  enabled: boolean;
  ringing: boolean;
  onToggle: () => void;
}

export function AlarmBell({ enabled, ringing, onToggle }: BellProps) {
  const color = ringing ? "#ef4444" : enabled ? "#fbbf24" : "#888";
  const label = ringing ? "响铃中" : enabled ? "已开启提醒" : "到点提醒";
  const title = ringing
    ? "Session 重置时间到（点击横幅停止全部）"
    : enabled
    ? "已开启 Session 重置提醒，点击关闭"
    : "点击开启 Session 到点提醒（到点会循环响铃，可统一停止）";
  const Icon = ringing ? BellRing : enabled ? Bell : BellOff;
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      title={title}
      className={ringing ? "alarm-ringing" : ""}
      style={{
        background: "transparent", border: `1px solid ${enabled || ringing ? color + "55" : "#333"}`,
        padding: "1px 6px 1px 5px", borderRadius: 10,
        cursor: "pointer", color, lineHeight: 1,
        display: "inline-flex", alignItems: "center", gap: 4,
        fontSize: 11,
      }}
    >
      <Icon size={11} strokeWidth={2.2} />
      <span>{label}</span>
    </button>
  );
}

interface BannerProps {
  ringingAliases: string[];
  colors: Record<string, string>;
  onStop: () => void;
}

export function AlarmBanner({ ringingAliases, colors, onStop }: BannerProps) {
  if (ringingAliases.length === 0) return null;
  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0, zIndex: 9999,
      background: "#1f1410",
      borderBottom: "1px solid #3a2a26",
      height: 36,
      display: "flex", alignItems: "center",
      padding: "0 12px",
      fontSize: 12,
    }}>
      <span className="alarm-dot" style={{
        width: 7, height: 7, borderRadius: "50%",
        background: "#ef4444", marginRight: 10, flexShrink: 0,
      }} />
      <span style={{ color: "#ddd", marginRight: 10, flexShrink: 0 }}>
        Session 到点
      </span>
      <span style={{
        display: "flex", gap: 6, flexWrap: "wrap", flex: 1,
        minWidth: 0, overflow: "hidden",
      }}>
        {ringingAliases.map(a => (
          <span key={a} style={{
            color: colors[a] ?? "#bbb",
            fontFamily: "monospace",
            fontWeight: 600,
          }}>
            {a}
          </span>
        ))}
      </span>
      <button
        onClick={onStop}
        style={{
          marginLeft: 12, padding: "3px 14px", borderRadius: 4,
          background: "transparent",
          color: "#ddd",
          border: "1px solid #555",
          fontSize: 12, cursor: "pointer",
          flexShrink: 0,
        }}
      >
        停止
      </button>
    </div>
  );
}
