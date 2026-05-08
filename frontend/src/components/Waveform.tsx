import { useEffect, useRef, useState } from "react";

type WaveColor = "blue" | "red" | "gray" | "idle";

type LiveProps = {
  mode: "live";
  analyser: AnalyserNode | null;
  bars?: number;
  color?: WaveColor;
  tint?: "red" | "blue" | "none";
};

type StaticProps = {
  mode: "static";
  samples: Float32Array;
  bars?: number;
  color?: WaveColor;
  tint?: "red" | "blue" | "none";
};

type IdleProps = {
  mode: "idle";
  bars?: number;
  color?: WaveColor;
  tint?: "red" | "blue" | "none";
};

type WaveformProps = LiveProps | StaticProps | IdleProps;

const DEFAULT_BARS = 48;

function tintClass(tint?: "red" | "blue" | "none") {
  if (tint === "red") return "bv-waveform--tinted-red";
  if (tint === "blue") return "bv-waveform--tinted-blue";
  return "";
}

function colorClass(color?: WaveColor) {
  if (!color || color === "blue") return "";
  return `bv-waveform--${color}`;
}

export function Waveform(props: WaveformProps) {
  const bars = props.bars ?? DEFAULT_BARS;
  const cls = ["bv-waveform", colorClass(props.color), tintClass(props.tint)].filter(Boolean).join(" ");

  if (props.mode === "live") {
    return <LiveWaveform analyser={props.analyser} bars={bars} className={cls} />;
  }
  if (props.mode === "static") {
    return <StaticWaveform samples={props.samples} bars={bars} className={cls} />;
  }
  return <IdleWaveform bars={bars} className={cls} />;
}

function LiveWaveform({ analyser, bars, className }: { analyser: AnalyserNode | null; bars: number; className: string }) {
  const [levels, setLevels] = useState<number[]>(() => seedLevels(bars));
  const rafRef = useRef<number | null>(null);
  const emaRef = useRef<number[]>(seedLevels(bars));

  useEffect(() => {
    if (!analyser) {
      setLevels(seedLevels(bars));
      return;
    }
    const buffer = new Uint8Array(analyser.frequencyBinCount);
    const alpha = 0.7;

    const tick = () => {
      analyser.getByteFrequencyData(buffer);
      const next = new Array(bars).fill(0);
      for (let i = 0; i < bars; i += 1) {
        const start = Math.floor((i / bars) * buffer.length);
        const end = Math.max(start + 1, Math.floor(((i + 1) / bars) * buffer.length));
        let sum = 0;
        for (let j = start; j < end; j += 1) sum += buffer[j];
        const avg = sum / (end - start) / 255;
        const prev = emaRef.current[i] ?? 0.1;
        const smoothed = prev * alpha + avg * (1 - alpha);
        emaRef.current[i] = smoothed;
        next[i] = Math.max(0.08, Math.min(1, smoothed * 1.4));
      }
      setLevels(next);
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [analyser, bars]);

  return <BarRow className={className} levels={levels} />;
}

function StaticWaveform({ samples, bars, className }: { samples: Float32Array; bars: number; className: string }) {
  const levels = staticLevels(samples, bars);
  return <BarRow className={className} levels={levels} />;
}

function IdleWaveform({ bars, className }: { bars: number; className: string }) {
  const levels = seedLevels(bars).map((v, i) => Math.max(0.18, v * (0.4 + Math.sin(i * 0.4) * 0.2)));
  return <BarRow className={className} levels={levels} />;
}

function BarRow({ levels, className }: { levels: number[]; className: string }) {
  return (
    <div className={className} aria-hidden="true">
      {levels.map((l, i) => (
        <span
          key={i}
          className="bv-waveform__bar"
          style={{ height: `${Math.round(l * 100)}%` }}
        />
      ))}
    </div>
  );
}

function seedLevels(bars: number): number[] {
  return Array.from({ length: bars }, (_, i) => 0.2 + Math.abs(Math.sin(i * 0.7)) * 0.2);
}

function staticLevels(samples: Float32Array, bars: number): number[] {
  if (samples.length === 0) return seedLevels(bars);
  const out = new Array(bars).fill(0);
  const bucket = samples.length / bars;
  let max = 0;
  for (let i = 0; i < bars; i += 1) {
    const start = Math.floor(i * bucket);
    const end = Math.max(start + 1, Math.floor((i + 1) * bucket));
    let acc = 0;
    for (let j = start; j < end; j += 1) acc += Math.abs(samples[j]);
    out[i] = acc / (end - start);
    if (out[i] > max) max = out[i];
  }
  if (max > 0) {
    for (let i = 0; i < bars; i += 1) out[i] = Math.max(0.08, out[i] / max);
  } else {
    return seedLevels(bars);
  }
  return out;
}
