(function () {
  const CODEX_TAURI_PORT = 47892;
  const CODEX_USAGE_URL = "/backend-api/wham/usage";
  const AUTH_SESSION_URL = "/api/auth/session";
  const CODEX_PLAN_MULTIPLIERS = {
    go: 0,
    plus: 1,
    pro5: 5,
    pro20: 20,
  };
  const DEFAULT_CODEX_PLAN = "pro5";

  function normalizeCodexPlan(plan) {
    const key = String(plan || "").trim();
    return Object.prototype.hasOwnProperty.call(CODEX_PLAN_MULTIPLIERS, key) ? key : DEFAULT_CODEX_PLAN;
  }

  function inferCodexPlan(usage) {
    const planType = String(usage?.plan_type || "").toLowerCase();
    if (planType.includes("go")) return "go";
    if (planType.includes("plus")) return "plus";
    if (planType.includes("pro")) return "pro5";
    return "plus";
  }

  function getCookieValue(name) {
    const prefix = `${name}=`;
    const item = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(prefix));
    return item ? item.slice(prefix.length) : "";
  }

  function getChatGptProfile() {
    const visible = getVisibleChatGptProfile();
    if (visible.email || visible.full_name || visible.plan_name) return visible;

    try {
      const raw = getCookieValue("oai-client-auth-info");
      if (!raw) return {};
      const parsed = JSON.parse(decodeURIComponent(raw));
      return {
        email: parsed?.user?.email || "",
        full_name: parsed?.user?.name || "",
        plan_name: "",
      };
    } catch {
      return {};
    }
  }

  function getVisibleChatGptProfile() {
    const menu = [...document.querySelectorAll("[role='menu'], [data-radix-popper-content-wrapper], div")]
      .filter((el) => {
        const text = el.innerText || "";
        return (text.includes("Codex 设置") || text.toLowerCase().includes("codex settings"))
          && (text.includes("ChatGPT 设置") || text.toLowerCase().includes("chatgpt settings"));
      })
      .sort((a, b) => (a.innerText || "").length - (b.innerText || "").length)[0];

    if (!menu) return {};
    const lines = (menu.innerText || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const settingsIndex = lines.findIndex((line) =>
      line.includes("Codex 设置")
      || line.includes("ChatGPT 设置")
      || line.toLowerCase().includes("codex settings")
      || line.toLowerCase().includes("chatgpt settings")
    );
    const headerLines = settingsIndex >= 0 ? lines.slice(0, settingsIndex) : lines.slice(0, 3);
    const planLine = headerLines.find((line) => /^(Go|Plus|Pro|Free|Team|Business|Enterprise)$/i.test(line));
    const nameLine = headerLines.find((line) => line !== planLine && !/^[A-Z]{1,3}$/.test(line));

    return {
      email: "",
      full_name: nameLine || "",
      plan_name: planLine || "",
    };
  }

  function isCodexContextValid() {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  async function getCodexSettings(usage) {
    const stored = await chrome.storage.local.get([
      "codexAccountAlias",
      "codexPlan",
    ]);
    const profile = getChatGptProfile();
    const alias = stored.codexAccountAlias?.trim() || usage.email || profile.email || profile.full_name || "codex";
    const plan = normalizeCodexPlan(stored.codexPlan || inferCodexPlan(usage));
    if (stored.codexPlan !== plan) await chrome.storage.local.set({ codexPlan: plan });
    const multiplier = CODEX_PLAN_MULTIPLIERS[plan] ?? 1;
    return {
      alias,
      email: usage.email || profile.email || "",
      full_name: profile.full_name || "",
      plan_name: profile.plan_name || "",
      plan,
      multiplier,
      featureAliases: false,
    };
  }

  async function reportCodexToTauri(report) {
    await fetch(`http://localhost:${CODEX_TAURI_PORT}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "codex", ...report }),
    });
  }

  function findAccessToken(value) {
    if (!value || typeof value !== "object") return "";
    for (const key of ["accessToken", "access_token", "token"]) {
      if (typeof value[key] === "string" && value[key]) return value[key];
    }
    for (const child of Object.values(value)) {
      const found = findAccessToken(child);
      if (found) return found;
    }
    return "";
  }

  async function fetchAuthSession() {
    const res = await fetch(new URL(AUTH_SESSION_URL, location.origin).toString(), {
      credentials: "include",
      headers: { "accept": "application/json" },
    });
    if (!res.ok) throw new Error(`auth session ${res.status}`);
    return res.json();
  }

  async function fetchCodexUsageWithToken() {
    const session = await fetchAuthSession();
    const token = findAccessToken(session);
    if (!token) throw new Error("未找到 ChatGPT access token");
    const res = await fetch(new URL(CODEX_USAGE_URL, location.origin).toString(), {
      credentials: "include",
      headers: {
        "accept": "application/json",
        "authorization": `Bearer ${token}`,
      },
    });
    if (!res.ok) throw new Error(`wham usage ${res.status}`);
    return res.json();
  }

  async function handleCodexUsage(usage) {
    try {
      const settings = await getCodexSettings(usage || {});
      let reports = [];
      if (usage && typeof globalThis.normalizeCodexUsage === "function") {
        reports = globalThis.normalizeCodexUsage(usage, settings);
      }

      if (isCodexContextValid()) {
        chrome.storage.local.set({
          codexData: { usage, reports, settings, source: "接口拦截" },
          codexStatus: reports.length > 0
            ? `已通过接口拦截读取 ${reports.length} 组 Codex 额度`
            : "Codex 接口响应中没有可记录的额度",
          codexUpdatedAt: Date.now(),
        });
      }

      for (const report of reports) {
        await reportCodexToTauri(report);
      }
    } catch (e) {
      if (isCodexContextValid()) {
        chrome.storage.local.set({
          codexStatus: `Codex 读取失败：${e?.message || e}`,
          codexUpdatedAt: Date.now(),
        });
      }
      console.warn("[claude-usage-monitor] Codex fetch error:", e.message);
    }
  }

  function markWaiting() {
    if (!isCodexContextValid()) {
      return;
    }
    chrome.storage.local.set({
      codexStatus: "等待 Codex 页面接口响应",
      codexUpdatedAt: Date.now(),
    });
  }

  async function refreshCodexUsage() {
    try {
      const usage = await fetchCodexUsageWithToken();
      await handleCodexUsage(usage);
    } catch (e) {
      if (isCodexContextValid()) {
        chrome.storage.local.set({
          codexStatus: `等待 Codex 接口响应：${e?.message || e}`,
          codexUpdatedAt: Date.now(),
        });
      }
    }
  }

  if (!globalThis.__codexUsageListenerInstalled) {
    globalThis.__codexUsageListenerInstalled = true;
    window.addEventListener("message", (event) => {
      if (event.source !== window || event.origin !== location.origin) return;
      if (event.data?.source !== "claude-usage-monitor") return;
      if (event.data?.type === "CODEX_USAGE_MONITOR_USAGE") {
        handleCodexUsage(event.data.usage);
      }
    });
    try {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === "REFRESH_CODEX") refreshCodexUsage();
      });
    } catch {}
  }

  refreshCodexUsage();
  if (!globalThis.__codexUsageIntervalId) {
    globalThis.__codexUsageIntervalId = setInterval(refreshCodexUsage, 20 * 1000);
  }
})();
