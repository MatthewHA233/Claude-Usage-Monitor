const REFRESH_INTERVAL_MS = 20_000;

function setStatus(key, message) {
  chrome.storage.local.set({ [key]: message, codexUpdatedAt: Date.now() });
}

function inject(tabId, files, statusKey) {
  chrome.scripting.executeScript({ target: { tabId }, files }, () => {
    if (chrome.runtime.lastError) {
      setStatus(statusKey, `注入脚本失败：${chrome.runtime.lastError.message}`);
    }
  });
}

function refreshClaudeTab(tabId) {
  chrome.tabs.sendMessage(tabId, { type: "REFRESH" }, () => {
    if (!chrome.runtime.lastError) return;
    inject(tabId, ["content.js"], "claudeStatus");
  });
}

function refreshCodexTab(tabId) {
  chrome.tabs.sendMessage(tabId, { type: "REFRESH_CODEX" }, () => {
    if (!chrome.runtime.lastError) {
      setStatus("codexStatus", "正在通过 ChatGPT 接口刷新 Codex 数据");
      return;
    }
    chrome.scripting.executeScript(
      { target: { tabId }, files: ["codex_quota.js", "codex_content.js"] },
      () => {
        if (chrome.runtime.lastError) {
          setStatus("codexStatus", `注入 Codex 脚本失败：${chrome.runtime.lastError.message}`);
          return;
        }
        setStatus("codexStatus", "已注入 Codex 脚本，正在通过 ChatGPT 接口刷新");
      },
    );
  });
}

function refreshPricingTab(tabId) {
  inject(tabId, ["pricing_detector.js"], "codexStatus");
}

function refreshOpenTabs() {
  chrome.tabs.query({ url: "https://claude.ai/*" }, (tabs) => {
    for (const tab of tabs) {
      if (tab.id) refreshClaudeTab(tab.id);
    }
  });

  chrome.tabs.query({ url: "https://chatgpt.com/*" }, (tabs) => {
    for (const tab of tabs) {
      if (tab.id) refreshCodexTab(tab.id);
    }
    for (const tab of tabs) {
      if (tab.id && tab.url?.includes("#pricing")) refreshPricingTab(tab.id);
    }
  });
}

chrome.runtime.onInstalled.addListener(refreshOpenTabs);
chrome.runtime.onStartup.addListener(refreshOpenTabs);
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (tab.url?.startsWith("https://claude.ai/")) refreshClaudeTab(tabId);
  if (tab.url?.startsWith("https://chatgpt.com/")) refreshCodexTab(tabId);
  if (tab.url?.startsWith("https://chatgpt.com/") && tab.url.includes("#pricing")) refreshPricingTab(tabId);
});

setInterval(refreshOpenTabs, REFRESH_INTERVAL_MS);
refreshOpenTabs();
