# 主题线白板（Topic Whiteboard）设计文档

> 把「会话发言面板」从「项目 → 会话」二维结构，升级为引入「主题(topic)」维度的
> **泳道换乘图**（地铁线 × git 换道算法）：每行 = 一条主题轨道，会话像列车线随时间
> 在主题间用贝塞尔曲线换乘；AI 读会话数据归纳主题并给每条消息分配主题，用户可拖拽换轨纠错。

状态：设计已定稿，分阶段实施中。本文档为实施依据，改动需同步更新。

---

## 1. 背景与目标

- 现状：会话窗口（`src/sessions/`，独立 WebviewWindow `label=sessions`）是 flomo 式「以天为中心」——
  热力图选天 + 并行轨道时间轴（`SessionTimeline`）+ 卡片流（`MessageStream`）+ 浮动待办（`DraftBar`）。
- 目标：新增「主题白板」视图，把**散落在多个会话里的同主题发言聚合成一条「主题线」**，
  直观展示「一条会话随时间在多个主题间游走/切换」。
- 形态：独立窗口 `label=topics`（与会话窗解耦），SVG 手绘零依赖。

## 2. 关键数据约束（决定了隐喻选型）

来自对现有代码的勘探，两条硬约束否决了「纯 git 分支 DAG」：

1. **JSONL 无 `parentUuid`/`fork` 字段**。`session_parse.rs` 只产线性的 `UserTurn` 序列，
   会话内消息关系靠 `session_id` 连续性 + 时间序，**没有父子提交链**。
   → git-DAG 的「分叉/合并」在数据里没有落点；而「会话随时间在主题间游走」是数据的自然结构。
2. **`messages.id` 不稳定**。`session_store.rs::ingest()` 每次同步对变更文件
   `DELETE FROM messages WHERE source=? AND file_path=?` 再带 `AUTOINCREMENT` 重插，
   故文件每次增长 `messages.id` 都会变。
   → topic 关联表**绝不能用 `messages.id` 当外键**。

**唯一稳定的消息键** = `(source, session_id, ts_unix, seq)`。
其中 `seq` 是 `ingest` 里 `meta.turns.iter().enumerate()` 的序号，对 append-only transcript
早期 turn 不变；`ts_unix` 同样不变；二者组合在「同一会话同一秒多条」的罕见情况下仍唯一。

## 3. 数据模型

全部落 **sessions.db**（`<LocalAppData>/claude-usage-monitor/sessions.db`，与 messages/sessions 同库），
由独立的 `TopicStore`（独立 `Connection` + WAL + `busy_timeout`，避开 4s 同步循环持锁）管理。
**绝不改 `messages` 表**——只新增关联表。

### 3.1 session_topics（主题字典，每源隔离）

```sql
CREATE TABLE IF NOT EXISTS session_topics (
    source       TEXT NOT NULL,
    topic_id     TEXT NOT NULL,           -- 应用层生成的稳定 id（如 uuid 或 hash）
    name         TEXT NOT NULL,           -- 主题名（AI 命名，可人工改）
    color        TEXT,                    -- 复用 db.rs::color_for_alias 的 15 色调色板
    blurb        TEXT,                    -- 一句话主题说明
    importance   INTEGER NOT NULL DEFAULT 0, -- 重要度（决定轨道 y 排序）
    lane_hint    INTEGER,                 -- 可选：钉主干主题到固定轨道
    created_unix INTEGER NOT NULL DEFAULT 0,
    infer_model  TEXT,                    -- 例 claude-haiku-4-5 / 手动
    PRIMARY KEY(source, topic_id)
);
```

### 3.2 message_topics（消息 ↔ 主题归属，MVP 单归属）

```sql
CREATE TABLE IF NOT EXISTS message_topics (
    source       TEXT NOT NULL,
    session_id   TEXT NOT NULL,
    ts_unix      INTEGER NOT NULL,
    seq          INTEGER NOT NULL,
    topic_id     TEXT NOT NULL,
    confidence   REAL,                    -- AI 置信度
    pinned       INTEGER NOT NULL DEFAULT 0, -- 1=人工锁定，AI 重算跳过
    updated_unix INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(source, session_id, ts_unix, seq)
);
CREATE INDEX IF NOT EXISTS idx_mt_topic ON message_topics(source, topic_id);
CREATE INDEX IF NOT EXISTS idx_mt_sess  ON message_topics(source, session_id, ts_unix);
```

