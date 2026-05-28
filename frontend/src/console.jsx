// Console / Operations dashboard — the default view for cyber experts.
// Plus settings panel and animation utilities.

import React, { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { VoiceOrb, Waveform, MelSpectrogram, LivePulse } from "./visuals.jsx";
import { AmbientField, EmbeddingConstellation } from "./console-ext.jsx";
import { Chrome } from "./screens.jsx";
import { useAppState } from "./lib/session";
import { getReady } from "./lib/api";
import { useEmbeddingProjection } from "./hooks/useEmbeddingProjection";
import { useLiveEmbedding } from "./hooks/useLiveEmbedding";

const SPEAKER_MODEL_LABELS = {
  redimnet_b5: "ReDimNet B5",
  ecapa_voxceleb: "ECAPA VoxCeleb",
  wespeaker_resnet293_lm: "WeSpeaker ResNet293",
};

// ============================================================================
// useCounter — animated count-up
// ============================================================================
function useCounter(target, ms = 1200, deps = []) {
  const [v, setV] = useState(0);
  useEffect(() => {
    let raf;
    const start = performance.now();
    const from = 0;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - t, 3);
      setV(from + (target - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, deps);
  return v;
}

function useElementSize() {
  const ref = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => {
      setSize({
        width: node.clientWidth || 0,
        height: node.clientHeight || 0,
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  return [ref, size];
}

// ============================================================================
// ParticleFlow — particles flowing across a horizontal line
// ============================================================================
function ParticleFlow({ width = 240, height = 60, color = '#7ef0ff', count = 8, speed = 1 }) {
  const ref = useRef();
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const ctx = c.getContext('2d');
    const dpr = 2;
    c.width = width * dpr; c.height = height * dpr;
    c.style.width = width + 'px'; c.style.height = height + 'px';
    ctx.scale(dpr, dpr);
    const parts = Array.from({ length: count }, (_, i) => ({
      x: -i * (width / count),
      y: height / 2 + (Math.random() - 0.5) * 6,
      size: 1 + Math.random() * 2,
      v: 0.6 + Math.random() * 0.6,
    }));
    let raf;
    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      // line
      ctx.strokeStyle = 'rgba(125,200,255,0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
      ctx.stroke();
      parts.forEach(p => {
        p.x += p.v * speed;
        if (p.x > width + 8) { p.x = -8; p.y = height / 2 + (Math.random() - 0.5) * 6; }
        const trailGrad = ctx.createLinearGradient(p.x - 18, 0, p.x, 0);
        trailGrad.addColorStop(0, 'rgba(126,240,255,0)');
        trailGrad.addColorStop(1, color);
        ctx.fillStyle = trailGrad;
        ctx.fillRect(p.x - 18, p.y - 0.6, 18, 1.2);
        ctx.fillStyle = color;
        ctx.shadowBlur = 8; ctx.shadowColor = color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      });
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [width, height, color, count, speed]);
  return <canvas ref={ref} style={{ display: 'block' }}/>;
}

// ============================================================================
// SettingsPanel — gear icon top-right; opens slide-in panel.
// ============================================================================
function SettingsPanel({ mode, setMode, soundOn, setSoundOn }) {
  const [open, setOpen] = useState(false);
  // Real microphone permission state — replaces the old hardcoded "granted".
  const [micPermission, setMicPermission] = useState("unknown");
  useEffect(() => {
    if (!open || typeof navigator === "undefined" || !navigator.permissions?.query) return;
    let cancelled = false;
    let status = null;
    (async () => {
      try {
        status = await navigator.permissions.query({ name: "microphone" });
        if (cancelled) return;
        setMicPermission(status.state);
        status.onchange = () => setMicPermission(status.state);
      } catch {
        // Some browsers (older Firefox / iOS Safari) don't expose the
        // microphone permission descriptor. Leave the state as "unknown".
      }
    })();
    return () => {
      cancelled = true;
      if (status) status.onchange = null;
    };
  }, [open]);
  // Real model readiness from /readyz — replaces the old TCAV / F5-TTS fakes.
  const [models, setModels] = useState(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const ready = await getReady();
        if (!cancelled) setModels(ready);
      } catch {
        if (!cancelled) setModels({ ready: false, databaseOk: false, aasistWeightsOk: false, redimnetWeightsOk: false });
      }
    })();
    return () => { cancelled = true; };
  }, [open]);
  return (
    <>
      <button
        onClick={() => setOpen(o => !o)}
        title="Settings (S)"
        style={{
          position: 'absolute', top: 96, right: 56, zIndex: 110,
          width: 40, height: 40, borderRadius: '50%',
          border: '1px solid rgba(125,200,255,0.18)',
          background: open ? 'rgba(126,240,255,0.15)' : 'rgba(10,20,34,0.6)',
          backdropFilter: 'blur(8px)',
          cursor: 'pointer', display: 'grid', placeItems: 'center',
          color: open ? '#7ef0ff' : 'var(--ink-mute)',
          transition: 'all 200ms',
        }}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" style={{ animation: open ? 'spin-slow 8s linear infinite' : 'none' }}>
          <circle cx="9" cy="9" r="2" stroke="currentColor" strokeWidth="1.4"/>
          <path d="M9 1 V3 M9 15 V17 M1 9 H3 M15 9 H17 M3.3 3.3 L4.7 4.7 M13.3 13.3 L14.7 14.7 M3.3 14.7 L4.7 13.3 M13.3 4.7 L14.7 3.3"
                stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
        </svg>
      </button>
      {/* G17 — settings drawer is scrollable; tabIndex makes it
          keyboard-navigable. role+aria-label gives the region a name
          for screen readers. */}
      <div
        tabIndex={0}
        role="region"
        aria-label="Settings panel"
        style={{
          position: 'absolute', top: 0, right: 0, bottom: 0,
          width: 420, zIndex: 109,
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 360ms cubic-bezier(0.2, 0.8, 0.2, 1)',
          background: 'linear-gradient(180deg, rgba(7,11,20,0.96), rgba(10,20,34,0.92))',
          borderLeft: '1px solid rgba(125,200,255,0.18)',
          backdropFilter: 'blur(20px)',
          padding: '110px 36px 40px',
          overflowY: 'auto',
        }}>
        <div className="label-mono" style={{ fontSize: 11, color: 'var(--teal-2)', marginBottom: 6 }}>SETTINGS</div>
        <div style={{ fontSize: 32, fontWeight: 200, marginBottom: 36 }}>System preferences</div>

        <Section label="Display Mode" sub="Controls how the demo reveals itself.">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[
              { id: 'expert',  label: 'Expert console',  sub: 'Default — full operator UI' },
              { id: 'live',    label: 'Live walkthrough', sub: 'Presenter pace · navigation tray' },
              { id: 'self',    label: 'Self-serve kiosk', sub: 'Visitor-driven · idle reset' },
              { id: 'auto',    label: 'Auto-loop showreel', sub: 'Hands-free · cycles every screen' },
            ].map(m => (
              <button key={m.id} onClick={() => setMode(m.id)} style={{
                textAlign: 'left',
                background: mode === m.id ? 'rgba(126,240,255,0.10)' : 'rgba(125,200,255,0.03)',
                border: `1px solid ${mode === m.id ? 'rgba(126,240,255,0.55)' : 'var(--line)'}`,
                borderRadius: 10, padding: '14px 16px', cursor: 'pointer',
                color: 'var(--ink)',
                transition: 'all 180ms',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 15, fontWeight: 400 }}>{m.label}</span>
                  {mode === m.id && <span style={{ color: 'var(--teal-2)', fontSize: 14 }}>●</span>}
                </div>
                <div className="label-mono" style={{ fontSize: 9, marginTop: 4, color: 'var(--ink-soft)' }}>{m.sub}</div>
              </button>
            ))}
          </div>
        </Section>

        <Section label="Audio" sub="Microphone & sound feedback.">
          <Toggle label="UI sound effects" value={soundOn} onChange={setSoundOn}/>
          <div style={{ marginTop: 10 }} className="label-mono" >
            <span style={{ color: 'var(--ink-soft)' }}>MIC PERMISSION · </span>
            <span style={{ color: micPermission === "granted" ? 'var(--good)' : micPermission === "denied" ? 'var(--bad)' : 'var(--ink-mute)' }}>
              {micPermission}
            </span>
          </div>
        </Section>

        <Section label="Models" sub="Live readiness from /readyz.">
          {(() => {
            const rows = models
              ? [
                  ['ReDimNet-B5', '192-d speaker embedding · vendored checkpoint', models.redimnetWeightsOk ? 'good' : 'warn'],
                  ['AASIST', 'Anti-spoofing detector · vendored checkpoint', models.aasistWeightsOk ? 'good' : 'warn'],
                  ['Spoof generator', 'system TTS fallback (XTTS planned for v1.1)', 'warn'],
                ]
              : [['Loading…', 'Probing /readyz', 'warn']];
            return rows.map(([n, s, k]) => (
              <div key={n} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderTop: '1px solid var(--line)' }}>
                <div>
                  <div style={{ fontSize: 13 }}>{n}</div>
                  <div className="label-mono" style={{ fontSize: 9, color: 'var(--ink-soft)', marginTop: 2 }}>{s}</div>
                </div>
                <span className={`pill ${k}`}><span className="dot"></span>{k === 'good' ? 'READY' : 'STANDBY'}</span>
              </div>
            ));
          })()}
        </Section>

        <Section label="About">
          <div style={{ fontSize: 12, color: 'var(--ink-mute)', lineHeight: 1.6 }}>
            BioVoice v0.6 — Software Design Document SDD-6<br/>
            Built for the Israel National Cyber Directorate.<br/>
            <span className="label-mono" style={{ display: 'block', marginTop: 8, fontSize: 9 }}>
              ML · Eden Adiv · Idan Shavit · Yoav Zucker
            </span>
          </div>
        </Section>

        <button onClick={() => setOpen(false)} className="btn btn-ghost" style={{ marginTop: 24, width: '100%', justifyContent: 'center', padding: '14px' }}>
          Close
        </button>
      </div>
    </>
  );
}

