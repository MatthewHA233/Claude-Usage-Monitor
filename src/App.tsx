import { useCallback, useEffect, useState } from "react";
import { Activity, BarChart3, Flame } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import logoUrl from "./assets/logo.png";
import {
  useLatestSnapshots,
  useRecommendation,
  useAnalysis,
  useTokenUsageReport,
  useLocalUsageStatuses,
  usePluginUsageStatuses,
} from "./hooks/useData";
import StatusCards from "./components/StatusCards";
import TokenUsagePanel from "./components/TokenUsagePanel";
import SessionRacePanel from "./components/SessionRacePanel";

type AppTab = "accounts" | "race" | "tokens";
const TAB_STORAGE_KEY = "claude_usage_monitor_active_tab";

export default function App() {
  const [tab, setTab] = useState<AppTab>(() => {
    const saved = localStorage.getItem(TAB_STORAGE_KEY);
    return saved === "tokens" || saved === "race" ? saved : "accounts";
  });
  const { snapshots, loading: snapsLoading, refetch: refetchSnaps } = useLatestSnapshots(30_000);
  const { recommendation, refetch: refetchRec } = useRecommendation();
  const { analysis, refetch: refetchAnalysis } = useAnalysis();
  const { statuses: localUsageStatuses, refetch: refetchLocalStatuses } = useLocalUsageStatuses(30_000);
  const { statuses: pluginUsageStatuses, refetch: refetchPluginStatuses } = usePluginUsageStatuses(10_000);
  const { report: tokenReport, loading: tokenLoading, error: tokenError, refetch: refetchTokenReport } = useTokenUsageReport(14, false);

  const refresh = useCallback(async () => {
    await invoke("refresh_local_usage").catch(() => undefined);
    await refetchSnaps();
    await refetchRec();
    await refetchAnalysis();
    await refetchLocalStatuses();
    await refetchPluginStatuses();
    await refetchTokenReport();
  }, [refetchSnaps, refetchRec, refetchAnalysis, refetchLocalStatuses, refetchPluginStatuses, refetchTokenReport]);

  useEffect(() => {
    if (snapshots.length > 0) {
      void refetchRec();
      void refetchAnalysis();
    }
  }, [snapshots, refetchRec, refetchAnalysis]);

  useEffect(() => {
    localStorage.setItem(TAB_STORAGE_KEY, tab);
    if (tab === "tokens") {
      void refetchTokenReport();
    }
  }, [tab, refetchTokenReport]);

  return (
    <div className="h-screen flex flex-col" style={{ background: "#181818" }}>
      <header
        className="flex items-center justify-between px-4 py-3 shrink-0"
        style={{ borderBottom: "1px solid #333" }}
        data-tauri-drag-region
      >
        <div className="flex items-center gap-2.5">
          <img src={logoUrl} alt="logo" style={{ width: 28, height: 28, borderRadius: 6, objectFit: "contain" }} />
          <div>
            <div className="text-sm font-semibold" style={{ color: "#fff" }}>Claude Usage Monitor</div>
            {snapsLoading && (
              <div className="text-xs animate-pulse" style={{ color: "#888" }}>更新中…</div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1" style={{ background: "#202020", border: "1px solid #333", borderRadius: 8, padding: 3 }}>
          <TabButton active={tab === "accounts"} onClick={() => setTab("accounts")} icon={<Activity size={14} />} label="用量" />
          <TabButton active={tab === "race"} onClick={() => setTab("race")} icon={<Flame size={14} />} label="竞赛" />
          <TabButton active={tab === "tokens"} onClick={() => setTab("tokens")} icon={<BarChart3 size={14} />} label="Token" />
        </div>
      </header>

      <main className="flex-1 overflow-auto p-3">
        {tab === "accounts" ? (
          <StatusCards
            snapshots={snapshots}
            recommendation={recommendation}
            analysis={analysis}
            localUsageStatuses={localUsageStatuses}
            pluginUsageStatuses={pluginUsageStatuses}
            onRefresh={() => void refresh()}
          />
        ) : tab === "race" ? (
          <SessionRacePanel
            snapshots={snapshots}
            recommendation={recommendation}
            pluginUsageStatuses={pluginUsageStatuses}
            onRefresh={() => void refresh()}
          />
        ) : (
          <TokenUsagePanel
            report={tokenReport}
            loading={tokenLoading}
            error={tokenError}
            onRefresh={() => void refetchTokenReport()}
          />
        )}
      </main>
    </div>
  );
}

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 text-xs"
      style={{
        height: 28,
        padding: "0 10px",
        borderRadius: 6,
        color: active ? "#f9fafb" : "#9ca3af",
        background: active ? "#343434" : "transparent",
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
