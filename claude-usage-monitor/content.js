// Content script: 在 claude.ai 页面运行，抓取 usage 数据
// 直接写 storage + 上报 Tauri，绕过 service worker（MV3 会休眠）

const TAURI_PORT = 47892;

// Claude 套餐额度倍率（以 Pro=100% 为基准，与 Codex 的 plus/pro5/pro20 同一套算法）
const CLAUDE_PLAN_MULTIPLIERS = { pro: 1, max5: 5, max20: 20 };

function normalizeClaudePlan(plan) {
  return Object.prototype.hasOwnProperty.call(CLAUDE_PLAN_MULTIPLIERS, plan) ? plan : 'auto';
}

// 从 org 数据自动推断套餐：优先 rate_limit_tier（形如 *_5x / *_20x），其次 capabilities
function detectClaudePlan(org) {
  const tier = String(org.rate_limit_tier || org.settings?.rate_limit_tier || '').toLowerCase();
  const match = tier.match(/(\d+)x/);
  if (match) {
    const factor = Number(match[1]);
    if (factor >= 20) return 'max20';
    if (factor >= 5) return 'max5';
    return 'pro';
  }
  const caps = org.capabilities || [];
  if (caps.includes('claude_max')) return 'max5';
  return 'pro';
}

function claudePlanLabel(planKey, caps) {
  if (planKey === 'max20') return 'Max (x20)';
  if (planKey === 'max5') return 'Max (x5)';
  if (caps.includes('claude_max')) return 'Max';
  if (caps.includes('claude_pro')) return 'Pro';
  return 'Free';
}

function scaleQuota(value, multiplier) {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * multiplier * 10) / 10;
}

async function fetchClaudeUsage() {
  try {
    const orgsRes = await fetch('/api/organizations', { credentials: 'include' });
    if (!orgsRes.ok) return;
    const orgs = await orgsRes.json();
    if (!Array.isArray(orgs) || orgs.length === 0) return;
    const org = orgs[0];
    const orgUuid = org.uuid;
    const plan = org.capabilities || [];

    const stored = isContextValid() ? await chrome.storage.local.get('claudePlan') : {};
    const manualPlan = normalizeClaudePlan(stored.claudePlan);
    const planKey = manualPlan === 'auto' ? detectClaudePlan(org) : manualPlan;
    const multiplier = CLAUDE_PLAN_MULTIPLIERS[planKey] ?? 1;

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
      plan: claudePlanLabel(planKey, plan),
      plan_key: planKey,
      multiplier,
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
    console.warn('[claude-usage-monitor] fetch error:', e.message);
  }
}

async function reportToTauri(data) {
  try {
    if (!isContextValid()) return;
    const { accountAlias } = await chrome.storage.local.get('accountAlias');
    const alias = accountAlias?.trim() || data.email || 'unknown';
    const multiplier = data.multiplier ?? 1;

    await fetch(`http://localhost:${TAURI_PORT}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider:          'claude_code',
        account_alias:     alias,
        session_pct:       scaleQuota(data.current_session?.utilization, multiplier),
        session_total_pct: 100 * multiplier,
        session_reset_at:  data.current_session?.resets_at ?? null,
        weekly_pct:        scaleQuota(data.weekly?.utilization, multiplier),
        weekly_total_pct:  100 * multiplier,
        weekly_reset_at:   data.weekly?.resets_at ?? null,
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