function Section({ label, sub, children }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div className="label-mono" style={{ fontSize: 10, marginBottom: 4 }}>{label}</div>
      {sub && <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginBottom: 12 }}>{sub}</div>}
      {children}
    </div>
  );
}

function Toggle({ label, value, onChange }) {
  return (
    <div onClick={() => onChange(!value)} style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '10px 0', cursor: 'pointer',
    }}>
      <span style={{ fontSize: 13 }}>{label}</span>
      <div style={{
        width: 38, height: 22, borderRadius: 999,
        background: value ? 'linear-gradient(135deg, #3da9fc, #7ef0ff)' : 'rgba(125,200,255,0.15)',
        position: 'relative', transition: 'all 200ms',
      }}>
        <div style={{
          position: 'absolute', top: 2, left: value ? 18 : 2,
          width: 18, height: 18, borderRadius: '50%',
          background: value ? '#04070d' : 'var(--ink-mute)',
          transition: 'left 200ms',
        }}></div>
      </div>
    </div>
  );
}

// ============================================================================
// ExpandButton — small corner control that opens a panel's large-mode modal.
// ============================================================================
function ExpandButton({ onClick, title = "Expand" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label="Expand panel"
      style={{
        flexShrink: 0, width: 26, height: 26, padding: 0,
        display: 'grid', placeItems: 'center',
        borderRadius: 7, border: '1px solid var(--line-2)',
        background: 'transparent', color: 'var(--ink-soft)',
        cursor: 'pointer', transition: 'all 160ms',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = 'var(--teal-2)';
        e.currentTarget.style.borderColor = 'rgba(126,240,255,0.55)';
        e.currentTarget.style.background = 'rgba(126,240,255,0.10)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = 'var(--ink-soft)';
        e.currentTarget.style.borderColor = 'var(--line-2)';
        e.currentTarget.style.background = 'transparent';
      }}
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
        <path d="M6 2 H2 V6 M10 2 H14 V6 M14 10 V14 H10 M2 10 V14 H6"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    </button>
  );
}

