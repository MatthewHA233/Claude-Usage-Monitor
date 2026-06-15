# Claude Usage Monitor - AI 辅助开发规则

## Rust 编译约束（严格遵守）

- Rust 编译必须用 `cargo xwin build`，不能直接 `cargo build`
- **禁止** `cargo xwin check` — 会产生 ~5.5GB 无用产物，且不产出可执行文件
- **禁止** 自主使用 `cargo xwin build --release` — 除非用户明确要求
- **禁止** 自动运行 `npm run dev` — 用户自行启动前端
- **禁止** 自动运行 `npm run tauri dev` — 此命令在本环境不可用
- 产物路径：`src-tauri/target/x86_64-pc-windows-msvc/debug/`（非 `target/debug/`）

## 开发工作流（两终端）

`npm run tauri dev` **不可用**（内部调用 `cargo build` 而非 `cargo xwin build`）。

开发时必须两个终端分开跑：
- 终端1（前端热更新）：`npm run dev`
- 终端2（Rust 后端）：`cd src-tauri && cargo xwin build` → 完成后手动运行 `target/x86_64-pc-windows-msvc/debug/claude-usage-monitor.exe`

TypeScript 类型检查：`npx tsc --noEmit`（前端），Rust 检查直接用 `cargo xwin build`（增量编译快，约 7-15s）。

## 磁盘空间管理

| 操作 | 占用 |
|------|------|
| debug 编译后 | ~2.2 GB |
| release 打包后 | ~2-3 GB |

打包流程：先删 debug 腾空间 → `npx tauri build --runner cargo-xwin` → 产物在 `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/`

## 版本同步

升版本时需同步修改三处：
- `package.json` → `"version"`
- `src-tauri/Cargo.toml` → `version`
- `src-tauri/tauri.conf.json` → `"version"`

## 项目说明

Claude Pro 三账号用量追踪与调度推荐工具。
- 前端：React 19 + TypeScript + Vite + Tailwind CSS
- 后端：Tauri 2 + Rust（reqwest + rusqlite + tokio + chrono）
- 配置文件：`~/.claude-usage-monitor/config.json`
- 数据库：`~/.claude-usage-monitor/usage.db`

## 会话数据架构 / 与 claude启动器 的通信

「会话」窗口（`src/sessions/`，独立 WebviewWindow，label=`sessions`）的数据后端在**本项目 Rust**，
**claude启动器**（ClaudeCodeLauncher，仓库：`D:\my_pro\纯文本\聊天\claude启动器`）只当**薄中继**。

**职责划分**
- **claude-switch（Rust）= 后端**：解析 JSONL（`session_parse.rs`）+ rusqlite 物化（`session_store.rs`）+ 出查询命令。
  - **本机数据**：Rust 直接读 `~/.claude/projects/**/*.jsonl`，**不经 Python**。
  - **远程数据**：Rust 用 `reqwest::blocking`（`.no_proxy()`，局域网不走 7890 代理）拉远程中继的原始字节，
    再用**同一个 Rust 解析器**解析、物化（库内按 `source` 区分本机/各远程）。
- **claude启动器（Python）= 薄中继**：只把本机原始 JSONL 传出去，**不解析、不建库**。脚本 `session_api_server.py`（纯标准库）。

**中继 HTTP 端点**（每台机器绑 `0.0.0.0:47800`）
- `GET  /api/ping`            心跳
- `GET  /api/info`            本机身份（hostname/os）
- `GET  /raw/list`            列全部 .jsonl：`{key, session_id, mtime, size}`
- `GET  /raw/file?key=...`    返回该文件原始字节
- `GET  /queue/list`          查看本机待发的「预备发言」队列（按 session_id 分组）
- `POST /queue/push`          推入一条待发草稿 `{session_id, text, id?}`
- `POST /api/shutdown`        仅本机优雅关闭

