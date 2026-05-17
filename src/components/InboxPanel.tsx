import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Check, Inbox, X } from "lucide-react";
import { useInbox, type InboxItem } from "../hooks/useInbox";

interface Props {
  onChanged?: () => void;
  colors: Record<string, string>;
  aliasFilter?: string;
}

function formatLocalTime(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { hour12: false });
}

function formatPct(p: number | null | undefined): string {
  if (p == null) return "-";
  return `${Math.round(p)}%`;
}

const inboxKey = (item: InboxItem) => `${item.provider ?? "claude_code"}::${item.account_alias}`;
const inboxProviderLabel = (provider?: string) => provider === "codex" ? "Codex" : "Claude Code";

export default function InboxBadge({ onChanged, colors, aliasFilter }: Props) {
  const { items: rawItems, accept, remove } = useInbox(15_000);
  const items = aliasFilter ? rawItems.filter((it) => inboxKey(it) === aliasFilter) : rawItems;
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const handler = (event: MouseEvent) => {
      if (!btnRef.current?.contains(event.target as Node) && !popRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const count = items.length;
  const popStyle = (): CSSProperties => {
    if (!btnRef.current) return { position: "fixed", top: 0, left: 0 };
    const rect = btnRef.current.getBoundingClientRect();
    const popW = 380;
    const left = rect.right - popW < 8 ? rect.left : rect.right - popW;
    return { position: "fixed", top: rect.bottom + 6, left: Math.max(8, left), width: popW, zIndex: 400 };
  };

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((value) => !value)}
        title="过滤收件箱"
        className="flex items-center gap-1.5 text-xs"
        style={{
          padding: "3px 10px",
          borderRadius: 20,
          border: "1px solid #444",
          background: open ? "#2a2a2a" : count > 0 ? "#2a201a" : "#1e1e1e",
          color: count > 0 ? "#fbbf24" : "#bbb",
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <Inbox size={13} strokeWidth={2.2} />
        <span>收件箱</span>
        {count > 0 && (
          <span style={{ background: "#ef4444", color: "#fff", borderRadius: 10, padding: "0 6px", fontSize: 10, fontWeight: 700, fontFamily: "monospace" }}>
            {count}
          </span>
        )}
      </button>

      {open && (
        <div ref={popRef} style={{ ...popStyle(), background: "#161616", border: "1px solid #3a3a3a", borderRadius: 10, boxShadow: "0 16px 48px rgba(0,0,0,0.75)", maxHeight: "70vh", overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "10px 14px", borderBottom: "1px solid #2e2e2e", background: "#1c1c1c" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#eee" }}>过滤收件箱{aliasFilter ? ` · ${aliasFilter}` : ""}</div>
            <div style={{ fontSize: 11, color: "#aaa", marginTop: 3 }}>系统识别为异常的快照。采纳会按原时间插回历史。</div>
          </div>

          <div style={{ overflowY: "auto", flex: 1 }}>
            {items.length === 0 ? (
              <div style={{ padding: "30px 14px", textAlign: "center", color: "#888", fontSize: 13 }}>暂无待审核条目</div>
            ) : (
              items.map((item) => (
                <InboxRow
                  key={item.id}
                  item={item}
                  color={colors[inboxKey(item)] ?? colors[item.account_alias] ?? "#888"}
                  onAccept={async () => {
                    await accept(item.id);
                    onChanged?.();
                  }}
                  onDelete={async () => {
                    await remove(item.id);
                  }}
                />
              ))
            )}
          </div>
        </div>
      )}
    </>
  );
}

function InboxRow({ item, color, onAccept, onDelete }: { item: InboxItem; color: string; onAccept: () => Promise<void>; onDelete: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);

  return (
    <div style={{ padding: "10px 14px", borderBottom: "1px solid #262626", display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span style={{ width: 8, height: 8, borderRadius: 4, background: color }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: "#eee" }}>{item.account_alias}</span>
          <span style={{ fontSize: 10, color: "#888" }}>{inboxProviderLabel(item.provider)}</span>
        </div>
        <span style={{ fontSize: 11, color: "#888", fontFamily: "monospace" }}>{formatLocalTime(item.collected_at)}</span>
      </div>
      <div style={{ display: "flex", gap: 14, fontSize: 12, color: "#bbb", fontFamily: "monospace" }}>
        <span>Session: <span style={{ color: "#fff" }}>{formatPct(item.session_pct)}</span></span>
        <span>Weekly: <span style={{ color: "#fff" }}>{formatPct(item.weekly_pct)}</span></span>
      </div>
      <div style={{ fontSize: 11, color: "#fbbf24" }}>{item.filter_reason}</div>
      <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
        <button disabled={busy} onClick={async () => { setBusy(true); try { await onAccept(); } finally { setBusy(false); } }} style={{ flex: 1, fontSize: 12, padding: "5px 10px", borderRadius: 6, background: "#1f3a2c", color: "#86efac", border: "1px solid #2d5a44", cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.5 : 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}>
          <Check size={13} strokeWidth={2.4} />
          <span>采纳</span>
        </button>
        <button disabled={busy} onClick={async () => { setBusy(true); try { await onDelete(); } finally { setBusy(false); } }} style={{ flex: 1, fontSize: 12, padding: "5px 10px", borderRadius: 6, background: "#3a1f1f", color: "#fca5a5", border: "1px solid #5a2d2d", cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.5 : 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}>
          <X size={13} strokeWidth={2.4} />
          <span>删除</span>
        </button>
      </div>
    </div>
  );
}
