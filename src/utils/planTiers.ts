export interface TierPreset {
  label: string;
  mult: number;
}

// 各 provider 的套餐档位预设（倍率）
export const TIER_PRESETS: Record<string, TierPreset[]> = {
  codex: [
    { label: "Plus", mult: 1 },
    { label: "Pro 5x", mult: 5 },
    { label: "Pro 20x", mult: 20 },
  ],
  claude_code: [
    { label: "Pro", mult: 1 },
    { label: "Max 5x", mult: 5 },
    { label: "Max 20", mult: 20 },
  ],
};

export const tierPresets = (provider: string): TierPreset[] =>
  TIER_PRESETS[provider] ?? TIER_PRESETS.claude_code;

/** 倍率 → 友好标签（找不到预设则显示 Nx） */
export const tierLabel = (provider: string, mult: number): string =>
  tierPresets(provider).find((p) => p.mult === mult)?.label ?? `${mult}x`;