// ============================================================================
// PanelModal — centered overlay that re-renders a panel's content at a large
// size. Mirrors the `biovoice-overlay` idiom used by VerificationOverlay.
// `children` is a render-prop called with the measured body {width,height}.
// ============================================================================
const PANEL_TITLES = {
  orb: "LIVE MIC · VOICE ORB",
  profiles: "ENROLLED PROFILES",
  spectrogram: "MEL-SPECTROGRAM · STREAMING",
  pipeline: "INFERENCE PIPELINE",
  constellation: "VOICE EMBEDDING SPACE",
  activity: "LIVE EVENT FEED",
};

function PanelModal({ title, onClose, children }) {
  const [bodyRef, bodySize] = useElementSize();
  const closeRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => { closeRef.current?.focus(); }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        display: 'grid', placeItems: 'center', padding: 32,
        background: 'rgba(2,5,12,0.72)', backdropFilter: 'blur(10px)',
        animation: 'fadeIn 240ms ease both',
      }}
    >
      <div
        style={{
          width: 'min(92vw, 1100px)', height: 'min(88vh, 760px)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          background: 'linear-gradient(180deg, rgba(10,16,28,0.97), rgba(8,12,22,0.97))',
          border: '1px solid rgba(125,200,255,0.18)', borderRadius: 16,
          boxShadow: '0 30px 120px rgba(0,0,0,0.6)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 22px', borderBottom: '1px solid var(--line)' }}>
          <span className="label-mono" style={{ fontSize: 11, color: 'var(--teal-2)' }}>{title}</span>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 30, height: 30, padding: 0, lineHeight: 1,
              display: 'grid', placeItems: 'center',
              borderRadius: 8, border: '1px solid var(--line-2)',
              background: 'transparent', color: 'var(--ink-soft)',
              cursor: 'pointer', fontSize: 18,
            }}
          >
            ×
          </button>
        </div>
        <div
          ref={bodyRef}
          style={{ flex: 1, minHeight: 0, padding: 22, overflow: 'auto', display: 'flex', flexDirection: 'column' }}
        >
          {bodySize.width > 0 ? children(bodySize) : null}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// ConsoleScreen — the default expert dashboard.
