function formatResetsIn(isoString) {
  if (!isoString) return '';
  const now = new Date();
  const target = new Date(isoString);
  let diffMs = target - now;
  if (diffMs < 0) return '即将重置';
  const totalMin = Math.floor(diffMs / 60000);
  const hr = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  if (hr > 0) return `${hr} 小时 ${min} 分后重置`;
  return `${min} 分钟后重置`;
}

function barClass(pct) {
  if (pct >= 80) return 'danger';
  if (pct >= 60) return 'warn';
  return '';
}

function render(data) {
  const el = document.getElementById('content');
  if (!data) {
    el.innerHTML = `
      <div class="no-data">
        暂无数据<br>
        请先访问 <a href="https://claude.ai" target="_blank">claude.ai</a><br>
        再打开此弹窗
      </div>`;
    return;
  }

  const sessionPct = data.current_session.utilization ?? 0;
  const weeklyPct  = data.weekly.utilization ?? 0;

  el.innerHTML = `
    <div class="account">
      <div class="account-email">${data.email || '未知账户'}</div>
      <div class="account-name">${data.full_name || ''}</div>
      <span class="plan-badge">${data.plan}</span>
    </div>

    <div class="section-title">用量统计</div>

    <div class="usage-card">
      <div class="usage-label">
        <span class="usage-name">Current Session（5h）</span>
        <span class="usage-pct">${sessionPct}%</span>
      </div>
      <div class="bar-bg">
        <div class="bar-fill ${barClass(sessionPct)}" style="width:${sessionPct}%"></div>
      </div>
      <div class="resets">${formatResetsIn(data.current_session.resets_at)}</div>
    </div>

    <div class="usage-card">
      <div class="usage-label">
        <span class="usage-name">Weekly · All Models</span>
        <span class="usage-pct">${weeklyPct}%</span>
      </div>
      <div class="bar-bg">
        <div class="bar-fill ${barClass(weeklyPct)}" style="width:${weeklyPct}%"></div>
      </div>
      <div class="resets">${formatResetsIn(data.weekly.resets_at)}</div>
    </div>

    <div class="extra-row">
      <span>Extra Usage</span>
      <div style="display:flex;align-items:center;gap:6px;">
        <span style="font-size:11px">${data.extra_usage_enabled ? '已开启' : '未开启'}</span>
        <div class="extra-dot ${data.extra_usage_enabled ? 'on' : 'off'}"></div>
      </div>
    </div>

    <button class="refresh-btn" id="refreshBtn">↺ 刷新数据</button>
    <div class="footer" id="updateTime"></div>
  `;

  document.getElementById('refreshBtn').addEventListener('click', () => {
    // 向 content script 发送刷新指令，然后重新读取
    chrome.tabs.query({ url: 'https://claude.ai/*' }, (tabs) => {
      if (tabs.length > 0) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'REFRESH' }, () => {
          setTimeout(loadAndRender, 1500);
        });
      }
    });
  });
}

function loadAndRender() {
  chrome.storage.local.get(['claudeData', 'updatedAt'], (result) => {
    render(result.claudeData || null);
    if (result.updatedAt) {
      const el = document.getElementById('updateTime');
      if (el) {
        const d = new Date(result.updatedAt);
        el.textContent = '更新于 ' + d.toLocaleTimeString('zh-CN');
      }
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  loadAndRender();

  // 别名
  chrome.storage.local.get('accountAlias', res => {
    if (res.accountAlias) document.getElementById('aliasInput').value = res.accountAlias;
  });
  document.getElementById('saveAlias').addEventListener('click', () => {
    const v = document.getElementById('aliasInput').value.trim();
    chrome.storage.local.set({ accountAlias: v }, () => {
      const btn = document.getElementById('saveAlias');
      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = '保存'; }, 1200);
    });
  });
});