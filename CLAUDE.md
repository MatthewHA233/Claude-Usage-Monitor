# Claude Switch - AI 辅助开发规则

## Rust 编译约束（严格遵守）

- Rust 编译必须用 `cargo xwin build`，不能直接 `cargo build`
- **禁止** `cargo xwin check` — 会产生 ~5.5GB 无用产物，且不产出可执行文件
- **禁止** 自主使用 `cargo xwin build --release` — 除非用户明确要求
- **禁止** 自动运行 `npm run dev` — 用户自行启动前端
- **禁止** 自动运行 `npm run tauri dev` — 此命令在本环境不可用
- 产物路径：`src-tauri/target/x86_64-pc-windows-msvc/debug/`（非 `target/debug/`）

## 版本同步

升版本时需同步修改三处：
- `package.json` → `"version"`
- `src-tauri/Cargo.toml` → `version`
- `src-tauri/tauri.conf.json` → `"version"`

## 项目说明

Claude Pro 三账号用量追踪与调度推荐工具。
- 前端：React 19 + TypeScript + Vite + Tailwind CSS
- 后端：Tauri 2 + Rust（reqwest + rusqlite + tokio + chrono）
- 配置文件：`~/.claude-switch/config.json`
- 数据库：`~/.claude-switch/usage.db`
