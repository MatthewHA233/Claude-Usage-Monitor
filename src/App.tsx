import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, BarChart3, CheckCircle2, Flame, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import logoUrl from "./assets/logo.png";
import segmentCompleteSoundUrl from "./assets/quota-segment-complete.wav";
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
import {
  setFocusedQuotaRaceId,
  setHighlightedQuotaRaceSegment,
  setSelectedQuotaRaceAccountKey,
} from "./utils/quotaRaceStorage";
import {
  QUOTA_RACE_SETTLED_EVENT,
  QUOTA_SEGMENT_COMPLETED_EVENT,
  type QuotaRaceSettledDetail,
  type QuotaSegmentCompletedDetail,
} from "./utils/quotaRaceEvents";

type AppTab = "accounts" | "race" | "tokens";
const TAB_STORAGE_KEY = "claude_usage_monitor_active_tab";
const SEGMENT_TOAST_DURATION_MS = 6200;

interface SegmentToast extends QuotaSegmentCompletedDetail {
  toastId: string;
}

interface RaceBurst extends QuotaRaceSettledDetail {
  burstId: string;
}

export default function App() {
  const [tab, setTab] = useState<AppTab>(() => {
    const saved = localStorage.getItem(TAB_STORAGE_KEY);
    return saved === "tokens" || saved === "race" ? saved : "accounts";
  });
  const [segmentToasts, setSegmentToasts] = useState<SegmentToast[]>([]);
  const [raceBurst, setRaceBurst] = useState<RaceBurst | null>(null);
  const raceBurstTimerRef = useRef<number | null>(null);
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

  const openRace = useCallback((raceId?: string, accountKey?: string) => {
    if (accountKey) setSelectedQuotaRaceAccountKey(accountKey);
    setFocusedQuotaRaceId(raceId ?? null);
    setTab("race");
  }, []);

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

  useEffect(() => {
    const handleSegmentCompleted = (event: Event) => {
      const detail = (event as CustomEvent<QuotaSegmentCompletedDetail>).detail;
      if (!detail) return;
      playSegmentCompleteSound();
      const toast: SegmentToast = {
        ...detail,
        toastId: `${detail.raceId}:${detail.segmentIndex}:${Date.now()}`,
      };
      setSegmentToasts((previous) => [toast, ...previous].slice(0, 4));
    };

    const handleRaceSettled = (event: Event) => {
      const detail = (event as CustomEvent<QuotaRaceSettledDetail>).detail;
      if (!detail) return;
      setRaceBurst({ ...detail, burstId: `${detail.raceId}:${detail.status}:${Date.now()}` });
      if (raceBurstTimerRef.current != null) window.clearTimeout(raceBurstTimerRef.current);
      raceBurstTimerRef.current = window.setTimeout(() => {
        setRaceBurst(null);
        raceBurstTimerRef.current = null;
      }, 4200);
    };

    window.addEventListener(QUOTA_SEGMENT_COMPLETED_EVENT, handleSegmentCompleted);
    window.addEventListener(QUOTA_RACE_SETTLED_EVENT, handleRaceSettled);
    return () => {
      window.removeEventListener(QUOTA_SEGMENT_COMPLETED_EVENT, handleSegmentCompleted);
      window.removeEventListener(QUOTA_RACE_SETTLED_EVENT, handleRaceSettled);
      if (raceBurstTimerRef.current != null) window.clearTimeout(raceBurstTimerRef.current);
      raceBurstTimerRef.current = null;
    };
  }, []);

  const dismissSegmentToast = useCallback((toastId: string) => {
    setSegmentToasts((previous) => previous.filter((toast) => toast.toastId !== toastId));
  }, []);

  const openSegmentToast = useCallback((toast: SegmentToast) => {
    setSelectedQuotaRaceAccountKey(toast.accountKey);
    setHighlightedQuotaRaceSegment(toast.raceId, toast.segmentIndex);
    setFocusedQuotaRaceId(toast.raceId);
    setTab("race");
    setSegmentToasts((previous) => previous.filter((item) => item.toastId !== toast.toastId));
  }, []);

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
        <div style={{ display: tab === "accounts" ? "block" : "none" }}>
          <StatusCards
            snapshots={snapshots}
            recommendation={recommendation}
            analysis={analysis}
            localUsageStatuses={localUsageStatuses}
            pluginUsageStatuses={pluginUsageStatuses}
            onOpenRace={openRace}
            onRefresh={() => void refresh()}
          />
        </div>
        <div style={{ display: tab === "race" ? "block" : "none" }}>
          <SessionRacePanel
            snapshots={snapshots}
            recommendation={recommendation}
            pluginUsageStatuses={pluginUsageStatuses}
            onRefresh={() => void refresh()}
          />
        </div>
        <div style={{ display: tab === "tokens" ? "block" : "none" }}>
          <TokenUsagePanel
            report={tokenReport}
            loading={tokenLoading}
            error={tokenError}
            onRefresh={() => void refetchTokenReport()}
          />
        </div>
      </main>
      <SegmentToastStack toasts={segmentToasts} onDismiss={dismissSegmentToast} onOpen={openSegmentToast} />
      <GlobalRaceSettlementBurst burst={raceBurst} />
    </div>
  );
}

