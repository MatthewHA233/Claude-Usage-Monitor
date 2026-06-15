import { useState } from "react";
import { ChevronRight, FolderGit2, Monitor } from "lucide-react";
import type { StreamMessage } from "./types";
import { stamp, nfmt } from "./format";
import MessageText from "./MessageText";
import Markdown from "./Markdown";

interface Props {
  messages: StreamMessage[];
  loading: boolean;
}

/** 发言流：跨会话、按时间倒序平铺「我的每条发言」，AI 回复默认折叠在条目内 */
export default function MessageStream({ messages, loading }: Props) {
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
        <div className="text-sm">还没有发言记录</div>
      </div>
    );
  }

  return (
    <div className="overflow-auto h-full px-4 py-3 space-y-1.5">
      {messages.map((m, i) => (
        <StreamItem key={`${m.source_id}:${m.session_id}:${m.ts_unix ?? 0}:${i}`} m={m} />
      ))}
    </div>
  );
}

function StreamItem({ m }: { m: StreamMessage }) {
  const [open, setOpen] = useState(false);
  const hasReply = m.reply_chars > 0;

  return (
    <div className="rounded-lg" style={{ background: "#1d1d1d", border: "1px solid #272727" }}>
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <span className="text-[10px] font-mono shrink-0 mt-0.5" style={{ color: "#6b7280", width: 78 }}>
          {stamp(m.ts_unix)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm whitespace-pre-wrap break-words" style={{ color: "#e5e7eb" }}>
            <MessageText text={m.text} images={m.images} />
          </div>

          <div className="flex items-center gap-2 mt-1.5 text-[10px] flex-wrap" style={{ color: "#8b9298" }}>
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded" style={{ background: "#262626" }}>
              <FolderGit2 size={10} /> {m.project_name || "—"}
            </span>
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded" style={{ background: "#262626" }}>
              <Monitor size={10} /> {m.source_label}
            </span>
            {hasReply ? (
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="inline-flex items-center gap-0.5"
                style={{ color: "#8fb3d3", background: "transparent", border: 0, cursor: "pointer" }}
              >
                <ChevronRight
                  size={11}
                  style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform .12s" }}
                />
                Claude 回复 · {nfmt(m.reply_chars)} 字
              </button>
            ) : (
              <span style={{ color: "#555" }}>（无回复正文）</span>
            )}
          </div>

          {open && hasReply && (
            <div
              className="rounded-md px-3 py-2 mt-2"
              style={{ background: "#171717", border: "1px solid #262626", maxHeight: 360, overflow: "auto" }}
            >
              <Markdown content={m.reply} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
