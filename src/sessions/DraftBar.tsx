import { useEffect, useMemo, useRef, useState } from "react";
import {
  ListTodo,
  Plus,
  Copy,
  Check,
  Send,
  Trash2,
  ChevronRight,
  Circle,
  CheckCircle2,
  MessageSquare,
  FolderGit2,
  ChevronDown,
  X,
} from "lucide-react";
import type { SessionDraft } from "./types";
import { pushDraft } from "./api";
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
 *
 * 形态：常驻左下角的科幻 HUD —— 收起时只是一个小 handle，点击后从左下角
 * 向右"伸展"成悬浮面板，叠在卡片之上、不挤占任何组件。
 * 始终展示全部未完成（不随选中日期收窄），即「纵观全局已写好的发言」。
 */
export default function DraftBar({ drafts, onChange, sessions, defaultTarget }: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [targetKey, setTargetKey] = useState<string>(""); // "" = 通用
  const [selOpen, setSelOpen] = useState(false); // 归属下拉是否展开（自定义，非原生 select）
  const [showDone, setShowDone] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [pushedId, setPushedId] = useState<string | null>(null);
  const [pushErr, setPushErr] = useState<{ id: string; msg: string } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<HTMLButtonElement | null>(null);

  // 时间轴选中会话变化时，把新待办默认归属切到该会话。
  // 依赖稳定的 key 字符串（非对象引用），避免 15s 轮询重建对象时反复覆盖手动选择。
  const defaultKey = defaultTarget ? keyOf(defaultTarget) : "";
  useEffect(() => {
    setTargetKey(defaultKey);
  }, [defaultKey]);

  // 展开时：Esc 收回 + 点击面板外收回（不拦截背后内容的交互）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || handleRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

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

  // 归属下拉项（首项＝通用）与当前选中标签
  const selItems = useMemo(
    () => [
      { key: "", label: "通用（不挂靠会话）", project: "" },
      ...options.map((o) => ({ key: keyOf(o), label: o.title, project: o.project_name })),
    ],
    [options]
  );
  const targetLabel = useMemo(() => {
    const cur = selItems.find((it) => it.key === targetKey) ?? selItems[0];
    return cur.label + (cur.project ? ` · ${cur.project}` : "");
  }, [selItems, targetKey]);

  // 面板收起时一并收起归属下拉
  useEffect(() => {
    if (!open) setSelOpen(false);
  }, [open]);

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

  const onPush = async (d: SessionDraft) => {
    try {
      await pushDraft(d);
      setPushErr((cur) => (cur?.id === d.id ? null : cur));
      setPushedId(d.id);
      window.setTimeout(() => setPushedId((cur) => (cur === d.id ? null : cur)), 1500);
    } catch (e) {
      const msg = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
      setPushErr({ id: d.id, msg });
      window.setTimeout(() => setPushErr((cur) => (cur?.id === d.id ? null : cur)), 3500);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      add();
    }
  };

  const canSubmit = !!text.trim();

  return (
    <div style={{ position: "fixed", right: 16, top: 16, zIndex: 45 }}>
      {/* 收起态：左下角常驻 handle */}
      <button
        ref={handleRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="draft-hud-handle"
        title="预备发言：提前写好未来要发给 Claude 的话"
        style={{ opacity: open ? 0 : 1, pointerEvents: open ? "none" : "auto", transition: "opacity .18s ease" }}
      >
        <ListTodo size={15} style={{ color: "#5fd3e0" }} />
        预备发言
        {pending.length > 0 && (
          <span
            className="tabular-nums"
            style={{
              fontSize: 11,
              fontWeight: 700,
              minWidth: 17,
              height: 17,
              padding: "0 4px",
              borderRadius: 9,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#0b1316",
              background: "#5fd3e0",
            }}
          >
            {pending.length}
          </span>
        )}
      </button>

      {/* 展开态：HUD 面板（始终在 DOM，靠 class 切 clip 动画） */}
      <div
        ref={panelRef}
        className={`draft-hud-panel ${open ? "open" : "closed"}`}
        style={{ width: 480, maxWidth: "calc(100vw - 32px)" }}
      >
        <span className="draft-hud-corner tl" />
        <span className="draft-hud-corner tr" />
        <span className="draft-hud-corner bl" />
        <span className="draft-hud-corner br" />

        {/* 头部 */}
        <div className="flex items-center gap-2 px-3.5 pt-3 pb-2.5">
          <ListTodo size={16} style={{ color: "#5fd3e0" }} />
          <span className="text-sm font-semibold" style={{ color: "#eafcff", letterSpacing: ".4px" }}>
            预备发言
          </span>
          {pending.length > 0 && (
            <span
              className="text-[11px] tabular-nums px-1.5 py-0.5 rounded-full"
              style={{ color: "#aef0f7", background: "rgba(95,211,224,0.16)" }}
            >
              {pending.length} 待办
            </span>
          )}
          <span className="text-[11px] ml-auto mr-1" style={{ color: "#5d6b70" }}>
            提前写好未来要发的话
          </span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            title="收起（Esc）"
            className="inline-flex items-center justify-center"
            style={{ width: 24, height: 24, borderRadius: 7, color: "#9ca3af", background: "rgba(255,255,255,0.04)", border: "1px solid #2c3338", cursor: "pointer" }}
          >
            <X size={14} />
          </button>
        </div>

        {/* 输入区 */}
        <div className="px-3.5">
          <div
            className="rounded-xl p-2.5"
            style={{ background: "rgba(0,0,0,0.28)", border: "1px solid rgba(95,211,224,0.16)" }}
          >
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              rows={2}
              placeholder="记下一条未来要发给 Claude 的话…"
              className="w-full resize-y outline-none text-sm"
              style={{ background: "transparent", color: "#e5e7eb", border: 0, lineHeight: 1.6, minHeight: 44 }}
            />
            <div className="flex items-center gap-2 mt-1.5">
              <span className="inline-flex items-center shrink-0" style={{ color: "#6b7780" }} title="归属会话">
                <MessageSquare size={13} />
              </span>
              <button
                type="button"
                onClick={() => setSelOpen((v) => !v)}
                title="选择归属会话"
                className="text-xs min-w-0 flex-1 inline-flex items-center gap-1 outline-none"
                style={{
                  background: selOpen ? "rgba(95,211,224,0.10)" : "rgba(255,255,255,0.04)",
                  color: "#cbd5e1",
                  border: `1px solid ${selOpen ? "rgba(95,211,224,0.45)" : "#2c3338"}`,
                  borderRadius: 7,
                  padding: "5px 8px",
                  cursor: "pointer",
                }}
              >
                <span className="truncate flex-1 text-left">{targetLabel}</span>
                <ChevronDown
                  size={13}
                  style={{ color: "#5fd3e0", transform: selOpen ? "rotate(180deg)" : "none", transition: "transform .15s" }}
                />
              </button>
              <span className="shrink-0 text-[10px] font-mono" style={{ color: "#4f5a60" }}>
                ⌘/Ctrl+↵
              </span>
              <button
                type="button"
                onClick={add}
                disabled={!canSubmit}
                className="inline-flex items-center gap-1 shrink-0 text-xs font-medium"
                style={{
                  color: canSubmit ? "#06131a" : "#5b6166",
                  background: canSubmit ? "#5fd3e0" : "rgba(255,255,255,0.05)",
                  border: 0,
                  borderRadius: 7,
                  padding: "5px 12px",
                  cursor: canSubmit ? "pointer" : "default",
                  boxShadow: canSubmit ? "0 0 14px rgba(95,211,224,0.4)" : "none",
                  transition: "box-shadow .18s ease",
                }}
              >
                <Plus size={13} /> 添加
              </button>
            </div>

            {/* 归属下拉（内联展开：面板随之长高，避开 clip-path 裁切；在 panelRef 内不会误收 HUD） */}
            {selOpen && (
              <div
                className="draft-hud-body mt-2"
                style={{ maxHeight: 200, overflowY: "auto", borderTop: "1px solid rgba(95,211,224,0.14)", paddingTop: 6 }}
              >
                {selItems.map((it) => {
                  const sel = it.key === targetKey;
                  return (
                    <button
                      key={it.key || "__general__"}
                      type="button"
                      onClick={() => {
                        setTargetKey(it.key);
                        setSelOpen(false);
                      }}
                      className="w-full text-left text-xs block"
                      style={{
                        padding: "6px 8px",
                        borderRadius: 6,
                        border: 0,
                        cursor: "pointer",
                        background: sel ? "rgba(95,211,224,0.16)" : "transparent",
                        color: sel ? "#aef0f7" : "#cbd5e1",
                      }}
                      onMouseEnter={(e) => {
                        if (!sel) e.currentTarget.style.background = "rgba(255,255,255,0.05)";
                      }}
                      onMouseLeave={(e) => {
                        if (!sel) e.currentTarget.style.background = "transparent";
                      }}
                    >
                      <span className="truncate block">
                        {it.label}
                        {it.project ? ` · ${it.project}` : ""}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* 列表（滚动区，纵观全局，不随日期收窄） */}
        <div className="draft-hud-body px-3.5 pb-3.5 pt-2" style={{ maxHeight: "min(58vh, 460px)" }}>
          {pending.length === 0 && done.length === 0 && (
            <div className="text-center text-xs py-6" style={{ color: "#5d6b70" }}>
              还没有预备发言。写一条，挂靠到会话后可一键投递到启动器。
            </div>
          )}

          {pending.length > 0 && (
            <div className="space-y-1.5">
              {pending.map((d) => (
                <DraftItem
                  key={d.id}
                  d={d}
                  copied={copiedId === d.id}
                  pushed={pushedId === d.id}
                  pushError={pushErr?.id === d.id ? pushErr.msg : null}
                  onToggle={() => toggleDone(d.id)}
                  onCopy={() => onCopy(d)}
                  onPush={() => onPush(d)}
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
                    style={{ color: "#9ca3af", background: "rgba(255,255,255,0.05)", border: 0, borderRadius: 6, padding: "1px 8px", cursor: "pointer" }}
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
                      pushed={pushedId === d.id}
                      pushError={pushErr?.id === d.id ? pushErr.msg : null}
                      onToggle={() => toggleDone(d.id)}
                      onCopy={() => onCopy(d)}
                      onPush={() => onPush(d)}
                      onRemove={() => remove(d.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DraftItem({
  d,
  copied,
  pushed,
  pushError,
  onToggle,
  onCopy,
  onPush,
  onRemove,
}: {
  d: SessionDraft;
  copied: boolean;
  pushed: boolean;
  pushError: string | null;
  onToggle: () => void;
  onCopy: () => void;
  onPush: () => void;
  onRemove: () => void;
}) {
  const canPush = !!d.session_id;
  return (
    <div
      className="group flex items-start gap-2 rounded-lg px-3 py-2"
      style={{ background: d.done ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}
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
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded truncate max-w-[260px]" style={{ background: "rgba(255,255,255,0.06)" }}>
              <MessageSquare size={10} /> {d.session_title || d.session_id.slice(0, 8)}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded" style={{ background: "rgba(255,255,255,0.06)", color: "#7a8086" }}>
              <MessageSquare size={10} /> 通用
            </span>
          )}
          {d.project_name && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded" style={{ background: "rgba(255,255,255,0.06)" }}>
              <FolderGit2 size={10} /> {d.project_name}
            </span>
          )}
          <span className="font-mono" style={{ color: "#6b7280" }}>{stamp(d.created_unix)}</span>
        </div>
        {pushError && (
          <div className="text-[10px] mt-1" style={{ color: "#f87171" }}>推送失败：{pushError}</div>
        )}
        {pushed && !pushError && (
          <div className="text-[10px] mt-1" style={{ color: "#4ade80" }}>已推送 · 进入该会话时自动填入（不自动发送）</div>
        )}
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={onPush}
          disabled={!canPush}
          title={
            !canPush
              ? "未挂靠会话，无法推送到启动器"
              : pushError
              ? `推送失败：${pushError}`
              : "推送到启动器（进入该会话时自动填入输入框，不自动发送）"
          }
          className="inline-flex items-center justify-center"
          style={{
            width: 26,
            height: 26,
            borderRadius: 7,
            color: pushed ? "#4ade80" : pushError ? "#f87171" : canPush ? "#5fd3e0" : "#4b5563",
            background: "rgba(255,255,255,0.04)",
            border: `1px solid ${pushError ? "#5b3636" : "rgba(255,255,255,0.08)"}`,
            cursor: canPush ? "pointer" : "default",
          }}
        >
          {pushed ? <Check size={13} /> : <Send size={13} />}
        </button>
        <button
          type="button"
          onClick={onCopy}
          title="复制到剪贴板"
          className="inline-flex items-center justify-center"
          style={{ width: 26, height: 26, borderRadius: 7, color: copied ? "#4ade80" : "#9ca3af", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", cursor: "pointer" }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
        <button
          type="button"
          onClick={onRemove}
          title="删除"
          className="inline-flex items-center justify-center"
          style={{ width: 26, height: 26, borderRadius: 7, color: "#9ca3af", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", cursor: "pointer" }}
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}