### 3.3 topic_runs（增量水位线，借 files.mtime 思路）

```sql
CREATE TABLE IF NOT EXISTS topic_runs (
    source          TEXT PRIMARY KEY,
    last_built_unix INTEGER NOT NULL DEFAULT 0,
    last_ts_unix    INTEGER NOT NULL DEFAULT 0, -- 只对 ts_unix>此值的新消息跑 AI
    model           TEXT,
    status          TEXT                        -- idle / building / error:<msg>
);
```

### 3.4 白板布局（派生缓存，非权威表）

布局由 lane-assignment 算法从 `message_topics` 派生，存 `db.rs::set_setting` 单行 blob，
键 `topic_layout_<source>_<scope>`（scope = `YYYY-MM-DD` 或 `range:from-to`）：

```jsonc
{
  "version": 1,
  "scope": "2026-06-16",
  "tracks": [{ "topic_id": "...", "y": 0, "color": "#cc785c" }],
  "trains": [{
    "session_id": "...", "color": "#4a9eff",
    "points": [{ "x_unix": 1750000000, "topic_id": "...", "confidence": 0.9 }],
    "kinks":  [/* 换乘拐点 */]
  }],
  "generated_unix": 1750000000
}
```

**坐标存逻辑 `x_unix` 而非像素**，前端按缩放换算 → 缩放/换天不失真。布局可随时重算重建。

### 3.5 待办挂主题

`session_drafts`（在 **usage.db**，db.rs 管）用 `add_column_if_missing` 幂等加 nullable 列 `topic_id`，
让 `DraftBar` 把预备发言挂到某主题轨道。`SessionDraft` 结构加 `topic_id: Option<String>`。

### 3.6 一致性维护点（重要）

`ingest` 删旧行重插后：
- `pinned=0` 的归属行无需处理——下次 build 用 `(session_id, ts_unix, seq)` 重新归属即可。
- `pinned=1` 的人工行若对应 turn 的 `ts_unix/seq` 因解析变化漂移会孤儿化。
  → build 末尾做一次 `message_topics` 孤儿清理（与 messages 反连接无匹配则删），并记日志。

## 4. AI 主题生成：可插拔 provider

**核心设计：把「谁来算」做成可插拔，不锁死任何一条调用路径。**
未来要接入「类似 open-design 那种内部调用 claude code 的对话框架」，也支持纯手动。

```
[稳定] 导出分析任务(export)   →   [可插拔] TopicProvider   →   [稳定] 校验落库(import)
  组装 prompt：                      ┌ 手动模式  (MVP 必做)
  系统说明 + 已有主题清单            ├ 自动模式  (可选，复用 local_usage OAuth+7890)
  + 本批会话摘要 + strict JSON 约束  └ 未来：claude code 对话框架 (agentic)
```

- **手动模式（MVP 默认，零风险零额度）**：
  `session_topics_export` 把结构化 prompt 复制到剪贴板/存文件 → 用户丢给任意 AI（网页 Claude /
  未来框架）→ 把返回 JSON 粘回 → `session_topics_import` 校验落库 + 重算布局。
- **自动模式（可选开关）**：复刻 `local_usage.rs` 的 OAuth（`~/.claude/.credentials.json` accessToken）
  + 7890 代理感知 `http_client`，调 `api.anthropic.com/v1/messages`，header 带
  `Authorization: Bearer` + `anthropic-beta: oauth-2025-04-20` + `anthropic-version`。
  **遵守铁律：禁止直连 Anthropic，必须走 7890 代理；用户无需配 API key。**
- **未来 provider**：实现同一 `TopicProvider` 接口（甚至 agentic 自主读会话）插入即可。

关键不变量：**export 打包 + import 校验落库是稳定契约，中间换谁算都行。**

### 4.1 输入信号（全部已物化，零新解析）

`messages.text` + 折叠 `reply` + `chars` + `ts_unix`（时间邻接）+ `images`（可选视觉锚）；
`sessions.title`（custom>ai>first_prompt 三级回退）/ `project_name` / `project_path` / `git_branch`。
**`git_branch + project_path` 是天然弱主题种子**——先按 `(source, project_path, git_branch)` 确定性
粗分桶降 token，再让 AI 在桶内/跨桶精炼语义与命名。**不扫 repo 源码**（已定）。

