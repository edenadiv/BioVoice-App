// Reusable visual atoms: VoiceOrb, Waveform, MelSpectrogram, EmbeddingCloud,
// SimilarityGauge, ConceptBars, PipelineFlow.

import React, { useEffect, useRef, useState, useMemo } from "react";
import { seedRand } from "./audio.jsx";

// ----------------------------------------------------------------------------
// VoiceOrb — the hero. A breathing, layered organic blob that reacts to audio.
// Based on layered noisy circles drawn on a canvas with a glow + caustics layer.
// ----------------------------------------------------------------------------
function VoiceOrb({ size = 520, level = 0.1, samples, hue = 'cyan', listening = true, intensity = 1 }) {
  const canvasRef = useRef();
  const tRef = useRef(0);
  const levelRef = useRef(level);
  const samplesRef = useRef(samples);
  levelRef.current = level;
  samplesRef.current = samples;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = 2;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    ctx.scale(dpr, dpr);

    let raf;
    const palette = hue === 'rose'
      ? { core: '#ff7aa8', mid: '#ff5577', edge: 'rgba(255,85,119,0.0)' }
      : hue === 'gold'
      ? { core: '#ffd577', mid: '#ffb24a', edge: 'rgba(255,178,74,0.0)' }
      : { core: '#bff4ff', mid: '#3da9fc', edge: 'rgba(126,240,255,0.0)' };

    const draw = () => {
      tRef.current += 0.012;
      const t = tRef.current;
      ctx.clearRect(0, 0, size, size);
      const cx = size / 2, cy = size / 2;
      const baseR = size * 0.28;

      const lvl = Math.min(1, (levelRef.current || 0) * 2.0);
      const liveSamples = samplesRef.current;
      const breath = (0.5 + 0.5 * Math.sin(t * 0.9)) * 0.06;
      const rOuter = baseR * (1 + breath + lvl * 0.18);

      // Outer caustic glow
      const grad = ctx.createRadialGradient(cx, cy, baseR * 0.2, cx, cy, baseR * 2.6);
      grad.addColorStop(0, 'rgba(126,240,255,0.55)');
      grad.addColorStop(0.25, 'rgba(61,169,252,0.22)');
      grad.addColorStop(0.6, 'rgba(20,40,80,0.14)');
      grad.addColorStop(1, 'rgba(4,7,13,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);

      // Layered organic rings — Heptapod ink vibe
      const rings = 5;
      for (let r = 0; r < rings; r++) {
        const rr = rOuter * (0.6 + r * 0.12);
        ctx.beginPath();
        const segs = 180;
        for (let i = 0; i <= segs; i++) {
          const a = (i / segs) * Math.PI * 2;
          // sample-driven wobble
          let amp = 0.04;
          if (liveSamples && liveSamples.length) {
            const idx = Math.floor((i / segs) * liveSamples.length);
            amp = ((liveSamples[idx] - 128) / 128) * 0.18 * intensity;
          }
          const wob =
            Math.sin(a * 3 + t * 1.2 + r) * 0.04 +
            Math.sin(a * 7 - t * 0.7 + r * 2) * 0.025 +
            Math.sin(a * 13 + t * 0.4) * 0.015 +
            amp * (0.5 + 0.5 * Math.sin(a * 4 + t)) * 0.6;
          const radius = rr * (1 + wob + lvl * 0.10);
          const x = cx + Math.cos(a) * radius;
          const y = cy + Math.sin(a) * radius;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        const ringGrad = ctx.createRadialGradient(cx, cy, rr * 0.4, cx, cy, rr * 1.2);
        const alpha = 0.10 + (rings - r) * 0.04;
        ringGrad.addColorStop(0, `rgba(126,240,255,${alpha + 0.12})`);
        ringGrad.addColorStop(0.7, `rgba(61,169,252,${alpha})`);
        ringGrad.addColorStop(1, 'rgba(4,7,13,0)');
        ctx.fillStyle = ringGrad;
        ctx.fill();
        ctx.strokeStyle = `rgba(126,240,255,${0.18 + (rings - r) * 0.04})`;
        ctx.lineWidth = 0.6;
        ctx.stroke();
      }

      // Core
      const coreR = baseR * 0.42 * (1 + lvl * 0.15);
      const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
      cg.addColorStop(0, palette.core);
      cg.addColorStop(0.4, palette.mid);
      cg.addColorStop(1, 'rgba(8,20,40,0)');
      ctx.fillStyle = cg;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
      ctx.fill();

      // Inner highlight pinhole
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.beginPath();
      ctx.arc(cx - coreR * 0.18, cy - coreR * 0.22, coreR * 0.12, 0, Math.PI * 2);
      ctx.fill();

      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [size, hue, intensity]);

  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <canvas ref={canvasRef} style={{ display: 'block', filter: listening ? 'none' : 'saturate(0.5) brightness(0.7)' }} />
    </div>
  );
}

// ----------------------------------------------------------------------------
// Waveform — horizontal time-domain bars.
// ----------------------------------------------------------------------------
function Waveform({ samples, width = 800, height = 140, color = '#7ef0ff', bars = 96, mirror = true }) {
  const ref = useRef();
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const ctx = c.getContext('2d');
    const dpr = 2;
    c.width = width * dpr; c.height = height * dpr;
    c.style.width = width + 'px'; c.style.height = height + 'px';
    ctx.scale(dpr, dpr);
    let raf;
    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      const step = Math.floor((samples.length || 1) / bars);
      const barW = width / bars;
      const barInner = barW * 0.6;
      ctx.fillStyle = color;
      for (let i = 0; i < bars; i++) {
        let max = 0;
        for (let j = 0; j < step; j++) {
          const v = Math.abs((samples[i * step + j] || 128) - 128) / 128;
          if (v > max) max = v;
        }
        const h = Math.max(2, max * height * 0.85);
        const x = i * barW + (barW - barInner) / 2;
        const y = mirror ? height / 2 - h / 2 : height - h;
        ctx.globalAlpha = 0.35 + max * 0.65;
        ctx.fillRect(x, y, barInner, h);
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [width, height, color, bars, mirror]);
  return <canvas ref={ref} style={{ display: 'block' }} />;
}

// ----------------------------------------------------------------------------
// MelSpectrogram — scrolling 2D heatmap fed by frequency data.
// ----------------------------------------------------------------------------
function MelSpectrogram({ freqs, width = 480, height = 180, mels = 80 }) {
  const ref = useRef();
  const bufRef = useRef(null);

  useEffect(() => {
    const c = ref.current; if (!c) return;
    const ctx = c.getContext('2d');
    const dpr = 2;
    c.width = width * dpr; c.height = height * dpr;
    c.style.width = width + 'px'; c.style.height = height + 'px';
    ctx.scale(dpr, dpr);
    ctx.imageSmoothingEnabled = false;

    if (!bufRef.current) {
      bufRef.current = new Uint8Array(width * mels);
    }

    let raf;
    const colorFor = (v) => {
      // dark navy -> teal -> hot cyan
      const t = v / 255;
      const r = Math.round(8 + t * 80);
      const g = Math.round(20 + t * 220);
      const b = Math.round(60 + t * 195);
      return `rgb(${r},${g},${b})`;
    };
    const draw = () => {
      // shift left by 1 column
      const buf = bufRef.current;
      for (let x = 0; x < width - 1; x++) {
        for (let y = 0; y < mels; y++) {
          buf[x * mels + y] = buf[(x + 1) * mels + y];
        }
      }
      // new column from freqs (downsample to `mels`)
      const step = Math.floor((freqs.length || 1) / mels);
      for (let y = 0; y < mels; y++) {
        let v = 0;
        for (let j = 0; j < step; j++) v = Math.max(v, freqs[y * step + j] || 0);
        buf[(width - 1) * mels + y] = v;
      }
      // render
      ctx.clearRect(0, 0, width, height);
      const cellW = width / width;
      const cellH = height / mels;
      for (let x = 0; x < width; x++) {
        for (let y = 0; y < mels; y++) {
          const v = buf[x * mels + y];
          if (v < 4) continue;
          ctx.fillStyle = colorFor(v);
          ctx.globalAlpha = 0.15 + (v / 255) * 0.85;
          // y inverted so low freq at bottom
          ctx.fillRect(x * cellW, (mels - 1 - y) * cellH, cellW + 0.5, cellH + 0.5);
        }
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [width, height, mels]);

  return <canvas ref={ref} style={{ display: 'block', borderRadius: 8 }} />;
}

// ----------------------------------------------------------------------------
// EmbeddingCloud — 192 dots with tiny per-dot value bar; gentle drift.
// Renders a square grid (16 x 12) of dimensions for the 192-dim embedding.
// ----------------------------------------------------------------------------
function EmbeddingCloud({ values, cols = 16, rows = 12, size = 22, gap = 8, accent = '#7ef0ff' }) {
  const cells = useMemo(() => {
    const rand = seedRand(7);
    return Array.from({ length: cols * rows }, (_, i) => {
      const v = values ? values[i] : (Math.sin(i * 0.31) * 0.5 + 0.5) * (0.4 + rand() * 0.6);
      return v;
    });
  }, [values, cols, rows]);

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: `repeat(${cols}, ${size}px)`,
      gap: `${gap}px`,
    }}>
      {cells.map((v, i) => {
        const intensity = Math.max(0.08, Math.min(1, v));
        return (
          <div key={i} style={{
            width: size, height: size,
            position: 'relative',
            borderRadius: 4,
            background: `rgba(125,200,255,${0.04 + intensity * 0.14})`,
            border: '1px solid rgba(125,200,255,0.10)',
          }}>
            <div style={{
              position: 'absolute', left: 2, right: 2, bottom: 2,
              height: `${intensity * (size - 4)}px`,
              background: `linear-gradient(180deg, ${accent}, #3da9fc)`,
              boxShadow: `0 0 ${intensity * 8}px rgba(126,240,255,${intensity * 0.6})`,
              borderRadius: 2,
              opacity: 0.4 + intensity * 0.6,
            }}></div>
          </div>
        );
      })}
    </div>
  );
}

// ----------------------------------------------------------------------------
// SimilarityGauge — semicircle meter with threshold marker at 0.75.
// ----------------------------------------------------------------------------
function SimilarityGauge({ value = 0.91, threshold = 0.75, size = 320, label = "Voice match" }) {
  // value 0..1 -> angle -90deg..+90deg
  const angle = -90 + value * 180;
  const thrAngle = -90 + threshold * 180;
  const passing = value >= threshold;
  const accent = passing ? '#7ef0ff' : '#ff5577';
  const r = size * 0.42;
  const cx = size / 2, cy = size * 0.62;
  const startA = Math.PI;
  const endA = 0;
  const arcPath = (a0, a1) => {
    const x0 = cx + r * Math.cos(a0);
    const y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1);
    const y1 = cy + r * Math.sin(a1);
    const large = (a1 - a0) > Math.PI ? 1 : 0;
    return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 0 ${x1} ${y1}`;
  };
  const valEnd = Math.PI - value * Math.PI;
  return (
    <div style={{ position: 'relative', width: size, height: size * 0.78 }}>
      <svg width={size} height={size * 0.78} viewBox={`0 0 ${size} ${size * 0.78}`}>
        {/* track */}
        <path d={arcPath(startA, endA)} stroke="rgba(125,200,255,0.12)" strokeWidth="14" fill="none" strokeLinecap="round"/>
        {/* tick marks */}
        {Array.from({length: 21}).map((_, i) => {
          const t = i / 20;
          const a = Math.PI - t * Math.PI;
          const r1 = r - 24, r2 = r - 14;
          const x1 = cx + r1 * Math.cos(a), y1 = cy + r1 * Math.sin(a);
          const x2 = cx + r2 * Math.cos(a), y2 = cy + r2 * Math.sin(a);
          const isMain = i % 5 === 0;
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(125,200,255,0.25)" strokeWidth={isMain ? 1.5 : 0.8}/>;
        })}
        {/* threshold marker */}
        {(() => {
          const a = Math.PI - threshold * Math.PI;
          const r1 = r - 6, r2 = r + 14;
          const x1 = cx + r1 * Math.cos(a), y1 = cy + r1 * Math.sin(a);
          const x2 = cx + r2 * Math.cos(a), y2 = cy + r2 * Math.sin(a);
          return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#ffb24a" strokeWidth="2" strokeDasharray="2 2"/>;
        })()}
        {/* value arc */}
        <path d={arcPath(startA, valEnd)} stroke={accent} strokeWidth="14" fill="none" strokeLinecap="round"
              style={{ filter: `drop-shadow(0 0 12px ${accent})` }}/>
        {/* needle */}
        {(() => {
          const a = Math.PI - value * Math.PI;
          const x = cx + (r - 4) * Math.cos(a), y = cy + (r - 4) * Math.sin(a);
          return <>
            <circle cx={cx} cy={cy} r="6" fill={accent}/>
            <line x1={cx} y1={cy} x2={x} y2={y} stroke={accent} strokeWidth="3" strokeLinecap="round"/>
          </>;
        })()}
      </svg>
      <div style={{
        position: 'absolute', left: 0, right: 0, bottom: 0,
        textAlign: 'center',
      }}>
        <div className="num-mono" style={{ fontSize: 56, fontWeight: 300, color: accent, lineHeight: 1, letterSpacing: '-0.02em' }}>
          {value.toFixed(3)}
        </div>
        <div className="label-mono" style={{ marginTop: 6 }}>{label}</div>
        <div style={{
          marginTop: 8,
          fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
          color: '#ffb24a', letterSpacing: '0.18em',
        }}>
          THRESHOLD · {threshold.toFixed(2)}
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// ConceptBars — TCAV-style horizontal bars showing voice concept contributions.
// ----------------------------------------------------------------------------
function ConceptBars({ concepts, max = 0.6 }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {concepts.map((c, i) => {
        const pct = Math.min(1, c.score / max);
        const positive = c.score >= 0;
        const w = Math.abs(c.score) / max * 100;
        return (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '230px 1fr 80px', alignItems: 'center', gap: 18 }}>
            <div>
              <div style={{ fontSize: 16, color: 'var(--ink)', fontWeight: 400 }}>{c.label}</div>
              <div className="label-mono" style={{ fontSize: 10, marginTop: 2 }}>{c.tech}</div>
            </div>
            <div style={{
              position: 'relative',
              height: 12,
              background: 'rgba(125,200,255,0.06)',
              borderRadius: 6,
              overflow: 'hidden',
            }}>
              <div style={{
                position: 'absolute', top: 0, bottom: 0, left: 0,
                width: `${w}%`,
                background: positive
                  ? `linear-gradient(90deg, rgba(61,169,252,0.3), #7ef0ff)`
                  : `linear-gradient(90deg, rgba(255,85,119,0.3), #ff7aa8)`,
                boxShadow: positive
                  ? `0 0 18px rgba(126,240,255,0.5)`
                  : `0 0 18px rgba(255,85,119,0.4)`,
                borderRadius: 6,
                transition: 'width 800ms cubic-bezier(0.2, 0.8, 0.2, 1)',
              }}></div>
            </div>
            <div className="num-mono" style={{ textAlign: 'right', color: positive ? '#7ef0ff' : '#ff7aa8', fontSize: 18 }}>
              {c.score >= 0 ? '+' : ''}{(c.score * 100).toFixed(0)}%
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ----------------------------------------------------------------------------
// PipelineFlow — animated horizontal flow with stage nodes lit progressively.
// ----------------------------------------------------------------------------
function PipelineFlow({ stages, activeIdx, complete = false }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'stretch',
      gap: 0,
      width: '100%',
    }}>
      {stages.map((s, i) => {
        const active = i === activeIdx;
        const done = complete || i < activeIdx;
        const pending = i > activeIdx && !complete;
        const color = done ? '#7ef0ff' : active ? '#3da9fc' : 'rgba(125,200,255,0.25)';
        return (
          <React.Fragment key={i}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 12 }}>
              <div style={{
                width: 64, height: 64, borderRadius: '50%',
                border: `1.5px solid ${color}`,
                display: 'grid', placeItems: 'center',
                background: done
                  ? 'radial-gradient(circle at 50% 50%, rgba(126,240,255,0.35), rgba(126,240,255,0.05))'
                  : active
                  ? 'radial-gradient(circle at 50% 50%, rgba(61,169,252,0.3), rgba(61,169,252,0.05))'
                  : 'rgba(10,20,34,0.5)',
                boxShadow: active ? `0 0 24px ${color}` : (done ? `0 0 8px ${color}` : 'none'),
                animation: active ? 'breathe 1.2s ease-in-out infinite' : 'none',
                position: 'relative',
              }}>
                <div style={{ color, fontSize: 22 }}>{s.icon}</div>
                {done && (
                  <div style={{
                    position: 'absolute', top: -4, right: -4,
                    width: 18, height: 18, borderRadius: '50%',
                    background: '#7ef0ff', color: '#04070d',
                    display: 'grid', placeItems: 'center',
                    fontSize: 10, fontWeight: 700,
                  }}>✓</div>
                )}
              </div>
              <div>
                <div className="label-mono" style={{ color, fontSize: 9 }}>{`STEP ${i + 1}`}</div>
                <div style={{ fontSize: 14, color: pending ? 'var(--ink-soft)' : 'var(--ink)', marginTop: 4, fontWeight: 400 }}>
                  {s.title}
                </div>
                <div style={{ fontSize: 11, color: 'var(--ink-soft)', marginTop: 2 }}>
                  {s.sub}
                </div>
              </div>
            </div>
            {i < stages.length - 1 && (
              <div style={{
                flex: 0.6,
                position: 'relative',
                marginTop: 31,
                height: 2,
                background: done ? '#7ef0ff' : 'rgba(125,200,255,0.18)',
                boxShadow: done ? '0 0 8px #7ef0ff' : 'none',
              }}>
                {active && (
                  <div style={{
                    position: 'absolute', top: -1, left: 0, right: 0, height: 4,
                    background: 'linear-gradient(90deg, transparent, #7ef0ff, transparent)',
                    backgroundSize: '60% 100%',
                    backgroundRepeat: 'no-repeat',
                    animation: 'shimmer 1.4s linear infinite',
                  }}></div>
                )}
              </div>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Brand mark — stylized BV / sound-ring SVG used in chrome.
// ----------------------------------------------------------------------------
function BrandMark({ size = 44 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 44 44">
      <defs>
        <radialGradient id="bm-core" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#bff4ff"/>
          <stop offset="60%" stopColor="#3da9fc"/>
          <stop offset="100%" stopColor="#1a3a6e" stopOpacity="0"/>
        </radialGradient>
      </defs>
      <circle cx="22" cy="22" r="20" stroke="rgba(126,240,255,0.25)" strokeWidth="0.7" fill="none"/>
      <circle cx="22" cy="22" r="14" stroke="rgba(126,240,255,0.45)" strokeWidth="0.7" fill="none"/>
      <circle cx="22" cy="22" r="8" fill="url(#bm-core)"/>
      {/* sound bars */}
      {[6, 10, 14, 10, 6].map((h, i) => (
        <rect key={i} x={14 + i * 4} y={22 - h/2} width="2" height={h} fill="#7ef0ff" opacity={0.85}>
          <animate attributeName="height" values={`${h};${h*0.4};${h}`} dur={`${1.1 + i*0.15}s`} repeatCount="indefinite"/>
          <animate attributeName="y" values={`${22-h/2};${22-h*0.4/2};${22-h/2}`} dur={`${1.1 + i*0.15}s`} repeatCount="indefinite"/>
        </rect>
      ))}
    </svg>
  );
}

// Crest for the partner badge (Israel cyber crest stylized)
function PartnerCrest({ size = 36 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" fill="none">
      <circle cx="18" cy="18" r="16" stroke="rgba(126,240,255,0.5)" strokeWidth="0.8"/>
      <path d="M18 6 L24 16 L18 26 L12 16 Z" stroke="#7ef0ff" strokeWidth="1.2" fill="none"/>
      <path d="M18 12 L21 18 L18 24 L15 18 Z" stroke="#3da9fc" strokeWidth="0.8" fill="none"/>
      <circle cx="18" cy="18" r="1.5" fill="#7ef0ff"/>
    </svg>
  );
}

// Mini 'breathing' pulse-dot for status / live feed
function LivePulse({ color = '#7ef0ff', size = 10 }) {
  return (
    <span style={{ position: 'relative', display: 'inline-block', width: size, height: size }}>
      <span style={{
        position: 'absolute', inset: 0, borderRadius: '50%',
        background: color,
        boxShadow: `0 0 10px ${color}`,
      }}></span>
      <span style={{
        position: 'absolute', inset: -4, borderRadius: '50%',
        border: `1px solid ${color}`,
        animation: 'pulse 1.4s ease-out infinite',
        opacity: 0.5,
      }}></span>
    </span>
  );
}

export {
  VoiceOrb, Waveform, MelSpectrogram, EmbeddingCloud, SimilarityGauge,
  ConceptBars, PipelineFlow, BrandMark, PartnerCrest, LivePulse,
};
