import { Bell, BellOff, BellRing } from "lucide-react";

interface BellProps {
  enabled: boolean;
  ringing: boolean;
  onToggle: () => void;
  onStop?: () => void;
}

export function AlarmBell({ enabled, ringing, onToggle, onStop }: BellProps) {
  const color = ringing ? "#ef4444" : enabled ? "#fbbf24" : "#888";
  const title = ringing
    ? "Session 重置时间到，点击停止响铃"
    : enabled
    ? "已开启 Session 重置提醒，点击关闭"
    : "点击开启 Session 到点提醒（到点会循环响铃）";
  const Icon = ringing ? BellRing : enabled ? Bell : BellOff;
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        if (ringing && onStop) onStop();
        else onToggle();
      }}
      title={title}
      className={ringing ? "alarm-ringing" : ""}
      style={{
        width: 18,
        height: 18,
        background: enabled || ringing ? `${color}14` : "transparent",
        border: `1px solid ${enabled || ringing ? color + "66" : "#333"}`,
        borderRadius: 999,
        cursor: "pointer",
        color,
        lineHeight: 1,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <Icon size={11} strokeWidth={2.2} />
    </button>
  );
}