// ============================================================================
function ConsoleScreen({ audio, micState, micStart, profiles, onVerify, onEnroll, onShowDetails, threatCount, verifyCount }) {
  const [selectedProfile, setSelectedProfile] = useState(profiles[0]?.id);
  const [hoverProfile, setHoverProfile] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [embeddingModelKey, setEmbeddingModelKey] = useState("redimnet_b5");
  const [expanded, setExpanded] = useState(null);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [spectrogramRef, spectrogramSize] = useElementSize();
  const [constellationRef, constellationSize] = useElementSize();

  // Tick clock for "elapsed" rendering on activity rows.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Derive the live event feed from real /results polling (E-16).
  const { results } = useAppState();
  const activity = useMemo(() => results.slice(0, 50).map(resultToActivity), [results]);

  // Keep the selected profile in sync with the live profiles list (E-15).
  useEffect(() => {
    if (profiles.length === 0) {
      setSelectedProfile(undefined);
      return;
    }
    if (!selectedProfile || !profiles.some((p) => p.id === selectedProfile)) {
      setSelectedProfile(profiles[0].id);
    }
  }, [profiles, selectedProfile]);

  // V3 — real ReDimNet embeddings projected to 3-d for the constellation.
  const projection = useEmbeddingProjection(embeddingModelKey, profiles.length);
  // V3 — live mic embedding via /embed; toggleable from the Settings panel.
  const live = useLiveEmbedding({
    getRecentFloat: micState === 'live' ? audio.getRecentFloat ?? null : null,
    sampleRate: audio.sampleRateRef?.current ?? 16000,
    basis: projection.basis,
    modelKey: embeddingModelKey,
  });
  const latestModelScores = results[0]?.speakerModelScores ?? [];
  const activeModelKeys = latestModelScores.length > 0
    ? latestModelScores.map((score) => score.modelKey)
    : ["redimnet_b5", "ecapa_voxceleb", "wespeaker_resnet293_lm"];
  const spectrogramWidth = Math.max(300, Math.floor((spectrogramSize.width || 860) - 52));
  const spectrogramHeight = Math.max(220, Math.min(340, Math.floor(spectrogramWidth * 0.38)));
  const constellationWidth = Math.max(320, Math.min(Math.floor(constellationSize.width || 480), 640));
  const constellationHeight = Math.max(300, Math.min(Math.floor(constellationSize.height || 360), 600));

  // --------------------------------------------------------------------------
  // Panel bodies — defined once and reused by both the inline panel and the
  // large-mode modal. `onExpand` (when present) renders the corner expand
  // button; the modal omits it. Canvas panels take explicit width/height so
  // they redraw crisply at modal size.
  // --------------------------------------------------------------------------
  const orbBody = ({ onExpand, orbSize = 260, waveWidth = 352, waveHeight = 48 } = {}) => (
    <>
      <VoiceOrb size={orbSize} samples={audio.samples} level={audio.level} hue="cyan" intensity={1.1}/>
      <div style={{ position: 'absolute', top: 16, left: 16, right: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <span className={`pill ${micState === 'live' ? 'good' : 'warn'}`}>
          <span className="dot"></span>
          {micState === 'live' ? 'LIVE MIC' : 'STANDBY MIC'}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="num-mono" style={{ fontSize: 11, color: 'var(--ink-soft)' }}>16 KHZ</span>
          {onExpand && <ExpandButton onClick={onExpand}/>}
        </span>
      </div>
      <div style={{ position: 'absolute', bottom: 12, left: 12, right: 12 }}>
        <Waveform samples={audio.samples} width={waveWidth} height={waveHeight} bars={80} mirror={true}/>
      </div>
    </>
  );

  const profilesBody = ({ onExpand } = {}) => (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <span className="label-mono" style={{ fontSize: 10 }}>ENROLLED PROFILE · CHOOSE ONE</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="num-mono" style={{ fontSize: 10, color: 'var(--ink-soft)' }}>{profiles.length} ACTIVE</span>
          {onExpand && <ExpandButton onClick={onExpand}/>}
        </span>
      </div>
      {/* G17 — buttons inside are focusable but axe needs the
          scrollable region itself to be reachable too. Lightweight
          defensive tabIndex + role keeps the panel green even if
          the button list is empty. */}
      <div
        style={{ display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto', flex: 1 }}
        tabIndex={0}
        role="region"
        aria-label="Enrolled profiles"
      >
        {profiles.map(p => (
          <button key={p.id}
            onClick={() => setSelectedProfile(p.id)}
            onMouseEnter={() => setHoverProfile(p.id)}
            onMouseLeave={() => setHoverProfile(null)}
            style={{
              background: selectedProfile === p.id ? 'rgba(126,240,255,0.10)' : (hoverProfile === p.id ? 'rgba(125,200,255,0.04)' : 'transparent'),
              border: `1px solid ${selectedProfile === p.id ? 'rgba(126,240,255,0.5)' : 'var(--line)'}`,
              borderRadius: 10, padding: '10px 14px', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 12,
              color: 'var(--ink)', textAlign: 'left',
              transition: 'all 180ms',
              transform: hoverProfile === p.id && selectedProfile !== p.id ? 'translateX(2px)' : 'none',
            }}>
            <div style={{
              width: 32, height: 32, borderRadius: '50%',
              background: `linear-gradient(135deg, ${p.color1}, ${p.color2})`,
              display: 'grid', placeItems: 'center',
              color: '#04070d', fontWeight: 600, fontSize: 13,
            }}>{p.initials}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14 }}>{p.name}</div>
              <div className="label-mono" style={{ fontSize: 9, color: 'var(--ink-soft)' }}>{p.id}</div>
            </div>
            {selectedProfile === p.id && <span style={{ color: 'var(--teal-2)' }}>●</span>}
          </button>
        ))}
      </div>
    </>
  );

  const spectrogramBody = ({ onExpand, width, height, wrapRef } = {}) => (
    <>
      <div className="biovoice-panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14 }}>
        <div>
          <div className="label-mono" style={{ fontSize: 10 }}>MEL-SPECTROGRAM · STREAMING</div>
          <div style={{ fontSize: 19, marginTop: 4 }}>How the AI <em className="serif" style={{ color: 'var(--teal-2)' }}>sees</em> the room</div>
        </div>
        <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
          <span className="label-mono" style={{ fontSize: 9, color: 'var(--ink-soft)' }}>80 BANDS · 20–8 K HZ</span>
          <LivePulse size={8}/>
          {onExpand && <ExpandButton onClick={onExpand}/>}
        </div>
      </div>
      <div
        ref={wrapRef}
        className="biovoice-spectrogram-wrap"
        style={{ flex: 1, display: 'grid', placeItems: 'center', position: 'relative', minHeight: 280, width: '100%' }}
      >
        <MelSpectrogram freqs={audio.freqs} width={width} height={height} mels={80}/>
        <div style={{
          position: 'absolute', left: 8, top: 8, bottom: 8, width: 36,
          display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
          fontFamily: 'JetBrains Mono, monospace', fontSize: 9, color: 'var(--ink-soft)',
        }}>
          <span>8 kHz</span><span>4 kHz</span><span>2 kHz</span><span>500</span><span>20 Hz</span>
        </div>
        {micState !== 'live' && (
          <div style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            pointerEvents: 'none',
          }}>
            <div style={{
              padding: '10px 14px',
              borderRadius: 10,
              background: 'rgba(4,7,13,0.72)',
              border: '1px solid rgba(125,200,255,0.12)',
              color: 'var(--ink-soft)',
            }}>
              <div className="label-mono" style={{ fontSize: 9, color: 'var(--teal-2)' }}>NO LIVE MIC SIGNAL</div>
              <div style={{ fontSize: 12, marginTop: 6 }}>Grant mic access to stream the spectrogram.</div>
            </div>
          </div>
        )}
      </div>
    </>
  );

  const pipelineBody = ({ onExpand } = {}) => (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <span className="label-mono" style={{ fontSize: 10 }}>INFERENCE PIPELINE · IDLE</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="num-mono" style={{ fontSize: 10, color: 'var(--good)' }}>READY</span>
          {onExpand && <ExpandButton onClick={onExpand}/>}
        </span>
      </div>
      <div className="biovoice-pipeline-row" style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        {[
          { label: 'Capture', sub: 'PCM' },
          { label: 'Mel-Spec', sub: '80 ch' },
          { label: 'ReDimNet', sub: '192 d' },
          { label: 'AASIST', sub: 'auth' },
          { label: 'Decision', sub: 'A / R' },
        ].map((s, i, arr) => (
          <React.Fragment key={i}>
            <div style={{
              flex: '0 0 auto',
              padding: '8px 10px',
              border: '1px solid var(--line-2)',
              borderRadius: 8,
              background: 'rgba(125,200,255,0.04)',
              width: 84, textAlign: 'center',
            }}>
              <div className="label-mono" style={{ fontSize: 9, color: 'var(--teal-2)' }}>{s.sub.toUpperCase()}</div>
              <div style={{ fontSize: 12, marginTop: 2 }}>{s.label}</div>
            </div>
            {i < arr.length - 1 && (
              <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                <ParticleFlow width={64} height={28} count={3} speed={0.6}/>
              </div>
            )}
          </React.Fragment>
        ))}
      </div>
    </>
  );

  const constellationBody = ({ onExpand, width, height, wrapRef } = {}) => (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span
          className="label-mono"
          style={{ fontSize: 10 }}
          title="Selected speaker model embeddings projected to PCA(3). Live point updates from the current mic window."
        >
          VOICE EMBEDDING SPACE
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {projection.error && (
            <span className="label-mono" style={{ fontSize: 9, color: 'var(--bad)' }}>OFFLINE</span>
          )}
          {onExpand && <ExpandButton onClick={onExpand}/>}
        </span>
      </div>
      <div
        ref={wrapRef}
        className="biovoice-constellation-wrap"
        style={{ flex: 1, display: 'grid', placeItems: 'center', width: '100%', minHeight: 0 }}
      >
        <EmbeddingConstellation
          width={width}
          height={height}
          projectedProfiles={projection.profiles}
          livePoint={live.liveProjected}
          matchId={selectedProfile}
          loading={projection.loading}
        />
      </div>
      <div className="biovoice-constellation-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, paddingTop: 10, borderTop: '1px solid var(--line)' }}>
        <div className="biovoice-constellation-legend" style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#bff4ff', boxShadow: '0 0 8px #7ef0ff', opacity: live.loading || live.liveProjected ? 1 : 0.45 }}></span>
            <span className="label-mono" style={{ fontSize: 9 }}>{live.liveProjected ? 'LIVE VOICE' : live.loading ? 'UPDATING LIVE POINT' : 'WAITING FOR MIC'}</span>
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#3da9fc' }}></span>
            <span className="label-mono" style={{ fontSize: 9 }}>{profiles.length} ENROLLED</span>
          </span>
        </div>
        <div className="biovoice-constellation-actions" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {activeModelKeys.map((modelKey) => {
            const active = embeddingModelKey === modelKey;
            return (
              <button
                key={modelKey}
                onClick={() => setEmbeddingModelKey(modelKey)}
                className="label-mono"
                style={{
                  fontSize: 9,
                  padding: '4px 10px',
                  borderRadius: 999,
                  border: `1px solid ${active ? 'rgba(126,240,255,0.55)' : 'var(--line-2)'}`,
                  background: active ? 'rgba(126,240,255,0.10)' : 'transparent',
                  color: active ? 'var(--teal-2)' : 'var(--ink-soft)',
                  cursor: 'pointer',
                  transition: 'all 180ms',
                }}
              >
                {SPEAKER_MODEL_LABELS[modelKey]}
              </button>
            );
          })}
        </div>
      </div>
    </>
  );

  // Full stat breakdown for a single event — shown in a modal when a row in
  // the live feed is clicked.
  const renderEventDetail = (r) => {
    const tone = r.decision === 'ACCEPT' ? 'var(--good)' : r.decision === 'DEEPFAKE' ? 'var(--bad)' : 'var(--warn)';
    const scores = r.speakerModelScores ?? [];
    const fusion = r.speakerFusion;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
          <div>
            <div className="label-mono" style={{ fontSize: 10, color: tone }}>{r.decision}</div>
            <div style={{ fontSize: 24, fontWeight: 300, marginTop: 2 }}>{r.userId}</div>
          </div>
          <div className="label-mono" style={{ fontSize: 10, color: 'var(--ink-soft)' }}>{new Date(r.createdAt).toLocaleString()}</div>
        </div>
        {r.message && <div style={{ fontSize: 13, color: 'var(--ink-mute)', lineHeight: 1.5 }}>{r.message}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
          <Metric label="Similarity" value={r.similarityScore.toFixed(3)} sub="cosine" trend={r.decision === 'ACCEPT' ? 'up' : 'flat'}/>
          <Metric label="Deepfake" value={r.deepfakeScore.toFixed(3)} sub="AASIST" trend={r.decision === 'DEEPFAKE' ? 'flat' : 'up'}/>
          <Metric label="Centroid" value={r.centroidSimilarity.toFixed(3)} sub="vs profile" trend="flat"/>
        </div>
        {scores.length > 0 && (
          <div style={{ display: 'grid', gap: 8 }}>
            <div className="label-mono" style={{ fontSize: 10 }}>PER-MODEL SCORES</div>
            {scores.map((score) => (
              <div key={score.modelKey} className="biovoice-model-score-row" style={{
                display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto auto', gap: 12, alignItems: 'center',
                padding: '10px 12px', borderRadius: 10,
                background: score.passedThreshold ? 'rgba(106,255,200,0.06)' : 'rgba(255,178,74,0.06)',
                border: `1px solid ${score.passedThreshold ? 'rgba(106,255,200,0.20)' : 'rgba(255,178,74,0.20)'}`,
              }}>
                <div>
                  <div style={{ fontSize: 13 }}>{SPEAKER_MODEL_LABELS[score.modelKey] ?? score.modelKey}</div>
                  <div className="label-mono" style={{ fontSize: 8, marginTop: 2, color: 'var(--ink-soft)' }}>
                    {score.passedThreshold ? 'MATCHED PROFILE' : 'BELOW THRESHOLD'}
                  </div>
                </div>
                <div className="num-mono" style={{ fontSize: 16, color: score.passedThreshold ? 'var(--good)' : 'var(--warn)' }}>
                  {score.similarityScore.toFixed(3)}
                </div>
                <div className="label-mono" style={{ fontSize: 8, color: 'var(--ink-soft)' }}>THR {score.threshold.toFixed(2)}</div>
              </div>
            ))}
          </div>
        )}
        {fusion && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
            <Metric label="Combined score" value={fusion.combinedSimilarityScore.toFixed(3)} sub={`${fusion.matchedModels}/${fusion.totalModels} matched`} trend={fusion.combinedMatch ? 'up' : 'flat'}/>
            <Metric label="Decision rule" value={`${fusion.majorityRequired}/${fusion.totalModels}`} sub={fusion.combinedMatch ? 'majority reached' : 'majority not reached'} trend={fusion.combinedMatch ? 'up' : 'flat'}/>
          </div>
        )}
        {r.sessionId && <div className="label-mono" style={{ fontSize: 9, color: 'var(--ink-soft)' }}>SESSION · {r.sessionId}</div>}
      </div>
    );
  };

  const activityBody = ({ onExpand } = {}) => (
    <>
      <div style={{ padding: '18px 22px', borderBottom: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="label-mono" style={{ fontSize: 10 }}>LIVE EVENT FEED</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <LivePulse size={8}/>
          {onExpand && <ExpandButton onClick={onExpand}/>}
        </span>
      </div>
      {/* G17 — `tabIndex={0}` lets keyboard users scroll the live
          event feed; without it, axe flags `scrollable-region-
          focusable` (Safari + WCAG 2.1.1). aria-label gives the
          feed a discoverable name in screen readers. */}
      <div
        style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}
        tabIndex={0}
        role="region"
        aria-label="Live event feed"
      >
        {activity.length === 0 ? (
          <div style={{ padding: '28px 22px', color: 'var(--ink-soft)', fontSize: 12, lineHeight: 1.6 }}>
            <div className="label-mono" style={{ fontSize: 9, color: 'var(--teal-2)', marginBottom: 8 }}>NO ACTIVITY YET</div>
            Verifications appear here as they happen.<br/>
            Press <kbd style={kbdStyle}>3</kbd> to open Profiles and enrol your first speaker.
          </div>
        ) : (
          activity.map((a, i) => (
            <ActivityRow
              key={a.id}
              {...a}
              fresh={i === 0}
              now={now}
              onSelect={() => setSelectedEvent(results.find((r) => r.resultId === a.id) ?? null)}
            />
          ))
        )}
      </div>
    </>
  );

  // Re-render a panel's content at the measured modal size.
  const renderLarge = (key, size) => {
    const w = size.width, h = size.height;
    switch (key) {
      case 'orb':
        return (
          <div style={{ position: 'relative', width: '100%', flex: 1, minHeight: 0, display: 'grid', placeItems: 'center' }}>
            {orbBody({ orbSize: Math.max(200, Math.min(w, h) - 80), waveWidth: Math.min(w - 24, 900), waveHeight: 72 })}
          </div>
        );
      case 'profiles':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
            {profilesBody()}
          </div>
        );
      case 'spectrogram':
        return spectrogramBody({ width: Math.max(320, w - 48), height: Math.max(240, h - 80) });
      case 'pipeline':
        return <div>{pipelineBody()}</div>;
      case 'constellation':
        return constellationBody({ width: Math.max(300, Math.min(w - 48, 820)), height: Math.max(260, h - 150) });
      case 'activity':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
            {activityBody()}
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="screen fade-enter">
      <Chrome status="OPERATIONAL · ALL MODELS HEALTHY" statusKind="good" subtitle="Operator console" screenName="CONSOLE"/>
      <AmbientField count={70}/>

      <div className="biovoice-page-content biovoice-console-grid" style={{ position: 'absolute', inset: 0, padding: '150px 56px 90px 124px', display: 'grid', gridTemplateColumns: 'minmax(320px, 400px) minmax(0, 1fr) minmax(360px, 540px)', gap: 24, zIndex: 2 }}>

        {/* ============ LEFT: Identity check ============ */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, minHeight: 0, minWidth: 0 }}>
          <PanelTitle eyebrow="01 · IDENTITY" title="Verify a speaker"/>

          {/* Mic visualizer */}
          <div className="panel outline-glow" style={{ position: 'relative', overflow: 'hidden', minHeight: 280, display: 'grid', placeItems: 'center', padding: 24 }}>
            {orbBody({ onExpand: () => setExpanded('orb') })}
          </div>

          {/* Profile picker */}
          <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            {profilesBody({ onExpand: () => setExpanded('profiles') })}
          </div>

          <button className="btn btn-primary" onClick={() => onVerify(profiles.find(p => p.id === selectedProfile))}
            style={{ width: '100%', justifyContent: 'center', padding: '18px', fontSize: 15 }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="3" fill="#04070d"/>
              <circle cx="8" cy="8" r="6.5" stroke="#04070d" strokeWidth="1.4" opacity="0.4"/>
            </svg>
            Run verification &nbsp;·&nbsp; V
          </button>
          <button className="btn btn-ghost" onClick={onEnroll} style={{ width: '100%', justifyContent: 'center', padding: '14px' }}>
            Enroll new profile · E
          </button>
        </div>

        {/* ============ MIDDLE: Live signal ============ */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, minHeight: 0, minWidth: 0 }}>
          <PanelTitle eyebrow="02 · LIVE SIGNAL" title="Room audio · real time"/>

          {/* Big spectrogram — grows to fill the column */}
          <div className="panel outline-glow" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, padding: 22, overflow: 'hidden' }}>
            {spectrogramBody({ onExpand: () => setExpanded('spectrogram'), width: spectrogramWidth, height: spectrogramHeight, wrapRef: spectrogramRef })}
          </div>

          {/* Pipeline mini-viz with particles */}
          <div className="panel" style={{ padding: '18px 20px', minWidth: 0, overflow: 'hidden' }}>
            {pipelineBody({ onExpand: () => setExpanded('pipeline') })}
          </div>
        </div>

        {/* ============ RIGHT: Activity ============ */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minHeight: 0, minWidth: 0 }}>
          <PanelTitle eyebrow="03 · EMBEDDING SPACE" title="Voice fingerprints · 192-D"/>

          {/* Embedding Constellation — the showpiece; takes the lion's share */}
          <div className="panel outline-glow" style={{ flex: 2, minHeight: 240, display: 'flex', flexDirection: 'column', padding: '18px 18px 14px', position: 'relative', overflow: 'hidden' }}>
            {constellationBody({ onExpand: () => setExpanded('constellation'), width: constellationWidth, height: constellationHeight, wrapRef: constellationRef })}
          </div>

          {/* Activity feed — scrollable; click a row for the full breakdown */}
          <div className="panel" style={{ flex: 1, minHeight: 140, display: 'flex', flexDirection: 'column', padding: 0 }}>
            {activityBody({ onExpand: () => setExpanded('activity') })}
          </div>

          {/* Hint */}
          <div className="biovoice-console-hint" style={{
            padding: '14px 18px', borderRadius: 12,
            background: 'rgba(126,240,255,0.05)',
            border: '1px solid rgba(126,240,255,0.18)',
            fontSize: 12, color: 'var(--ink-mute)',
            display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <kbd style={kbdStyle}>V</kbd>
            <span>verify</span>
            <kbd style={kbdStyle}>E</kbd>
            <span>enroll</span>
            <kbd style={kbdStyle}>S</kbd>
            <span>settings</span>
          </div>
        </div>
      </div>

      {expanded && (
        <PanelModal title={PANEL_TITLES[expanded]} onClose={() => setExpanded(null)}>
          {(size) => renderLarge(expanded, size)}
        </PanelModal>
      )}

      {selectedEvent && (
        <PanelModal title="VERIFICATION DETAIL" onClose={() => setSelectedEvent(null)}>
          {() => renderEventDetail(selectedEvent)}
        </PanelModal>
      )}
    </div>
  );
}

