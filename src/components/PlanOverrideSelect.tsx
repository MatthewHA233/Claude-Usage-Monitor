import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { tierPresets } from "../utils/planTiers";

/**
 * 账号「当前档位」手动覆盖：一个下拉,选 自动 / Plus / Pro5x / …。
 * 仅作用于**今后采集**（采集时用此倍率算 5x/20x 归一化百分比），不重写历史。
 * 用于自动识别不出档位的账号（如新装机 Max20 被记成 Pro）。
 */
export default function PlanOverrideSelect({ provider, alias }: { provider: string; alias: string }) {
  const presets = tierPresets(provider);
  const [mult, setMult] = useState<number>(0); // 0 = 自动
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const map = await invoke<Record<string, number>>("get_plan_overrides");
        setMult(map[`${provider}::${alias}`] ?? 0);
      } catch {
        /* ignore */
      }
    })();
  }, [provider, alias]);

  const onChange = async (v: string) => {
    const m = v === "auto" ? 0 : Number(v);
    setMult(m);
    try {
      await invoke("set_plan_override", { provider, alias, mult: m });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1300);
    } catch {
      /* ignore */
    }
  };

  const isPreset = mult === 0 || presets.some((p) => p.mult === mult);

  return (
    <div className="inline-flex items-center gap-1.5 text-xs" title="当前套餐档位（仅影响今后采集，不改历史）">
      <span style={{ color: "#888" }}>档位</span>
      <select
        value={isPreset ? (mult === 0 ? "auto" : String(mult)) : "custom"}
        onChange={(e) => onChange(e.target.value)}
        style={{ background: "#2c2c2c", color: "#cbd5e1", border: "1px solid #3a3a3a", borderRadius: 6, padding: "3px 6px", cursor: "pointer" }}
      >
        <option value="auto">自动</option>
        {presets.map((p) => (
          <option key={p.mult} value={String(p.mult)}>{p.label}</option>
        ))}
        {!isPreset && <option value="custom">自定义 {mult}x</option>}
      </select>
      {saved && <span style={{ color: "#4ade80" }}>已设</span>}
    </div>
  );
}
