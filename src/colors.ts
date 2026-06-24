// 机器配色（本机 + 各远程机器）：token 用量面板与会话时间轴共用此函数，
// 保证同一台机器在两处同色。避开绿与紫/橙——紫是 Codex、橙是 Claude 的 provider 色，
// 机器色都避开以免与 provider 撞色；绿留作他用。远程机器不超过 4 台，4 色够分。
const LOCAL_MACHINE_COLOR = "#3b82f6"; // 本机固定蓝
const REMOTE_MACHINE_COLORS = ["#22d3ee", "#f472b6", "#fbbf24", "#fb7185"]; // 青 / 粉 / 琥珀 / 玫红

/** 按机器名取稳定色：本机固定蓝，远程按名字 hash 在调色板里取。避开绿/紫/橙。 */
export function machineColor(source: string): string {
  if (!source || source === "本机" || source === "local") return LOCAL_MACHINE_COLOR;
  let h = 0;
  for (let i = 0; i < source.length; i++) h = (h * 31 + source.charCodeAt(i)) >>> 0;
  return REMOTE_MACHINE_COLORS[h % REMOTE_MACHINE_COLORS.length];
}