const kbdStyle = {
  fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
  padding: '3px 8px', borderRadius: 4,
  background: 'rgba(125,200,255,0.10)',
  border: '1px solid rgba(125,200,255,0.25)',
  color: 'var(--ink)',
};

function PanelTitle({ eyebrow, title }) {
  return (
    <div>
      <div className="label-mono" style={{ fontSize: 10, color: 'var(--teal-2)' }}>{eyebrow}</div>
      <div style={{ fontSize: 22, fontWeight: 300, marginTop: 4 }}>{title}</div>
    </div>
  );
}

function Metric({ label, value, sub, trend }) {
  return (
    <div className="panel" style={{ padding: '12px 14px', minWidth: 0, overflow: 'hidden' }}>
      <div className="label-mono" style={{ fontSize: 9, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 4, gap: 4 }}>
        <span className="num-mono" style={{ fontSize: 18, color: 'var(--ink)', whiteSpace: 'nowrap' }}>{value}</span>
        <span style={{ fontSize: 10, color: trend === 'up' ? 'var(--good)' : 'var(--ink-soft)' }}>
          {trend === 'up' ? '▲' : '◆'}
        </span>
      </div>
      <div className="label-mono" style={{ fontSize: 8, color: 'var(--ink-soft)', marginTop: 2, whiteSpace: 'nowrap' }}>{sub}</div>
    </div>
  );
}

