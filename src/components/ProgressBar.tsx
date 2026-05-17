interface Props {
  pct: number | null;
  total?: number | null;
  className?: string;
}

export default function ProgressBar({ pct, total = 100, className = "" }: Props) {
  const safeTotal = total && total > 0 ? total : 100;
  const ratio = pct === null ? 0 : (pct / safeTotal) * 100;
  const w = Math.min(100, Math.max(0, ratio));
  const cls = ratio >= 80 ? "danger" : ratio >= 60 ? "warn" : "";
  return (
    <div className={`bar-bg ${className}`}>
      <div className={`bar-fill ${cls}`} style={{ width: `${w}%` }} />
    </div>
  );
}
