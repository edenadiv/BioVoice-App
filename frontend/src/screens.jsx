// Screen components: Welcome (attract), Enroll, Processing, Verification,
// Deepfake, TCAV. Each is full-bleed within the 1920x1080 stage.

import React, { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { seedRand } from "./audio.jsx";
import {
  VoiceOrb, Waveform, MelSpectrogram, EmbeddingCloud, SimilarityGauge,
  ConceptBars, PipelineFlow, BrandMark, PartnerCrest, LivePulse,
} from "./visuals.jsx";
import { LiveClock, ThreatLevel } from "./console-ext.jsx";
import { SIM_THRESHOLD, DF_THRESHOLD } from "./lib/thresholds";
import { useAppState } from "./lib/session";

// =============================================================================
// Common chrome (top + bottom bars) used across screens
// =============================================================================
function Chrome({ status = "SYSTEM ONLINE", statusKind = "good", subtitle, screenName = "" }) {
  const time = useClock();
  const sessionStart = useRef(Date.now() - 47 * 60 * 1000).current;
  return (
    <>
      <div className="chrome-top">
        <div className="left">
          <div className="wordmark">
            <div className="mark"><BrandMark size={48}/></div>
            <div>
              <div className="name"><b>BIO</b>VOICE</div>
              <div className="sub">Voice Biometric Authentication</div>
            </div>
          </div>
        </div>
        <div className="right" style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'nowrap' }}>
          <ThreatLevel level="amber"/>
          <LiveClock sessionStart={sessionStart}/>
          <div className="partner">
            <div className="stack" style={{ alignItems: 'flex-end' }}>
              <div className="l1">INCD</div>
            </div>
            <div className="crest"><PartnerCrest size={32}/></div>
          </div>
        </div>
      </div>
      <div className="chrome-bottom">
        <div className="left" style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <span className={`pill ${statusKind}`}><span className="dot"></span>{status}</span>
          {subtitle && <span className="label-mono" style={{ fontSize: 10 }}>{subtitle}</span>}
        </div>
        <div className="right" style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
          {screenName && <span className="label-mono" style={{ fontSize: 10 }}>SCREEN · {screenName}</span>}
          <span className="label-mono" style={{ fontSize: 10 }}>NODE · TLV-01</span>
          <span className="num-mono" style={{ fontSize: 12, color: 'var(--ink)', letterSpacing: '0.18em' }}>
            {time}
          </span>
        </div>
      </div>
    </>
  );
}

function useClock() {
  const [t, setT] = useState(() => fmtTime(new Date()));
  useEffect(() => {
    const id = setInterval(() => setT(fmtTime(new Date())), 1000);
    return () => clearInterval(id);
  }, []);
  return t;
}
function fmtTime(d) {
  const hh = String(d.getHours()).padStart(2,'0');
  const mm = String(d.getMinutes()).padStart(2,'0');
  const ss = String(d.getSeconds()).padStart(2,'0');
  return `${hh} : ${mm} : ${ss}`;
}

