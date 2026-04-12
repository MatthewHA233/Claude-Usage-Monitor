import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { UsageSnapshot, Recommendation, AccountAnalysis } from "../types";

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

export function useHistory(alias: string) {
  const [history, setHistory] = useState<UsageSnapshot[]>([]);
  const [loading, setLoading] = useState(false);

  const fetch = useCallback(async () => {
    if (!alias) return;
    setLoading(true);
    try {
      const data = await invoke<UsageSnapshot[]>("get_history", {
        alias,
        limit: 100,
      });
      setHistory(data);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [alias]);

  useEffect(() => {
    void fetch();
  }, [fetch]);

  return { history, loading, refetch: fetch };
}
