import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
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
import { machineColor } from "../colors"; // 设备段边框按机器配色，与 token 面板/时间轴一致
import { fetchToolResult } from "./api";
import MessageText from "./MessageText";
import Markdown from "./Markdown";

const pad2 = (n: number) => String(n).padStart(2, "0");

// 轨道(列)最小宽度：多轨道平分若低于此值，则固定此宽并开横向滚动（实测 2 轨≈310px，取整 300）
const MIN_LANE_W = 300;
const LANE_GAP = 12;
// 浮动会话表头（镜像时间轴贴边逻辑：滚过贴顶叠放、未到贴底叠放，当前会话亮、远方暗）
const SEG_H = 28; // 段首锚点(in-flow)占位高度
const HEAD_H = 25; // chevron 表头实际高 = 叠放间距：贴边叠罗汉按它一格紧贴、无缝（SEG_H 比它高 3px 会留缝）
const MARKER_H = SEG_H + 8; // 段首锚点占位高度（给浮动表头留位，兼作会话分隔间距）
const ARROW = 10; // chevron 右凸尖箭头进深；表头与会话框右边都按它内收，框右竖线正落在 chevron 右拐点(100%-ARROW)
const FRAME_INSET = ARROW; // 会话框距轨道左右边的内缩 = 尖尖宽 → 右边对齐表头拐点；宽度仍=轨宽-2×内缩(自适应)
const CARD_PAD = FRAME_INSET + 4; // 卡片再多缩一点，框落在卡片外侧的留白里

interface LaneHeadInfo {
  sourceLabel: string; // 设备/机器
  projectName: string; // 项目
  sessionTitle: string; // 会话
}

