import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  UsageSnapshot,
  Recommendation,
  AccountAnalysis,
  AccountColor,
  AccountPauseState,
  LocalUsageStatus,
  PluginUsageStatus,
  TokenUsageReport,
} from "../types";

export function useLatestSnapshots(autoRefreshMs = 0) {
  const [snapshots, setSnapshots] = useState<UsageSnapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await invoke<UsageSnapshot[]>("get_latest_snapshots");
      setSnapshots(data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetch();
    if (autoRefreshMs > 0) {
      const timer = setInterval(() => void fetch(), autoRefreshMs);
      return () => clearInterval(timer);
    }
    return undefined;
  }, [fetch, autoRefreshMs]);

  return { snapshots, loading, error, refetch: fetch };
}

export function useRecommendation() {
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const [loading, setLoading] = useState(false);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const data = await invoke<Recommendation>("get_recommendation");
      setRecommendation(data);
    } catch {
      // no data yet
    } finally {
      setLoading(false);
    }
  }, []);

  return { recommendation, loading, refetch: fetch };
}

export function useAnalysis() {
  const [analysis, setAnalysis] = useState<AccountAnalysis[]>([]);
  const [loading, setLoading] = useState(false);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const data = await invoke<AccountAnalysis[]>("get_analysis");
      setAnalysis(data);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetch();
  }, [fetch]);

  return { analysis, loading, refetch: fetch };
}

export function useAccountColors() {
  const [colors, setColors] = useState<Record<string, string>>({});

  const fetch = useCallback(async () => {
    try {
      const data = await invoke<AccountColor[]>("get_account_colors");
      setColors(Object.fromEntries(data.map((d) => [d.alias, d.color])));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { void fetch(); }, [fetch]);

  const setColor = useCallback(async (alias: string, color: string) => {
    await invoke("set_account_color", { alias, color });
    setColors((prev) => ({ ...prev, [alias]: color }));
  }, []);

  return { colors, refetch: fetch, setColor };
}

export function useAccountPauseStates() {
  const [pauseStates, setPauseStates] = useState<Record<string, AccountPauseState>>({});

  const fetch = useCallback(async () => {
    try {
      const data = await invoke<AccountPauseState[]>("get_account_pause_states");
      setPauseStates(Object.fromEntries(data.map((d) => [d.account_key, d])));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { void fetch(); }, [fetch]);

  const setPaused = useCallback(async (provider: string, alias: string, paused: boolean) => {
    const key = `${provider}::${alias}`;
    const pausedAt = paused ? new Date().toISOString() : null;
    await invoke("set_account_paused", { provider, alias, paused });
    setPauseStates((prev) => ({
      ...prev,
      [key]: { provider, account_alias: alias, account_key: key, paused, paused_at: pausedAt },
    }));
  }, []);

  return { pauseStates, refetch: fetch, setPaused };
}

export function useLocalUsageStatuses(autoRefreshMs = 0) {
  const [statuses, setStatuses] = useState<LocalUsageStatus[]>([]);

  const fetch = useCallback(async () => {
    try {
      const data = await invoke<LocalUsageStatus[]>("get_local_usage_statuses");
      setStatuses(data);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void fetch();
    if (autoRefreshMs > 0) {
      const timer = setInterval(() => void fetch(), autoRefreshMs);
      return () => clearInterval(timer);
    }
    return undefined;
  }, [fetch, autoRefreshMs]);

  return { statuses, refetch: fetch };
}

export function usePluginUsageStatuses(autoRefreshMs = 0) {
  const [statuses, setStatuses] = useState<PluginUsageStatus[]>([]);

  const fetch = useCallback(async () => {
    try {
      const data = await invoke<PluginUsageStatus[]>("get_plugin_usage_statuses");
      setStatuses(data);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void fetch();
    if (autoRefreshMs > 0) {
      const timer = setInterval(() => void fetch(), autoRefreshMs);
      return () => clearInterval(timer);
    }
    return undefined;
  }, [fetch, autoRefreshMs]);

  return { statuses, refetch: fetch };
}

export function useAllHistories() {
  const [histories, setHistories] = useState<Record<string, UsageSnapshot[]>>({});
  const [loading, setLoading] = useState(false);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const data = await invoke<Record<string, UsageSnapshot[]>>("get_all_histories");
      setHistories(data);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void fetch(); }, [fetch]);

  return { histories, loading, refetch: fetch };
}

export function useHistorySince(provider: string, alias: string, sinceDays = 31) {
  const [history, setHistory] = useState<UsageSnapshot[]>([]);
  const [loading, setLoading] = useState(false);

  const fetch = useCallback(async () => {
    if (!alias) return;
    setLoading(true);
    try {
      const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
      const data = await invoke<UsageSnapshot[]>("get_history_since", { provider, alias, since });
      setHistory(data);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [provider, alias, sinceDays]);

  useEffect(() => { void fetch(); }, [fetch]);

  return { history, loading, refetch: fetch };
}

const PAGE_SIZE = 50;

export function useHistory(provider: string, alias: string, limit = PAGE_SIZE) {
  const [history, setHistory] = useState<UsageSnapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const offsetRef = useRef(0);

  const fetchPage = useCallback(async (offset: number, append: boolean) => {
    if (!alias) return;
    if (append) setLoadingMore(true); else setLoading(true);
    try {
      const data = await invoke<UsageSnapshot[]>("get_history", { provider, alias, limit, offset });
      if (append) {
        setHistory(prev => {
          const seen = new Set(prev.map(s => s.id).filter(id => id != null));
          return [...prev, ...data.filter(s => s.id == null || !seen.has(s.id))];
        });
      } else {
        setHistory(data);
        offsetRef.current = 0;
      }
      offsetRef.current = offset + data.length;
      setHasMore(data.length === limit);
    } catch {
      // ignore
    } finally {
      if (append) setLoadingMore(false); else setLoading(false);
    }
  }, [provider, alias, limit]);

  const loadMore = useCallback(() => {
    if (!loadingMore && hasMore) {
      void fetchPage(offsetRef.current, true);
    }
  }, [fetchPage, loadingMore, hasMore]);

  const refetch = useCallback(() => {
    setHasMore(true);
    void fetchPage(0, false);
  }, [fetchPage]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { history, loading, loadingMore, hasMore, loadMore, refetch };
}

export function useTokenUsageReport(sinceDays = 14, autoFetch = false) {
  const [report, setReport] = useState<TokenUsageReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadCached = useCallback(async () => {
    setError(null);
    try {
      const data = await invoke<TokenUsageReport>("get_cached_token_usage_report", { sinceDays });
      setReport(data);
    } catch (e) {
      setError(String(e));
    }
  }, [sinceDays]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await invoke<TokenUsageReport>("get_token_usage_report", { sinceDays });
      setReport(data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [sinceDays]);

  useEffect(() => {
    void loadCached();
  }, [loadCached]);

  useEffect(() => {
    if (autoFetch) {
      void refresh();
    }
  }, [autoFetch, refresh]);

  return { report, loading, error, refetch: refresh, loadCached };
}
