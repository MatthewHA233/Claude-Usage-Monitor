# Claude Usage Monitor

跨账号 Claude Pro 用量监控桌面端 — Tauri + React 主程序配套 Chrome 扩展，本地汇总 session / weekly 配额，提供历史曲线、重置到点闹钟和异常数据收件箱。

> Multi-account Claude Pro usage monitor — Tauri + React desktop app paired with a Chrome extension that reports session / weekly limits to a local server, with history charts, reset alarms and an anomaly inbox.

---

## 工作原理

```
 ┌──────────────────┐    POST /report     ┌──────────────────────┐
 │ Chrome 扩展       │ ──────────────────► │ Tauri 桌面端          │
 │ (content script) │                     │ axum @ 127.0.0.1:47892│
 │ 抓 claude.ai     │                     │ rusqlite (SQLite)    │
 └──────────────────┘                     └──────────┬───────────┘
                                                     │
                                                     ▼
                                          React UI（多账号视图）
```

- **Chrome 扩展** 在登录的 `claude.ai` 页面读取 session / weekly utilization、reset 时间和账号邮箱，按变化推送到本机端口 `47892`
- **Tauri 后端**（Rust + axum + rusqlite）把上报落地到本地 SQLite，启动时跑 schema 迁移和百分比归一化
- **React 前端**（Vite + Tailwind + lucide-react）渲染每账号当前用量、历史曲线、堆叠彩带图和提醒/收件箱面板

所有数据只在本机存储，不向外发出。

## 主要功能

- **多账号面板**：每个账号一张卡片，分别显示 session（5 小时窗口）和 weekly（7 天窗口）的实时百分比、剩余时间、彩色进度条
- **历史图表**：按账号查看历史使用率曲线、每日总消耗的堆叠彩带图、自定义账号颜色
- **Session 到点闹钟** 🔔：每张卡片可单独开启重置提醒；多个账号在 ±1 分钟内同时到点，会合并成一条顶栏横幅、统一停止
- **异常数据收件箱** 📥：扩展瞬时读到的脏数据（如 weekly 0% → 100%、session 0% → 100% 但 weekly 几乎不变）会被自动过滤进每账号 FIFO 收件箱（最多 10 条），可手动确认补回历史，按原 `collected_at` 时间戳插入正确位置
- **自动同步**：Chrome 扩展只在数值变化时推送；后端去重 + 异常过滤；前端轮询展示

## 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面外壳 | Tauri 2.x（Rust + WebView2） |
| 后端 | axum 0.8、rusqlite 0.31（bundled）、tokio、chrono |
| 前端 | React 19、TypeScript、Vite 6、Tailwind 3、lucide-react |
| 浏览器扩展 | Chrome MV3（content script + service worker） |

## 安装与运行

### 终端用户

直接下载 [Releases](../../releases) 中的 `Claude Usage Monitor_<version>_x64-setup.exe`（NSIS）或 `.msi` 安装即可。

安装后还需要：

1. 把 `claude-usage-monitor/` 目录作为「未打包扩展」加载到 Chrome（`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序）
2. 登录至少一个 `claude.ai` 账号
3. 启动桌面端，扩展会自动开始上报

### 开发

```bash
# 前端依赖
npm install

# 开发模式（前端 + Tauri 同时启动）
npx tauri dev

# 打包 Windows 安装包（使用 cargo-xwin）
npx tauri build --runner cargo-xwin
```

产物位于 `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/{nsis,msi}/`。

## 目录结构

```
claude-switch/
├─ src/                   # React 前端
│  ├─ components/         # StatusCards / AlarmBell / InboxPanel / ProgressBar
│  ├─ hooks/              # useData / useInbox / useResetAlarm
│  └─ assets/             # logo、闹钟铃声
├─ src-tauri/
│  └─ src/                # commands.rs / db.rs / http_server.rs / models.rs
└─ claude-usage-monitor/  # Chrome MV3 扩展
   ├─ manifest.json
   ├─ background.js
   ├─ content.js
   └─ popup.html / popup.js
```

## License

MIT