// 一个会话段：lane=轨道，ordinal=该轨第几个会话(0=主线)，isFloat=是否浮动表头(主线静态时为 false)
type Seg = { idx: number; lane: number; ordinal: number; isFloat: boolean; anchorKey: string; head: LaneHeadInfo };

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
  const wrapRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const firstKeyRef = useRef("");
  // 抗抖动：贴边表头放在不滚动的 overlay 层（屏幕坐标恒定，不随合成器滚动闪）；
  // 视野内表头留在流里(inline marker)，由合成器平滑滚动。markerRefs=流内锚点，overlayHeaderRefs=overlay 贴边副本。
  const markerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const overlayHeaderRefs = useRef<(HTMLDivElement | null)[]>([]);
  const frameRefs = useRef<(HTMLDivElement | null)[]>([]); // 每会话块的机器色描边框（绝对定位、随卡片滚动）
  const endMarkerRefs = useRef<(HTMLDivElement | null)[]>([]); // 每会话末卡后的零高结束锚点 → 框底收到这里
  const layoutRef = useRef<() => void>(() => {});
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    layoutRef.current();
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

  // 卡片流实际包含的不同会话数（去重 source+session）。laneCount 来自全天时间轴 rows，
  // 可能多于 stream 实际会话 → 单会话时别按多轨道铺表头，改为居中迷你单表头。
  const sessionKeys = useMemo(() => {
    const s = new Set<string>();
    for (const m of ordered) s.add(laneKey(m.source_id, m.session_id));
    return s;
  }, [ordered]);
  // 单会话表头直接取流里第一条的会话（不经 laneOf 下标，避免会话落在 lane≠0 时取空）
  const soleHead = useMemo<LaneHeadInfo | undefined>(() => {
    const m = ordered[0];
    if (!m) return undefined;
    return {
      sourceLabel: m.source_label,
      projectName: m.project_name || "—",
      sessionTitle: sessionTitles[m.session_id] || m.session_id.slice(0, 8),
    };
  }, [ordered, sessionTitles]);

  const singleSession = sessionKeys.size <= 1; // 流里只有一个会话 → 居中迷你单表头
  const single = singleSession || laneCount <= 1; // 单列阅读视图（居中、760 宽）

  // 多会话：每个会话段都做成浮动表头（无静态主线表头）。每轨「当前会话」(视口顶落在其会话内)贴顶显示，
  // 随滚动直接切到当前会话，其余保持自然位置/隐藏 → 只一层、不堆叠、不需要"暗"。每段打锚点 marker(占位 MARKER_H)。
  const segs = useMemo<Seg[]>(() => {
    if (singleSession) return [];
    const out: Seg[] = [];
    const lastByLane: Record<number, string> = {};
    const ordByLane: Record<number, number> = {};
    for (const m of ordered) {
      const lane = single ? 0 : (laneOf[laneKey(m.source_id, m.session_id)] ?? 0);
      const sk = laneKey(m.source_id, m.session_id);
      if (lastByLane[lane] === sk) continue;
      lastByLane[lane] = sk;
      const ord = ordByLane[lane] ?? 0;
      ordByLane[lane] = ord + 1;
      out.push({
        idx: out.length,
        lane,
        ordinal: ord,
        isFloat: true,
        anchorKey: `${m.source_id}:${m.session_id}:${m.ts_unix ?? 0}`,
        head: {
          sourceLabel: m.source_label,
          projectName: m.project_name || "—",
          sessionTitle: sessionTitles[m.session_id] || m.session_id.slice(0, 8),
        },
      });
    }
    return out;
  }, [ordered, single, singleSession, laneOf, sessionTitles]);
  const floatSegs = segs;
  const segByAnchor = useMemo(() => {
    const map = new Map<string, Seg>();
    for (const s of segs) map.set(s.anchorKey, s);
    return map;
  }, [segs]);
  // 每会话「末卡」anchorKey → seg.idx（与上面 segs 同序同 idx）。框底收到末卡、不延伸到下个会话。
  const segEndByAnchor = useMemo(() => {
    const map = new Map<string, number>();
    if (singleSession) return map;
    const lastByLane: Record<number, string> = {};
    const curSeg: Record<number, number> = {};
    const prevAnchor: Record<number, string> = {};
    let idx = 0;
    for (const m of ordered) {
      const lane = single ? 0 : (laneOf[laneKey(m.source_id, m.session_id)] ?? 0);
      const sk = laneKey(m.source_id, m.session_id);
      const anchor = `${m.source_id}:${m.session_id}:${m.ts_unix ?? 0}`;
      if (lastByLane[lane] !== sk) {
        if (curSeg[lane] !== undefined && prevAnchor[lane] !== undefined) map.set(prevAnchor[lane], curSeg[lane]);
        lastByLane[lane] = sk;
        curSeg[lane] = idx;
        idx += 1;
      }
      prevAnchor[lane] = anchor;
    }
    for (const laneStr of Object.keys(curSeg)) {
      const lane = Number(laneStr);
      if (prevAnchor[lane] !== undefined) map.set(prevAnchor[lane], curSeg[lane]);
    }
    return map;
  }, [ordered, single, singleSession, laneOf]);
  const useFloat = floatSegs.length > 0;

  useLayoutEffect(() => layoutRef.current()); // 每次渲染后同步浮动表头位置
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => layoutRef.current());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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

  const renderCard = (m: StreamMessage, ci: number, bucket: number) => {
    const ck = `${m.source_id}:${m.session_id}:${m.ts_unix ?? 0}`;
    const seg = segByAnchor.get(ck);
    return (
      <Fragment key={`${ck}:${ci}`}>
        {seg && (
          // 段首锚点 = 流内「自然位置」会话表头：随内容被合成器平滑滚动(不抖)；滚出视口后由 overlay 贴边副本接管。
          // marker 同时占位 MARKER_H、其 getBoundingClientRect 供 layoutRef 测段顶屏幕 Y。
          // 负 margin 抵消轨道列的 CARD_PAD → in-flow 表头撑到整 laneW，和 overlay 贴边表头同宽(不滚/滚一致)
          <div
            ref={(el) => { markerRefs.current[seg.idx] = el; }}
            style={{ height: MARKER_H, marginLeft: single ? 0 : -CARD_PAD, marginRight: single ? 0 : -CARD_PAD }}
          >
            <div onClick={() => scrollToSeg(seg.idx)} title="点击滚到该会话开头" style={{ height: SEG_H, cursor: "pointer" }}>
              <LaneHeader head={seg.head} />
            </div>
          </div>
        )}
        <StreamCard m={m} shade={bucket % 2 === 0} />
        {segEndByAnchor.has(ck) && (
          // 会话末卡后的零高结束锚点：框底收到这里（不延伸到下个会话/空白时段）
          <div ref={(el) => { endMarkerRefs.current[segEndByAnchor.get(ck)!] = el; }} style={{ height: 0 }} />
        )}
      </Fragment>
    );
  };

  // 点击表头：平滑滚到该会话段首（用 getBoundingClientRect，不依赖 offsetParent）
  const scrollToSeg = (idx: number) => {
    const el = scrollRef.current;
    const mk = markerRefs.current[idx];
    if (!el || !mk) return;
    const target = el.scrollTop + (mk.getBoundingClientRect().top - el.getBoundingClientRect().top) - 4;
    el.scrollTo({ top: target, behavior: "smooth" });
  };

  // 抗抖动叠层布局：贴边表头放 overlay(不滚动层、屏幕坐标恒定 → 合成器滚动时不闪)；视野内由流内 inline 表头平滑显示。
  //   · 各 lane 恒按时间(marker 屏幕 Y)升序排序 → 叠层顺序固定；滚过→贴顶叠放、未到→贴底叠放(整高紧邻、≤STACK_MAX)。
  //   · 当前会话亮、远方提示用 grayscale+brightness 不透明暗下去。横向用 clientWidth、纵向用 clientHeight(排除滚动条→逃开它)。
  layoutRef.current = () => {
    if (!useFloat) return;
    const el = scrollRef.current;
    const wrap = wrapRef.current;
    if (!el || !wrap) return;
    const sRect = el.getBoundingClientRect();
    const wrapScreenLeft = wrap.getBoundingClientRect().left - sRect.left; // 含横向滚动 + 居中偏移
    const wrapW = wrap.clientWidth;
    const vW = el.clientWidth; // 排除竖向滚动条
    const laneW = single ? wrapW : (wrapW - (laneCount - 1) * LANE_GAP) / laneCount;
    const vTop = 0;                // overlay 顶 = 卡片区视口顶
    const vBot = el.clientHeight;  // 排除横向滚动条 → 贴底表头逃开它
    const byLane: Record<number, { idx: number; topY: number }[]> = {};
    for (const s of floatSegs) {
      const mk = markerRefs.current[s.idx];
      const y = mk ? mk.getBoundingClientRect().top - sRect.top : 0; // 段顶屏幕 Y
      (byLane[s.lane] ??= []).push({ idx: s.idx, topY: y });
    }
    const place = new Map<number, { top: number; bright: boolean }>(); // overlay 贴边副本：idx→位置
    const stuck = new Set<number>(); // 贴顶的段 → 隐藏其内联表头，改由 overlay 副本显示(避免双重影/重叠)
    for (const k of Object.keys(byLane)) {
      const arr = byLane[Number(k)].sort((a, b) => a.topY - b.topY); // 恒按时间升序 → 叠层顺序固定
      // 顶部贪心占槽：从上往下槽位 0,1,2…；某段滚到它的槽位(上方已贴段数×HEAD_H)即贴住、停在上一个的下沿。
      // 用 HEAD_H(chevron 实高)做间距 → 叠罗汉严丝合缝无缝。无上限——一轨多少会话就叠多少。
      let slotY = vTop;
      const above: typeof arr = [];
      for (const p of arr) {
        if (p.topY <= slotY) { above.push(p); slotY += HEAD_H; }
        else break;
      }
      const below = arr.filter((p) => p.topY > vBot - HEAD_H);  // 未到 → 贴底
      above.forEach((p) => stuck.add(p.idx)); // 贴顶段一律隐藏内联(由 overlay 副本显示)
      // 只有栈最底那枚(最贴内容=当前会话)亮；其上(更早滚过)与贴底(未到的将来)一律暗下去
      above.forEach((p, j) => place.set(p.idx, { top: vTop + j * HEAD_H, bright: j === above.length - 1 }));
      below.forEach((p, j) => place.set(p.idx, { top: vBot - (below.length - j) * HEAD_H, bright: false }));
    }
    for (const s of floatSegs) {
      // 贴顶段隐藏内联表头(由 overlay 显示)；其余(视野内/贴底)内联正常显示，由 overflow 裁切边缘
      const inner = (markerRefs.current[s.idx]?.firstElementChild ?? null) as HTMLElement | null;
      if (inner) inner.style.visibility = stuck.has(s.idx) ? "hidden" : "visible";
      const h = overlayHeaderRefs.current[s.idx];
      if (!h) continue;
      const pl = place.get(s.idx);
      const left = wrapScreenLeft + (single ? 0 : s.lane * (laneW + LANE_GAP));
      // 未贴边 / 横向滚出卡片区的 lane → 隐藏 overlay 副本
      if (!pl || left + laneW <= 0 || left >= vW) { h.style.display = "none"; continue; }
      h.style.display = "flex";
      h.style.top = `${pl.top}px`;
      h.style.left = `${left}px`;
      h.style.width = `${laneW}px`;
      h.classList.toggle("seg-dim", !pl.bright); // 暗用 class(只压暗保留颜色) + :hover 高亮
    }

    // 会话块机器色描边框：内容坐标(随卡片滚动，不随合成器贴边)。每 lane 按相邻 marker 定首尾、画框
    if (!single) {
      const wrapTop = wrap.getBoundingClientRect().top;
      const wrapH = wrap.scrollHeight;
      const segByLane: Record<number, { idx: number; cy: number; color: string }[]> = {};
      for (const s of floatSegs) {
        const mk = markerRefs.current[s.idx];
        if (!mk) continue;
        const cy = mk.getBoundingClientRect().top - wrapTop; // 内容 Y（随滚动不变）
        (segByLane[s.lane] ??= []).push({ idx: s.idx, cy, color: machineColor(s.head.sourceLabel) });
      }
      for (const key of Object.keys(segByLane)) {
        const arr = segByLane[Number(key)].sort((a, b) => a.cy - b.cy);
        arr.forEach((it, i) => {
          const f = frameRefs.current[it.idx];
          if (!f) return;
          const top = it.cy + SEG_H + 2; // 表头下方起
          // 框底「提前收」到本会话末卡（结束锚点）；没量到则兜底用下个会话表头/内容底
          const endMk = endMarkerRefs.current[it.idx];
          const bottom = endMk
            ? endMk.getBoundingClientRect().top - wrapTop
            : i + 1 < arr.length ? arr[i + 1].cy : wrapH;
          // 只设纵向(首尾)；横向 left/right 由 CSS(flex 列)管 → 窗口缩放自适应不闪
          f.style.display = "block";
          f.style.top = `${top}px`;
          f.style.height = `${Math.max(0, bottom - top - 4)}px`;
          f.style.borderColor = it.color;
        });
      }
    }
  };

  return (
   <div style={{ position: "relative", height: "100%" }}>
    <div ref={scrollRef} onScroll={onScroll} className={`overflow-auto h-full py-4 ${single ? "px-5" : "px-3"}`}>
      <div
        ref={wrapRef}
        className={single ? "mx-auto" : undefined}
        style={single ? { maxWidth: 760, position: "relative" } : { minWidth: laneCount * MIN_LANE_W + (laneCount - 1) * LANE_GAP, position: "relative" }}
      >
        {/* 顶部表头：仅单会话渲染居中迷你静态表头；多会话全部用下方浮动会话表头（随滚动切到当前会话） */}
        {!useFloat && singleSession && (
          <div className="sticky flex" style={{ top: -16, zIndex: 10, paddingTop: 16, paddingBottom: 7, justifyContent: "center", background: "#181818" }}>
            {/* 单会话：居中迷你单表头（紧凑、按内容定宽），悬浮看全貌；点击回到开头 */}
            <div onClick={() => scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" })} title="点击回到开头" style={{ minWidth: 0, display: "flex", alignItems: "stretch", height: 25, cursor: "pointer" }}>
              <LaneHeader head={soleHead} mini />
            </div>
          </div>
        )}
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
                          <div key={lane} className="flex flex-col" style={{ flex: 1, minWidth: 0, gap: 6, marginTop: top, paddingLeft: CARD_PAD, paddingRight: CARD_PAD }}>
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

        {/* 会话块机器色描边框：横向用 flex 列(与卡片同套布局，随窗口缩放 CSS 自适应、不靠 JS 重算→不闪)，
            纵向首尾由 layoutRef 按相邻 marker 算。线条与表头 accent 一致(2px 机器色)。 */}
        {!single && (
          <div style={{ position: "absolute", inset: 0, display: "flex", gap: LANE_GAP, pointerEvents: "none", zIndex: 1 }}>
            {Array.from({ length: laneCount }, (_, lane) => (
              <div key={lane} style={{ flex: 1, minWidth: 0, position: "relative" }}>
                {floatSegs.filter((s) => s.lane === lane).map((s) => (
                  <div
                    key={s.idx}
                    ref={(el) => { frameRefs.current[s.idx] = el; }}
                    style={{ position: "absolute", left: FRAME_INSET, right: FRAME_INSET, display: "none", border: "2px solid transparent", borderRadius: 10, boxSizing: "border-box" }}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
    {/* 贴边表头 overlay：脱离滚动容器、屏幕坐标恒定 → 合成器滚动时不抖动。layoutRef 改 top/left/width/filter。 */}
    {useFloat && (
      <div ref={overlayRef} style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none", zIndex: 11 }}>
        {floatSegs.map((s) => (
          <div
            key={s.idx}
            ref={(el) => { overlayHeaderRefs.current[s.idx] = el; }}
            onClick={() => scrollToSeg(s.idx)}
            title="点击滚到该会话开头"
            style={{ position: "absolute", left: 0, width: 0, display: "none", alignItems: "center", height: HEAD_H, cursor: "pointer", background: "transparent", pointerEvents: "auto" }}
          >
            {/* 普通 block(flex:1 minWidth:0)，让 .lane-head 填满列宽 → project/session 正常 fill + ellipsis */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <LaneHeader head={s.head} />
            </div>
          </div>
        ))}
      </div>
    )}
   </div>
  );
}

const StreamCard = memo(function StreamCard({ m, shade }: { m: StreamMessage; shade: boolean }) {
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
        {/* 项目/会话/机器标签已上移到轨道顶部表头（LaneHeader）；这里只留 Claude 回复入口 */}
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

// 轨道顶部表头：设备 / 项目 / 会话 三枚「锥体」标签层叠堆放——左侧强调竖线、右侧尖头（楔形）。
// 后一枚负 margin 压进前一枚右尖下方，zIndex 递减 → 最左（设备）在最顶、最右（会话）在最底；
// 设备/项目按内容自适应（左短），会话占满剩余（右长），溢出才省略。
// 弹头/箭头标签：左侧平直 + 右侧凸尖。后一枚整条直左边压进前一枚右凸尖之下(overlap=ARROW)，
// zIndex 递减 → 有「被前一枚挡住」的层叠感(claude-switch 被本机挡住、横着压过去)。
// 双层实体描边：底层铺 accent 实色，填充层(渐变)露出 accent 边——但「被挡的左边」不留 accent(left:0)，
// 露出的是渐变背景而非 accent，避免它从前一枚凸尖的上下缺口冒出成碎片白点；
// 分界 = 前一枚右凸尖的 accent 实体描边(彩色箭头轮廓) + 暗影。首枚左侧留 2px accent 作起点竖线。
// 三段均可 flex 压缩 + 文本 ellipsis：窄轨道(5 列)时按权重分配、各自省略，不溢出重叠。
const CLIP = `polygon(0 0, calc(100% - ${ARROW}px) 0, 100% 50%, calc(100% - ${ARROW}px) 100%, 0 100%)`;
// fill=true：内容层 absolute 铺满外层 flex 宽度 → 文本在边界内 ellipsis、不溢出(项目/会话用)。
// fill=false：内容层 relative 撑开 → 外层 basis auto 取内容宽(设备段短，按内容定宽)。
function Bullet({ icon, label, grad, accent, zi, first, flex, fill, maxW }: { icon: ReactNode; label: string; grad: string; accent: string; zi: number; first?: boolean; flex?: string; fill?: boolean; maxW?: number }) {
  return (
    <span
      style={{
        position: "relative",
        zIndex: zi,
        height: "100%",
        marginLeft: first ? 0 : -ARROW,
        flex: flex ?? "0 1 auto",
        minWidth: 0,
        maxWidth: maxW,
        filter: "drop-shadow(2px 0 2px rgba(0,0,0,0.6))",
      }}
    >
      <span style={{ position: "absolute", inset: 0, background: accent, clipPath: CLIP }} />
      <span style={{ position: "absolute", top: 2, bottom: 2, left: first ? 2 : 0, right: 2, background: grad, clipPath: CLIP }} />
      <span
        className="inline-flex items-center"
        style={{
          position: fill ? "absolute" : "relative",
          inset: fill ? 0 : undefined,
          // fill=false（设备/紧凑段）内容层为 relative，须自带宽度上界 + 裁切，否则 label 的 ellipsis 失效会溢出
          maxWidth: fill ? undefined : maxW,
          overflow: "hidden",
          height: "100%",
          gap: 4,
          paddingLeft: first ? 9 : ARROW + 5,
          paddingRight: ARROW + 6,
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.1px",
          color: "#f0f2f6",
        }}
      >
        <span className="shrink-0 inline-flex" style={{ color: accent }}>{icon}</span>
        <span style={{ minWidth: 0, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{label}</span>
      </span>
    </span>
  );
}

// mini=true（单会话居中表头）：项目/会话按内容定宽 + maxW 封顶省略，整体紧凑不铺满；
// mini=false（多轨道）：项目/会话 flex 充满轨道列、absolute fill 省略。
// 表头本身即悬浮面板，故不再额外弹「看全貌」说明面板（避免两个悬浮面板重复）；title 给完整文本兜底。
function LaneHeader({ head, mini = false }: { head?: LaneHeadInfo; mini?: boolean }) {
  if (!head) return null;
  return (
    <div className="lane-head" title={`${head.sourceLabel} › ${head.projectName} › ${head.sessionTitle}`} style={{ position: "relative", height: 25, minWidth: 0, display: "flex", alignItems: "stretch" }}>
      <Bullet icon={<Monitor size={12} />} label={head.sourceLabel} grad="linear-gradient(180deg,#36424f,#28323d)" accent={machineColor(head.sourceLabel)} zi={3} first flex="0 1 auto" maxW={96} />
      <Bullet icon={<FolderGit2 size={12} />} label={head.projectName} grad="linear-gradient(180deg,#35432f,#27311f)" accent="#6fc23f" zi={2} flex={mini ? "0 1 auto" : "1 1 0"} fill={!mini} maxW={mini ? 150 : undefined} />
      <Bullet icon={<MessagesSquare size={12} />} label={head.sessionTitle} grad="linear-gradient(180deg,#3b3252,#2c2540)" accent="#9d6fe8" zi={1} flex={mini ? "0 1 auto" : "1.6 1 0"} fill={!mini} maxW={mini ? 230 : undefined} />
    </div>
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
