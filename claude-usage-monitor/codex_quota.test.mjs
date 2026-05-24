import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const context = { globalThis: {}, Date };
context.globalThis = context;
vm.runInNewContext(
  readFileSync(new URL("./codex_quota.js", import.meta.url), "utf8"),
  context,
);

const { normalizeCodexUsage } = context;

test("normalizes Codex usage into scaled session and weekly quotas", () => {
  const usage = {
    email: "pro@example.com",
    plan_type: "prolite",
    rate_limit: {
      primary_window: { used_percent: 20, reset_at: 1778929619 },
      secondary_window: { used_percent: 3, reset_at: 1779458474 },
    },
    additional_rate_limits: [
      {
        limit_name: "GPT-5.3-Codex-Spark",
        metered_feature: "codex_bengalfox",
        rate_limit: {
          primary_window: { used_percent: 0, reset_at: 1778931768 },
          secondary_window: { used_percent: 10, reset_at: 1779518568 },
        },
      },
    ],
  };

  const reports = normalizeCodexUsage(usage, {
    alias: "codex-pro",
    multiplier: 5,
  });

  assert.deepEqual(JSON.parse(JSON.stringify(reports)), [
    {
      account_alias: "codex-pro",
      session_pct: 100,
      session_total_pct: 500,
      session_reset_at: "2026-05-16T11:06:59.000Z",
      weekly_pct: 15,
      weekly_total_pct: 500,
      weekly_reset_at: "2026-05-22T14:01:14.000Z",
    },
  ]);
});

test("does not report Codex quotas for Go tier", () => {
  const usage = {
    email: "go@example.com",
    plan_type: "go",
    rate_limit: {
      primary_window: { used_percent: 1, reset_at: 1778929619 },
      secondary_window: { used_percent: 2, reset_at: 1779458474 },
    },
  };

  assert.deepEqual(JSON.parse(JSON.stringify(normalizeCodexUsage(usage, {
    alias: "codex-go",
    multiplier: 0,
  }))), []);

});

test("normalizes Codex usage for Pro 5x tier", () => {
  const usage = {
    email: "promo@example.com",
    plan_type: "pro",
    rate_limit: {
      primary_window: { used_percent: 22.5, reset_at: 1778929619 },
      secondary_window: { used_percent: 4.5, reset_at: 1779458474 },
    },
  };

  const [report] = normalizeCodexUsage(usage, {
    alias: "codex-pro",
    multiplier: 5,
  });

  assert.equal(report.session_pct, 112.5);
  assert.equal(report.session_total_pct, 500);
  assert.equal(report.weekly_pct, 22.5);
  assert.equal(report.weekly_total_pct, 500);
});

test("normalizes Codex usage reset_after_seconds windows", () => {
  const originalNow = context.Date.now;
  context.Date.now = () => Date.UTC(2026, 4, 17, 0, 0, 0);
  try {
    const [report] = normalizeCodexUsage({
      rate_limit: {
        primary_window: { used_percent: 42.5, reset_after_seconds: 3600 },
        secondary_window: { used_percent: 18, reset_after_seconds: 86400 },
      },
    }, {
      alias: "codex-pro",
      multiplier: 5,
    });

    assert.equal(report.session_pct, 212.5);
    assert.equal(report.weekly_pct, 90);
    assert.equal(report.session_reset_at, "2026-05-17T01:00:00.000Z");
    assert.equal(report.weekly_reset_at, "2026-05-18T00:00:00.000Z");
  } finally {
    context.Date.now = originalNow;
  }
});