**预备发言 / 待办（drafts）+ 启动器自动打字**（用户手写、面向未来、仅本机私有）
- 草稿存**独立表** `session_drafts`（`db.rs`，列：id/text/source_id/session_id/session_title/project_name/done/created_unix/done_unix）。
  命令 `session_drafts_get`(列表) / `session_draft_upsert`(按行新增改) / `session_draft_delete`(按行删)。前端组件 `src/sessions/DraftBar.tsx`。
  - **绝不整表覆盖**：`SessionsApp.persistDrafts` 对比新旧数组，只 upsert 变化行、只 delete 真正移除行；
    即使加载扑空(drafts=[])，新增也只 upsert 一条，不会误删已有行。
  - 旧实现曾把整数组塞进 `app_settings['session_drafts']`（整体覆盖式，易在前端状态扑空时被清空导致丢数据），
    已弃用；`db.rs::migrate_drafts_from_settings` 启动时一次性把旧 blob 迁入新表并删掉该 setting。
- 「推送到启动器」：Tauri 命令 `session_draft_push(draft)` —— 本机会话由 Rust 直写
  `~/.claude/launcher_queue.json`；远程会话 POST 到该来源中继 `/queue/push`（中继写它本机同名文件）。
- **队列文件契约** `~/.claude/launcher_queue.json`：`{"version":1,"queue":{"<session_id>":[{"id","text"}]}}`，
  同 `draft id` 去重，临时文件 rename 原子替换。
- **启动器消费（实时注入）**：`claude_launcher.py` 的 `execute_claude_command`（四种进入对话的触发器全汇于此）
  解析 session_id（`--resume <id>` 直接取；`-c` 反查最近会话；新建/选择器拿不到则跳过）后调用
  `_start_draft_watcher` 起一个**后台轮询线程**：会话存活期间每秒 `launcher_queue.pop` 一次，有草稿就
  `console_typer.type_text` **逐字符**写入控制台输入缓冲（`WriteConsoleInputW`，不依赖窗口焦点）。
  既覆盖「进入前已排队」也覆盖「**常驻对话期间随时推送**」。**只填不发**（不注入回车），用户检查后自行回车。
  会话退出时主线程 `stop_evt.set()` 停止轮询。
  **关键前提**：本进程与 claude 共用同一控制台，故 subprocess.run 阻塞主线程时该线程仍能写入；
  因此**只有经更新后的启动器进入/恢复的会话**才带 watcher——旧启动器拉起的旧会话需重新 `ccrun` 进入一次才生效。

**中继生命周期**：由 launcher 幂等自启 —— `session_api_autostart.py` 的 `ensure_running()`，
在 `claude_launcher.py` / `codex_launcher.py` 启动时调用；detached、不弹窗、空闲 900s 自动退、多窗口竞态由 bind 失败兜底。
**关键约束**：本机读文件系统**不需要**中继；只有「别的机器要读本机数据」才需要在那台机器跑中继。

**物化库**：`<LocalAppData>/claude-usage-monitor/sessions.db`（与 usage.db 同目录、独立文件）。
文件级增量同步（mtime/size 未变即跳过），后台循环每 4s 一次，查询命令只读不阻塞。

**前端取数**：全部走 Tauri 命令 `invoke`（`session_my_messages` / `session_timeline` / `session_stats` /
`session_status` / `session_sync_state` / `session_image` / `session_sources_get|save` 等），**不直接发 HTTP**。
远程源地址（中继的局域网 URL）由用户在「会话」窗口手动添加，存在 `app_settings` 的 `session_sources`。

**局域网发现（mDNS，零配置加源）**：对端中继用系统原生 Bonjour 广播 `_claude-relay._tcp`
（macOS `dns-sd -R` / Linux `avahi-publish`，relay 退出即终止）；本项目用 `mdns-sd` crate 浏览，
命令 `session_discover_relays`（独立模块 `src-tauri/src/discovery.rs`，前端 `src/sessions/discovery.ts`）。
「添加会话来源」对话框打开即扫描，列出在线中继，点一下直接添加（免手输 IP）。仅能发现**正在运行**的中继。
