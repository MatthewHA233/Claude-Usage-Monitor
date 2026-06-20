import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
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
  const [zoom, setZoom] = useState(false); // 全屏查看
  const ref = useRef<HTMLSpanElement>(null);

  // 用原生 mouseenter/mouseleave/click 绑定——本环境(WebView2)下 React 合成的 onMouseEnter 真实鼠标不触发，
  // 而原生事件实测必触发，故绕开 React 合成直接挂原生监听。
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const enter = () => {
      const r = el.getBoundingClientRect();
      const above = r.bottom > window.innerHeight - 380;
      setPos({
        left: r.left,
        top: above ? null : r.bottom + 6,
        bottom: above ? window.innerHeight - r.top + 6 : null,
      });
      setOpen(true);
    };
    const leave = () => setOpen(false);
    const click = (e: MouseEvent) => {
      e.stopPropagation(); // 别触发卡片自身的点击
      setOpen(false);
      setZoom(true); // 点击 → 全屏
    };
    el.addEventListener("mouseenter", enter);
    el.addEventListener("mouseleave", leave);
    el.addEventListener("click", click);
    return () => {
      el.removeEventListener("mouseenter", enter);
      el.removeEventListener("mouseleave", leave);
      el.removeEventListener("click", click);
    };
  }, []);

  return (
    <>
      <span
        ref={ref}
        title="点击全屏查看"
        style={{
          color: "#8fb3d3",
          cursor: "pointer", // 链接(手型)光标，不用问号 help 光标
          textDecoration: "underline dotted",
          textUnderlineOffset: 2,
        }}
      >
        {label}
      </span>
      {open && !zoom && <ImagePanel path={path} pos={pos} />}
      {zoom && <ImageLightbox path={path} onClose={() => setZoom(false)} />}
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

  // 用 Portal 渲染到 document.body：否则面板虽 position:fixed，但身处卡片的层叠上下文里、会被后面的卡片盖住
  return createPortal(
    <div
      style={{
        position: "fixed",
        left,
        top: pos.top ?? undefined,
        bottom: pos.bottom ?? undefined,
        width: PANEL_W,
        zIndex: 1000,
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
        <div style={{ color: "#f87171", fontSize: 12, lineHeight: 1.5 }}>
          {/^.*(找不到|No such|os error 3|系统找不到).*/.test(err)
            ? "源图片已不存在 —— 多为剪贴板粘贴图的临时缓存(.claude/image-cache)被 Claude 清理"
            : `无法预览：${err}`}
        </div>
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
    </div>,
    document.body,
  );
}

/** 全屏图片查看：暗背景铺满，图片居中等比缩放；点暗区 / Esc / 右上角 × 退出。Portal 到 body。 */
function ImageLightbox({ path, onClose }: { path: string; onClose: () => void }) {
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

  // Esc 退出全屏
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2000,
        background: "rgba(0,0,0,0.92)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {url ? (
        <img
          src={url}
          alt={path}
          onClick={(e) => e.stopPropagation()} // 点图片本身不退出
          style={{ maxWidth: "96vw", maxHeight: "96vh", objectFit: "contain", boxShadow: "0 10px 50px rgba(0,0,0,0.6)", cursor: "default" }}
        />
      ) : err ? (
        <div style={{ color: "#f87171", fontSize: 14 }}>无法加载图片</div>
      ) : (
        <div className="animate-pulse" style={{ color: "#9ca3af", fontSize: 14 }}>加载图片…</div>
      )}
      <button
        type="button"
        onClick={onClose}
        title="退出全屏 (Esc)"
        style={{
          position: "fixed",
          top: 14,
          right: 18,
          width: 36,
          height: 36,
          borderRadius: 18,
          border: 0,
          background: "rgba(40,40,40,0.85)",
          color: "#e5e7eb",
          fontSize: 22,
          lineHeight: "34px",
          cursor: "pointer",
        }}
      >
        ×
      </button>
    </div>,
    document.body,
  );
}
