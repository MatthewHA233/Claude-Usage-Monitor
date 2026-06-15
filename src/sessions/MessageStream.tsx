import { useState, type ReactNode } from "react";
import { ChevronRight, ChevronDown, ChevronUp, FolderGit2, Monitor, MessagesSquare } from "lucide-react";
import type { StreamMessage } from "./types";
import { clock, nfmt, bucketOf } from "./format";
import MessageText from "./MessageText";
import Markdown from "./Markdown";

const pad2 = (n: number) => String(n).padStart(2, "0");

interface Props {
  messages: StreamMessage[];
  loading: boolean;
  sessionTitles: Record<string, string>;
  activeSourceId: string | null;
  activeProject: string | null;
  activeSession: string | null;
  onFilterSource: (id: string) => void;
  onFilterProject: (name: string) => void;
  onFilterSession: (sourceId: string, sessionId: string, title: string) => void;
}

/** flomo 风格卡片流：当天我的发言，时间倒序，每条一张卡片 */
export default function MessageStream({
  messages,
  loading,
  sessionTitles,
  activeSourceId,
  activeProject,
  activeSession,
  onFilterSource,
  onFilterProject,
  onFilterSession,
}: Props) {
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

  return (
    <div className="overflow-auto h-full px-5 py-4">
      <div className="mx-auto" style={{ maxWidth: 760 }}>
        {messages.map((m, i) => {
          const b = bucketOf(m.ts_unix); // 当天第几个 10 分钟
          const h = Math.floor(b / 6);
          const prevB = i > 0 ? bucketOf(messages[i - 1].ts_unix) : -2;
          const crossHour = i > 0 && Math.floor(prevB / 6) !== h;
          const cross10 = i > 0 && prevB !== b;
          return (
            <div key={`${m.source_id}:${m.session_id}:${m.ts_unix ?? 0}:${i}`}>
              {i > 0 &&
                (crossHour ? (
                  // 1 小时边界：醒目分界 + 时刻
                  <div className="flex items-center gap-2" style={{ margin: "13px 6px 11px" }}>
                    <div style={{ height: 1, flex: 1, background: "#3a3a3a" }} />
                    <span className="text-[10px] font-mono" style={{ color: "#9ca3af" }}>{pad2(h)}:00</span>
                    <div style={{ height: 1, flex: 1, background: "#3a3a3a" }} />
                  </div>
                ) : cross10 ? (
                  // 10 分钟边界：细分界
                  <div style={{ height: 1, background: "#2c2c2c", margin: "8px 16px" }} />
                ) : (
                  <div style={{ height: 6 }} />
                ))}
              <StreamCard
                m={m}
                shade={b % 2 === 0}
                sessionTitle={sessionTitles[m.session_id] || m.session_id.slice(0, 8)}
                activeSourceId={activeSourceId}
                activeProject={activeProject}
                activeSession={activeSession}
                onFilterSource={onFilterSource}
                onFilterProject={onFilterProject}
                onFilterSession={onFilterSession}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StreamCard({
  m,
  shade,
  sessionTitle,
  activeSourceId,
  activeProject,
  activeSession,
  onFilterSource,
  onFilterProject,
  onFilterSession,
}: {
  m: StreamMessage;
  shade: boolean;
  sessionTitle: string;
  activeSourceId: string | null;
  activeProject: string | null;
  activeSession: string | null;
  onFilterSource: (id: string) => void;
  onFilterProject: (name: string) => void;
  onFilterSession: (sourceId: string, sessionId: string, title: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const hasReply = m.reply_chars > 0;

  // 按 10 分钟桶奇偶相间的卡片背景（与时间轴斑马同节奏）
  const bg = shade ? "#25252c" : "#191919";
  return (
    <div className="rounded-xl px-4 py-3 flex gap-3" style={{ background: bg, border: "1px solid #2a2a2a" }}>
      <div
        className="shrink-0 font-mono"
        style={{ color: "#e5e7eb", fontSize: 15, fontWeight: 700, width: 46, paddingTop: 1, letterSpacing: "0.3px" }}
      >
        {clock(m.ts_unix)}
      </div>

      <div className="min-w-0 flex-1">
        <CollapsibleText text={m.text} images={m.images} bg={bg} />

      <div className="flex items-center gap-1.5 mt-2 text-[10px] flex-wrap">
        <Tag
          icon={<FolderGit2 size={10} />}
          label={m.project_name || "—"}
          active={activeProject === (m.project_name || "—")}
          accent="green"
          onClick={() => onFilterProject(m.project_name || "—")}
        />
        <Tag
          icon={<MessagesSquare size={10} />}
          label={sessionTitle}
          active={activeSession === m.session_id}
          accent="violet"
          onClick={() => onFilterSession(m.source_id, m.session_id, sessionTitle)}
        />
        <Tag
          icon={<Monitor size={10} />}
          label={m.source_label}
          active={activeSourceId === m.source_id}
          accent="green"
          onClick={() => onFilterSource(m.source_id)}
        />

        {hasReply ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-0.5 ml-0.5"
            style={{ color: "#8fb3d3", background: "transparent", border: 0, cursor: "pointer" }}
          >
            <ChevronRight size={11} style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .12s" }} />
            Claude 回复 · {nfmt(m.reply_chars)} 字
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
          <Markdown content={m.reply} />
        </div>
      )}
      </div>
    </div>
  );
}

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

function Tag({
  icon,
  label,
  active,
  accent,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  accent: "green" | "violet";
  onClick: () => void;
}) {
  const activeBg = accent === "green" ? "#2f6f4f" : "#5a4a8c";
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="card-tag inline-flex items-center gap-1 px-1.5 py-0.5 rounded"
      style={{
        background: active ? activeBg : "#2c2c2c",
        color: active ? "#f9fafb" : "#c7ccd1",
        border: 0,
        cursor: "pointer",
        maxWidth: 190,
      }}
      title={label}
    >
      <span className="shrink-0 inline-flex">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}
