interface Props {
  pct: number | null;
  className?: string;
}

export default function ProgressBar({ pct, className = "" }: Props) {
  const w = pct === null ? 0 : Math.min(100, Math.max(0, pct));
  const cls = pct !== null && pct >= 80 ? "danger" : pct !== null && pct >= 60 ? "warn" : "";
  return (
    <div className={`bar-bg ${className}`}>
      <div className={`bar-fill ${cls}`} style={{ width: `${w}%` }} />
    </div>
  );
}
