// Content script: 在 claude.ai 页面运行，抓取 usage 数据
// 直接写 storage + 上报 Tauri，绕过 service worker（MV3 会休眠）

const TAURI_PORT = 47892;

async function fetchClaudeUsage() {
  try {
    const orgsRes = await fetch('/api/organizations', { credentials: 'include' });
    if (!orgsRes.ok) return;
    const orgs = await orgsRes.json();
    if (!Array.isArray(orgs) || orgs.length === 0) return;
    const org = orgs[0];
    const orgUuid = org.uuid;
    const plan = org.capabilities || [];

    const membersRes = await fetch(`/api/organizations/${orgUuid}/members`, { credentials: 'include' });
    if (!membersRes.ok) return;
    const members = await membersRes.json();
    const me = (members[0] && members[0].account) || {};

    const usageRes = await fetch(`/api/organizations/${orgUuid}/usage`, { credentials: 'include' });
    if (!usageRes.ok) return;
    const usage = await usageRes.json();

    const data = {
      email: me.email_address || '',
      full_name: me.full_name || '',
      plan: plan.includes('claude_max') ? 'Max' : plan.includes('claude_pro') ? 'Pro' : 'Free',
      current_session: {
        utilization: usage.five_hour ? usage.five_hour.utilization : null,
        resets_at:   usage.five_hour ? usage.five_hour.resets_at   : null,
      },
      weekly: {
        utilization: usage.seven_day ? usage.seven_day.utilization : null,
        resets_at:   usage.seven_day ? usage.seven_day.resets_at   : null,
      },
      extra_usage_enabled: usage.extra_usage ? usage.extra_usage.is_enabled : false,
    };

    // 直接写 storage（popup 读这里）
    if (isContextValid()) {
      chrome.storage.local.set({ claudeData: data, updatedAt: Date.now() });
    }

    // 直接 POST 到 Tauri，不走 background service worker
    await reportToTauri(data);

  } catch (e) {
    console.warn('[Claude Usage Monitor] fetch error:', e.message);
  }
}

async function reportToTauri(data) {
  try {
    if (!isContextValid()) return;
    const { accountAlias } = await chrome.storage.local.get('accountAlias');
    const alias = accountAlias?.trim() || data.email || 'unknown';

    await fetch(`http://localhost:${TAURI_PORT}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_alias:    alias,
        session_pct:      data.current_session?.utilization ?? null,
        session_reset_at: data.current_session?.resets_at   ?? null,
        weekly_pct:       data.weekly?.utilization           ?? null,
        weekly_reset_at:  data.weekly?.resets_at             ?? null,
      }),
    });
  } catch {
    // Tauri 未启动时静默忽略
  }
}

function isContextValid() {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

async function safeFetchClaudeUsage() {
  if (!isContextValid()) {
    clearInterval(intervalId);
    return;
  }
  await fetchClaudeUsage();
}

// 监听来自 popup 的刷新请求
try {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'REFRESH') safeFetchClaudeUsage();
  });
} catch {}

safeFetchClaudeUsage();
const intervalId = setInterval(safeFetchClaudeUsage, 20 * 1000);