function ActivityRow({ id, kind, name, score, ago, fresh, now, ts, onSelect }) {
  const colors = {
    accept: { tag: 'var(--good)', bg: 'rgba(106,255,200,0.06)' },
    reject: { tag: 'var(--warn)', bg: 'rgba(255,178,74,0.06)' },
    deepfake: { tag: 'var(--bad)', bg: 'rgba(255,85,119,0.06)' },
    enroll: { tag: 'var(--teal-2)', bg: 'rgba(126,240,255,0.06)' },
  };
  const palette = colors[kind] || colors.accept;
  const labels = {
    accept: 'VERIFIED',
    reject: 'REJECTED',
    deepfake: 'DEEPFAKE BLOCKED',
    enroll: 'ENROLLED',
  };
  const elapsed = Math.floor((now - ts) / 1000);
  return (
    <div
      onClick={onSelect}
      onKeyDown={onSelect ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } } : undefined}
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
      title={onSelect ? 'View full stats' : undefined}
      style={{
      padding: '14px 22px', display: 'flex', alignItems: 'center', gap: 14,
      borderBottom: '1px solid var(--line)',
      background: fresh ? palette.bg : 'transparent',
      animation: fresh ? 'fadeIn 600ms ease both' : 'none',
      cursor: onSelect ? 'pointer' : 'default',
    }}>
      <div style={{
        width: 8, height: 8, borderRadius: '50%',
        background: palette.tag,
        boxShadow: fresh ? `0 0 12px ${palette.tag}` : 'none',
      }}></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="label-mono" style={{ fontSize: 9, color: palette.tag }}>{labels[kind]}</div>
        <div style={{ fontSize: 14, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {name}
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div className="num-mono" style={{ fontSize: 13, color: palette.tag }}>{score}</div>
        <div className="label-mono" style={{ fontSize: 9, color: 'var(--ink-soft)' }}>{elapsed < 60 ? `${elapsed}s ago` : `${Math.floor(elapsed/60)}m ago`}</div>
      </div>
    </div>
  );
}

// Map a live VerificationResult into the activity-row shape the renderer expects.
// Decision → kind: ACCEPT → 'accept', REJECT → 'reject', DEEPFAKE → 'deepfake'.
// `enroll` activity kind is intentionally not surfaced — /results is verify-only.
function resultToActivity(result) {
  const kind =
    result.decision === 'ACCEPT' ? 'accept' :
    result.decision === 'DEEPFAKE' ? 'deepfake' : 'reject';
  const scoreNum = result.decision === 'DEEPFAKE' ? result.deepfakeScore : result.similarityScore;
  return {
    id: result.resultId,
    kind,
    name: result.userId,
    score: scoreNum.toFixed(3).replace(/^0?\./, '0.'),
    ts: new Date(result.createdAt).getTime(),
  };
}

export {
  ConsoleScreen, SettingsPanel, ParticleFlow, useCounter,
};
