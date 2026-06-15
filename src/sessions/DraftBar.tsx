import { useEffect, useMemo, useState } from "react";
import {
  ListTodo,
  Plus,
  Copy,
  Check,
  Trash2,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  Circle,
  CheckCircle2,
  MessageSquare,
  FolderGit2,
} from "lucide-react";
import type { SessionDraft } from "./types";
import { stamp } from "./format";

/** 归属会话选项（来自当天时间轴的会话行） */
export interface SessionOption {
  source_id: string;
  session_id: string;
  title: string;
  project_name: string;
}

interface Props {
  drafts: SessionDraft[];
  /** 不可变更新：组件构造新数组后交给父组件落盘 */
  onChange: (next: SessionDraft[]) => void;
  /** 当天会话，供「归属」下拉选择 */
  sessions: SessionOption[];
  /** 当前选中的会话（时间轴筛选），作为新待办的默认归属 */
  defaultTarget: SessionOption | null;
}

const nowUnix = () => Math.floor(Date.now() / 1000);
const keyOf = (s: { source_id: string; session_id: string }) => `${s.source_id}::${s.session_id}`;

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 退化方案：隐藏 textarea + execCommand
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/**
 * 「预备发言 / 待办」——用户手写的、面向未来的草稿提示词。
 * 与只读的会话历史相反：可变、用户产生、仅本机私有。
 * 始终展示全部未完成（不随选中日期收窄），即「纵观全局已写好的发言」。
 */
