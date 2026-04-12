import { useCallback, useEffect } from "react";
import { useLatestSnapshots, useRecommendation, useAnalysis } from "./hooks/useData";
import StatusCards from "./components/StatusCards";

export default function App() {
  const { snapshots, loading: snapsLoading, refetch: refetchSnaps } = useLatestSnapshots(30_000);
  const { recommendation, refetch: refetchRec } = useRecommendation();
  const { analysis, refetch: refetchAnalysis } = useAnalysis();

  const refresh = useCallback(async () => {
    await refetchSnaps();
    await refetchRec();
    await refetchAnalysis();
  }, [refetchSnaps, refetchRec, refetchAnalysis]);

  useEffect(() => {
    if (snapshots.length > 0) {
      void refetchRec();
      void refetchAnalysis();
    }
  }, [snapshots, refetchRec, refetchAnalysis]);

  return (
    <div className="h-screen flex flex-col" style={{ background: "#181818" }}>
      <header
        className="flex items-center justify-between px-4 py-3 shrink-0"
        style={{ borderBottom: "1px solid #333" }}
        data-tauri-drag-region
      >
        <div className="flex items-center gap-2.5">
          <div style={{
            width: 28, height: 28,
            background: "linear-gradient(135deg, #cc785c, #d4956b)",
            borderRadius: 8, display: "flex", alignItems: "center",
            justifyContent: "center", fontSize: 14, fontWeight: 700, color: "#fff",
          }}>C</div>
          <div>
            <div className="text-sm font-semibold" style={{ color: "#fff" }}>Claude Switch</div>
            {snapsLoading && (
              <div className="text-xs animate-pulse" style={{ color: "#888" }}>更新中…</div>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-auto p-3">
        <StatusCards
          snapshots={snapshots}
          recommendation={recommendation}
          analysis={analysis}
          onRefresh={() => void refresh()}
        />
      </main>
    </div>
  );
}
