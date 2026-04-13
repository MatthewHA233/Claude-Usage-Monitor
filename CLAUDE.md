# Claude Switch - AI 辅助开发规则

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
- 终端2（Rust 后端）：`cd src-tauri && cargo xwin build` → 完成后手动运行 `target/x86_64-pc-windows-msvc/debug/claude-switch.exe`

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
- 配置文件：`~/.claude-switch/config.json`
- 数据库：`~/.claude-switch/usage.db`
