type GaugeProps = {
  value: number;
  threshold?: number;
  label?: string;
  sublabel?: string;
};

const W = 160;
const H = 96;
const STROKE = 14;
const R = (W - STROKE) / 2;
const CX = W / 2;
const CY = H - 4;
const ARC_LEN = Math.PI * R;

function describeArc(value: number) {
  const clamped = Math.max(0, Math.min(value, 1));
  const offset = ARC_LEN * (1 - clamped);
  return offset;
}

function pointOnArc(value: number) {
  const clamped = Math.max(0, Math.min(value, 1));
  const angle = Math.PI * (1 - clamped);
  const x = CX + R * Math.cos(angle);
  const y = CY - R * Math.sin(angle);
  return { x, y };
}

export function Gauge({ value, threshold = 0.75, label, sublabel = "score" }: GaugeProps) {
  const tone =
    value >= threshold ? "" : value >= threshold - 0.15 ? "bv-gauge--warn" : "bv-gauge--danger";
  const pathD = `M ${STROKE / 2} ${CY} A ${R} ${R} 0 0 1 ${W - STROKE / 2} ${CY}`;
  const thresholdPoint = pointOnArc(threshold);
  const innerThreshold = {
    x: CX + (R - STROKE / 2 - 4) * Math.cos(Math.PI * (1 - threshold)),
    y: CY - (R - STROKE / 2 - 4) * Math.sin(Math.PI * (1 - threshold)),
  };

  return (
    <div className={`bv-gauge ${tone}`}>
      <svg className="bv-gauge__svg" viewBox={`0 0 ${W} ${H}`} aria-label={`Score ${value.toFixed(2)}`}>
        <path className="bv-gauge__track" d={pathD} />
        <path
          className="bv-gauge__fill"
          d={pathD}
          strokeDasharray={ARC_LEN}
          strokeDashoffset={describeArc(value)}
        />
        <line
          className="bv-gauge__threshold"
          x1={innerThreshold.x}
          y1={innerThreshold.y}
          x2={thresholdPoint.x + (STROKE / 2 + 4) * Math.cos(Math.PI * (1 - threshold))}
          y2={thresholdPoint.y - (STROKE / 2 + 4) * Math.sin(Math.PI * (1 - threshold))}
        />
      </svg>
      <div className="bv-gauge__readout">{label ?? value.toFixed(2)}</div>
      <div className="bv-gauge__sub">{sublabel}</div>
    </div>
  );
}
