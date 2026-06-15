import { useEffect, useRef, useState, type ReactNode } from "react";
import { fetchImage } from "./api";

// 已加载图片缓存（path -> dataURL），避免重复 hover 重复读盘
const imgCache = new Map<string, string>();

interface PanelPos {
  left: number;
  top: number | null;
  bottom: number | null;
}

const PANEL_W = 440;

/** 渲染消息文本，把 [Image #N] 变成悬浮可预览的标记 */
export default function MessageText({ text, images }: { text: string; images: string[] }) {
  if (!images || images.length === 0) {
    return <>{text}</>;
  }
  // [Image #N] 的 N 是整段对话的全局累计编号；本条消息的 images 是按出现顺序的局部数组，
  // 所以用「本条里第几个标记」(序数) 映射，而非 N。
  const re = /\[Image #\d+\]/g;
  const parts: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let ordinal = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(<span key={key++}>{text.slice(last, m.index)}</span>);
    const path = images[ordinal];
    ordinal += 1;
    parts.push(
      path ? (
        <ImageToken key={key++} label={m[0]} path={path} />
      ) : (
        <span key={key++}>{m[0]}</span>
      )
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(<span key={key++}>{text.slice(last)}</span>);
  return <>{parts}</>;
}

function ImageToken({ label, path }: { label: string; path: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<PanelPos>({ left: 0, top: 0, bottom: null });
  const ref = useRef<HTMLSpanElement>(null);

  const handleEnter = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) {
      const above = r.bottom > window.innerHeight - 380;
      setPos({
        left: r.left,
        top: above ? null : r.bottom + 6,
        bottom: above ? window.innerHeight - r.top + 6 : null,
      });
    }
    setOpen(true);
  };

  return (
    <>
      <span
        ref={ref}
        onMouseEnter={handleEnter}
        onMouseLeave={() => setOpen(false)}
        style={{
          color: "#8fb3d3",
          cursor: "help",
          textDecoration: "underline dotted",
          textUnderlineOffset: 2,
        }}
      >
        {label}
      </span>
      {open && <ImagePanel path={path} pos={pos} />}
    </>
  );
}

function ImagePanel({ path, pos }: { path: string; pos: PanelPos }) {
  const [url, setUrl] = useState<string | null>(imgCache.get(path) ?? null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (url) return;
    let cancelled = false;
    fetchImage(path)
      .then((u) => {
        if (!cancelled) {
          imgCache.set(path, u);
          setUrl(u);
        }
      })
      .catch((e) => !cancelled && setErr(String(e)));
    return () => {
      cancelled = true;
    };
  }, [path, url]);

  const left = Math.max(8, Math.min(pos.left, window.innerWidth - PANEL_W - 12));

  return (
    <div
      style={{
        position: "fixed",
        left,
        top: pos.top ?? undefined,
        bottom: pos.bottom ?? undefined,
        width: PANEL_W,
        zIndex: 70,
        background: "#1b1b1b",
        border: "1px solid #333",
        borderRadius: 8,
        padding: 8,
        boxShadow: "0 8px 28px rgba(0,0,0,.55)",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: "#9ca3af",
          wordBreak: "break-all",
          marginBottom: 6,
          fontFamily: "ui-monospace, monospace",
        }}
      >
        {path}
      </div>
      {err ? (
        <div style={{ color: "#f87171", fontSize: 12 }}>无法预览：{err}</div>
      ) : url ? (
        <img
          src={url}
          alt={path}
          style={{ maxWidth: "100%", maxHeight: 340, borderRadius: 4, display: "block" }}
        />
      ) : (
        <div className="animate-pulse" style={{ color: "#6b7280", fontSize: 12 }}>
          加载图片…
        </div>
      )}
    </div>
  );
}
