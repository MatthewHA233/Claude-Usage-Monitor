(function () {
  const USAGE_PATH = "/backend-api/wham/usage";
  const MESSAGE_TYPE = "CODEX_USAGE_MONITOR_USAGE";

  function isUsageUrl(input) {
    try {
      const url = typeof input === "string"
        ? new URL(input, location.origin)
        : new URL(input?.url || "", location.origin);
      return url.origin === location.origin && url.pathname === USAGE_PATH;
    } catch {
      return false;
    }
  }

  function publishUsage(usage) {
    window.postMessage({ source: "claude-usage-monitor", type: MESSAGE_TYPE, usage }, location.origin);
  }

  function captureResponse(response) {
    try {
      if (!isUsageUrl(response.url)) return;
      response.clone().json().then(publishUsage).catch(() => {});
    } catch {
      // Ignore page-side interception failures.
    }
  }

  if (!window.__claudeUsageMonitorCodexFetchPatched) {
    window.__claudeUsageMonitorCodexFetchPatched = true;
    const originalFetch = window.fetch;
    window.fetch = async function patchedFetch(input, init) {
      const response = await originalFetch.apply(this, arguments);
      if (isUsageUrl(input)) captureResponse(response);
      return response;
    };
  }

  if (!window.__claudeUsageMonitorCodexXhrPatched) {
    window.__claudeUsageMonitorCodexXhrPatched = true;
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
      this.__claudeUsageMonitorCodexUrl = url;
      return originalOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function patchedSend() {
      if (isUsageUrl(this.__claudeUsageMonitorCodexUrl)) {
        this.addEventListener("load", () => {
          try {
            const text = this.responseText;
            if (!text) return;
            publishUsage(JSON.parse(text));
          } catch {
            // Ignore non-JSON responses.
          }
        });
      }
      return originalSend.apply(this, arguments);
    };
  }
})();