function playSegmentCompleteSound() {
  const audio = new Audio(segmentCompleteSoundUrl);
  audio.volume = 0.42;
  void audio.play().catch(() => undefined);
}

function SegmentToastStack({
  toasts,
  onDismiss,
  onOpen,
}: {
  toasts: SegmentToast[];
  onDismiss: (toastId: string) => void;
  onOpen: (toast: SegmentToast) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div
      className="fixed top-4 right-4 flex flex-col gap-2"
      style={{ zIndex: 120, width: "min(360px, calc(100vw - 32px))", pointerEvents: "none" }}
    >
      <style>
        {`
          @keyframes quota-segment-toast-in {
            0% { opacity: 0; transform: translate3d(18px, -8px, 0) scale(0.98); }
            100% { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
          }
        `}
      </style>
      {toasts.map((toast) => (
        <SegmentToastItem
          key={toast.toastId}
          toast={toast}
          onDismiss={() => onDismiss(toast.toastId)}
          onOpen={() => onOpen(toast)}
        />
      ))}
    </div>
  );
}

function SegmentToastItem({
  toast,
  onDismiss,
  onOpen,
}: {
  toast: SegmentToast;
  onDismiss: () => void;
  onOpen: () => void;
}) {
  const dismissTimerRef = useRef<number | null>(null);
  const consumedRaw = toast.actualDeltaPct * toast.totalPct / 100;
  const targetRaw = toast.raceTargetDeltaPct * toast.totalPct / 100;
  const providerColor = toastProviderColor(toast.provider);

  const clearDismissTimer = useCallback(() => {
    if (dismissTimerRef.current != null) {
      window.clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
  }, []);

  const scheduleDismissTimer = useCallback(() => {
    clearDismissTimer();
    dismissTimerRef.current = window.setTimeout(() => {
      dismissTimerRef.current = null;
      onDismiss();
    }, SEGMENT_TOAST_DURATION_MS);
  }, [clearDismissTimer, onDismiss]);

  useEffect(() => {
    scheduleDismissTimer();
    return clearDismissTimer;
  }, [clearDismissTimer, scheduleDismissTimer]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={handleKeyDown}
      onMouseEnter={clearDismissTimer}
      onMouseLeave={scheduleDismissTimer}
      style={{
        pointerEvents: "auto",
        borderRadius: 8,
        border: "1px solid #315f3a",
        background: "rgba(31, 41, 33, 0.96)",
        boxShadow: "0 14px 38px rgba(0, 0, 0, 0.36)",
        overflow: "hidden",
        animation: "quota-segment-toast-in 180ms ease-out",
        cursor: "pointer",
        outline: "none",
      }}
    >
      <div className="flex items-start gap-2.5 px-3 py-3">
        <span
          className="inline-flex items-center justify-center"
          style={{ width: 30, height: 30, borderRadius: 7, background: providerColor, color: "#fff", flexShrink: 0 }}
        >
          <ToastProviderIcon provider={toast.provider} size={17} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <CheckCircle2 size={13} style={{ color: "#4ade80", flexShrink: 0 }} />
              <div className="text-xs font-semibold truncate" style={{ color: "#dcfce7" }}>
                {toastProviderLabel(toast.provider)} 小目标完成
              </div>
            </div>
            <div className="text-[10px] font-mono" style={{ color: "#86efac", flexShrink: 0 }}>
              {toast.segmentIndex}/{toast.segmentsTotal}
            </div>
          </div>
          <div className="text-sm font-semibold truncate mt-0.5" style={{ color: "#f3f4f6" }}>
            你已经完成 {shortToastAlias(toast.alias)} 的第 {toast.segmentIndex} 个小目标
          </div>
          <div className="grid gap-1 mt-2 text-[11px]" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))", color: "#a7f3d0" }}>
            <span>本次 +{formatToastPct(toast.targetDeltaPct)}</span>
            <span className="text-right">累计 {formatToastPct(toast.actualDeltaPct)}</span>
            <span>用时 {formatToastDuration(toast.elapsedSeconds)}</span>
            <span className="text-right">映射 {formatToastWhole(consumedRaw)} / {formatToastWhole(targetRaw)}</span>
          </div>
        </div>
        <button
          type="button"
          title="关闭"
          onClick={(event) => {
            event.stopPropagation();
            onDismiss();
          }}
          className="inline-flex items-center justify-center"
          style={{ width: 22, height: 22, border: 0, background: "transparent", color: "#86efac", cursor: "pointer", flexShrink: 0 }}
        >
          <X size={13} />
        </button>
      </div>
      <div style={{ height: 2, background: "linear-gradient(90deg, #4ade80, transparent)" }} />
    </div>
  );
}

