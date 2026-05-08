type ProgressBarProps = {
  value: number;
  max?: number;
  tone?: "primary" | "success" | "danger" | "warn" | "neutral";
  label?: string;
  caption?: string;
  rightValue?: string;
  layout?: "stacked" | "row";
};

export function ProgressBar({
  value,
  max = 100,
  tone = "primary",
  label,
  caption,
  rightValue,
  layout = "stacked",
}: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(value, max));
  const pct = (clamped / max) * 100;
  const toneClass = tone === "primary" ? "" : `bv-progress--${tone}`;

  if (layout === "row") {
    return (
      <div className={`bv-progress bv-progress--row ${toneClass}`} role="progressbar" aria-valuenow={clamped} aria-valuemax={max}>
        {caption ? <span className="bv-progress__caption">{caption}</span> : null}
        <div className="bv-progress__track">
          <div className="bv-progress__fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="bv-progress__value">{rightValue ?? `${Math.round(pct)}%`}</span>
      </div>
    );
  }

  return (
    <div className={`bv-progress ${toneClass}`} role="progressbar" aria-valuenow={clamped} aria-valuemax={max}>
      <div className="bv-progress__track">
        <div className="bv-progress__fill" style={{ width: `${pct}%` }} />
      </div>
      {label ? <div className="bv-progress__label">{label}</div> : null}
    </div>
  );
}
