import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface InboxItem {
  id: number;
  account_alias: string;
  collected_at: string;
  session_pct: number | null;
  session_reset_at: string | null;
  weekly_pct: number | null;
  weekly_reset_at: string | null;
  filter_reason: string;
  created_at: string;
}

export function useInbox(autoRefreshMs = 30_000) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(false);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const data = await invoke<InboxItem[]>("inbox_list");
      setItems(data);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  const accept = useCallback(async (id: number) => {
    await invoke("inbox_accept", { id });
    await refetch();
  }, [refetch]);

  const remove = useCallback(async (id: number) => {
    await invoke("inbox_delete", { id });
    await refetch();
  }, [refetch]);

  useEffect(() => {
    void refetch();
    if (autoRefreshMs > 0) {
      const t = setInterval(() => void refetch(), autoRefreshMs);
      return () => clearInterval(t);
    }
    return undefined;
  }, [refetch, autoRefreshMs]);

  return { items, loading, refetch, accept, remove };
}