### 4.2 两段式（自动模式，控成本）

1. **Worker = claude-haiku-4-5**（200K ctx，便宜）：分批（每批 80–150 条）对每条消息分配
   `topic_id` 或 `new_topic_name`，走 strict 工具 `assign_topics`
   （`input_schema strict:true / additionalProperties:false`），`tool_choice` 强制该工具，
   `json.loads` 解析（不做 raw 字符串匹配）。
2. **Curator = claude-sonnet-4-x**：对 Haiku 候选主题去重/合并/定名/定 importance，单次调用
   （主题数通常 <30）。把若干 `pinned=1` 人工样例反喂作 few-shot 让 AI 学偏好。

`assign_topics` 入参示意：
```jsonc
{
  "assignments": [{ "key": { "session_id": "...", "ts_unix": 0, "seq": 0 },
                    "topic_id": "...|null", "new_topic_name": "...|null", "confidence": 0.0 }],
  "new_topics":  [{ "topic_id": "...", "name": "...", "blurb": "..." }]
}
```

**prompt 缓存**：稳定前缀（系统提示 + 已存在主题清单 + 项目上下文）打
`cache_control:{type:'ephemeral'}`，易变的「本批消息」放断点之后 → 重复/分批跑走 cache_read(~0.1x)。

### 4.3 触发、增量、纠错

- 触发：默认**手动按钮「分析主题」**，`tokio::task::spawn_blocking` 跑（同 `session_my_messages` 模式），
  **绝不进 4s 同步循环**。状态走 `AtomicBool`，前端轮询 `session_topics_state` 显示「归纳中…」。
- 增量：只喂 `topic_runs.last_ts_unix` 之后的新消息；`force` 时全量重跑（清 `pinned=0` 行）。
  首次对 history 源 8000+ 条**按项目/日期范围小步跑**，UI 给进度与预估，不一键全量。
- 纠错闭环：白板拖会话节点换轨 → `session_topic_reassign(keys[], topic_id)` →
  写 `message_topics(pinned=1, confidence=1.0)` → 乐观更新布局 → 后端重算 → 回填；失败回滚。
  手动归属对 AI 不可见地钉死，下次 build 跳过 `pinned` 行。

## 5. 布局算法（git lane-assignment 贪心）

纯前端 TS（或后端 `build_layout()`），不用力导向：

```
输入：scope 内全部 message_topics（按 ts_unix 升序）+ session_topics
1. 收集 scope 内出现过的 topic_id，按「首次出现时间」排序 → 决定轨道进场顺序。
   importance 高的主题钉到低 y（类比 git first-parent 主线）；「未归类」灰轨置底兜底。
2. 维护 activeLanes:（topic_id|null）[]。遍历时间：
   - 某主题首次出现 → 占首个空轨（branch in）
   - 某主题在 scope 内不再出现 → 释放轨（merge out），释放轨优先复用
   ⇒ 主题存活期不换列，天然抗交叉。
3. 每个会话取其消息序 (x_unix, topic_id) 串：
   - 同轨连续点 → 直线（贴轨道中心；同轨多会话按 session_id hash 取 8 槽 ±offset 微错位）
   - 相邻跨轨 → 三次贝塞尔换乘曲线（控制点取两端 x 中点，成 S 形），换乘点放会话色车站圆点
   - idle gap（复用 last_unix 间隔阈值）→ 断为虚线，不强连长曲线
4. 坐标输出逻辑 x_unix（非像素），前端按缩放换算。
```

## 6. 渲染与窗口

- **技术**：SVG + React hooks 手绘，+0KB 依赖（不引 reactflow/d3/konva）。与
  `SessionTimeline.tsx`/`Heatmap.tsx` 的 inline-style + 绝对定位 + `position:fixed` 浮层同范式。
- **窗口**：独立 `WebviewWindow label=topics`。`main.tsx` 按 `window.label` 加分支渲染 `TopicBoardApp`
  （与 `sessions` 同模式）。状态自建（date/source/topic/缩放），**取数走 Tauri 命令、不直发 HTTP**。
  与会话窗联动（点主题线→筛卡片流）通过 Tauri 事件或共享 DB 状态跨窗通信。
- **渲染分层（z 序）**：底=轨道矩形带（主题色 12% 透明）→ 中=会话列车线 `<path>` →
  上=车站 `<circle>` → 左侧冻结主题标题列（sticky div，复用 `SessionTimeline` 的 `LABEL_W=220` + FREEZE 阴影）。
  大数据用 `transform` 平移 + 视口裁剪。
