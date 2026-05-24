function formatResetsIn(isoString) {
  if (!isoString) return "";
  const diffMs = new Date(isoString) - new Date();
  if (diffMs < 0) return "即将重置";
  const totalMin = Math.floor(diffMs / 60000);
  const hr = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return hr > 0 ? `${hr} 小时 ${min} 分后重置` : `${min} 分钟后重置`;
}

function formatPercent(value) {
  if (value == null || !Number.isFinite(value)) return "-";
  return String(Math.round(value));
}

function barClassByRatio(used, total = 100) {
  const ratio = total > 0 ? (used / total) * 100 : used;
  if (ratio >= 80) return "danger";
  if (ratio >= 60) return "warn";
  return "";
}

const CODEX_PLAN_LABELS = {
  go: "Go 不记录",
  plus: "Plus",
  pro5: "Pro 5x",
  pro20: "Pro 20x",
};

function normalizeCodexPlan(plan) {
  return Object.prototype.hasOwnProperty.call(CODEX_PLAN_LABELS, plan) ? plan : "pro5";
}

function codexPlanLabel(plan) {
  return CODEX_PLAN_LABELS[normalizeCodexPlan(plan)] || "Codex";
}

function usageCard(label, used, total, resetAt) {
  const safeUsed = used ?? 0;
  const safeTotal = total ?? 100;
  const width = Math.min(100, Math.max(0, (safeUsed / safeTotal) * 100));
  const remaining = Math.max(0, safeTotal - safeUsed);
  return `
    <div class="usage-card">
      <div class="usage-label">
        <span class="usage-name">${label}</span>
        <span class="usage-pct">${formatPercent(safeUsed)} / ${formatPercent(safeTotal)}%</span>
      </div>
      <div class="bar-bg">
        <div class="bar-fill ${barClassByRatio(safeUsed, safeTotal)}" style="width:${width}%"></div>
      </div>
      <div class="resets">剩余 ${formatPercent(remaining)}% · ${formatResetsIn(resetAt)}</div>
    </div>
  `;
}

function renderClaude(data) {
  if (!data) {
    return `<div class="no-data">暂无 Claude 数据<br><a href="https://claude.ai" target="_blank">打开 Claude</a></div>`;
  }
  return `
    <div class="account">
      <div class="account-email">${data.email || "未知账号"}</div>
      <div class="account-name">${data.full_name || ""}</div>
      <span class="plan-badge">${data.plan}</span>
    </div>
    ${usageCard("Claude Session（5小时）", data.current_session?.utilization ?? 0, 100, data.current_session?.resets_at)}
    ${usageCard("Claude 周限额", data.weekly?.utilization ?? 0, 100, data.weekly?.resets_at)}
    <div class="extra-row">
      <span>Extra Usage</span>
      <div style="display:flex;align-items:center;gap:6px;">
        <span style="font-size:11px">${data.extra_usage_enabled ? "已开启" : "未开启"}</span>
        <div class="extra-dot ${data.extra_usage_enabled ? "on" : "off"}"></div>
      </div>
    </div>
  `;
}

function renderCodex(codexData, codexStatus) {
  const reports = codexData?.reports ?? [];
  if (reports.length === 0) {
    return `
      <div class="no-data">
        暂无 Codex 数据<br>
        <a href="https://chatgpt.com/" target="_blank">打开 ChatGPT</a>
        ${codexStatus ? `<div style="margin-top:6px;color:#777;">${codexStatus}</div>` : ""}
      </div>`;
  }

  const settings = codexData.settings ?? {};
  const planLabel = codexPlanLabel(settings.plan);
  return `
    <div class="account">
      <div class="account-email">${settings.email || settings.alias || codexData.usage?.email || "codex"}</div>
      <div class="account-name">${settings.full_name || ""}</div>
      <span class="plan-badge">${planLabel}</span>
    </div>
    ${reports.map((report) => `
      ${usageCard(`${report.account_alias} Session`, report.session_pct, report.session_total_pct, report.session_reset_at)}
      ${usageCard(`${report.account_alias} 周限额`, report.weekly_pct, report.weekly_total_pct, report.weekly_reset_at)}
    `).join("")}
  `;
}

