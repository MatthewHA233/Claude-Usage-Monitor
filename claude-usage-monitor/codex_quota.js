(function () {
  function toIsoFromUnixSeconds(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    return new Date(value * 1000).toISOString();
  }

  function toIsoFromResetWindow(window) {
    if (typeof window?.reset_at === "number") return toIsoFromUnixSeconds(window.reset_at);
    if (typeof window?.reset_after_seconds === "number" && Number.isFinite(window.reset_after_seconds)) {
      return new Date(Date.now() + window.reset_after_seconds * 1000).toISOString();
    }
    return null;
  }

  function roundQuota(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    return Math.round(value * 10) / 10;
  }

  function buildReport(alias, rateLimit, multiplier) {
    const session = rateLimit?.primary_window;
    const weekly = rateLimit?.secondary_window;
    const total = 100 * multiplier;
    return {
      account_alias: alias,
      session_pct: roundQuota((session?.used_percent ?? 0) * multiplier),
      session_total_pct: total,
      session_reset_at: toIsoFromResetWindow(session),
      weekly_pct: roundQuota((weekly?.used_percent ?? 0) * multiplier),
      weekly_total_pct: total,
      weekly_reset_at: toIsoFromResetWindow(weekly),
    };
  }

  function normalizeCodexUsage(usage, options) {
    const multiplier = Number(options?.multiplier ?? 1);
    if (!Number.isFinite(multiplier) || multiplier <= 0) return [];
    const safeMultiplier = multiplier;
    const baseAlias = options?.alias || usage?.email || "codex";
    const reports = [];

    if (usage?.rate_limit) {
      reports.push(buildReport(baseAlias, usage.rate_limit, safeMultiplier));
    }

    return reports;
  }

  globalThis.normalizeCodexUsage = normalizeCodexUsage;
})();