export default function DraftBar({ drafts, onChange, sessions, defaultTarget }: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [text, setText] = useState("");
  const [targetKey, setTargetKey] = useState<string>(""); // "" = 通用
  const [showDone, setShowDone] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // 时间轴选中会话变化时，把新待办默认归属切到该会话。
  // 依赖稳定的 key 字符串（非对象引用），避免 15s 轮询重建对象时反复覆盖手动选择。
  const defaultKey = defaultTarget ? keyOf(defaultTarget) : "";
  useEffect(() => {
    setTargetKey(defaultKey);
  }, [defaultKey]);

  const pending = useMemo(
    () => drafts.filter((d) => !d.done).sort((a, b) => b.created_unix - a.created_unix),
    [drafts]
  );
  const done = useMemo(
    () => drafts.filter((d) => d.done).sort((a, b) => (b.done_unix ?? 0) - (a.done_unix ?? 0)),
    [drafts]
  );

  // 下拉选项：当天会话 + 当前归属（若不在当天列表里，补一条以保证可选中）
  const options = useMemo(() => {
    const map = new Map<string, SessionOption>();
    for (const s of sessions) map.set(keyOf(s), s);
    if (defaultTarget && !map.has(keyOf(defaultTarget))) map.set(keyOf(defaultTarget), defaultTarget);
    return Array.from(map.values());
  }, [sessions, defaultTarget]);

  const add = () => {
    const t = text.trim();
    if (!t) return;
    const opt = options.find((o) => keyOf(o) === targetKey);
    const draft: SessionDraft = {
      id: crypto.randomUUID(),
      text: t,
      source_id: opt?.source_id ?? null,
      session_id: opt?.session_id ?? null,
      session_title: opt?.title ?? "",
      project_name: opt?.project_name ?? "",
      done: false,
      created_unix: nowUnix(),
      done_unix: null,
    };
    onChange([draft, ...drafts]);
    setText("");
  };

  const toggleDone = (id: string) =>
    onChange(
      drafts.map((d) =>
        d.id === id ? { ...d, done: !d.done, done_unix: d.done ? null : nowUnix() } : d
      )
    );

  const remove = (id: string) => onChange(drafts.filter((d) => d.id !== id));
  const clearDone = () => onChange(drafts.filter((d) => !d.done));

  const onCopy = async (d: SessionDraft) => {
    if (await copyText(d.text)) {
      setCopiedId(d.id);
      window.setTimeout(() => setCopiedId((cur) => (cur === d.id ? null : cur)), 1200);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      add();
    }
  };

  return (
    <div className="flex flex-col shrink-0" style={{ background: "#1a1a1a", borderBottom: "1px solid #2a2a2a" }}>
      {/* 头部 */}
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? "展开预备发言" : "收起预备发言"}
          className="inline-flex items-center justify-center"
          style={{ width: 24, height: 24, borderRadius: 6, color: "#9ca3af", background: "#232323", border: "1px solid #333", cursor: "pointer" }}
        >
          {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </button>
        <ListTodo size={15} style={{ color: "#e08a6a" }} />
        <span className="text-sm font-semibold" style={{ color: "#f3f4f6" }}>预备发言</span>
        {pending.length > 0 && (
          <span
            className="text-[11px] tabular-nums px-1.5 py-0.5 rounded-full"
            style={{ color: "#f0b59e", background: "rgba(224,138,106,0.16)" }}
          >
            {pending.length} 待办
          </span>
        )}
        <span className="text-xs ml-auto" style={{ color: "#7a8086" }}>提前写好未来要发给 Claude 的话</span>
      </div>

      {!collapsed && (
        <div className="px-3 pb-3">
          <div className="mx-auto" style={{ maxWidth: 760 }}>
            {/* 输入区 */}
            <div className="rounded-xl p-2.5" style={{ background: "#1d1d1d", border: "1px solid #2a2a2a" }}>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKeyDown}
                rows={2}
                placeholder="记下一条未来要发给 Claude 的话…（Ctrl/⌘+Enter 添加）"
                className="w-full resize-y outline-none text-sm"
                style={{ background: "transparent", color: "#e5e7eb", border: 0, lineHeight: 1.6, minHeight: 44 }}
              />
              <div className="flex items-center gap-2 mt-1.5">
                <span className="inline-flex items-center gap-1 shrink-0 text-[11px]" style={{ color: "#8b9298" }}>
                  <MessageSquare size={12} /> 归属
                </span>
                <select
                  value={targetKey}
                  onChange={(e) => setTargetKey(e.target.value)}
                  className="text-xs min-w-0 flex-1 outline-none"
                  style={{ background: "#232323", color: "#cbd5e1", border: "1px solid #333", borderRadius: 7, padding: "4px 8px", cursor: "pointer" }}
                >
                  <option value="">通用（不挂靠会话）</option>
                  {options.map((o) => (
                    <option key={keyOf(o)} value={keyOf(o)}>
                      {o.title}
                      {o.project_name ? ` · ${o.project_name}` : ""}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={add}
                  disabled={!text.trim()}
                  className="inline-flex items-center gap-1 shrink-0 text-xs font-medium"
                  style={{
                    color: text.trim() ? "#fff" : "#6b7280",
                    background: text.trim() ? "#cc785c" : "#262626",
                    border: 0,
                    borderRadius: 7,
                    padding: "5px 12px",
                    cursor: text.trim() ? "pointer" : "default",
                  }}
                >
                  <Plus size={13} /> 添加
                </button>
              </div>
            </div>

            {/* 待办列表（纵观全局，不随日期收窄） */}
            {pending.length > 0 && (
              <div className="space-y-1.5 mt-2">
                {pending.map((d) => (
                  <DraftItem
                    key={d.id}
                    d={d}
                    copied={copiedId === d.id}
                    onToggle={() => toggleDone(d.id)}
                    onCopy={() => onCopy(d)}
                    onRemove={() => remove(d.id)}
                  />
                ))}
              </div>
            )}

            {/* 已完成（折叠） */}
            {done.length > 0 && (
              <div className="mt-2">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowDone((v) => !v)}
                    className="inline-flex items-center gap-1 text-xs"
                    style={{ color: "#8b9298", background: "transparent", border: 0, cursor: "pointer" }}
                  >
                    <ChevronRight size={12} style={{ transform: showDone ? "rotate(90deg)" : "none", transition: "transform .12s" }} />
                    已完成 {done.length}
                  </button>
                  {showDone && (
                    <button
                      type="button"
                      onClick={clearDone}
                      className="text-[11px] ml-1"
                      style={{ color: "#9ca3af", background: "#262626", border: 0, borderRadius: 6, padding: "1px 8px", cursor: "pointer" }}
                    >
                      清空已完成
                    </button>
                  )}
                </div>
                {showDone && (
                  <div className="space-y-1.5 mt-1.5">
                    {done.map((d) => (
                      <DraftItem
                        key={d.id}
                        d={d}
                        copied={copiedId === d.id}
                        onToggle={() => toggleDone(d.id)}
                        onCopy={() => onCopy(d)}
                        onRemove={() => remove(d.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DraftItem({
  d,
  copied,
  onToggle,
  onCopy,
  onRemove,
}: {
  d: SessionDraft;
  copied: boolean;
  onToggle: () => void;
  onCopy: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      className="group flex items-start gap-2 rounded-lg px-3 py-2"
      style={{ background: d.done ? "#191919" : "#1d1d1d", border: "1px solid #272727" }}
    >
      <button
        type="button"
        onClick={onToggle}
        title={d.done ? "标记为未完成" : "标记为完成"}
        className="shrink-0 inline-flex mt-0.5"
        style={{ background: "transparent", border: 0, cursor: "pointer", color: d.done ? "#4ade80" : "#6b7280" }}
      >
        {d.done ? <CheckCircle2 size={16} /> : <Circle size={16} />}
      </button>

      <div className="min-w-0 flex-1">
        <div
          className="text-sm whitespace-pre-wrap break-words"
          style={{
            color: d.done ? "#6b7280" : "#e5e7eb",
            textDecoration: d.done ? "line-through" : "none",
            lineHeight: 1.55,
            maxHeight: 160,
            overflow: "auto",
          }}
        >
          {d.text}
        </div>
        <div className="flex items-center gap-2 mt-1 text-[10px] flex-wrap" style={{ color: "#8b9298" }}>
          {d.session_id ? (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded truncate max-w-[260px]" style={{ background: "#262626" }}>
              <MessageSquare size={10} /> {d.session_title || d.session_id.slice(0, 8)}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded" style={{ background: "#262626", color: "#7a8086" }}>
              <MessageSquare size={10} /> 通用
            </span>
          )}
          {d.project_name && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded" style={{ background: "#262626" }}>
              <FolderGit2 size={10} /> {d.project_name}
            </span>
          )}
          <span className="font-mono" style={{ color: "#6b7280" }}>{stamp(d.created_unix)}</span>
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={onCopy}
          title="复制到剪贴板"
          className="inline-flex items-center justify-center"
          style={{ width: 26, height: 26, borderRadius: 7, color: copied ? "#4ade80" : "#9ca3af", background: "#232323", border: "1px solid #333", cursor: "pointer" }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
        <button
          type="button"
          onClick={onRemove}
          title="删除"
          className="inline-flex items-center justify-center"
          style={{ width: 26, height: 26, borderRadius: 7, color: "#9ca3af", background: "#232323", border: "1px solid #333", cursor: "pointer" }}
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}