function GlobalRaceSettlementBurst({ burst }: { burst: RaceBurst | null }) {
  if (!burst) return null;
  const isCompleted = burst.status === "completed";
  const color = isCompleted ? "#4ade80" : "#fb7185";
  const deepColor = isCompleted ? "#14532d" : "#7f1d1d";
  const title = isCompleted ? "竞赛完成" : burst.status === "lost" ? "竞赛战败" : "竞赛超时";
  const subtitle = isCompleted ? "大目标达成" : burst.status === "lost" ? "Session 已重置" : "超过目标时间";
  const consumedRaw = burst.consumedDeltaPct * burst.totalPct / 100;
  const targetRaw = burst.targetDeltaPct * burst.totalPct / 100;
  const pieces = Array.from({ length: 24 }, (_, index) => index);

  return (
    <div
      key={burst.burstId}
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 115, pointerEvents: "none" }}
    >
      <style>
        {`
          @keyframes quota-race-burst-fade {
            0% { opacity: 0; }
            10% { opacity: 1; }
            82% { opacity: 1; }
            100% { opacity: 0; }
          }
          @keyframes quota-race-burst-card {
            0% { opacity: 0; transform: translateY(10px) scale(0.94); }
            16% { opacity: 1; transform: translateY(0) scale(1); }
            82% { opacity: 1; transform: translateY(0) scale(1); }
            100% { opacity: 0; transform: translateY(-8px) scale(0.98); }
          }
          @keyframes quota-race-burst-piece {
            0% { opacity: 0; transform: translate3d(0, 0, 0) rotate(0deg) scale(0.8); }
            12% { opacity: 1; }
            100% { opacity: 0; transform: translate3d(var(--x), var(--y), 0) rotate(var(--r)) scale(1); }
          }
          @keyframes quota-race-burst-ring {
            0% { opacity: 0.72; transform: scale(0.45); }
            100% { opacity: 0; transform: scale(1.8); }
          }
        `}
      </style>
      <div
        className="absolute inset-0"
        style={{
          animation: "quota-race-burst-fade 4.2s ease-out forwards",
          background: isCompleted
            ? "radial-gradient(circle at 50% 42%, rgba(74, 222, 128, 0.22), rgba(0, 0, 0, 0.08) 36%, rgba(0, 0, 0, 0.5))"
            : "radial-gradient(circle at 50% 42%, rgba(251, 113, 133, 0.24), rgba(0, 0, 0, 0.1) 36%, rgba(0, 0, 0, 0.56))",
        }}
      />
      <div
        className="absolute"
        style={{
          width: 240,
          height: 240,
          borderRadius: "50%",
          border: `1px solid ${color}`,
          animation: "quota-race-burst-ring 1300ms ease-out forwards",
        }}
      />
      {pieces.map((index) => {
        const angle = (Math.PI * 2 * index) / pieces.length;
        const distance = 128 + (index % 5) * 24;
        const x = Math.cos(angle) * distance;
        const y = Math.sin(angle) * distance * 0.72 - 18;
        const delay = (index % 6) * 34;
        return (
          <span
            key={index}
            className="absolute"
            style={{
              width: index % 3 === 0 ? 5 : 4,
              height: index % 3 === 0 ? 18 : 12,
              borderRadius: 2,
              background: index % 2 === 0 ? color : "#fef3c7",
              boxShadow: `0 0 16px ${color}`,
              opacity: 0,
              "--x": `${x}px`,
              "--y": `${y}px`,
              "--r": `${index % 2 === 0 ? 260 : -240}deg`,
              animation: `quota-race-burst-piece 950ms ${delay}ms ease-out forwards`,
            } as React.CSSProperties}
          />
        );
      })}
      <div
        className="relative flex flex-col items-center text-center px-7 py-6"
        style={{
          width: "min(360px, calc(100vw - 48px))",
          borderRadius: 10,
          border: `1px solid ${color}`,
          background: `linear-gradient(180deg, rgba(24, 24, 24, 0.96), ${deepColor}cc)`,
          boxShadow: `0 28px 90px rgba(0, 0, 0, 0.52), 0 0 40px ${color}44`,
          animation: "quota-race-burst-card 4.2s ease-out forwards",
        }}
      >
        <span
          className="inline-flex items-center justify-center mb-3"
          style={{ width: 48, height: 48, borderRadius: 12, background: toastProviderColor(burst.provider), color: "#fff" }}
        >
          <ToastProviderIcon provider={burst.provider} size={26} />
        </span>
        <div className="text-xs font-semibold tracking-wide" style={{ color }}>
          {toastProviderLabel(burst.provider)} · {subtitle}
        </div>
        <div className="text-3xl font-bold mt-1" style={{ color: "#fff" }}>
          {title}
        </div>
        <div className="text-sm font-semibold mt-1 truncate w-full" style={{ color: "#e5e7eb" }}>
          {shortToastAlias(burst.alias)}
        </div>
        <div className="grid grid-cols-3 gap-2 w-full mt-4 text-xs">
          <BurstMetric label="分卷" value={`${burst.completedSegments}/${burst.segmentsTotal}`} color={color} />
          <BurstMetric label="额度" value={`${formatToastWhole(consumedRaw)}/${formatToastWhole(targetRaw)}`} color={color} />
          <BurstMetric label="用时" value={formatToastDuration(burst.elapsedSeconds)} color={color} />
        </div>
      </div>
    </div>
  );
}