- **新文件**：`src/topics/TopicBoardApp.tsx`（主组件 + 轨道/列车线子组件）、`src/topics/api.ts`、
  `src/topics/types.ts`。配色借 `db.rs::color_for_alias`。

## 7. Tauri 命令清单

| 命令 | 用途 |
|------|------|
| `session_topics_get(source?)` | 读主题字典 |
| `session_topics_save(topic)` | 主题增删改名/改色（行级 upsert） |
| `session_topics_export(source?, scope?, force)` | 组装手动分析 prompt（含会话摘要 + strict JSON 约束） |
| `session_topics_import(json)` | 校验并落库 AI 返回（写 session_topics/message_topics + 重算布局） |
| `session_topics_build(source?, scope?, force)` | 自动模式：spawn_blocking 触发 provider 两段式归纳 |
| `session_topics_state()` | 轮询归纳进度（building/done/total） |
| `session_topic_board(source?, scope?)` | 读布局 blob；缺失时回退按 git_branch/project_path 出占位轨道 |
| `session_topic_reassign(keys[], topic_id)` | 人工纠错，写 message_topics(pinned=1) + 重算布局 |
| `session_my_messages` 扩 `topic?` | JOIN message_topics 过滤，配合 StreamFilter.topic |
| `session_draft_upsert` 扩 `topic_id` | 待办挂主题轨道 |

## 8. 交互

- 点主题线（整轨）：高亮该主题全部会话段 + 下发 `StreamFilter{topic}` 联动卡片流。
- 点会话线/节点：等价「点会话名」，高亮整条 strand + 卡片流过滤到该会话该时段。
- 悬浮车站/线段：复用 `SessionTimeline` 的 `position:fixed z-60` 浮层，显示
  会话标题 · 项目 · 时间 · 当前主题 · confidence。
- 拖拽纠错：拖会话节点（或框选某段）到另一条轨道 → `session_topic_reassign` → 乐观更新。
- DraftBar：归属下拉加「按主题」分组；草稿挂主题轨道显示徽标。
- 工具栏「分析主题」按钮 + 进度态。

## 9. 分阶段实施路线

- **P0 数据底座**（1–2d）：`topic_store.rs`（3 表 + TopicStore + Topic/MessageTopic + 读写骨架）、
  `session_drafts` 加 `topic_id` 列、AppState 接线、lib.rs 注册、确认稳定键。**纯增量、零 AI、零风险。**
- **P1 AI 归纳 + provider 抽象**（2–3d）：`TopicProvider` trait、`export`/`import`（手动）、
  `build`（自动模式，复刻 OAuth+7890，Haiku→Sonnet 两段式 + strict 工具 + prompt 缓存 + 增量水位线 +
  pinned 跳过 + 孤儿清理）、`session_topics_state` 进度。
- **P2 布局 + 只读白板**（3–4d）：`build_layout()` lane-assignment、`session_topic_board`；
  `main.tsx` 加 `topics` 窗口入口 + `TopicBoardApp` SVG 渲染轨道/列车线/贝塞尔/车站 + 缩放平移 + 视口裁剪。
- **P3 交互闭环**（2–3d）：点轨道/会话联动、悬浮浮层、拖拽换轨纠错、主题 CRUD、DraftBar 挂主题。
- **P4 进阶**（可选）：跨源叠加（列车线描边区分 source）、时间折叠压缩长 idle、主题合并/只显 TopK、
  自由白板（届时引入 `@xyflow/react` 仅用于自由编排画布，泳道图仍 SVG）、历史小步归纳的额度护栏。

## 10. 取舍记录

- **不用纯 git-DAG**：数据无 parentUuid，分叉合并无落点；泳道换乘图才是数据的自然结构。
- **不用 reactflow（MVP）**：泳道图是「固定行 + 水平时间 + 贝塞尔线」，坐标后端算好前端只读，
  SVG 即可，+0KB；自由白板（拖节点/便签/手连线）推迟到 P4 再评估引入。
- **AI 只管归属，不算布局**：布局是确定性算法的派生缓存，可重算、省 AI、稳定不抖。
- **AI 调用可插拔**：手动模式不依赖任何外部框架，自动模式复用现有零封号链路，未来框架平滑接入。
