import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FilePen,
  FilePlus,
  FileText,
  FolderGit2,
  Globe,
  ListChecks,
  MessagesSquare,
  Monitor,
  Search,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { StreamMessage, ReplyBlock } from "./types";
import { clock, nfmt, bucketOf, subSecond, secInBucket } from "./format";
import { laneKey } from "./lanes";
import { fetchToolResult } from "./api";
import MessageText from "./MessageText";
import Markdown from "./Markdown";

const pad2 = (n: number) => String(n).padStart(2, "0");

// 轨道(列)最小宽度：多轨道平分若低于此值，则固定此宽并开横向滚动（实测 2 轨≈310px，取整 300）
const MIN_LANE_W = 300;
const LANE_GAP = 12;

interface Props {
  messages: StreamMessage[];
  loading: boolean;
  sessionTitles: Record<string, string>;
  laneOf: Record<string, number>; // laneKey → 列；与时间轴共用
  laneCount: number;
}

/** flomo 风格卡片流：当天我的发言，时间正序（新消息在底部）、滚动默认贴底，每条一张卡片 */
export default function MessageStream({ messages, loading, sessionTitles, laneOf, laneCount }: Props) {
  // 时间正序：新消息排在底部（messages 传入为倒序，这里翻正）
  const ordered = useMemo(() => [...messages].reverse(), [messages]);
  // 滚动贴底：仅在「切换数据集(切天/筛选, 首条变了)」或「用户本就停在底部」时贴底，
  // 不打断用户向上翻看历史（父组件轮询刷新会换 messages 引用，不能每次都拉回底部）
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const firstKeyRef = useRef("");
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const first = ordered[0];
    const firstKey = first ? `${first.source_id}:${first.session_id}:${first.ts_unix ?? 0}` : "";
    const datasetChanged = firstKey !== firstKeyRef.current;
    firstKeyRef.current = firstKey;
    if (datasetChanged || atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [ordered]);

  // 按 10 分钟桶分组：同桶的卡片横向并排（最多 3 列、略微高低错落）表达并发；
  // 单卡片桶占满整行（不空旷）
  const groups = useMemo(() => {
    const gs: { bucket: number; hour: number; cards: StreamMessage[] }[] = [];
    for (const m of ordered) {
      const b = bucketOf(m.ts_unix);
      const last = gs[gs.length - 1];
      if (last && last.bucket === b) last.cards.push(m);
      else gs.push({ bucket: b, hour: Math.floor(b / 6), cards: [m] });
    }
    return gs;
  }, [ordered]);

  if (loading && messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 animate-pulse" style={{ color: "#8b9298" }}>
        <div className="text-sm">正在初始化会话数据…</div>
        <div className="text-xs" style={{ color: "#6b7280" }}>首次需解析全部历史会话，可能要十几秒，请稍候</div>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2" style={{ color: "#6b7280" }}>
        <div className="text-sm">这一天没有发言</div>
      </div>
    );
  }

  const single = laneCount <= 1;
  const renderCard = (m: StreamMessage, ci: number, bucket: number) => (
    <StreamCard
      key={`${m.source_id}:${m.session_id}:${m.ts_unix ?? 0}:${ci}`}
      m={m}
      shade={bucket % 2 === 0}
      sessionTitle={sessionTitles[m.session_id] || m.session_id.slice(0, 8)}
    />
  );

  return (
    <div ref={scrollRef} onScroll={onScroll} className={`overflow-auto h-full py-4 ${single ? "px-5" : "px-3"}`}>
      <div
        className={single ? "mx-auto" : undefined}
        style={single ? { maxWidth: 760 } : { minWidth: laneCount * MIN_LANE_W + (laneCount - 1) * LANE_GAP }}
      >
        {groups.map((g, gi) => {
          const crossHour = gi > 0 && groups[gi - 1].hour !== g.hour;
          return (
            <div key={`${g.bucket}:${gi}`}>
              {gi > 0 &&
                (crossHour ? (
                  // 1 小时边界：醒目分界 + 时刻
                  <div className="flex items-center gap-2" style={{ margin: "13px 6px 11px" }}>
                    <div style={{ height: 1, flex: 1, background: "#3a3a3a" }} />
                    <span className="text-[10px] font-mono" style={{ color: "#9ca3af" }}>{pad2(g.hour)}:00</span>
                    <div style={{ height: 1, flex: 1, background: "#3a3a3a" }} />
                  </div>
                ) : (
                  // 10 分钟边界：细分界
                  <div style={{ height: 1, background: "#2c2c2c", margin: "8px 16px" }} />
                ))}
              {single ? (
                // 单轨道：纵向流，宽容器舒适阅读
                <div className="flex flex-col" style={{ gap: 6 }}>
                  {g.cards.map((m, ci) => renderCard(m, ci, g.bucket))}
                </div>
              ) : (
                // 多轨道：每个会话固定在自己的列(轨道)；以本桶最早卡片为基准(不下沉)，
                // 其余列按"相对最早卡片的秒差"下沉形成参差。单列/单卡片桶基准=自己=不下沉
                (() => {
                  const baseSec = Math.min(...g.cards.map((m) => secInBucket(m.ts_unix)));
                  return (
                    <div className="flex items-start" style={{ gap: 12 }}>
                      {Array.from({ length: laneCount }, (_, lane) => {
                        const laneCards = g.cards.filter((m) => (laneOf[laneKey(m.source_id, m.session_id)] ?? 0) === lane);
                        const top = laneCards.length
                          ? (secInBucket(laneCards[0].ts_unix) - baseSec) * 0.18
                          : 0;
                        return (
                          <div key={lane} className="flex flex-col" style={{ flex: 1, minWidth: 0, gap: 6, marginTop: top }}>
                            {laneCards.map((m, ci) => renderCard(m, ci, g.bucket))}
                          </div>
                        );
                      })}
                    </div>
                  );
                })()
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const StreamCard = memo(function StreamCard({ m, shade, sessionTitle }: { m: StreamMessage; shade: boolean; sessionTitle: string }) {
  const [open, setOpen] = useState(false);
  const blocks = m.blocks ?? [];
  const toolCount = blocks.reduce((n, b) => n + (b.type === "tool" ? 1 : 0), 0);
  const hasReply = m.reply_chars > 0 || blocks.length > 0;

  // 按 10 分钟桶奇偶相间的卡片背景（与时间轴斑马同节奏）
  const bg = shade ? "#25252c" : "#191919";
  const { ss } = subSecond(m.ts); // 秒（时:分之外更细一档）
  return (
    // content-visibility:auto → 视口外卡片跳过布局/绘制（长列表性能关键）；
    // contain-intrinsic-size 给未渲染时的占位高度，auto 让浏览器记住渲染过的真实高度、避免滚动条跳动
    <div
      className="rounded-xl px-4 py-3 flex gap-3"
      style={{ background: bg, border: "1px solid #2a2a2a", contentVisibility: "auto", containIntrinsicSize: "auto 88px" }}
    >
      <div className="shrink-0 font-mono" style={{ width: 46, paddingTop: 1 }}>
        <div style={{ color: "#e5e7eb", fontSize: 15, fontWeight: 700, letterSpacing: "0.3px" }}>{clock(m.ts_unix)}</div>
        {ss && (
          <div style={{ fontSize: 11, fontWeight: 600, marginTop: 2, letterSpacing: "0.5px", color: "#8b9096" }}>:{ss}</div>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <CollapsibleText text={m.text} images={m.images} bg={bg} />

      <div className="flex items-center gap-1.5 mt-2 text-[10px] flex-wrap">
        <Tag icon={<FolderGit2 size={10} />} label={m.project_name || "—"} accent="green" />
        <Tag icon={<MessagesSquare size={10} />} label={sessionTitle} accent="violet" />
        <Tag icon={<Monitor size={10} />} label={m.source_label} accent="green" />

        {hasReply ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-0.5 ml-0.5"
            style={{ color: "#8fb3d3", background: "transparent", border: 0, cursor: "pointer" }}
          >
            <ChevronRight size={11} style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .12s" }} />
            Claude 回复{m.reply_chars > 0 ? ` · ${nfmt(m.reply_chars)} 字` : ""}{toolCount > 0 ? ` · ${toolCount} 工具` : ""}
          </button>
        ) : (
          <span style={{ color: "#555" }}>（无回复正文）</span>
        )}
      </div>

      {open && hasReply && (
        <div
          className="rounded-md px-3 py-2 mt-2.5"
          style={{ background: "#171717", border: "1px solid #262626", maxHeight: 420, overflow: "auto" }}
        >
          {blocks.length > 0 ? (
            <ReplyBlocks blocks={blocks} source={m.source_id} session={m.session_id} />
          ) : (
            <Markdown content={m.reply} />
          )}
        </div>
      )}
      </div>
    </div>
  );
});

// 超过该字数的发言（常是大段粘贴）默认折叠，底部渐变 + 大范围可点的展开/收起
const COLLAPSE_THRESHOLD = 1000;
const COLLAPSED_H = 220;

function CollapsibleText({
  text,
  images,
  bg,
}: {
  text: string;
  images: StreamMessage["images"];
  bg: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > COLLAPSE_THRESHOLD;

  const body = (
    <div className="card-selectable text-sm whitespace-pre-wrap break-words" style={{ color: "#e5e7eb", lineHeight: 1.6 }}>
      <MessageText text={text} images={images} />
    </div>
  );

  if (!long) return body;

  if (!expanded) {
    return (
      <div style={{ position: "relative" }}>
        <div style={{ maxHeight: COLLAPSED_H, overflow: "hidden" }}>{body}</div>
        {/* 底部渐变 + 大范围可点的展开按钮 */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(true);
          }}
          className="card-expand absolute inset-x-0 bottom-0 flex items-end justify-center"
          style={{
            height: 92,
            paddingBottom: 8,
            background: `linear-gradient(to bottom, ${bg}00 0%, ${bg} 78%)`,
            border: 0,
            cursor: "pointer",
          }}
          title="展开全文"
        >
          <span
            className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium"
            style={{ color: "#cbd5e1", background: "#2c2c34", border: "1px solid #3a3b46", boxShadow: "0 2px 8px rgba(0,0,0,0.45)" }}
          >
            <ChevronDown size={14} /> 展开全文 · {nfmt(text.length)} 字
          </span>
        </button>
      </div>
    );
  }

  // 展开态：收起按钮 sticky 在视口底部，正文滚出后才归位
  return (
    <div>
      {body}
      <div
        className="flex justify-center"
        style={{ position: "sticky", bottom: 8, marginTop: 10, pointerEvents: "none", zIndex: 1 }}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(false);
          }}
          className="card-expand inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium"
          style={{
            pointerEvents: "auto",
            color: "#cbd5e1",
            background: "#2c2c34",
            border: "1px solid #3a3b46",
            boxShadow: "0 4px 14px rgba(0,0,0,0.55)",
            cursor: "pointer",
          }}
          title="收起"
        >
          <ChevronUp size={14} /> 收起
        </button>
      </div>
    </div>
  );
}

// 纯展示标签（筛选已撤，仅标识项目/会话/机器）
function Tag({ icon, label, accent }: { icon: ReactNode; label: string; accent: "green" | "violet" }) {
  const dot = accent === "green" ? "#7fd1a8" : "#b3a0e0";
  return (
    <span
      className="card-tag inline-flex items-center gap-1 px-1.5 py-0.5 rounded"
      style={{ background: "#2c2c2c", color: "#c7ccd1", maxWidth: 190 }}
      title={label}
    >
      <span className="shrink-0 inline-flex" style={{ color: dot }}>{icon}</span>
      <span className="truncate">{label}</span>
    </span>
  );
}

// ── 回复块交错渲染：文字（Markdown）+ 工具调用卡片，按真实顺序 ──
function ReplyBlocks({ blocks, source, session }: {
  blocks: ReplyBlock[];
  source: string;
  session: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      {blocks.map((b, i) =>
        b.type === "text" ? (
          <Markdown key={i} content={b.text} />
        ) : (
          <ToolCallBlock key={i} name={b.name} input={b.input} toolId={b.id} source={source} session={session} />
        )
      )}
    </div>
  );
}

/** 各工具的图标 + 强调色 */
function toolVisual(name: string): { Icon: LucideIcon; color: string } {
  switch (name) {
    case "Read":
      return { Icon: FileText, color: "#60a5fa" };
    case "Write":
      return { Icon: FilePlus, color: "#4ade80" };
    case "Edit":
    case "NotebookEdit":
      return { Icon: FilePen, color: "#fbbf24" };
    case "Bash":
      return { Icon: SquareTerminal, color: "#fb923c" };
    case "Grep":
    case "Glob":
      return { Icon: Search, color: "#22d3ee" };
    case "Task":
      return { Icon: Bot, color: "#c084fc" };
    case "WebFetch":
    case "WebSearch":
      return { Icon: Globe, color: "#38bdf8" };
    case "TodoWrite":
      return { Icon: ListChecks, color: "#a3e635" };
    default:
      return { Icon: Wrench, color: "#d98cff" };
  }
}

const toolPre: CSSProperties = {
  margin: 0,
  fontSize: 11,
  lineHeight: 1.55,
  color: "#c2c8d0",
  fontFamily: "monospace",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  overflow: "auto",
  maxHeight: 300,
};

function ToolSection({ label, sep, children }: { label: string; sep?: boolean; children: ReactNode }) {
  return (
    <div style={{ padding: "6px 10px 8px", borderTop: sep ? "1px solid #232329" : undefined }}>
      <div
        style={{
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: "0.6px",
          color: "#6b7078",
          marginBottom: 4,
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

/** 单个工具调用：图标 + 名称 + 入参摘要；点一次同时展开「完整入参 + 懒加载结果」 */
function ToolCallBlock({ name, input, toolId, source, session }: {
  name: string;
  input: unknown;
  toolId: string;
  source: string;
  session: string;
}) {
  const [open, setOpen] = useState(false);
  const [res, setRes] = useState<string | null>(null);
  const [resLoading, setResLoading] = useState(false);
  const [resErr, setResErr] = useState(false);
  const summary = summarizeToolInput(name, input);
  const { Icon, color } = toolVisual(name);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    // 首次展开时懒加载结果（之后切换只是显隐）
    if (next && res === null && !resErr && toolId) {
      setResLoading(true);
      try {
        const r = await fetchToolResult(source, session, toolId);
        setRes(r ?? "（未找到该工具的返回结果）");
      } catch {
        setResErr(true);
      } finally {
        setResLoading(false);
      }
    }
  };

  return (
    <div className="rounded-lg overflow-hidden" style={{ background: "#1a1a1e", border: "1px solid #2b2b32" }}>
      <button
        type="button"
        onClick={toggle}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 min-w-0 text-left"
        style={{ background: open ? "#1f1f24" : "transparent", border: 0, cursor: "pointer" }}
      >
        <span
          className="inline-flex items-center justify-center shrink-0"
          style={{ width: 19, height: 19, borderRadius: 5, background: `${color}22` }}
        >
          <Icon size={12} style={{ color }} />
        </span>
        <span style={{ color, fontWeight: 600, fontFamily: "monospace", fontSize: 12.5, flexShrink: 0 }}>{name}</span>
        {summary && (
          <span className="truncate" style={{ color: "#8b9096", fontSize: 11.5, fontFamily: "monospace" }}>{summary}</span>
        )}
        <ChevronRight
          size={12}
          style={{ marginLeft: "auto", flexShrink: 0, color: "#5b5f67", transform: open ? "rotate(90deg)" : "none", transition: "transform .12s" }}
        />
      </button>

      {open && (
        <div style={{ borderTop: "1px solid #2b2b32" }}>
          <ToolSection label="入参">
            <pre style={toolPre}>{prettyJson(input)}</pre>
          </ToolSection>
          <ToolSection label="结果" sep>
            {resLoading ? (
              <span style={{ color: "#8b9096", fontSize: 11 }}>加载中…</span>
            ) : resErr ? (
              <span style={{ color: "#e0a0a0", fontSize: 11 }}>读取失败：原始会话文件不可达 / 远程源离线</span>
            ) : (
              <pre style={toolPre}>{res}</pre>
            )}
          </ToolSection>
        </div>
      )}
    </div>
  );
}

// 工具入参摘要：取各工具的关键字段，单行展示
function summarizeToolInput(name: string, input: unknown): string {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));
  const short = (v: string, n = 100) => (v.length > n ? v.slice(0, n) + "…" : v);
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return short(s(o.file_path ?? o.path ?? o.notebook_path));
    case "Bash":
      return short(s(o.command));
    case "Grep":
      return short([s(o.pattern), o.path ? `· ${s(o.path)}` : "", o.glob ? `· ${s(o.glob)}` : ""].filter(Boolean).join(" "));
    case "Glob":
      return short(s(o.pattern));
    case "Task":
      return short(s(o.description ?? o.subagent_type));
    case "WebFetch":
      return short(s(o.url));
    case "WebSearch":
      return short(s(o.query));
    case "TodoWrite":
      return Array.isArray(o.todos) ? `${(o.todos as unknown[]).length} 项` : "";
    default: {
      const first = Object.values(o).find((v) => typeof v === "string") as string | undefined;
      return first ? short(first) : "";
    }
  }
}

function prettyJson(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}