function BurstMetric({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ border: "1px solid rgba(255,255,255,0.12)", borderRadius: 7, padding: "7px 6px", background: "rgba(0,0,0,0.22)" }}>
      <div className="text-[10px]" style={{ color: "#a1a1aa" }}>{label}</div>
      <div className="font-mono font-semibold mt-0.5" style={{ color }}>{value}</div>
    </div>
  );
}

function toastProviderLabel(provider: string) {
  return provider === "codex" ? "Codex" : "Claude Code";
}

function toastProviderColor(provider: string) {
  return provider === "codex" ? "#0f6fea" : "#cc785c";
}

function ToastProviderIcon({ provider, size = 18 }: { provider: string; size?: number }) {
  if (provider === "codex") {
    return (
      <svg viewBox="0 0 600 600" width={size} height={size} aria-hidden="true">
        <path fill="currentColor" d="M557 245.5a150 150 0 0 0-12.8-122.7 151 151 0 0 0-162.8-72.5 151.6 151.6 0 0 0-256.9 54.2 150 150 0 0 0-100 72.5 151 151 0 0 0 18.6 177.5c-13.6 40.8-9 85.6 12.8 122.7 32.8 57 98.6 86.3 162.9 72.5a151.4 151.4 0 0 0 257-54.9A151.4 151.4 0 0 0 557 245.6M331.5 560.7c-26.3 0-51.7-9.1-72-26l3.6-2 119.5-69c6-3.5 9.8-10 9.8-17V278.3l50.5 29.2q.8.4 1 1.3v139.6c-.2 62-50.4 112.2-112.4 112.3M90 457.6a112 112 0 0 1-13.4-75.3l3.6 2 119.5 69c6 3.6 13.5 3.6 19.6 0l146-84.2v58.3a2 2 0 0 1-.8 1.6l-121 69.8A112.5 112.5 0 0 1 90 457.6M58.5 197.4c13.3-23 34.2-40.4 59.2-49.3V290c-.1 7 3.6 13.5 9.7 17l145.3 83.8-50.5 29.2q-.8.5-1.8 0L99.7 350.3a112.6 112.6 0 0 1-41.2-153.5zm415 96.4-146-84.7 50.5-29q.8-.6 1.8 0l120.7 69.7a112.4 112.4 0 0 1-16.9 202.6v-142c-.2-6.9-4-13.2-10.2-16.6m50.2-75.6-3.6-2.1-119.3-69.6c-6-3.5-13.6-3.5-19.6 0l-146 84.2v-58.3q0-1 .7-1.5l120.8-69.7a112.5 112.5 0 0 1 167 116.5zm-316 103.4-50.5-29.1a2 2 0 0 1-1-1.4V151.9a112.5 112.5 0 0 1 184.4-86.4l-3.5 2-119.5 69c-6 3.5-9.8 10-9.8 17zm27.4-59.2 65-37.4 65.2 37.4v75l-65 37.5-65-37.5z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path fill="currentColor" d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 0 1-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" />
    </svg>
  );
}

function shortToastAlias(alias: string) {
  return alias.includes("@") ? alias.split("@")[0] : alias;
}

function formatToastWhole(value: number) {
  if (!Number.isFinite(value)) return "-";
  return String(Math.round(value));
}

function formatToastPct(value: number) {
  return `${formatToastWhole(value)}%`;
}

function formatToastDuration(seconds: number) {
  const safe = Math.max(0, Math.round(seconds));
  if (safe < 60) return `${safe}s`;
  const minutes = Math.floor(safe / 60);
  const secs = safe % 60;
  if (minutes < 60) return secs > 0 ? `${minutes}m${secs}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours}h${restMinutes}m` : `${hours}h`;
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
