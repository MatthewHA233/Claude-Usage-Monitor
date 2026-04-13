import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { UsageSnapshot, Recommendation, AccountAnalysis, AccountColor } from "../types";

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

const PAGE_SIZE = 50;

export function useHistory(alias: string, limit = PAGE_SIZE) {
  const [history, setHistory] = useState<UsageSnapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const offsetRef = useRef(0);

  const fetchPage = useCallback(async (offset: number, append: boolean) => {
    if (!alias) return;
    if (append) setLoadingMore(true); else setLoading(true);
    try {
      const data = await invoke<UsageSnapshot[]>("get_history", { alias, limit, offset });
      if (append) {
        setHistory(prev => [...prev, ...data]);
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
  }, [alias, limit]);

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