// =============================================================================
// 1. WELCOME / ATTRACT SCREEN
// =============================================================================
function WelcomeScreen({ onStart, micState, audio }) {
  return (
    <div className="screen fade-enter">
      <Chrome status="STANDBY · WAITING FOR USER" statusKind="" subtitle="Tap anywhere to begin" screenName="00 ATTRACT"/>

      <div style={{
        position: 'absolute', inset: 0,
        display: 'grid', placeItems: 'center',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 56 }}>

          {/* Eyebrow */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
            <div style={{
              fontFamily: 'JetBrains Mono, monospace', fontSize: 12,
              letterSpacing: '0.4em', color: 'var(--teal-2)', textTransform: 'uppercase',
            }}>
              <LivePulse size={8}/> &nbsp; Live demonstration
            </div>
          </div>

          {/* The orb */}
          <div style={{ position: 'relative' }}>
            <VoiceOrb size={520} samples={audio.samples} level={audio.level} hue="cyan" />
            <div style={{
              position: 'absolute', inset: 0,
              border: '1px solid rgba(126,240,255,0.10)',
              borderRadius: '50%',
              transform: 'scale(1.25)',
              animation: 'breathe 3.2s ease-in-out infinite',
              pointerEvents: 'none',
            }}></div>
          </div>

          {/* Wordmark headline */}
          <div style={{ textAlign: 'center', marginTop: -24 }}>
            <div style={{
              fontSize: 96, fontWeight: 200, letterSpacing: '-0.02em',
              lineHeight: 1, color: 'var(--ink)',
            }}>
              <span className="serif" style={{ fontStyle: 'italic', color: 'var(--teal-2)' }}>Your voice</span>
              <span style={{ color: 'var(--ink-mute)' }}> is your </span>
              <span style={{ fontWeight: 300 }}>signature.</span>
            </div>
            <div style={{
              marginTop: 22, fontSize: 22, color: 'var(--ink-mute)',
              maxWidth: 920, fontWeight: 300, lineHeight: 1.5,
            }}>
              BioVoice turns the way you speak into a unique biometric fingerprint —
              and tells real humans apart from AI deepfakes in under two seconds.
            </div>
          </div>

          {/* CTAs */}
          <div style={{ display: 'flex', gap: 18, marginTop: 8 }}>
            <button className="btn btn-primary" onClick={onStart}>
              Begin demonstration
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path d="M3 9 L15 9 M10 4 L15 9 L10 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>

          {/* Trust strip */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 56,
            marginTop: 24, paddingTop: 36,
            borderTop: '1px solid var(--line)',
            width: 1100,
          }}>
            {[
              ['< 2s', 'End-to-end decision'],
              ['0.79%', 'Identity error rate'],
              ['> 95%', 'Deepfake detection'],
              ['192', 'Voice fingerprint dims'],
            ].map(([n, l]) => (
              <div key={l} style={{ textAlign: 'center' }}>
                <div className="num-mono" style={{ fontSize: 36, color: 'var(--teal-2)', fontWeight: 300 }}>{n}</div>
                <div className="label-mono" style={{ marginTop: 8, fontSize: 10 }}>{l}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Caption explaining hero microphone state */}
      <div style={{ position: 'absolute', left: 56, bottom: 84, width: 280 }}>
        <div className="label-mono" style={{ fontSize: 10, marginBottom: 6 }}>MICROPHONE</div>
        <div style={{ fontSize: 13, color: micState === 'live' ? 'var(--teal-2)' : 'var(--ink-mute)' }}>
          {micState === 'live' ? 'Live · the orb breathes with the room' :
           micState === 'denied' ? 'Permission denied · running on synthesized audio' :
           'Synthesized audio · grant mic to feel it react'}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// 2. ENROLLMENT SCREEN
// =============================================================================
function EnrollScreen({ onComplete, audio, micState, micStart }) {
  const [phase, setPhase] = useState('prompt'); // prompt | recording | done
  const [secs, setSecs] = useState(0);
  const [name, setName] = useState('Eden');

  useEffect(() => {
    if (phase !== 'recording') return;
    const id = setInterval(() => setSecs(s => s + 0.1), 100);
    return () => clearInterval(id);
  }, [phase]);

  useEffect(() => {
    if (phase === 'recording' && secs >= 4.5) {
      setPhase('done');
      setTimeout(() => onComplete(name), 800);
    }
  }, [secs, phase, onComplete, name]);

  const startRec = async () => {
    if (micState !== 'live') await micStart();
    setSecs(0);
    setPhase('recording');
  };

  return (
    <div className="screen fade-enter">
      <Chrome status="ENROLLMENT · NEW PROFILE" statusKind="" screenName="01 ENROLL"/>

      <div style={{ position: 'absolute', inset: 0, padding: '160px 120px 130px', display: 'grid', gridTemplateColumns: '1fr 720px', gap: 80 }}>

        {/* Left: copy + form */}
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 32 }}>
          <div>
            <div className="label-mono" style={{ color: 'var(--teal-2)', marginBottom: 14 }}>STEP 1 · ENROLLMENT</div>
            <div style={{ fontSize: 76, fontWeight: 200, lineHeight: 1.05, letterSpacing: '-0.02em' }}>
              Let the system <br/>
              <span className="serif" style={{ fontStyle: 'italic', color: 'var(--teal-2)' }}>learn your voice.</span>
            </div>
            <div style={{ marginTop: 22, fontSize: 19, color: 'var(--ink-mute)', maxWidth: 540, lineHeight: 1.5 }}>
              Speak any sentence for a few seconds. We'll capture the timbre, pitch and rhythm
              that make your voice unmistakably yours — and store it as a 192-number fingerprint.
            </div>
          </div>

          <div className="panel outline-glow" style={{ maxWidth: 540 }}>
            <div className="label-mono" style={{ fontSize: 10, marginBottom: 10 }}>YOUR NAME</div>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              disabled={phase !== 'prompt'}
              style={{
                width: '100%', background: 'transparent', border: 'none',
                outline: 'none', color: 'var(--ink)', fontSize: 32, fontWeight: 300,
                fontFamily: 'Sora, sans-serif', padding: 0,
              }}
            />
            <div style={{ marginTop: 12, height: 1, background: 'linear-gradient(90deg, var(--teal-1), transparent)' }}></div>
            <div className="label-mono" style={{ fontSize: 9, marginTop: 10, color: 'var(--good)' }}>
              ✓ NEW IDENTIFIER · NO PRIOR ENROLLMENT
            </div>
          </div>

          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            {phase === 'prompt' && (
              <button className="btn btn-primary" onClick={startRec}>
                <span style={{
                  width: 10, height: 10, borderRadius: '50%',
                  background: '#04070d', boxShadow: '0 0 0 2px rgba(4,7,13,0.3)',
                }}></span>
                Record voice
              </button>
            )}
            {phase === 'recording' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <span className="pill bad"><span className="dot"></span>RECORDING</span>
                <span className="num-mono" style={{ fontSize: 24, color: 'var(--ink)' }}>
                  00:0{secs.toFixed(1)}
                </span>
              </div>
            )}
            {phase === 'done' && (
              <span className="pill good"><span className="dot"></span>SAMPLE CAPTURED</span>
            )}
          </div>
        </div>

        {/* Right: live orb + waveform */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 28 }}>
          <div style={{ position: 'relative' }}>
            <VoiceOrb size={460} samples={audio.samples} level={audio.level} hue="cyan" listening={phase === 'recording'} intensity={phase === 'recording' ? 1.6 : 0.7}/>
            {phase === 'recording' && (
              <div style={{
                position: 'absolute', top: -10, right: -10,
                padding: '6px 12px', borderRadius: 999,
                background: 'rgba(255,85,119,0.15)', border: '1px solid rgba(255,85,119,0.5)',
                color: '#ff7aa8', fontFamily: 'JetBrains Mono, monospace',
                fontSize: 10, letterSpacing: '0.22em',
              }}>
                <span style={{ display: 'inline-block', width: 6, height: 6, background: '#ff5577', borderRadius: '50%', marginRight: 6, animation: 'pulse 0.8s infinite' }}></span>
                REC
              </div>
            )}
          </div>

          <div className="panel" style={{ width: 600, padding: '20px 24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
              <span className="label-mono" style={{ fontSize: 10 }}>WAVEFORM · 16 KHZ MONO</span>
              <span className="num-mono" style={{ fontSize: 11, color: 'var(--ink-mute)' }}>
                {phase === 'recording' ? `${(secs).toFixed(1)}s / 5.0s` : '— / 5.0s'}
              </span>
            </div>
            <Waveform samples={audio.samples} width={552} height={100} bars={92} mirror={true}/>
            <div className="ticks" style={{ marginTop: 8 }}></div>
          </div>

          <div style={{ display: 'flex', gap: 32, justifyContent: 'center' }}>
            {[
              ['Sample rate', '16,000 Hz'],
              ['Mono channel', 'avg L+R'],
              ['Embedding', '192-dim'],
            ].map(([l, v]) => (
              <div key={l} style={{ textAlign: 'center' }}>
                <div className="label-mono" style={{ fontSize: 9 }}>{l}</div>
                <div className="num-mono" style={{ fontSize: 14, marginTop: 4, color: 'var(--ink)' }}>{v}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// 3. PROCESSING SCREEN — the AI moment
// =============================================================================
function ProcessingScreen({ onComplete, audio, mode = 'enroll' }) {
  // mode: 'enroll' | 'verify'
  const stages = [
    { icon: '◐', title: 'Capture',     sub: '16 kHz PCM' },
    { icon: '⌇', title: 'Preprocess',  sub: 'normalize · mono' },
    { icon: '▦', title: 'Mel-spectrogram', sub: '80 bands · 100 fps' },
    { icon: '✦', title: 'ReDimNet-B5', sub: '192-dim embedding' },
    { icon: '◊', title: 'AASIST',      sub: 'authenticity score' },
    { icon: '✓', title: mode === 'enroll' ? 'Stored' : 'Decision', sub: mode === 'enroll' ? 'profile saved' : 'accept / reject' },
  ];

  const [active, setActive] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    setActive(0); setDone(false);
    const timings = [600, 700, 900, 1100, 800, 700];
    let t = 0;
    const ids = [];
    timings.forEach((d, i) => {
      t += d;
      ids.push(setTimeout(() => setActive(i + 1 < stages.length ? i + 1 : i), t));
    });
    ids.push(setTimeout(() => { setDone(true); setTimeout(onComplete, 700); }, t + 500));
    return () => ids.forEach(clearTimeout);
  }, []);

  // synthetic embedding values for the right-hand reveal
  const embedding = useMemo(() => {
    const r = seedRand(1337);
    return Array.from({ length: 192 }, () => r());
  }, []);

  return (
    <div className="screen fade-enter">
      <Chrome status="PROCESSING · NEURAL INFERENCE" statusKind="warn" screenName={mode === 'enroll' ? '02 PROCESS · ENROLL' : '02 PROCESS · VERIFY'}/>

      <div style={{ position: 'absolute', inset: 0, padding: '150px 100px 130px', display: 'flex', flexDirection: 'column', gap: 36 }}>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <div>
            <div className="label-mono" style={{ color: 'var(--teal-2)', marginBottom: 12 }}>{mode === 'enroll' ? 'STEP 2 · LEARNING' : 'STEP 3 · INFERENCE'}</div>
            <div style={{ fontSize: 64, fontWeight: 200, lineHeight: 1, letterSpacing: '-0.02em' }}>
              <span className="serif" style={{ fontStyle: 'italic', color: 'var(--teal-2)' }}>Listening</span>
              <span style={{ color: 'var(--ink-mute)' }}> with </span>
              <span>two minds, in parallel.</span>
            </div>
            <div style={{ marginTop: 18, fontSize: 18, color: 'var(--ink-mute)', maxWidth: 880, lineHeight: 1.5 }}>
              One model — <em className="serif">ReDimNet-B5</em> — extracts your voice fingerprint.
              Another — <em className="serif">AASIST</em> — looks for the tell-tale artefacts of synthetic audio.
              Both finish in milliseconds.
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="label-mono" style={{ fontSize: 10 }}>ELAPSED</div>
            <div className="num-mono" style={{ fontSize: 44, color: 'var(--teal-2)', fontWeight: 300 }}>
              {(active * 0.18).toFixed(2)}<span style={{ fontSize: 18, color: 'var(--ink-soft)' }}>s</span>
            </div>
          </div>
        </div>

        {/* Pipeline */}
        <div className="panel outline-glow" style={{ padding: '40px 48px' }}>
          <PipelineFlow stages={stages} activeIdx={active} complete={done}/>
        </div>

        {/* Live two-up: spectrogram + embedding cloud */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32, flex: 1 }}>
          <div className="panel" style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
              <div>
                <div className="label-mono" style={{ fontSize: 10 }}>MEL-SPECTROGRAM</div>
                <div style={{ fontSize: 18, marginTop: 4 }}>How the AI <em className="serif">sees</em> sound</div>
              </div>
              <div className="label-mono" style={{ fontSize: 10, color: 'var(--ink-soft)' }}>80 BANDS · 20–8 K HZ</div>
            </div>
            <div style={{ flex: 1, display: 'grid', placeItems: 'center', position: 'relative' }}>
              <MelSpectrogram freqs={audio.freqs} width={580} height={260} mels={80}/>
              <div style={{
                position: 'absolute', left: 8, top: 8, bottom: 8, width: 32,
                display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                fontFamily: 'JetBrains Mono, monospace', fontSize: 9, color: 'var(--ink-soft)',
              }}>
                <span>8 kHz</span>
                <span>2 kHz</span>
                <span>500 Hz</span>
                <span>20 Hz</span>
              </div>
            </div>
          </div>

          <div className="panel" style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
              <div>
                <div className="label-mono" style={{ fontSize: 10 }}>VOICE FINGERPRINT</div>
                <div style={{ fontSize: 18, marginTop: 4 }}>192 numbers, <em className="serif">unique to you</em></div>
              </div>
              <div className="label-mono" style={{ fontSize: 10, color: active >= 4 ? 'var(--good)' : 'var(--ink-soft)' }}>
                {active >= 4 ? '✓ EXTRACTED' : 'AWAITING…'}
              </div>
            </div>
            <div style={{ flex: 1, display: 'grid', placeItems: 'center', opacity: active >= 4 ? 1 : 0.3, transition: 'opacity 600ms' }}>
              <EmbeddingCloud values={embedding} cols={16} rows={12} size={26} gap={6}/>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// 4. VERIFICATION RESULT
// =============================================================================
function VerifyScreen({ onNext, name, similarity: similarityProp, dfScore: dfScoreProp, samples }) {
  // Source of truth: state.lastVerification (E-19). Props are kept for the
  // legacy linear-mode path but are overridden by real data when present.
  const { lastVerification } = useAppState();
  const similarity = lastVerification?.similarityScore ?? similarityProp ?? 0;
  const dfScore = lastVerification?.deepfakeScore ?? dfScoreProp ?? 0;
  // Accepted comes from the server decision — no client-side derivation.
  const accepted = lastVerification
    ? lastVerification.decision === 'ACCEPT'
    : similarity >= SIM_THRESHOLD && dfScore >= DF_THRESHOLD;
  const reasonBlurb = accepted
    ? 'Your voice matched the stored profile, and the audio was confirmed as a real human speaker — not synthetic.'
    : lastVerification?.decisionReason === 'synthetic'
      ? 'Audio was flagged as synthetic. The stored profile was not consulted.'
      : 'The captured voice did not match the stored profile.';
  const displayName = name || lastVerification?.userId?.split(/[^A-Za-z0-9]+/)[0] || 'speaker';
  const totalMs = lastVerification?.stageBreakdown?.totalMs ?? 0;
  const latencyDisplay = totalMs > 0 ? `${(totalMs / 1000).toFixed(2)} s` : '— s';
  return (
    <div className="screen fade-enter">
      <Chrome status={accepted ? "ACCESS GRANTED" : "ACCESS DENIED"} statusKind={accepted ? "good" : "bad"} screenName="04 VERIFY · RESULT"/>

      <div style={{ position: 'absolute', inset: 0, padding: '150px 100px 130px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 60 }}>

        {/* Left: hero verdict */}
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 40 }}>
          <div>
            <div className="label-mono" style={{ color: accepted ? 'var(--good)' : 'var(--bad)', marginBottom: 14 }}>
              {accepted ? '✓ DECISION · ACCEPT' : '✗ DECISION · REJECT'}
            </div>
            <div style={{ fontSize: 92, fontWeight: 200, lineHeight: 1, letterSpacing: '-0.02em' }}>
              <span className="serif" style={{ fontStyle: 'italic', color: accepted ? 'var(--teal-2)' : 'var(--bad)' }}>
                {accepted ? 'Welcome,' : 'Not a match.'}
              </span>
              {accepted && <><br/><span style={{ color: 'var(--ink)' }}>{displayName}.</span></>}
            </div>
            <div style={{ marginTop: 22, fontSize: 21, color: 'var(--ink-mute)', maxWidth: 540, lineHeight: 1.5 }}>
              {reasonBlurb}
            </div>
          </div>

          {/* Two scores side-by-side */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <ScoreCard
              icon="◉"
              title="Voice match"
              value={similarity}
              threshold={SIM_THRESHOLD}
              passed={similarity >= SIM_THRESHOLD}
              tech="Cosine similarity · ReDimNet-B5"
              caption={similarity >= SIM_THRESHOLD ? 'The voice fingerprint matches what we stored at enrollment.' : 'The fingerprints diverge beyond the safe threshold.'}
            />
            <ScoreCard
              icon="◊"
              title="Authenticity"
              value={dfScore}
              threshold={DF_THRESHOLD}
              passed={dfScore >= DF_THRESHOLD}
              tech="AASIST anti-spoofing"
              caption={dfScore >= DF_THRESHOLD ? 'Spectro-temporal patterns are consistent with genuine human speech.' : 'Synthetic artefacts detected — likely AI-generated audio.'}
            />
          </div>

          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            <button className="btn btn-primary" onClick={onNext}>
              See why
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path d="M3 9 L15 9 M10 4 L15 9 L10 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Right: gauge + waveform */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24 }}>
          <div className="panel outline-glow" style={{ padding: '36px 56px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24 }}>
            <div className="label-mono" style={{ fontSize: 11 }}>VERIFICATION CONFIDENCE</div>
            <SimilarityGauge value={similarity} threshold={SIM_THRESHOLD} size={420}/>
            <div style={{ display: 'flex', gap: 24, paddingTop: 24, borderTop: '1px solid var(--line)', width: '100%', justifyContent: 'space-around' }}>
              <Stat label="Latency" value={latencyDisplay}/>
              <Stat label="Session" value={lastVerification?.sessionId?.split('-').slice(-1)[0] ?? '—'}/>
              <Stat label="Model" value="ReDimNet-B5"/>
            </div>
          </div>

          <div className="panel" style={{ width: 540, padding: '14px 22px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
              <span className="label-mono" style={{ fontSize: 9 }}>CAPTURED SAMPLE</span>
              <span className="num-mono" style={{ fontSize: 10, color: 'var(--ink-soft)' }}>16 KHZ · 4.5 S</span>
            </div>
            <Waveform samples={samples} width={500} height={64} bars={120} mirror={true}/>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div className="label-mono" style={{ fontSize: 9 }}>{label}</div>
      <div className="num-mono" style={{ fontSize: 16, marginTop: 4, color: 'var(--ink)' }}>{value}</div>
    </div>
  );
}

function ScoreCard({ icon, title, value, threshold, passed, tech, caption }) {
  return (
    <div className="panel" style={{
      borderColor: passed ? 'rgba(106,255,200,0.25)' : 'rgba(255,85,119,0.35)',
      boxShadow: passed ? '0 0 30px rgba(106,255,200,0.06)' : '0 0 30px rgba(255,85,119,0.08)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div>
          <div style={{ fontSize: 22, color: passed ? 'var(--good)' : 'var(--bad)', marginBottom: 6 }}>{icon}</div>
          <div className="label-mono" style={{ fontSize: 9 }}>{title.toUpperCase()}</div>
          <div className="num-mono" style={{ fontSize: 36, color: passed ? 'var(--good)' : 'var(--bad)', fontWeight: 300, marginTop: 4 }}>
            {value.toFixed(3)}
          </div>
          <div className="num-mono" style={{ fontSize: 9, color: 'var(--ink-soft)', marginTop: 2 }}>
            THRESHOLD ≥ {threshold.toFixed(2)} · {passed ? 'PASS' : 'FAIL'}
          </div>
        </div>
        <div style={{
          padding: '4px 10px', borderRadius: 999, fontSize: 10,
          fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.18em',
          background: passed ? 'rgba(106,255,200,0.12)' : 'rgba(255,85,119,0.12)',
          color: passed ? 'var(--good)' : 'var(--bad)',
          border: `1px solid ${passed ? 'rgba(106,255,200,0.4)' : 'rgba(255,85,119,0.4)'}`,
        }}>
          {passed ? '✓ PASS' : '✗ FAIL'}
        </div>
      </div>
      <div style={{ height: 1, background: 'var(--line)', margin: '14px 0' }}></div>
      <div style={{ fontSize: 13, color: 'var(--ink-mute)', lineHeight: 1.5 }}>{caption}</div>
      <div className="label-mono" style={{ fontSize: 9, marginTop: 10, color: 'var(--ink-soft)' }}>{tech}</div>
    </div>
  );
}

// =============================================================================
// 5. DEEPFAKE CATCH SCREEN
// =============================================================================
function DeepfakeScreen({ onNext, audio }) {
  // Driven entirely by state.lastVerification (Y-15). No mock animation; if a
  // verification has happened, render the real numbers; otherwise fall back to
  // an "analyzing" placeholder until a verification lands.
  const { lastVerification } = useAppState();
  const isSynthetic = lastVerification?.decisionReason === 'synthetic';
  const phase = lastVerification ? (isSynthetic ? 'flagged' : 'genuine') : 'analyzing';
  const score = lastVerification?.deepfakeScore ?? 0.5;
  const details = lastVerification?.analysisDetails;

  return (
    <div className="screen fade-enter">
      <Chrome
        status={
          phase === 'flagged' ? 'SYNTHETIC AUDIO DETECTED' :
          phase === 'genuine' ? 'GENUINE AUDIO · CONFIRMED' :
          'ANTI-SPOOFING · ANALYZING'
        }
        statusKind={phase === 'flagged' ? 'bad' : phase === 'genuine' ? 'good' : 'warn'}
        screenName="03 DEEPFAKE · CATCH"
      />

      <div style={{ position: 'absolute', inset: 0, padding: '140px 100px 130px', display: 'grid', gridTemplateColumns: '1fr 760px', gap: 60 }}>

        {/* Left */}
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 32 }}>
          <div>
            <div className="label-mono" style={{ color: phase === 'flagged' ? 'var(--bad)' : phase === 'genuine' ? 'var(--good)' : 'var(--warn)', marginBottom: 14 }}>
              {phase === 'flagged' ? '⚠ DEEPFAKE FLAGGED' :
               phase === 'genuine' ? '✓ HUMAN SPEAKER CONFIRMED' :
               '◌ ANALYZING SAMPLE'}
            </div>
            <div style={{ fontSize: 78, fontWeight: 200, lineHeight: 1.02, letterSpacing: '-0.02em' }}>
              {phase === 'flagged' ? (
                <>
                  <span className="serif" style={{ fontStyle: 'italic', color: 'var(--bad)' }}>Not a human.</span>
                  <br/>
                  <span style={{ color: 'var(--ink)' }}>Access denied.</span>
                </>
              ) : phase === 'genuine' ? (
                <>
                  <span className="serif" style={{ fontStyle: 'italic', color: 'var(--good)' }}>Real voice.</span>
                  <br/>
                  <span style={{ color: 'var(--ink)' }}>Cleared.</span>
                </>
              ) : (
                <>
                  <span className="serif" style={{ fontStyle: 'italic', color: 'var(--teal-2)' }}>Is this voice</span>
                  <br/>
                  <span style={{ color: 'var(--ink)' }}>real?</span>
                </>
              )}
            </div>
            <div style={{ marginTop: 22, fontSize: 19, color: 'var(--ink-mute)', maxWidth: 580, lineHeight: 1.5 }}>
              {phase === 'flagged'
                ? 'AASIST found unnatural spectro-temporal patterns — the kind only present in AI-generated audio. The voice was a clone, not the real person.'
                : phase === 'genuine'
                  ? 'AASIST detected the natural spectro-temporal micro-patterns that only real vocal cords produce. No synthetic artefacts.'
                  : 'AASIST examines micro-patterns in pitch, harmonic stability and temporal flow that real vocal cords leave behind. No two are quite the same.'}
            </div>
          </div>

          {/* Artifact breakdown — driven by real analysis_details (Y-15/Y-19) */}
          <div className="panel" style={{ padding: '22px 26px' }}>
            <div className="label-mono" style={{ fontSize: 10, marginBottom: 14 }}>WHAT BIOVOICE NOTICED</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {[
                { label: 'Voice naturalness',    val: details?.voiceNaturalness   ?? (phase === 'flagged' ? 0.18 : phase === 'genuine' ? 0.92 : 0.5), bad: phase === 'flagged' },
                { label: 'Spectral consistency', val: details?.spectralConsistency ?? (phase === 'flagged' ? 0.24 : phase === 'genuine' ? 0.90 : 0.5), bad: phase === 'flagged' },
                { label: 'Temporal pattern',     val: details?.temporalPatterns    ?? (phase === 'flagged' ? 0.31 : phase === 'genuine' ? 0.94 : 0.5), bad: phase === 'flagged' },
                { label: 'Artifact detection',   val: details?.artifactDetection   ?? (phase === 'flagged' ? 0.92 : phase === 'genuine' ? 0.06 : 0.5), bad: phase === 'flagged', invert: true, label2: phase === 'flagged' ? 'High artefact load' : 'Low artefact load' },
              ].map((r, i) => (
                <ArtifactRow key={i} {...r} animate={phase !== 'analyzing'} delay={i*120}/>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 16 }}>
            <button className="btn btn-primary" onClick={onNext} disabled={phase === 'analyzing'} style={{ opacity: phase === 'analyzing' ? 0.4 : 1 }}>
              Continue
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path d="M3 9 L15 9 M10 4 L15 9 L10 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Right: dual orb (real vs cloned) + score */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 32 }}>
          <div style={{ position: 'relative', display: 'flex', gap: 60, alignItems: 'center' }}>
            <div style={{ textAlign: 'center' }}>
              <VoiceOrb size={280} samples={audio.samples} level={audio.level * 0.7} hue="cyan"/>
              <div className="label-mono" style={{ fontSize: 10, marginTop: 12, color: 'var(--teal-2)' }}>YOUR REAL VOICE</div>
              <div className="num-mono" style={{ fontSize: 11, color: 'var(--ink-soft)', marginTop: 4 }}>ENROLLED PROFILE</div>
            </div>
            <div style={{ fontSize: 28, color: 'var(--ink-soft)' }}>vs</div>
            <div style={{ textAlign: 'center' }}>
              <VoiceOrb
                size={280}
                samples={audio.samples}
                level={audio.level * (phase === 'flagged' ? 0.6 : 0.7)}
                hue={phase === 'flagged' ? 'rose' : phase === 'genuine' ? 'cyan' : 'gold'}
              />
              <div className="label-mono" style={{ fontSize: 10, marginTop: 12, color: phase === 'flagged' ? 'var(--bad)' : phase === 'genuine' ? 'var(--good)' : 'var(--warn)' }}>
                {phase === 'flagged' ? '⚠ SYNTHETIC CLONE' : phase === 'genuine' ? '✓ HUMAN VOICE' : 'TEST SAMPLE'}
              </div>
              <div className="num-mono" style={{ fontSize: 11, color: 'var(--ink-soft)', marginTop: 4 }}>
                {phase === 'flagged' ? 'AASIST FLAG' : phase === 'genuine' ? 'AASIST PASS' : 'ANALYZING…'}
              </div>
            </div>
          </div>

          <div className="panel outline-glow" style={{ padding: '24px 32px', width: 600 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
              <span className="label-mono" style={{ fontSize: 10 }}>AASIST AUTHENTICITY SCORE</span>
              <span className="label-mono" style={{ fontSize: 9, color: 'var(--warn)' }}>THRESHOLD ≥ 0.50</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
              <div className="num-mono" style={{ fontSize: 64, color: phase === 'flagged' ? 'var(--bad)' : phase === 'genuine' ? 'var(--good)' : 'var(--warn)', fontWeight: 200, letterSpacing: '-0.02em' }}>
                {score.toFixed(2)}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{
                  height: 12, background: 'rgba(125,200,255,0.08)', borderRadius: 6, position: 'relative', overflow: 'hidden',
                }}>
                  <div style={{
                    position: 'absolute', left: 0, top: 0, bottom: 0,
                    width: `${score * 100}%`,
                    background: phase === 'flagged'
                      ? 'linear-gradient(90deg, rgba(255,85,119,0.4), #ff5577)'
                      : phase === 'genuine'
                        ? 'linear-gradient(90deg, rgba(106,255,200,0.35), #6affc8)'
                        : 'linear-gradient(90deg, rgba(255,178,74,0.4), #ffb24a)',
                    boxShadow: phase === 'genuine'
                      ? '0 0 16px rgba(106,255,200,0.4)'
                      : '0 0 16px rgba(255,85,119,0.4)',
                    borderRadius: 6,
                    transition: 'width 1500ms cubic-bezier(0.2, 0.8, 0.2, 1)',
                  }}></div>
                  <div style={{
                    position: 'absolute', top: -4, bottom: -4, left: '50%', width: 2,
                    background: 'var(--warn)', opacity: 0.8,
                  }}></div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
                  <span className="num-mono" style={{ fontSize: 9, color: 'var(--ink-soft)' }}>0.00 · FAKE</span>
                  <span className="num-mono" style={{ fontSize: 9, color: 'var(--ink-soft)' }}>1.00 · GENUINE</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ArtifactRow({ label, label2, val, invert, animate, delay }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr 56px', gap: 14, alignItems: 'center' }}>
      <div style={{ fontSize: 14, color: 'var(--ink)' }}>{label}</div>
      <div style={{
        height: 8, borderRadius: 4, background: 'rgba(125,200,255,0.06)', position: 'relative', overflow: 'hidden',
      }}>
        <div style={{
          position: 'absolute', inset: 0,
          width: animate ? `${val * 100}%` : '0%',
          background: invert
            ? 'linear-gradient(90deg, rgba(255,85,119,0.4), #ff5577)'
            : (val < 0.5
              ? 'linear-gradient(90deg, rgba(255,85,119,0.3), #ff5577)'
              : 'linear-gradient(90deg, rgba(106,255,200,0.3), #6affc8)'),
          boxShadow: '0 0 12px rgba(255,85,119,0.3)',
          borderRadius: 4,
          transition: `width 900ms cubic-bezier(0.2, 0.8, 0.2, 1) ${delay}ms`,
        }}></div>
      </div>
      <div className="num-mono" style={{ fontSize: 13, textAlign: 'right', color: invert || val < 0.5 ? 'var(--bad)' : 'var(--good)' }}>
        {(val * 100).toFixed(0)}%
      </div>
    </div>
  );
}

// TCAV ExplainScreen removed in the wire-live milestone — TCAV is out of scope
// per Plan.md §3 and MIGRATION_POSTMORTEM.md.

export {
  Chrome,
  WelcomeScreen, EnrollScreen, ProcessingScreen, VerifyScreen, DeepfakeScreen,
};