function refreshCodexTab(tabId) {
  chrome.tabs.sendMessage(tabId, { type: "REFRESH_CODEX" }, () => {
    if (!chrome.runtime.lastError) {
      chrome.storage.local.set({
        codexStatus: "正在通过 ChatGPT 接口刷新 Codex 数据",
        codexUpdatedAt: Date.now(),
      });
      return;
    }
    chrome.scripting.executeScript(
      { target: { tabId }, files: ["codex_quota.js", "codex_content.js"] },
      () => {
        chrome.storage.local.set({
          codexStatus: chrome.runtime.lastError
            ? `注入 Codex 脚本失败：${chrome.runtime.lastError.message}`
            : "已注入 Codex 脚本，正在通过 ChatGPT 接口刷新",
          codexUpdatedAt: Date.now(),
        });
      },
    );
  });
}

function refreshPricingTab() {
  chrome.tabs.query({ url: "https://chatgpt.com/*" }, (tabs) => {
    const pricing = tabs.find((tab) => tab.url && tab.url.includes("#pricing"));
    if (!pricing?.id) return;
    chrome.scripting.executeScript(
      { target: { tabId: pricing.id }, files: ["pricing_detector.js"] },
      () => {
        if (chrome.runtime.lastError) {
          chrome.storage.local.set({
            codexStatus: `检测定价页失败：${chrome.runtime.lastError.message}`,
            codexUpdatedAt: Date.now(),
          });
        }
      },
    );
  });
}

function render(result) {
  document.getElementById("content").innerHTML = `
    <div class="section-title">Claude</div>
    ${renderClaude(result.claudeData || null)}
    <div class="section-title">Codex</div>
    ${renderCodex(result.codexData || null, result.codexStatus || "")}
    <button class="refresh-btn" id="refreshBtn">刷新数据</button>
    <div class="footer" id="updateTime"></div>
  `;

  document.getElementById("refreshBtn").addEventListener("click", () => {
    refreshPricingTab();
    chrome.tabs.query({ url: "https://claude.ai/*" }, (tabs) => {
      if (tabs.length > 0) chrome.tabs.sendMessage(tabs[0].id, { type: "REFRESH" });
    });
    chrome.tabs.query({ url: "https://chatgpt.com/*" }, (tabs) => {
      if (tabs.length > 0) {
        refreshCodexTab(tabs[0].id);
      } else {
        chrome.storage.local.set({
          codexStatus: "没有找到已打开的 ChatGPT 页面",
          codexUpdatedAt: Date.now(),
        });
      }
    });
    setTimeout(loadAndRender, 1500);
  });
}

function loadAndRender() {
  chrome.storage.local.get(["claudeData", "codexData", "codexStatus", "updatedAt", "codexUpdatedAt"], (result) => {
    render(result);
    const latest = Math.max(result.updatedAt ?? 0, result.codexUpdatedAt ?? 0);
    if (latest) {
      const el = document.getElementById("updateTime");
      if (el) el.textContent = "更新于 " + new Date(latest).toLocaleTimeString("zh-CN");
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  loadAndRender();

  chrome.storage.local.get(["accountAlias", "codexAccountAlias", "codexPlan"], (res) => {
    if (res.accountAlias) document.getElementById("aliasInput").value = res.accountAlias;
    if (res.codexAccountAlias) document.getElementById("codexAliasInput").value = res.codexAccountAlias;
    if (res.codexPlan) {
      const codexPlan = normalizeCodexPlan(res.codexPlan);
      document.getElementById("codexPlanInput").value = codexPlan;
      if (res.codexPlan !== codexPlan) chrome.storage.local.set({ codexPlan });
    }
  });

  document.getElementById("saveAlias").addEventListener("click", () => {
    const accountAlias = document.getElementById("aliasInput").value.trim();
    const codexAccountAlias = document.getElementById("codexAliasInput").value.trim();
    const codexPlan = document.getElementById("codexPlanInput").value;

    chrome.storage.local.set({ accountAlias, codexAccountAlias, codexPlan }, () => {
      const btn = document.getElementById("saveAlias");
      btn.textContent = "已保存";
      setTimeout(() => { btn.textContent = "保存"; }, 1200);
    });
  });
});
