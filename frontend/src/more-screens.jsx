// Additional pages: Sidebar nav, Deepfake Creation Lab, User Settings, Profile manager.

import React, { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { LivePulse, Waveform } from "./visuals.jsx";
import { AmbientField } from "./console-ext.jsx";
import { Chrome } from "./screens.jsx";
import { useVoiceRecorder } from "./lib/audio";
import { enrollSpeaker, getAvailability, listSpeakers } from "./lib/api";
import { useAppDispatch, useAppState } from "./lib/session";

const ENROLLMENT_TARGET = 3;
const USER_ID_PATTERN = /^[a-zA-Z0-9_\-\.]{3,32}$/;

// ============================================================================
// Sidebar — real-app navigation rail.
// ============================================================================
function Sidebar({ page, setPage }) {
  const items = [
    { id: 'console',  label: 'Console',   icon: <path d="M2 4h16M2 9h16M2 14h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/> },
    { id: 'lab',      label: 'DF Lab',    icon: <><circle cx="10" cy="10" r="6" stroke="currentColor" strokeWidth="1.5"/><path d="M6 10h8M10 6v8" stroke="currentColor" strokeWidth="1.5"/></> },
    { id: 'profiles', label: 'Profiles',  icon: <><circle cx="10" cy="7" r="3" stroke="currentColor" strokeWidth="1.5"/><path d="M3 17c0-3.3 3.1-6 7-6s7 2.7 7 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></> },
    { id: 'settings', label: 'Settings',  icon: <><circle cx="10" cy="10" r="2.4" stroke="currentColor" strokeWidth="1.5"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4 4l1.4 1.4M14.6 14.6L16 16M4 16l1.4-1.4M14.6 5.4L16 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></> },
  ];
  return (
    <div style={{
      position: 'absolute', top: 110, left: 24, bottom: 80, width: 76, zIndex: 50,
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
      padding: '14px 0',
      borderRadius: 18,
      background: 'linear-gradient(180deg, rgba(10,20,34,0.7), rgba(10,20,34,0.4))',
      border: '1px solid rgba(125,200,255,0.10)',
      backdropFilter: 'blur(14px)',
    }}>
      {items.map(it => {
        const active = page === it.id;
        return (
          <button key={it.id} onClick={() => setPage(it.id)} title={it.label}
            style={{
              width: 56, height: 56, borderRadius: 14, cursor: 'pointer',
              background: active ? 'linear-gradient(135deg, rgba(126,240,255,0.18), rgba(61,169,252,0.06))' : 'transparent',
              border: active ? '1px solid rgba(126,240,255,0.45)' : '1px solid transparent',
              color: active ? '#7ef0ff' : 'var(--ink-mute)',
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3,
              transition: 'all 240ms cubic-bezier(.2,.8,.2,1)',
              position: 'relative',
            }}
            onMouseEnter={e => !active && (e.currentTarget.style.background = 'rgba(125,200,255,0.06)')}
            onMouseLeave={e => !active && (e.currentTarget.style.background = 'transparent')}
          >
            {active && <span style={{ position: 'absolute', left: -16, top: 12, bottom: 12, width: 2, background: '#7ef0ff', boxShadow: '0 0 10px #7ef0ff', borderRadius: 2 }}></span>}
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">{it.icon}</svg>
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 8, letterSpacing: '0.16em', textTransform: 'uppercase' }}>{it.label}</span>
          </button>
        );
      })}
      <div style={{ flex: 1 }}></div>
      {/* Avatar at the bottom */}
      <div style={{
        width: 44, height: 44, borderRadius: '50%',
        background: 'linear-gradient(135deg, #7ef0ff, #3da9fc)',
        display: 'grid', placeItems: 'center', color: '#04070d',
        fontWeight: 600, fontSize: 14, cursor: 'pointer',
        boxShadow: '0 0 0 2px rgba(126,240,255,0.3), 0 0 16px rgba(126,240,255,0.25)',
      }}>OP</div>
    </div>
  );
}

// ============================================================================
// DeepfakeLab — interactive deepfake creation/detection demo.
// ============================================================================
function DeepfakeLab({ audio, profiles }) {
  const [target, setTarget] = useState(profiles[0].id);
  const [text, setText] = useState("Authorize transfer of two million dollars.");
  const [model, setModel] = useState('clone-v3');
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState(null);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState(0); // 0 idle, 1 cloning, 2 synthesizing, 3 detecting, 4 done

  const targetProfile = profiles.find(p => p.id === target) || profiles[0];

  const generate = () => {
    setGenerating(true); setResult(null); setProgress(0); setStage(1);
    const stages = [
      { ms: 1400, next: 2 },
      { ms: 1600, next: 3 },
      { ms: 1400, next: 4 },
    ];
    let i = 0;
    const startedAt = performance.now();
    let raf;
    const totalMs = stages.reduce((a, b) => a + b.ms, 0);
    const tick = (now) => {
      const el = now - startedAt;
      setProgress(Math.min(1, el / totalMs));
      let cum = 0; let s = 1;
      for (const st of stages) { cum += st.ms; if (el < cum) break; s = st.next; }
      setStage(s);
      if (el >= totalMs) {
        setGenerating(false);
        setResult({
          dfScore: 0.04 + Math.random() * 0.06,
          confidence: 0.96 + Math.random() * 0.03,
          model,
          time: (totalMs / 1000).toFixed(2),
          artifacts: [
            { name: 'Spectral discontinuities', strength: 0.81 + Math.random() * 0.1 },
            { name: 'Phase coherence loss', strength: 0.74 + Math.random() * 0.1 },
            { name: 'Vocoder fingerprint', strength: 0.91 + Math.random() * 0.05 },
            { name: 'Micro-prosody drift', strength: 0.62 + Math.random() * 0.15 },
          ],
        });
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  };

  const stages = [
    { label: 'Cloning voice timbre', sub: 'XTTS-v3 embedding from 6s reference' },
    { label: 'Synthesizing speech', sub: 'Neural vocoder · 24 kHz waveform' },
    { label: 'Running BioVoice detector', sub: 'AASIST anti-spoof · 192-d fingerprint' },
  ];

  return (
    <div className="screen fade-enter">
      <Chrome status="DEEPFAKE LABORATORY · ETHICAL USE ONLY" statusKind="warn" subtitle="Adversarial testing" screenName="DF LAB"/>
      <AmbientField count={50}/>

      <div style={{ position: 'absolute', inset: 0, padding: '150px 56px 90px 124px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 28, zIndex: 2 }}>

        {/* LEFT: Forge */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0, minHeight: 0 }}>
          <div>
            <div className="label-mono" style={{ fontSize: 10, color: 'var(--warn)' }}>RED-TEAM · FORGE</div>
            <div style={{ fontSize: 30, fontWeight: 200, marginTop: 4 }}>Create a deepfake</div>
            <div style={{ fontSize: 14, color: 'var(--ink-mute)', marginTop: 6, maxWidth: 540 }}>
              Try to clone an enrolled voice and use it to authenticate. BioVoice catches the fakes — even ones a human ear can't distinguish.
            </div>
          </div>

          <div className="panel" style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 18 }}>
            <Field label="TARGET VOICE">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                {profiles.slice(0, 6).map(p => (
                  <button key={p.id} onClick={() => setTarget(p.id)} className="lift"
                    style={{
                      padding: '10px 10px', borderRadius: 10, cursor: 'pointer',
                      background: target === p.id ? 'rgba(255,178,74,0.10)' : 'rgba(125,200,255,0.03)',
                      border: target === p.id ? '1px solid rgba(255,178,74,0.55)' : '1px solid var(--line)',
                      color: 'var(--ink)', textAlign: 'left',
                      display: 'flex', alignItems: 'center', gap: 8,
                      transition: 'all 200ms',
                    }}>
                    <div style={{
                      width: 26, height: 26, borderRadius: '50%',
                      background: `linear-gradient(135deg, ${p.color1}, ${p.color2})`,
                      display: 'grid', placeItems: 'center', color: '#04070d', fontWeight: 600, fontSize: 10,
                    }}>{p.initials}</div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</div>
                      <div className="label-mono" style={{ fontSize: 8 }}>{p.id}</div>
                    </div>
                  </button>
                ))}
              </div>
            </Field>

            <Field label="UTTERANCE TO SYNTHESIZE">
              <textarea value={text} onChange={e => setText(e.target.value)} rows={2}
                style={{
                  width: '100%', resize: 'none',
                  background: 'rgba(125,200,255,0.04)',
                  border: '1px solid var(--line-2)',
                  borderRadius: 10, color: 'var(--ink)',
                  padding: '12px 14px',
                  fontFamily: 'Sora, sans-serif', fontSize: 14,
                  outline: 'none',
                }}/>
            </Field>

            <Field label="ATTACK MODEL">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                {[
                  { id: 'clone-v3', label: 'Voice clone', sub: 'XTTS-v3' },
                  { id: 'replay',   label: 'Replay', sub: 'Recorded attack' },
                  { id: 'splice',   label: 'Splice', sub: 'Concatenative' },
                ].map(m => (
                  <button key={m.id} onClick={() => setModel(m.id)} className="lift"
                    style={{
                      padding: '10px 12px', borderRadius: 10, cursor: 'pointer',
                      background: model === m.id ? 'rgba(255,178,74,0.10)' : 'rgba(125,200,255,0.03)',
                      border: model === m.id ? '1px solid rgba(255,178,74,0.5)' : '1px solid var(--line)',
                      color: 'var(--ink)', textAlign: 'left',
                      transition: 'all 200ms',
                    }}>
                    <div style={{ fontSize: 12 }}>{m.label}</div>
                    <div className="label-mono" style={{ fontSize: 8, marginTop: 2 }}>{m.sub}</div>
                  </button>
                ))}
              </div>
            </Field>

            <button onClick={generate} disabled={generating} className="btn btn-primary"
              style={{ width: '100%', justifyContent: 'center', padding: '16px', fontSize: 14,
                opacity: generating ? 0.7 : 1, cursor: generating ? 'wait' : 'pointer' }}>
              {generating ? `Generating · ${(progress * 100).toFixed(0)}%` : <>⚡  Forge & test attack</>}
            </button>
          </div>
        </div>

        {/* RIGHT: Outcome */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0, minHeight: 0 }}>
          <div>
            <div className="label-mono" style={{ fontSize: 10, color: 'var(--teal-2)' }}>BLUE-TEAM · DETECTOR</div>
            <div style={{ fontSize: 30, fontWeight: 200, marginTop: 4 }}>BioVoice response</div>
          </div>

          {/* Pipeline */}
          <div className="panel" style={{ padding: 20 }}>
            <div className="label-mono" style={{ fontSize: 10, marginBottom: 14 }}>ATTACK PIPELINE</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {stages.map((s, i) => {
                const active = stage === i + 1;
                const done = stage > i + 1 || (!generating && stage > 0);
                const pending = stage < i + 1 && !done;
                const color = done ? '#6affc8' : (active ? '#ffb24a' : 'rgba(125,200,255,0.25)');
                return (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '10px 12px', borderRadius: 8,
                    background: active ? 'rgba(255,178,74,0.06)' : 'transparent',
                    border: '1px solid ' + (active ? 'rgba(255,178,74,0.35)' : 'transparent'),
                    transition: 'all 240ms',
                    opacity: pending ? 0.4 : 1,
                  }}>
                    <div style={{
                      width: 24, height: 24, borderRadius: '50%',
                      border: `1.5px solid ${color}`,
                      display: 'grid', placeItems: 'center', flexShrink: 0,
                      background: done ? `radial-gradient(circle, rgba(106,255,200,0.4), transparent)` : 'transparent',
                      color, fontSize: 11, fontWeight: 700,
                      animation: active ? 'breathe 1.2s ease-in-out infinite' : 'none',
                    }}>{done ? '✓' : i + 1}</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, color: pending ? 'var(--ink-soft)' : 'var(--ink)' }}>{s.label}</div>
                      <div className="label-mono" style={{ fontSize: 9 }}>{s.sub}</div>
                    </div>
                    {active && <LivePulse size={6} color="#ffb24a"/>}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Verdict */}
          <div className="panel outline-glow" style={{ padding: 24, flex: 1, display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 }}>
            {!result && !generating && (
              <div style={{ display: 'grid', placeItems: 'center', flex: 1, color: 'var(--ink-soft)', textAlign: 'center', padding: 24 }}>
                <div>
                  <div style={{ fontSize: 48, opacity: 0.3, marginBottom: 12 }}>◌</div>
                  <div style={{ fontSize: 14 }}>Run an attack to see how BioVoice catches it.</div>
                  <div className="label-mono" style={{ fontSize: 9, marginTop: 6 }}>WAITING</div>
                </div>
              </div>
            )}
            {generating && (
              <div style={{ display: 'grid', placeItems: 'center', flex: 1, padding: 30 }}>
                <ScanRings/>
              </div>
            )}
            {result && (
              <div style={{ animation: 'fadeIn 600ms ease both' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
                  <div style={{
                    padding: '6px 14px', borderRadius: 999,
                    border: '1px solid rgba(255,85,119,0.5)',
                    background: 'rgba(255,85,119,0.10)',
                    color: '#ff5577', fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 11, letterSpacing: '0.2em', fontWeight: 600,
                  }}>⚠  DEEPFAKE DETECTED</div>
                  <div className="label-mono" style={{ fontSize: 9 }}>BLOCKED IN {result.time}s</div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
                  <div style={{ padding: 14, borderRadius: 10, background: 'rgba(255,85,119,0.06)', border: '1px solid rgba(255,85,119,0.2)' }}>
                    <div className="label-mono" style={{ fontSize: 9 }}>AUTHENTICITY</div>
                    <div className="num-mono" style={{ fontSize: 30, color: '#ff5577', marginTop: 4, fontWeight: 200 }}>{result.dfScore.toFixed(2)}</div>
                    <div className="label-mono" style={{ fontSize: 8, marginTop: 2, color: 'var(--bad)' }}>BELOW 0.50 · SYNTHETIC</div>
                  </div>
                  <div style={{ padding: 14, borderRadius: 10, background: 'rgba(126,240,255,0.06)', border: '1px solid rgba(126,240,255,0.2)' }}>
                    <div className="label-mono" style={{ fontSize: 9 }}>DETECTOR CONFIDENCE</div>
                    <div className="num-mono" style={{ fontSize: 30, color: '#7ef0ff', marginTop: 4, fontWeight: 200 }}>{(result.confidence * 100).toFixed(1)}%</div>
                    <div className="label-mono" style={{ fontSize: 8, marginTop: 2, color: 'var(--good)' }}>HIGH CONFIDENCE</div>
                  </div>
                </div>
                <div className="label-mono" style={{ fontSize: 9, marginBottom: 8 }}>FORENSIC ARTIFACTS DETECTED</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {result.artifacts.map((a, i) => (
                    <ArtifactBar key={i} {...a} delay={i * 120}/>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ArtifactBar({ name, strength, delay = 0 }) {
  const [w, setW] = useState(0);
  useEffect(() => {
    const id = setTimeout(() => setW(strength), delay + 60);
    return () => clearTimeout(id);
  }, [strength, delay]);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 60px', alignItems: 'center', gap: 10 }}>
      <div>
        <div style={{ fontSize: 12 }}>{name}</div>
        <div style={{ height: 6, background: 'rgba(125,200,255,0.06)', borderRadius: 3, overflow: 'hidden', marginTop: 4 }}>
          <div style={{
            height: '100%', width: `${w * 100}%`,
            background: 'linear-gradient(90deg, rgba(255,178,74,0.5), #ff5577)',
            boxShadow: '0 0 10px rgba(255,85,119,0.5)',
            transition: 'width 700ms cubic-bezier(.2,.8,.2,1)',
            borderRadius: 3,
          }}></div>
        </div>
      </div>
      <span className="num-mono" style={{ fontSize: 13, color: '#ff7aa8', textAlign: 'right' }}>{(strength * 100).toFixed(0)}%</span>
    </div>
  );
}

function ScanRings() {
  return (
    <div style={{ position: 'relative', width: 160, height: 160, display: 'grid', placeItems: 'center' }}>
      {[0, 1, 2].map(i => (
        <div key={i} style={{
          position: 'absolute', inset: 0, borderRadius: '50%',
          border: '1px solid #ffb24a',
          animation: `scanring 2s ${i * 0.6}s ease-out infinite`,
          opacity: 0,
        }}></div>
      ))}
      <div style={{ width: 60, height: 60, borderRadius: '50%', background: 'radial-gradient(circle, #ffb24a, transparent)', filter: 'blur(8px)' }}></div>
      <div style={{ position: 'absolute', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, letterSpacing: '0.2em', color: '#ffb24a' }}>ANALYZING</div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <div className="label-mono" style={{ fontSize: 9, marginBottom: 8 }}>{label}</div>
      {children}
    </div>
  );
}

// ============================================================================
// UserSettingsPage — comprehensive in-app settings (not the demo-mode panel).
// ============================================================================
function UserSettingsPage({ settings, setSettings }) {
  const update = (k, v) => setSettings(s => ({ ...s, [k]: v }));
  return (
    <div className="screen fade-enter">
      <Chrome status="OPERATIONAL · ALL MODELS HEALTHY" statusKind="good" subtitle="Application preferences" screenName="SETTINGS"/>
      <AmbientField count={40}/>

      <div style={{ position: 'absolute', inset: 0, padding: '150px 56px 110px 124px', overflow: 'auto', zIndex: 2 }}>
        <div style={{ maxWidth: 1180, margin: '0 auto', paddingBottom: 40 }}>
          <div className="label-mono" style={{ fontSize: 11, color: 'var(--teal-2)' }}>OPERATOR · OP-104</div>
          <div style={{ fontSize: 40, fontWeight: 200, marginTop: 6, marginBottom: 4 }}>Settings</div>
          <div style={{ fontSize: 14, color: 'var(--ink-mute)', marginBottom: 32 }}>Tune detection thresholds, security policies, and notifications.</div>

          <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 32 }}>
            {/* Section nav */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {['Detection', 'Security', 'Audio', 'Notifications', 'About'].map((s, i) => (
                <a key={s} href={`#sec-${i}`}
                  style={{
                    padding: '10px 14px', borderRadius: 10,
                    color: 'var(--ink-mute)', textDecoration: 'none',
                    fontSize: 13,
                    background: 'transparent', cursor: 'pointer',
                    transition: 'background 180ms, color 180ms',
                  }}
                  onMouseEnter={e => { e.target.style.background = 'rgba(125,200,255,0.06)'; e.target.style.color = '#7ef0ff'; }}
                  onMouseLeave={e => { e.target.style.background = 'transparent'; e.target.style.color = 'var(--ink-mute)'; }}
                >{s}</a>
              ))}
            </div>

            {/* Sections */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <SectionCard id="sec-0" title="Detection thresholds" desc="When does the system call something a match — or a fake?">
                <SliderRow label="Voice match threshold" value={settings.matchThr} min={0.5} max={0.95} step={0.01}
                  onChange={v => update('matchThr', v)} hint={settings.matchThr < 0.7 ? 'Permissive · more false accepts' : settings.matchThr > 0.85 ? 'Strict · more false rejects' : 'Balanced'}/>
                <SliderRow label="Anti-spoof threshold" value={settings.antiSpoofThr} min={0.3} max={0.8} step={0.01}
                  onChange={v => update('antiSpoofThr', v)} hint="Below = considered synthetic"/>
                <ToggleRow label="Aggressive deepfake mode" sub="Adds 5ms latency · catches more attacks"
                  value={settings.aggressive} onChange={v => update('aggressive', v)}/>
              </SectionCard>

              <SectionCard id="sec-1" title="Security policy" desc="Lockouts and challenge response.">
                <NumberRow label="Failed attempts before lock" value={settings.maxAttempts} min={1} max={10} step={1}
                  onChange={v => update('maxAttempts', v)}/>
                <ToggleRow label="Random phrase challenge" sub="Operator must repeat a generated phrase"
                  value={settings.challenge} onChange={v => update('challenge', v)}/>
                <ToggleRow label="Two-factor on critical actions" sub="Voice + hardware key" value={settings.twoFactor} onChange={v => update('twoFactor', v)}/>
              </SectionCard>

              <SectionCard id="sec-2" title="Audio capture" desc="How we listen.">
                <SelectRow label="Input device" value={settings.input} onChange={v => update('input', v)}
                  options={['Booth mic · Shure MV7', 'USB headset', 'Phone over SIP']}/>
                <SliderRow label="Capture gain" value={settings.gain} min={0} max={1} step={0.05}
                  onChange={v => update('gain', v)} unit="x" hint=""/>
                <ToggleRow label="Noise suppression" sub="RNNoise · denoise booth ambient" value={settings.denoise} onChange={v => update('denoise', v)}/>
              </SectionCard>

              <SectionCard id="sec-3" title="Notifications" desc="When to ping the operator.">
                <ToggleRow label="Sound on deepfake block" value={settings.notifySound} onChange={v => update('notifySound', v)}/>
                <ToggleRow label="Desktop alerts" value={settings.notifyDesktop} onChange={v => update('notifyDesktop', v)}/>
                <ToggleRow label="Daily threat brief email" sub="08:00 local · classified channel" value={settings.notifyEmail} onChange={v => update('notifyEmail', v)}/>
              </SectionCard>

              <SectionCard id="sec-4" title="About" desc="">
                <KV k="Build" v="BioVoice v3.7.2 · TLV-PROD"/>
                <KV k="Models" v="ReDimNet-B5 · AASIST-L · v2025.04"/>
                <KV k="License" v="INCD-RIVA · expires 2027-12-31"/>
                <KV k="Sovereignty" v="Air-gapped · on-prem only"/>
              </SectionCard>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionCard({ id, title, desc, children }) {
  return (
    <div id={id} className="panel" style={{ padding: 26 }}>
      <div style={{ fontSize: 18, fontWeight: 400 }}>{title}</div>
      {desc && <div style={{ fontSize: 12, color: 'var(--ink-mute)', marginTop: 4, marginBottom: 18 }}>{desc}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>
    </div>
  );
}

function SliderRow({ label, value, min, max, step, onChange, unit = '', hint }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px 70px', alignItems: 'center', gap: 14, padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
      <div>
        <div style={{ fontSize: 13 }}>{label}</div>
        {hint && <div className="label-mono" style={{ fontSize: 9, marginTop: 2 }}>{hint}</div>}
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        style={{ accentColor: '#7ef0ff', width: '100%' }}/>
      <span className="num-mono" style={{ fontSize: 16, color: '#7ef0ff', textAlign: 'right' }}>
        {value.toFixed(2)}{unit}
      </span>
    </div>
  );
}

function ToggleRow({ label, sub, value, onChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--line)', gap: 14 }}>
      <div>
        <div style={{ fontSize: 13 }}>{label}</div>
        {sub && <div className="label-mono" style={{ fontSize: 9, marginTop: 2 }}>{sub}</div>}
      </div>
      <button onClick={() => onChange(!value)}
        style={{
          width: 46, height: 26, borderRadius: 999, position: 'relative', cursor: 'pointer',
          background: value ? 'linear-gradient(135deg, #3da9fc, #7ef0ff)' : 'rgba(125,200,255,0.10)',
          border: value ? '1px solid rgba(126,240,255,0.7)' : '1px solid var(--line-2)',
          transition: 'all 240ms cubic-bezier(.2,.8,.2,1)',
          boxShadow: value ? '0 0 14px rgba(126,240,255,0.4)' : 'none',
        }}>
        <span style={{
          position: 'absolute', top: 2, left: value ? 22 : 2,
          width: 20, height: 20, borderRadius: '50%',
          background: value ? '#04070d' : '#7ef0ff',
          transition: 'left 240ms cubic-bezier(.2,.8,.2,1)',
        }}/>
      </button>
    </div>
  );
}

function NumberRow({ label, value, min, max, step, onChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
      <div style={{ fontSize: 13 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button onClick={() => onChange(Math.max(min, value - step))}
          style={{ width: 28, height: 28, borderRadius: 8, border: '1px solid var(--line-2)', background: 'transparent', color: 'var(--ink)', cursor: 'pointer' }}>−</button>
        <span className="num-mono" style={{ width: 50, textAlign: 'center', fontSize: 16, color: '#7ef0ff' }}>{value}</span>
        <button onClick={() => onChange(Math.min(max, value + step))}
          style={{ width: 28, height: 28, borderRadius: 8, border: '1px solid var(--line-2)', background: 'transparent', color: 'var(--ink)', cursor: 'pointer' }}>+</button>
      </div>
    </div>
  );
}

function SelectRow({ label, value, onChange, options }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
      <div style={{ fontSize: 13 }}>{label}</div>
      <select value={value} onChange={e => onChange(e.target.value)}
        style={{
          background: 'rgba(125,200,255,0.04)', color: 'var(--ink)',
          border: '1px solid var(--line-2)', borderRadius: 8,
          padding: '8px 12px', fontFamily: 'Sora, sans-serif', fontSize: 13,
        }}>
        {options.map(o => <option key={o} value={o} style={{ background: '#0a1422' }}>{o}</option>)}
      </select>
    </div>
  );
}

function KV({ k, v }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
      <span className="label-mono" style={{ fontSize: 10 }}>{k}</span>
      <span className="num-mono" style={{ fontSize: 12, color: 'var(--ink)' }}>{v}</span>
    </div>
  );
}

// ============================================================================
// ProfilesPage — manage enrolled voice profiles. Wired to real /users +
// inline EnrollDialog hitting /enroll. Per-card stats derived from /results.
// ============================================================================
function ProfilesPage({ profiles, audio }) {
  const [hover, setHover] = useState(null);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const { results } = useAppState();

  // VERIFIED count per user comes from real /results filtered by userId.
  const verifyCountByUser = useMemo(() => {
    const counts = new Map();
    for (const r of results) {
      if (r.decision !== 'ACCEPT') continue;
      counts.set(r.userId, (counts.get(r.userId) ?? 0) + 1);
    }
    return counts;
  }, [results]);

  return (
    <div className="screen fade-enter">
      <Chrome
        status="OPERATIONAL · ALL MODELS HEALTHY"
        statusKind="good"
        subtitle={`${profiles.length} enrolled profile${profiles.length === 1 ? '' : 's'}`}
        screenName="PROFILES"
      />
      <AmbientField count={40}/>
      <div style={{ position: 'absolute', inset: 0, padding: '150px 56px 110px 124px', overflow: 'auto', zIndex: 2 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 28 }}>
          <div>
            <div className="label-mono" style={{ fontSize: 11, color: 'var(--teal-2)' }}>VOICE PROFILES</div>
            <div style={{ fontSize: 40, fontWeight: 200, marginTop: 4 }}>Enrolled voices</div>
            <div style={{ fontSize: 14, color: 'var(--ink-mute)', marginTop: 6 }}>
              Each profile is a 192-dimensional fingerprint — not a recording.
            </div>
          </div>
          <button
            className="btn btn-primary"
            style={{ padding: '12px 22px', fontSize: 13 }}
            onClick={() => setEnrollOpen(true)}
          >+ &nbsp;ENROLL NEW</button>
        </div>

        {profiles.length === 0 ? (
          <EmptyProfiles onEnroll={() => setEnrollOpen(true)} />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 18 }}>
            {profiles.map((p, i) => (
              <ProfileCard
                key={p.id}
                profile={p}
                verifyCount={verifyCountByUser.get(p.userId) ?? 0}
                index={i}
                hovered={hover === p.id}
                onHover={(on) => setHover(on ? p.id : null)}
              />
            ))}
          </div>
        )}
      </div>

      {enrollOpen && (
        <EnrollDialog onClose={() => setEnrollOpen(false)} />
      )}
    </div>
  );
}

function ProfileCard({ profile, verifyCount, index, hovered, onHover }) {
  const enrolledLabel = formatRelative(profile.enrolledAt);
  const samples = profile.sampleCount ?? 0;
  const ready = samples >= ENROLLMENT_TARGET;
  return (
    <div
      className="panel lift"
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      style={{
        padding: 24, position: 'relative', overflow: 'hidden',
        animation: `fadeIn 500ms ${index * 60}ms ease both`,
      }}
    >
      <div style={{
        position: 'absolute', top: -40, right: -40, width: 160, height: 160, borderRadius: '50%',
        background: `radial-gradient(circle, ${profile.color1}33, transparent)`,
        opacity: hovered ? 1 : 0.5,
        transition: 'opacity 300ms',
      }}/>
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
        <div style={{
          width: 56, height: 56, borderRadius: '50%',
          background: `linear-gradient(135deg, ${profile.color1}, ${profile.color2})`,
          display: 'grid', placeItems: 'center',
          color: '#04070d', fontWeight: 600, fontSize: 18,
          boxShadow: `0 0 20px ${profile.color1}66`,
        }}>{profile.initials}</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 18 }}>{profile.name}</div>
          <div className="label-mono" style={{ fontSize: 10 }}>{profile.id}</div>
        </div>
        {!ready && (
          <span className="pill warn"><span className="dot"/>{samples}/{ENROLLMENT_TARGET}</span>
        )}
      </div>
      <MiniWave color={profile.color1} idx={index}/>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 16, fontSize: 11 }}>
        <Stat2 k="VERIFIED" v={verifyCount}/>
        <Stat2 k="ENROLLED" v={enrolledLabel}/>
        <Stat2 k="SAMPLES"  v={`${samples}/${ENROLLMENT_TARGET}`}/>
      </div>
    </div>
  );
}

function EmptyProfiles({ onEnroll }) {
  return (
    <div className="panel" style={{
      padding: 48, textAlign: 'center', display: 'grid', placeItems: 'center', gap: 16,
    }}>
      <div className="label-mono" style={{ fontSize: 11, color: 'var(--teal-2)' }}>NO PROFILES YET</div>
      <div style={{ fontSize: 22, fontWeight: 300 }}>Enrol your first speaker.</div>
      <div style={{ fontSize: 13, color: 'var(--ink-mute)', maxWidth: 480 }}>
        Capture three short voice samples to build a 192-dimensional fingerprint.
        Verification is unlocked once the third sample is saved.
      </div>
      <button className="btn btn-primary" style={{ padding: '12px 22px', fontSize: 13 }} onClick={onEnroll}>
        + &nbsp;ENROLL NEW
      </button>
    </div>
  );
}

function Stat2({ k, v }) {
  return (
    <div>
      <div className="label-mono" style={{ fontSize: 8 }}>{k}</div>
      <div className="num-mono" style={{ fontSize: 14, color: 'var(--teal-2)', marginTop: 2 }}>{v}</div>
    </div>
  );
}

// ============================================================================
// EnrollDialog — three-sample enrollment driven by Y-12 recorder + /enroll.
// ============================================================================
const RECORD_MS_ENROLL = 3000;

function EnrollDialog({ onClose }) {
  const [userId, setUserId] = useState('');
  const [availability, setAvailability] = useState({ status: 'idle', available: null });
  const [samplesEnrolled, setSamplesEnrolled] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [statusMessage, setStatusMessage] = useState(null);
  const recorder = useVoiceRecorder({ minMs: 1000, maxMs: RECORD_MS_ENROLL });
  const dispatch = useAppDispatch();
  const recordTimerRef = useRef(null);

  // Once we have at least one sample for this user, the username is locked in.
  const lockedUserId = samplesEnrolled > 0;

  const userIdValid = USER_ID_PATTERN.test(userId);
  const userIdAvailable = availability.status === 'ready' && availability.available === true;
  const canRecord = userIdValid && (lockedUserId || userIdAvailable) && !busy && recorder.state !== 'recording';

  // Debounced availability check.
  useEffect(() => {
    if (lockedUserId) return;
    if (!userId) {
      setAvailability({ status: 'idle', available: null });
      return;
    }
    if (!USER_ID_PATTERN.test(userId)) {
      setAvailability({ status: 'invalid', available: null });
      return;
    }
    setAvailability({ status: 'checking', available: null });
    const timer = setTimeout(async () => {
      try {
        const available = await getAvailability(userId);
        setAvailability({ status: 'ready', available });
      } catch {
        setAvailability({ status: 'error', available: null });
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [userId, lockedUserId]);

  // Once recording is live, schedule auto-stop + save.
  useEffect(() => {
    if (recorder.state !== 'recording') return;
    recordTimerRef.current = setTimeout(() => {
      void handleStopAndSave();
    }, RECORD_MS_ENROLL);
    return () => {
      if (recordTimerRef.current) clearTimeout(recordTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder.state]);

  const handleStopAndSave = useCallback(async () => {
    const recording = await recorder.stop();
    if (!recording) {
      setError(
        recorder.state === 'denied'
          ? 'Microphone access denied. Allow it in your browser to enrol.'
          : 'Recording too short — try again.',
      );
      return;
    }
    setBusy(true);
    setError(null);
    setStatusMessage(null);
    try {
      const message = await enrollSpeaker(userId, recording.wavFile);
      const next = samplesEnrolled + 1;
      setSamplesEnrolled(next);
      setStatusMessage(message);
      // Refresh the speakers list so the page reflects the new sample_count.
      try {
        const speakers = await listSpeakers();
        dispatch({ type: 'set-speakers', speakers });
      } catch {
        /* polling will catch up */
      }
      if (next >= ENROLLMENT_TARGET) {
        setTimeout(() => onClose(), 900);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err ?? 'Enrolment failed.');
      setError(message);
    } finally {
      setBusy(false);
    }
  }, [recorder, userId, samplesEnrolled, dispatch, onClose]);

  const onStartClick = useCallback(() => {
    setError(null);
    setStatusMessage(null);
    void recorder.start();
  }, [recorder]);

  const onCancelClick = useCallback(() => {
    recorder.cancel();
    onClose();
  }, [recorder, onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={(e) => { if (e.target === e.currentTarget && !busy && recorder.state !== 'recording') onClose(); }}
      style={{
        position: 'absolute', inset: 0, zIndex: 220,
        background: 'rgba(4,7,13,0.78)',
        backdropFilter: 'blur(10px)',
        display: 'grid', placeItems: 'center',
        animation: 'fadeIn 220ms ease both',
      }}
    >
      <div className="panel outline-glow" style={{
        width: 720, padding: '36px 44px',
        display: 'grid', gap: 22,
        background: 'linear-gradient(180deg, rgba(10,20,34,0.96), rgba(7,11,20,0.94))',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div className="label-mono" style={{ fontSize: 11, color: 'var(--teal-2)' }}>ENROL NEW SPEAKER</div>
            <div style={{ fontSize: 26, fontWeight: 300, marginTop: 4 }}>Sample {Math.min(samplesEnrolled + 1, ENROLLMENT_TARGET)} of {ENROLLMENT_TARGET}</div>
          </div>
          <button
            onClick={onCancelClick}
            className="btn btn-ghost"
            style={{ padding: '8px 16px', fontSize: 11 }}
            disabled={recorder.state === 'recording'}
          >✕ &nbsp;CLOSE</button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label className="label-mono" style={{ fontSize: 10 }}>USER ID</label>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <input
              type="text"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="3–32 chars · letters, digits, _ - ."
              readOnly={lockedUserId}
              autoFocus
              style={{
                flex: 1,
                background: 'rgba(125,200,255,0.04)',
                border: '1px solid var(--line)',
                borderRadius: 10, padding: '12px 14px',
                color: 'var(--ink)', fontFamily: 'JetBrains Mono, monospace', fontSize: 14,
              }}
            />
            <AvailabilityPill availability={availability} userId={userId} userIdValid={userIdValid} locked={lockedUserId}/>
          </div>
        </div>

        <div className="panel" style={{ padding: 20, display: 'grid', gap: 12, background: 'rgba(125,200,255,0.04)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="label-mono" style={{ fontSize: 10 }}>VOICE CAPTURE · {RECORD_MS_ENROLL / 1000}s</span>
            <span className={`pill ${recorder.state === 'recording' ? 'good' : recorder.state === 'denied' ? 'bad' : 'warn'}`}>
              <span className="dot"/>
              {recorder.state === 'recording' ? 'LIVE · 16 KHZ' :
               recorder.state === 'requesting' ? 'AWAITING MIC' :
               recorder.state === 'denied' ? 'MIC BLOCKED' :
               recorder.state === 'stopped' ? 'PROCESSING' : 'STANDBY'}
            </span>
          </div>
          <Waveform samples={recorder.samples} width={620} height={70} bars={92} mirror={true} color="#7ef0ff"/>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <SampleDots count={ENROLLMENT_TARGET} done={samplesEnrolled} active={busy ? samplesEnrolled : -1}/>
            <button
              className={recorder.state === 'recording' ? 'btn' : 'btn btn-primary'}
              onClick={onStartClick}
              disabled={!canRecord}
              style={{
                padding: '12px 28px', fontSize: 13,
                background: recorder.state === 'recording'
                  ? 'rgba(255,85,119,0.20)'
                  : undefined,
                color: recorder.state === 'recording' ? 'var(--bad)' : undefined,
                border: recorder.state === 'recording' ? '1px solid var(--bad)' : undefined,
              }}
            >
              {recorder.state === 'recording' ? '● RECORDING' :
               busy ? 'SAVING…' :
               samplesEnrolled === 0 ? 'RECORD SAMPLE 1' : `RECORD SAMPLE ${samplesEnrolled + 1}`}
            </button>
          </div>
        </div>

        {(error || statusMessage) && (
          <div style={{
            padding: 14, borderRadius: 10,
            background: error ? 'rgba(255,85,119,0.10)' : 'rgba(106,255,200,0.08)',
            border: `1px solid ${error ? 'rgba(255,85,119,0.45)' : 'rgba(106,255,200,0.35)'}`,
            color: error ? 'var(--bad)' : 'var(--good)',
            fontSize: 12, fontFamily: 'JetBrains Mono, monospace',
          }}>
            {error || statusMessage}
          </div>
        )}
      </div>
    </div>
  );
}

function AvailabilityPill({ availability, userId, userIdValid, locked }) {
  if (locked) return <span className="pill good"><span className="dot"/>LOCKED</span>;
  if (!userId) return <span className="pill"><span className="dot" style={{ background: 'var(--ink-soft)' }}/>ENTER ID</span>;
  if (!userIdValid) return <span className="pill warn"><span className="dot"/>BAD FORMAT</span>;
  if (availability.status === 'checking') return <span className="pill"><span className="dot" style={{ background: 'var(--teal-2)' }}/>CHECKING…</span>;
  if (availability.status === 'error') return <span className="pill warn"><span className="dot"/>BACKEND DOWN</span>;
  if (availability.status === 'ready' && availability.available) return <span className="pill good"><span className="dot"/>AVAILABLE</span>;
  if (availability.status === 'ready' && !availability.available) return <span className="pill bad"><span className="dot"/>TAKEN</span>;
  return <span className="pill"><span className="dot"/>—</span>;
}

function SampleDots({ count, done, active }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      {Array.from({ length: count }).map((_, i) => {
        const isDone = i < done;
        const isActive = i === active;
        return (
          <span key={i} style={{
            width: 14, height: 14, borderRadius: '50%',
            background: isDone ? 'var(--teal-2)' : 'rgba(125,200,255,0.10)',
            border: isActive ? '1px solid var(--teal-2)' : '1px solid var(--line-2)',
            boxShadow: isDone ? '0 0 8px rgba(126,240,255,0.6)' : 'none',
            transition: 'all 240ms ease',
          }}/>
        );
      })}
      <span className="label-mono" style={{ fontSize: 10, color: 'var(--ink-soft)', marginLeft: 6 }}>
        {done}/{count}
      </span>
    </div>
  );
}

function formatRelative(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  const days = Math.floor(seconds / 86400);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function MiniWave({ color, idx = 0 }) {
  const ref = useRef();
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const ctx = c.getContext('2d');
    const dpr = 2; const W = 280, H = 40;
    c.width = W * dpr; c.height = H * dpr; c.style.width = W + 'px'; c.style.height = H + 'px';
    ctx.scale(dpr, dpr);
    let raf, t = idx * 0.7;
    const draw = () => {
      t += 0.03;
      ctx.clearRect(0, 0, W, H);
      ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.shadowBlur = 6; ctx.shadowColor = color;
      ctx.beginPath();
      for (let x = 0; x < W; x++) {
        const v = Math.sin(x * 0.05 + t) * 0.6 + Math.sin(x * 0.12 + t * 1.4) * 0.3 + Math.sin(x * 0.21 + t * 0.6) * 0.2;
        const y = H / 2 + v * H * 0.35;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [color, idx]);
  return <canvas ref={ref} style={{ display: 'block', opacity: 0.85 }}/>;
}

export {
  Sidebar, DeepfakeLab, UserSettingsPage, ProfilesPage,
};
