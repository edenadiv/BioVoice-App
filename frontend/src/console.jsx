// Console / Operations dashboard — the default view for cyber experts.
// Plus settings panel and animation utilities.

import { Fragment, useEffect, useRef, useState, useMemo, useCallback } from "react";
import { AmbientField, EmbeddingConstellation, LiveFeatures } from "./console-ext.jsx";
import { LivePulse, MelSpectrogram, VoiceOrb, Waveform } from "./visuals.jsx";
import { Chrome } from "./screens.jsx";

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
      <div style={{
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
            <span style={{ color: 'var(--good)' }}>granted</span>
          </div>
        </Section>

        <Section label="Models" sub="Loaded inference graphs.">
          {[
            ['ReDimNet-B5', '0.79% EER · 9.1 M params · loaded', 'good'],
            ['AASIST', 'Anti-spoofing · loaded', 'good'],
            ['TCAV STAGE-4', 'Explainability · on-demand', 'good'],
            ['F5-TTS (test rig)', 'Synthetic generator · staged', 'warn'],
          ].map(([n, s, k]) => (
            <div key={n} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderTop: '1px solid var(--line)' }}>
              <div>
                <div style={{ fontSize: 13 }}>{n}</div>
                <div className="label-mono" style={{ fontSize: 9, color: 'var(--ink-soft)', marginTop: 2 }}>{s}</div>
              </div>
              <span className={`pill ${k}`}><span className="dot"></span>{k === 'good' ? 'READY' : 'STANDBY'}</span>
            </div>
          ))}
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
// ConsoleScreen — the default expert dashboard.
// ============================================================================
function ConsoleScreen({
  audio,
  micState,
  micStart,
  profiles,
  activity,
  onVerify,
  onEnroll,
  onShowDetails,
  threatCount,
  verifyCount,
  homeState,
  homeError,
}) {
  const [selectedProfile, setSelectedProfile] = useState(profiles[0]?.id);
  const [hoverProfile, setHoverProfile] = useState(null);
  const [mockActivity, setMockActivity] = useState(() => seedActivity());
  const [now, setNow] = useState(Date.now());
  const liveActivity = Array.isArray(activity);

  // Tick clock + occasionally inject new activity for liveness
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (profiles.length === 0) {
      return;
    }
    if (!selectedProfile || !profiles.some((profile) => profile.id === selectedProfile)) {
      setSelectedProfile(profiles[0].id);
    }
  }, [profiles, selectedProfile]);
  useEffect(() => {
    if (liveActivity) {
      return;
    }
    const id = setInterval(() => {
      setMockActivity(a => [makeRandomActivity(), ...a].slice(0, 8));
    }, 6500);
    return () => clearInterval(id);
  }, [liveActivity]);

  const acceptedCount = useCounter(verifyCount, 1400, [verifyCount]);
  const blockedCount = useCounter(threatCount, 1400, [threatCount]);
  const profilesCount = useCounter(profiles.length, 1000, [profiles.length]);
  const feed = liveActivity ? activity : mockActivity;
  const showLiveNotice = homeState === 'loading' || homeState === 'error';

  return (
    <div className="screen fade-enter">
      <Chrome status="OPERATIONAL · ALL MODELS HEALTHY" statusKind="good" subtitle="Operator console" screenName="CONSOLE"/>
      <AmbientField count={70}/>

      <div style={{ position: 'absolute', inset: 0, padding: '150px 56px 90px 124px', display: 'grid', gridTemplateColumns: 'minmax(0, 400px) minmax(0, 1fr) minmax(0, 460px)', gap: 24, zIndex: 2 }}>

        {/* ============ LEFT: Identity check ============ */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, minHeight: 0, minWidth: 0 }}>
          <PanelTitle eyebrow="01 · IDENTITY" title="Verify a speaker"/>

          {/* Mic visualizer */}
          <div className="panel outline-glow" style={{ position: 'relative', overflow: 'hidden', minHeight: 280, display: 'grid', placeItems: 'center', padding: 24 }}>
            <VoiceOrb size={260} samples={audio.samples} level={audio.level} hue="cyan" intensity={1.1}/>
            <div style={{ position: 'absolute', top: 16, left: 16, right: 16, display: 'flex', justifyContent: 'space-between' }}>
              <span className={`pill ${micState === 'live' ? 'good' : 'warn'}`}>
                <span className="dot"></span>
                {micState === 'live' ? 'LIVE MIC' : 'STANDBY MIC'}
              </span>
              <span className="num-mono" style={{ fontSize: 11, color: 'var(--ink-soft)' }}>16 KHZ</span>
            </div>
            <div style={{ position: 'absolute', bottom: 12, left: 12, right: 12 }}>
              <Waveform samples={audio.samples} width={352} height={48} bars={80} mirror={true}/>
            </div>
          </div>

          {/* Profile picker */}
          <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
              <span className="label-mono" style={{ fontSize: 10 }}>ENROLLED PROFILE · CHOOSE ONE</span>
              <span className="num-mono" style={{ fontSize: 10, color: 'var(--ink-soft)' }}>{profiles.length} ACTIVE</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto', flex: 1 }}>
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
          </div>

          <button className="btn btn-primary" onClick={() => onVerify(profiles.find(p => p.id === selectedProfile))}
            disabled={profiles.length === 0}
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

          {/* Big spectrogram */}
          <div className="panel outline-glow" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, padding: 22, overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14 }}>
              <div>
                <div className="label-mono" style={{ fontSize: 10 }}>MEL-SPECTROGRAM · STREAMING</div>
                <div style={{ fontSize: 19, marginTop: 4 }}>How the AI <em className="serif" style={{ color: 'var(--teal-2)' }}>sees</em> the room</div>
              </div>
              <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
                <span className="label-mono" style={{ fontSize: 9, color: 'var(--ink-soft)' }}>80 BANDS · 20–8 K HZ</span>
                <LivePulse size={8}/>
              </div>
            </div>
            <div style={{ flex: 1, display: 'grid', placeItems: 'center', position: 'relative', minHeight: 280 }}>
              <MelSpectrogram freqs={audio.freqs} width={820} height={300} mels={80}/>
              <div style={{
                position: 'absolute', left: 8, top: 8, bottom: 8, width: 36,
                display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                fontFamily: 'JetBrains Mono, monospace', fontSize: 9, color: 'var(--ink-soft)',
              }}>
                <span>8 kHz</span><span>4 kHz</span><span>2 kHz</span><span>500</span><span>20 Hz</span>
              </div>
            </div>
          </div>

          {/* Pipeline mini-viz with particles */}
          <div className="panel" style={{ padding: '18px 20px', minWidth: 0, overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
              <span className="label-mono" style={{ fontSize: 10 }}>INFERENCE PIPELINE · IDLE</span>
              <span className="num-mono" style={{ fontSize: 10, color: 'var(--good)' }}>READY</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              {[
                { label: 'Capture', sub: 'PCM' },
                { label: 'Mel-Spec', sub: '80 ch' },
                { label: 'ReDimNet', sub: '192 d' },
                { label: 'AASIST', sub: 'auth' },
                { label: 'Decision', sub: 'A / R' },
              ].map((s, i, arr) => (
                <Fragment key={i}>
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
                </Fragment>
              ))}
            </div>
          </div>

          {/* Live extracted voice features */}
          <div className="panel" style={{ padding: '16px 20px', minWidth: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
              <span className="label-mono" style={{ fontSize: 10 }}>EXTRACTED VOICE FEATURES · LIVE</span>
              <span className="label-mono" style={{ fontSize: 9, color: 'var(--ink-soft)' }}>16 KHZ · 25MS WIN · 10MS HOP</span>
            </div>
            <LiveFeatures freqs={audio.freqs} samples={audio.samples} level={audio.level}/>
          </div>

          {/* Health bar */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
            <Metric label="GPU latency" value="11ms" sub="p50" trend="flat"/>
            <Metric label="Inference" value="62/s" sub="rolling" trend="up"/>
            <Metric label="Profiles" value={profilesCount.toFixed(0)} sub="enrolled" trend="up"/>
            <Metric label="Uptime" value="14 d" sub="continuous" trend="flat"/>
          </div>
        </div>

        {/* ============ RIGHT: Activity ============ */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minHeight: 0, minWidth: 0 }}>
          <PanelTitle eyebrow="03 · EMBEDDING SPACE" title="Voice fingerprints · 192-D"/>

          {/* Embedding Constellation — the showpiece */}
          <div className="panel outline-glow" style={{ padding: '18px 18px 14px', position: 'relative', overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
              <span className="label-mono" style={{ fontSize: 10 }}>VOICE EMBEDDING SPACE</span>
              <span className="label-mono" style={{ fontSize: 9, color: 'var(--teal-2)' }}>● LIVE</span>
            </div>
            <div style={{ display: 'grid', placeItems: 'center' }}>
              <EmbeddingConstellation width={420} height={300} profiles={profiles} audioLevel={audio.level} matchId={selectedProfile}/>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, paddingTop: 10, borderTop: '1px solid var(--line)' }}>
              <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#bff4ff', boxShadow: '0 0 8px #7ef0ff' }}></span>
                  <span className="label-mono" style={{ fontSize: 9 }}>LIVE VOICE</span>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#3da9fc' }}></span>
                  <span className="label-mono" style={{ fontSize: 9 }}>{profiles.length} ENROLLED</span>
                </span>
              </div>
              <span className="label-mono" style={{ fontSize: 9, color: 'var(--ink-soft)' }}>UMAP · COS DIST</span>
            </div>
          </div>

          {/* Compact counters */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="panel" style={{ padding: '14px 18px' }}>
              <div className="label-mono" style={{ fontSize: 9 }}>VERIFIED TODAY</div>
              <div className="num-mono" style={{ fontSize: 30, fontWeight: 200, color: 'var(--teal-2)', lineHeight: 1, marginTop: 6, letterSpacing: '-0.02em' }}>
                {Math.floor(acceptedCount).toLocaleString()}
              </div>
              <div className="label-mono" style={{ fontSize: 8, color: 'var(--good)', marginTop: 2 }}>+12% VS YESTERDAY</div>
            </div>
            <div className="panel" style={{ padding: '14px 18px', border: '1px solid rgba(255,85,119,0.25)', boxShadow: '0 0 30px rgba(255,85,119,0.06)' }}>
              <div className="label-mono" style={{ fontSize: 9 }}>DEEPFAKES BLOCKED</div>
              <div className="num-mono" style={{ fontSize: 30, fontWeight: 200, color: 'var(--bad)', lineHeight: 1, marginTop: 6, letterSpacing: '-0.02em' }}>
                {Math.floor(blockedCount).toLocaleString()}
              </div>
              <div className="label-mono" style={{ fontSize: 8, color: 'var(--bad)', marginTop: 2 }}>3 IN LAST HOUR</div>
            </div>
          </div>

          {/* Activity feed */}
          <div className="panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, padding: 0 }}>
            <div style={{ padding: '18px 22px', borderBottom: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="label-mono" style={{ fontSize: 10 }}>LIVE EVENT FEED</span>
              <LivePulse size={8}/>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
              {feed.length === 0 ? (
                <div style={{ padding: '20px 22px', color: 'var(--ink-soft)', fontSize: 13 }}>
                  No verification activity yet.
                </div>
              ) : (
                feed.map((a, i) => (
                  <ActivityRow key={a.id} {...a} fresh={i === 0} now={now}/>
                ))
              )}
            </div>
          </div>

          {/* Hint */}
          <div style={{
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

function ActivityRow({ id, kind, name, score, ago, fresh, now, ts }) {
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
    <div style={{
      padding: '14px 22px', display: 'flex', alignItems: 'center', gap: 14,
      borderBottom: '1px solid var(--line)',
      background: fresh ? palette.bg : 'transparent',
      animation: fresh ? 'fadeIn 600ms ease both' : 'none',
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

function makeRandomActivity() {
  const r = Math.random();
  const names = ['Eden Adiv', 'Idan Shavit', 'Yoav Zucker', 'Maya Levi', 'Ori Cohen', 'Tal Bergman', 'Noa Friedman', 'Shai Mor'];
  const name = names[Math.floor(Math.random() * names.length)];
  if (r < 0.55) return { id: Math.random(), kind: 'accept', name, score: '0.' + (88 + Math.floor(Math.random()*10)), ts: Date.now() };
  if (r < 0.7)  return { id: Math.random(), kind: 'reject', name, score: '0.' + (40 + Math.floor(Math.random()*30)), ts: Date.now() };
  if (r < 0.85) return { id: Math.random(), kind: 'deepfake', name: name + ' · cloned', score: '0.' + (10 + Math.floor(Math.random()*20)), ts: Date.now() };
  return { id: Math.random(), kind: 'enroll', name, score: 'new', ts: Date.now() };
}

function seedActivity() {
  const now = Date.now();
  return [
    { id: 1, kind: 'accept', name: 'Eden Adiv',    score: '0.913', ts: now - 12_000 },
    { id: 2, kind: 'deepfake', name: 'Yoav Z. · cloned', score: '0.18', ts: now - 38_000 },
    { id: 3, kind: 'accept', name: 'Idan Shavit',  score: '0.892', ts: now - 71_000 },
    { id: 4, kind: 'accept', name: 'Maya Levi',    score: '0.876', ts: now - 124_000 },
    { id: 5, kind: 'reject', name: 'Unknown speaker', score: '0.612', ts: now - 188_000 },
    { id: 6, kind: 'enroll', name: 'Tal Bergman',  score: 'new',   ts: now - 240_000 },
    { id: 7, kind: 'accept', name: 'Ori Cohen',    score: '0.901', ts: now - 312_000 },
    { id: 8, kind: 'deepfake', name: 'Eden A. · cloned', score: '0.22', ts: now - 401_000 },
  ];
}

export {
  ConsoleScreen,
  SettingsPanel,
  ParticleFlow,
  useCounter,
  PanelTitle,
  Metric,
  ActivityRow,
  makeRandomActivity,
  seedActivity,
};
