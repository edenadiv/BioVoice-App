// Additional pages: Sidebar nav, Deepfake Creation Lab, Profile manager.

import React, { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { LivePulse } from "./visuals.jsx";
import { AmbientField } from "./console-ext.jsx";
import { Chrome } from "./screens.jsx";
import { generateSpoof, getSpoofEngines, spoofTest, deleteUser, identifySpeaker } from "./lib/api";
import { usePerProfileVerifyCounts, daysSince, useRefreshSpeakers } from "./lib/session";
import { EnrollModal } from "./components/EnrollModal.tsx";
import { DegradedBanner } from "./components/DegradedBanner";
import {
  decodeAudioFileToWav,
  listAudioInputs,
  requestMicPermission,
  useVoiceRecorder,
} from "./lib/audio";

// ============================================================================
// Sidebar — three-item navigation rail (Console / DeepfakeLab / Profiles).
// ============================================================================
function Sidebar({ page, setPage }) {
  const items = [
    { id: 'console',  label: 'Console',      icon: <path d="M2 4h16M2 9h16M2 14h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/> },
    { id: 'identify', label: 'Identify',     icon: <><circle cx="9" cy="9" r="5" stroke="currentColor" strokeWidth="1.5"/><path d="M13 13l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></> },
    { id: 'lab',      label: 'Deepfake Lab', icon: <><circle cx="10" cy="10" r="6" stroke="currentColor" strokeWidth="1.5"/><path d="M6 10h8M10 6v8" stroke="currentColor" strokeWidth="1.5"/></> },
    { id: 'profiles', label: 'Profiles',     icon: <><circle cx="10" cy="7" r="3" stroke="currentColor" strokeWidth="1.5"/><path d="M3 17c0-3.3 3.1-6 7-6s7 2.7 7 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></> },
  ];
  return (
    <div className="biovoice-sidebar" style={{
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
// DeepfakeLab — interactive deepfake creation/detection.
//
// Two-step pipeline driven by the public backend routes:
//   1. POST /spoof          → XTTS clones `target_user_id`'s enrolled voice.
//   2. POST /spoof/test     → AASIST + F4 sub-classifier score the clone.
//
// XTTS missing on the server (503) and reference-missing surface as
// actionable error banners in the result panel.
// ============================================================================
function DeepfakeLab({ audio, profiles }) {
  const [target, setTarget] = useState(profiles[0]?.id ?? null);
  const [text, setText] = useState("Authorize transfer of two million dollars.");
  // T4 — engine + voice pickers. Loaded once from /spoof/engines on
  // mount; the voice list refreshes when the engine selection changes.
  const [enginesPayload, setEnginesPayload] = useState(null); // { engines, defaultEngine } | null
  const [engineId, setEngineId] = useState('');
  const [voiceId, setVoiceId] = useState('');
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [stage, setStage] = useState(0); // 0 idle, 1 cloning, 2 detecting, 3 done

  // Keep the target picker in sync as profiles arrive from the polling.
  useEffect(() => {
    if (!target && profiles[0]) setTarget(profiles[0].id);
  }, [profiles, target]);

  // Fetch the engine catalogue on mount; auto-pick the backend's
  // default engine + that engine's default voice.
  useEffect(() => {
    let cancelled = false;
    getSpoofEngines()
      .then((payload) => {
        if (cancelled) return;
        setEnginesPayload(payload);
        const defaultEngine =
          payload.engines.find((e) => e.id === payload.defaultEngine && e.available)
          ?? payload.engines.find((e) => e.available)
          ?? null;
        if (defaultEngine) {
          setEngineId(defaultEngine.id);
          setVoiceId(defaultEngine.defaultVoice ?? defaultEngine.voices[0]?.id ?? '');
        }
      })
      .catch(() => {
        if (!cancelled) setEnginesPayload({ engines: [], defaultEngine: null });
      });
    return () => { cancelled = true; };
  }, []);

  // When the engine changes, reset the voice to that engine's default.
  const selectedEngine = useMemo(
    () => enginesPayload?.engines.find((e) => e.id === engineId) ?? null,
    [enginesPayload, engineId],
  );
  const handleEngineChange = useCallback((newEngineId) => {
    setEngineId(newEngineId);
    const eng = enginesPayload?.engines.find((e) => e.id === newEngineId);
    if (eng) setVoiceId(eng.defaultVoice ?? eng.voices[0]?.id ?? '');
  }, [enginesPayload]);

  const targetProfile = profiles.find(p => p.id === target) || profiles[0];

  const generate = useCallback(async () => {
    if (!target) {
      setError("Enrol at least one profile in the Profiles page first.");
      return;
    }
    setError(null);
    setResult(null);
    setGenerating(true);
    setStage(1);
    const startedAt = performance.now();

    try {
      // Step 1 — synthesise the utterance via the chosen TTS engine.
      // Returns a blob URL we can play AND the fileName for the
      // spoof-test round-trip.
      const generation = await generateSpoof({
        targetUserId: target,
        text,
        language: 'en',
        engine: engineId || undefined,
        voice: voiceId || undefined,
      });
      setStage(2);

      // Step 2 — fetch the blob, run /spoof/test on it.
      const blob = await (await fetch(generation.audioUrl)).blob();
      const cloneFile = new File([blob], generation.fileName, { type: 'audio/wav' });
      const detection = await spoofTest(cloneFile);
      setStage(3);

      const elapsedMs = performance.now() - startedAt;
      setResult({
        audioUrl: generation.audioUrl,
        fileName: generation.fileName,
        sourceDescription: generation.sourceDescription,
        dfScore: detection.deepfakeScore,
        decision: detection.decision,
        analysisDetails: detection.analysisDetails,
        modelProvenance: detection.modelProvenance,
        time: (elapsedMs / 1000).toFixed(2),
        engine: generation.engine ?? engineId,
        voice: generation.voice ?? voiceId,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      let friendly = msg;
      if (msg.includes('503') || msg.toLowerCase().includes('xtts') || msg.toLowerCase().includes('tts')) {
        friendly = 'Spoof generation requires XTTS-v2. Install it on the backend (see backend/README.md §XTTS spoof generation).';
      } else if (msg.toLowerCase().includes('reference') || msg.toLowerCase().includes('enrol') || msg.includes('404')) {
        friendly = `No reference sample for "${target}" — enrol them first via the Profiles page.`;
      }
      setError(friendly);
      setStage(0);
    } finally {
      setGenerating(false);
    }
  }, [target, text, engineId, voiceId]);

  // Pipeline stage labels — names mirror the real backend pipeline.
  const stages = [
    { label: 'Cloning voice timbre', sub: 'XTTS-v2 → 24 kHz waveform' },
    { label: 'Running BioVoice detector', sub: 'AASIST + F4 sub-classifier' },
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

            <Field label="TTS ENGINE">
              {enginesPayload === null ? (
                <div className="label-mono" style={{ fontSize: 10, color: 'var(--ink-soft)' }}>
                  LOADING ENGINES…
                </div>
              ) : enginesPayload.engines.filter((e) => e.available).length === 0 ? (
                <div className="label-mono" style={{ fontSize: 10, color: 'var(--warn)' }}>
                  No TTS engines available on the backend. Install macOS `say` / espeak-ng, or expose internet for edge-tts / gTTS.
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
                  {enginesPayload.engines.map((e) => {
                    const disabled = !e.available;
                    const selected = engineId === e.id;
                    return (
                      <button
                        key={e.id}
                        onClick={() => !disabled && handleEngineChange(e.id)}
                        disabled={disabled}
                        title={disabled ? `${e.label} isn't available on this backend.` : e.description}
                        className="lift"
                        style={{
                          padding: '10px 12px', borderRadius: 10,
                          cursor: disabled ? 'not-allowed' : 'pointer',
                          background: selected ? 'rgba(255,178,74,0.10)' : 'rgba(125,200,255,0.03)',
                          border: selected ? '1px solid rgba(255,178,74,0.55)' : '1px solid var(--line)',
                          color: disabled ? 'var(--ink-mute)' : 'var(--ink)',
                          textAlign: 'left', transition: 'all 200ms',
                          position: 'relative', opacity: disabled ? 0.5 : 1,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                          <span style={{ fontSize: 12 }}>{e.label}</span>
                          {e.requiresNetwork && (
                            <span className="label-mono" style={{ fontSize: 7, color: 'var(--teal-2)', letterSpacing: '0.18em' }}>NET</span>
                          )}
                        </div>
                        <div className="label-mono" style={{ fontSize: 8, marginTop: 2, color: 'var(--ink-soft)' }}>
                          {disabled ? 'UNAVAILABLE' : `${e.voices.length} VOICE${e.voices.length === 1 ? '' : 'S'}`}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </Field>

            {selectedEngine && selectedEngine.voices.length > 0 && (
              <Field label={`VOICE  ·  ${selectedEngine.label}`}>
                <select
                  value={voiceId}
                  onChange={(e) => setVoiceId(e.target.value)}
                  style={{
                    width: '100%', padding: '10px 12px',
                    background: 'rgba(125,200,255,0.04)',
                    border: '1px solid var(--line-2)',
                    borderRadius: 10, color: 'var(--ink)',
                    fontFamily: 'JetBrains Mono, monospace', fontSize: 12,
                    outline: 'none', cursor: 'pointer',
                  }}
                >
                  {selectedEngine.voices.map((v) => (
                    <option key={v.id} value={v.id} style={{ background: '#04070d', color: 'var(--ink)' }}>
                      {v.label}{v.language ? `  ·  ${v.language}` : ''}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            <button onClick={generate} disabled={generating} className="btn btn-primary"
              style={{ width: '100%', justifyContent: 'center', padding: '16px', fontSize: 14,
                opacity: generating ? 0.7 : 1, cursor: generating ? 'wait' : 'pointer' }}>
              {generating
                ? (stage === 1 ? 'Cloning voice…' : 'Running detector…')
                : <>⚡  Forge & test attack</>}
            </button>
            {!target && (
              <div className="label-mono" style={{ fontSize: 9, color: 'var(--warn)', marginTop: 4 }}>
                Enrol at least one profile in Profiles before forging.
              </div>
            )}
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
            {!result && !generating && !error && (
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
            {error && !generating && (
              <div style={{
                display: 'grid', placeItems: 'center', flex: 1, padding: 24,
                color: '#ff8080', textAlign: 'center',
              }}>
                <div>
                  <div className="label-mono" style={{ fontSize: 10, marginBottom: 10, color: '#ff8080' }}>FORGE FAILED</div>
                  <div style={{ fontSize: 13, fontFamily: 'JetBrains Mono, monospace', maxWidth: 380, lineHeight: 1.5 }}>
                    {error}
                  </div>
                </div>
              </div>
            )}
            {result && (
              <div style={{ animation: 'fadeIn 600ms ease both' }}>
                <DegradedBanner provenance={result.modelProvenance} variant="full" style={{ marginBottom: 14 }}/>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16, flexWrap: 'wrap' }}>
                  {/* G14 — banner reflects the REAL detector decision instead of
                       always-DEEPFAKE. If AASIST flagged the clone (FAKE), the
                       gate caught it; if not (GENUINE), the clone slipped past
                       and the operator should know it. */}
                  {result.decision === 'FAKE' ? (
                    <div style={{
                      padding: '6px 14px', borderRadius: 999,
                      border: '1px solid rgba(255,85,119,0.5)',
                      background: 'rgba(255,85,119,0.10)',
                      color: '#ff5577', fontFamily: 'JetBrains Mono, monospace',
                      fontSize: 11, letterSpacing: '0.2em', fontWeight: 600,
                    }}>⚠  DEEPFAKE DETECTED</div>
                  ) : (
                    <div style={{
                      padding: '6px 14px', borderRadius: 999,
                      border: '1px solid rgba(255,178,74,0.55)',
                      background: 'rgba(255,178,74,0.10)',
                      color: '#ffb24a', fontFamily: 'JetBrains Mono, monospace',
                      fontSize: 11, letterSpacing: '0.2em', fontWeight: 600,
                    }}>⚠  CLONE PASSED THE GATE</div>
                  )}
                  <div className="label-mono" style={{ fontSize: 9 }}>
                    ROUND-TRIP {result.time}s · {result.sourceDescription}
                  </div>
                </div>

                {/* Real audio playback of the generated clone — closes the
                     loop on "did the synthesis actually work?". */}
                <audio src={result.audioUrl} controls style={{
                  width: '100%', marginBottom: 16, borderRadius: 8,
                  background: 'rgba(0,0,0,0.4)',
                }}/>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
                  <div style={{
                    padding: 14, borderRadius: 10,
                    background: result.decision === 'FAKE' ? 'rgba(255,85,119,0.06)' : 'rgba(255,178,74,0.06)',
                    border: '1px solid ' + (result.decision === 'FAKE' ? 'rgba(255,85,119,0.2)' : 'rgba(255,178,74,0.25)'),
                  }}>
                    <div className="label-mono" style={{ fontSize: 9 }}>AASIST AUTHENTICITY</div>
                    <div className="num-mono biovoice-numerals" style={{
                      fontSize: 30, marginTop: 4, fontWeight: 200,
                      color: result.decision === 'FAKE' ? '#ff5577' : '#ffb24a',
                    }}>{result.dfScore.toFixed(3)}</div>
                    <div className="label-mono" style={{
                      fontSize: 8, marginTop: 2,
                      color: result.decision === 'FAKE' ? 'var(--bad)' : 'var(--warn)',
                    }}>
                      {result.decision === 'FAKE' ? 'BELOW 0.50 · SYNTHETIC' : 'ABOVE 0.50 · GATE FAILED TO CATCH'}
                    </div>
                  </div>
                  <div style={{ padding: 14, borderRadius: 10, background: 'rgba(126,240,255,0.06)', border: '1px solid rgba(126,240,255,0.2)' }}>
                    <div className="label-mono" style={{ fontSize: 9 }}>ATTACK MODEL</div>
                    <div style={{ fontSize: 18, marginTop: 6, fontWeight: 300 }}>{result.model}</div>
                    <div className="label-mono" style={{ fontSize: 8, marginTop: 2 }}>VIA /me/spoof + /me/spoof/test</div>
                  </div>
                </div>

                <div className="label-mono" style={{ fontSize: 9, marginBottom: 8 }}>
                  {result.analysisDetails.mode === "trained_heads"
                    ? "ACOUSTIC SUB-AXES · TRAINED PROBE"
                    : "ACOUSTIC FEATURES (heuristic v1.0 · not from AASIST)"}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {/* G14 — real F4 sub-axis values from AcousticProbe instead
                       of four `0.81 + Math.random() * 0.1` placeholders. */}
                  {[
                    { name: 'Voice naturalness',     strength: result.analysisDetails.voiceNaturalness },
                    { name: 'Spectral consistency',  strength: result.analysisDetails.spectralConsistency },
                    { name: 'Temporal patterns',     strength: result.analysisDetails.temporalPatterns },
                    { name: 'Artifact detection',    strength: result.analysisDetails.artifactDetection },
                  ].map((a, i) => (
                    <ArtifactBar key={a.name} {...a} delay={i * 120}/>
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

// ============================================================================
// IdentifyScreen — open-set "most similar" feature.
//
// Operator records or uploads a sample, the backend ranks every enrolled
// profile by cosine similarity and returns the top-3. Useful for
// answering "who does this voice sound most like?" without committing
// to a single user_id up front.
// ============================================================================
function IdentifyScreen({ profiles }) {
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState("");
  const recorder = useVoiceRecorder({ minMs: 800, maxMs: null, deviceId: deviceId || undefined });

  const [sample, setSample] = useState(null); // { wavFile, durationSec, source }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null); // IdentificationResult
  const fileInputRef = useRef(null);

  // Mic devices ----------------------------------------------------------
  const reloadDevices = useCallback(async () => {
    const list = await listAudioInputs();
    setDevices(list);
    if (deviceId && !list.some((d) => d.deviceId === deviceId)) setDeviceId("");
  }, [deviceId]);
  useEffect(() => {
    void reloadDevices();
    if (!navigator.mediaDevices?.addEventListener) return;
    const handler = () => void reloadDevices();
    navigator.mediaDevices.addEventListener("devicechange", handler);
    return () => navigator.mediaDevices.removeEventListener("devicechange", handler);
  }, [reloadDevices]);
  const handleEnableMicLabels = useCallback(async () => {
    const ok = await requestMicPermission();
    if (!ok) {
      setError("Microphone access denied. Allow it in your browser settings.");
      return;
    }
    await reloadDevices();
  }, [reloadDevices]);

  // Recording ------------------------------------------------------------
  const handleStartRec = useCallback(async () => {
    setError(null);
    setResult(null);
    setSample(null);
    await recorder.start();
  }, [recorder]);
  const handleStopRec = useCallback(async () => {
    const rec = await recorder.stop();
    if (!rec) {
      setError(recorder.state === "denied" ? "Microphone access denied." : "Recording too short.");
      return;
    }
    setSample({ wavFile: rec.wavFile, durationSec: rec.durationSec, source: "record" });
  }, [recorder]);

  // Upload ---------------------------------------------------------------
  const handleUploadClick = useCallback(() => fileInputRef.current?.click(), []);
  const handleFilePicked = useCallback(async (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setError(null);
    setResult(null);
    setSample(null);
    try {
      const wav = await decodeAudioFileToWav(files[0]);
      const dur = Math.max(0, (wav.size - 44) / 32_000);
      setSample({ wavFile: wav, durationSec: dur, source: "upload" });
    } catch (err) {
      setError(`Couldn't decode "${files[0].name}": ${err instanceof Error ? err.message : String(err)}`);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  // Submit ---------------------------------------------------------------
  const handleSubmit = useCallback(async () => {
    if (!sample) return;
    setBusy(true);
    setError(null);
    try {
      const r = await identifySpeaker(sample.wavFile, 3);
      setResult(r);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg.length > 240 ? msg.slice(0, 240) + "…" : msg);
    } finally {
      setBusy(false);
    }
  }, [sample]);

  const handleReset = useCallback(() => {
    setSample(null);
    setResult(null);
    setError(null);
    if (recorder.state === "recording") recorder.cancel();
  }, [recorder]);

  return (
    <div className="screen fade-enter">
      <Chrome status="OPEN-SET IDENTIFICATION" statusKind="info" subtitle="Most similar across all enrolled profiles" screenName="IDENTIFY"/>
      <AmbientField count={40}/>

      <div style={{ position: 'absolute', inset: 0, padding: '150px 56px 90px 124px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 28, zIndex: 2 }}>

        {/* LEFT — capture */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>
          <div>
            <div className="label-mono" style={{ fontSize: 10, color: 'var(--teal-2)' }}>WHO IS THIS VOICE?</div>
            <div style={{ fontSize: 30, fontWeight: 200, marginTop: 4 }}>Most similar match</div>
            <div style={{ fontSize: 14, color: 'var(--ink-mute)', marginTop: 6, maxWidth: 540 }}>
              Capture or upload a voice sample. The system ranks all <strong>{profiles.length}</strong> enrolled profile{profiles.length === 1 ? '' : 's'} by cosine similarity and returns the top three matches.
            </div>
          </div>

          <div className="panel" style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 18 }}>
            <Field label="MICROPHONE">
              <div style={{ display: 'flex', gap: 8 }}>
                <select
                  value={deviceId}
                  onChange={(e) => setDeviceId(e.target.value)}
                  disabled={recorder.state === "recording"}
                  style={{
                    flex: 1, padding: '10px 12px', borderRadius: 10,
                    background: 'rgba(0,0,0,0.35)', color: 'var(--ink)',
                    border: '1px solid rgba(125,200,255,0.18)',
                    fontFamily: 'JetBrains Mono, monospace', fontSize: 12,
                  }}>
                  <option value="">Browser default</option>
                  {devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
                </select>
                {devices.every((d) => !d.label || d.label === "Microphone") && (
                  <button onClick={handleEnableMicLabels} style={{
                    padding: '8px 12px', fontSize: 11,
                    background: 'transparent', color: 'var(--teal-2)',
                    border: '1px solid rgba(126,240,255,0.3)', borderRadius: 8, cursor: 'pointer',
                  }}>Enable labels</button>
                )}
              </div>
            </Field>

            <div style={{ display: 'flex', gap: 12 }}>
              {recorder.state !== 'recording' ? (
                <button onClick={handleStartRec} disabled={!!sample || busy} style={{
                  flex: 1, padding: '14px 20px', borderRadius: 10,
                  background: sample ? 'rgba(125,200,255,0.05)' : 'linear-gradient(180deg, #ff5577, #c8194a)',
                  color: sample ? 'var(--ink-mute)' : '#fff',
                  border: 'none', cursor: sample ? 'not-allowed' : 'pointer',
                  fontFamily: 'JetBrains Mono, monospace', fontSize: 12, fontWeight: 600, letterSpacing: '0.08em',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                }}>
                  <span style={{ width: 10, height: 10, borderRadius: '50%', background: sample ? 'var(--ink-mute)' : '#fff' }}/>
                  START RECORDING
                </button>
              ) : (
                <button onClick={handleStopRec} style={{
                  flex: 1, padding: '14px 20px', borderRadius: 10,
                  background: 'linear-gradient(180deg, rgba(126,240,255,0.25), rgba(106,255,200,0.15))',
                  color: '#fff', border: '1px solid rgba(126,240,255,0.5)', cursor: 'pointer',
                  fontFamily: 'JetBrains Mono, monospace', fontSize: 12, fontWeight: 600, letterSpacing: '0.08em',
                }}>STOP — {(recorder.durationMs / 1000).toFixed(1)}s</button>
              )}
              <button onClick={handleUploadClick} disabled={recorder.state === 'recording' || busy} style={{
                padding: '14px 22px', borderRadius: 10,
                background: 'transparent', color: 'var(--teal-2)',
                border: '1px solid rgba(126,240,255,0.35)', cursor: recorder.state === 'recording' || busy ? 'not-allowed' : 'pointer',
                fontFamily: 'JetBrains Mono, monospace', fontSize: 12, fontWeight: 600, letterSpacing: '0.08em',
              }}>⤴ UPLOAD AUDIO</button>
              <input ref={fileInputRef} type="file" accept="audio/*,.wav,.mp3,.m4a,.ogg,.flac"
                onChange={handleFilePicked} style={{ display: 'none' }}/>
            </div>

            {sample && (
              <div className="label-mono" style={{ fontSize: 10, color: 'var(--ink-mute)' }}>
                READY · {sample.source.toUpperCase()} · {sample.durationSec.toFixed(1)}s
              </div>
            )}

            {recorder.lastError && (
              <div style={{
                padding: '10px 14px', borderRadius: 8,
                background: 'rgba(255,128,128,0.08)',
                border: '1px solid rgba(255,128,128,0.35)',
                color: '#ffadad', fontSize: 11, fontFamily: 'JetBrains Mono, monospace',
              }}>{recorder.lastError}</div>
            )}

            <div style={{ display: 'flex', gap: 12 }}>
              <button onClick={handleSubmit} disabled={!sample || busy || profiles.length === 0} style={{
                flex: 1, padding: '16px 24px', borderRadius: 10,
                background: sample && !busy && profiles.length > 0 ? 'linear-gradient(180deg, #7ef0ff, #3da9fc)' : 'rgba(125,200,255,0.05)',
                color: sample && !busy && profiles.length > 0 ? '#04070d' : 'var(--ink-mute)',
                border: 'none', cursor: sample && !busy && profiles.length > 0 ? 'pointer' : 'not-allowed',
                fontFamily: 'JetBrains Mono, monospace', fontSize: 13, fontWeight: 700, letterSpacing: '0.12em',
              }}>
                {busy ? 'COMPARING…' :
                 profiles.length === 0 ? 'ENROL A PROFILE FIRST' :
                 sample ? 'FIND TOP 3 MATCHES' : 'CAPTURE A SAMPLE FIRST'}
              </button>
              {(sample || result) && (
                <button onClick={handleReset} disabled={busy} style={{
                  padding: '16px 22px', borderRadius: 10,
                  background: 'transparent', color: 'var(--ink-mute)',
                  border: '1px solid rgba(125,200,255,0.18)', cursor: busy ? 'wait' : 'pointer',
                  fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
                }}>RESET</button>
              )}
            </div>

            {error && (
              <div style={{
                padding: '10px 14px', borderRadius: 8,
                background: 'rgba(255,128,128,0.08)',
                border: '1px solid rgba(255,128,128,0.35)',
                color: '#ffadad', fontSize: 12,
              }}>{error}</div>
            )}
          </div>
        </div>

        {/* RIGHT — results */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>
          <div>
            <div className="label-mono" style={{ fontSize: 10, color: 'var(--teal-2)' }}>RANKED MATCHES</div>
            <div style={{ fontSize: 30, fontWeight: 200, marginTop: 4 }}>
              {result ? `Top ${result.matches.length}` : 'Awaiting sample'}
            </div>
            <div style={{ fontSize: 13, color: 'var(--ink-mute)', marginTop: 6 }}>
              {result
                ? `Compared against ${result.nEnrolledTotal} enrolled profile${result.nEnrolledTotal === 1 ? '' : 's'}.`
                : 'Submit a sample to see the ranked list.'}
            </div>
          </div>

          {result && <IdentifyResults result={result} profiles={profiles}/>}
          {!result && (
            <div className="panel" style={{
              padding: '32px 24px', textAlign: 'center',
              color: 'var(--ink-mute)', fontSize: 13, lineHeight: 1.6,
            }}>
              The result panel will show similarity percentages and the deepfake verdict here once you submit.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function IdentifyResults({ result, profiles }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <DegradedBanner provenance={result.modelProvenance} variant="full"/>
      {result.matches.map((m, i) => {
        const profile = profiles.find((p) => (p.id ?? p.userId) === m.userId);
        const pct = (m.similarityScore * 100).toFixed(1);
        const above = m.similarityScore >= result.similarityThreshold;
        const accent = i === 0 ? (above ? '#7ef0ff' : '#ffb24a') : 'var(--ink-mute)';
        return (
          <div key={m.userId} className="panel" style={{
            padding: '16px 20px',
            background: i === 0 ? 'linear-gradient(180deg, rgba(126,240,255,0.08), rgba(126,240,255,0.02))' : 'rgba(125,200,255,0.02)',
            border: `1px solid ${i === 0 ? 'rgba(126,240,255,0.35)' : 'rgba(125,200,255,0.15)'}`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 10 }}>
              <span className="label-mono" style={{ fontSize: 18, color: accent, minWidth: 28 }}>#{i + 1}</span>
              {profile && (
                <div style={{
                  width: 36, height: 36, borderRadius: '50%',
                  background: `linear-gradient(135deg, ${profile.color1}, ${profile.color2})`,
                  display: 'grid', placeItems: 'center', color: '#04070d', fontSize: 12, fontWeight: 600,
                }}>{profile.initials}</div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 16, fontWeight: 500 }}>{m.userId}</div>
                <div className="label-mono" style={{ fontSize: 9, color: 'var(--ink-mute)', marginTop: 2 }}>
                  {m.sampleCount} enrol sample{m.sampleCount === 1 ? '' : 's'}
                </div>
              </div>
              <div className="num-mono" style={{ fontSize: 28, color: accent, letterSpacing: '-0.02em', fontWeight: 600 }}>
                {pct}%
              </div>
            </div>
            <div style={{ height: 8, borderRadius: 4, background: 'rgba(0,0,0,0.4)', overflow: 'hidden', position: 'relative' }}>
              <div style={{
                width: `${pct}%`, height: '100%',
                background: i === 0
                  ? `linear-gradient(90deg, ${accent}88, ${accent})`
                  : 'linear-gradient(90deg, rgba(125,200,255,0.4), rgba(125,200,255,0.7))',
                transition: 'width 600ms cubic-bezier(.2,.8,.2,1)',
              }}/>
              {/* Threshold marker */}
              <div title={`accept threshold ${(result.similarityThreshold * 100).toFixed(0)}%`} style={{
                position: 'absolute', top: -3, bottom: -3,
                left: `${result.similarityThreshold * 100}%`,
                width: 1.5, background: 'rgba(255,178,74,0.55)',
              }}/>
            </div>
          </div>
        );
      })}

      {/* Deepfake verdict + verdict summary */}
      <div className="panel" style={{ padding: '14px 20px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div>
          <div className="label-mono" style={{ fontSize: 9, color: 'var(--ink-mute)' }}>DEEPFAKE SCORE</div>
          <div className="num-mono" style={{
            fontSize: 22, marginTop: 4,
            color: result.deepfakeScore >= result.deepfakeThreshold ? 'var(--good)' : 'var(--bad)',
          }}>
            {result.deepfakeScore.toFixed(3)}
          </div>
          <div className="label-mono" style={{ fontSize: 9, color: 'var(--ink-soft)', marginTop: 2 }}>
            threshold {result.deepfakeThreshold.toFixed(2)} · {result.deepfakeScore >= result.deepfakeThreshold ? 'GENUINE' : 'FAKE'}
          </div>
        </div>
        <div>
          <div className="label-mono" style={{ fontSize: 9, color: 'var(--ink-mute)' }}>WOULD /VERIFY ACCEPT?</div>
          <div style={{
            fontSize: 22, marginTop: 4, fontWeight: 600,
            color: result.wouldAcceptTop1 ? 'var(--good)' : 'var(--bad)',
          }}>
            {result.wouldAcceptTop1 ? 'YES' : 'NO'}
          </div>
          <div className="label-mono" style={{ fontSize: 9, color: 'var(--ink-soft)', marginTop: 2 }}>
            top match vs sim ≥ {(result.similarityThreshold * 100).toFixed(0)}% + df ≥ {result.deepfakeThreshold.toFixed(2)}
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
// ProfilesPage — manage enrolled voice profiles (real-app feel).
// ============================================================================
function ProfilesPage({ profiles, audio }) {
  // G15 — per-card stats now derive from real session state instead of
  // per-render Math.random(). VERIFIED is the live ACCEPT count from
  // state.results; ENROLLED is days since speaker.enrolledAt; SAMPLES
  // replaces the synthetic QUALITY % (real quality persistence belongs
  // to a future enrollment_quality table — until then, sampleCount is
  // the most truthful proxy a profile card can render).
  const [hover, setHover] = useState(null);
  const [showEnroll, setShowEnroll] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const verifyCounts = usePerProfileVerifyCounts();
  const refreshSpeakers = useRefreshSpeakers();

  const handleDelete = useCallback(async (userId) => {
    if (!window.confirm(`Delete profile "${userId}"? This cannot be undone.`)) return;
    setDeleting(userId);
    try {
      await deleteUser(userId);
      await refreshSpeakers();
    } catch (err) {
      window.alert(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDeleting(null);
    }
  }, [refreshSpeakers]);

  return (
    <div className="screen fade-enter">
      <Chrome status="OPERATIONAL · ALL MODELS HEALTHY" statusKind="good" subtitle={`${profiles.length} enrolled profiles`} screenName="PROFILES"/>
      <AmbientField count={40}/>
      <div style={{ position: 'absolute', inset: 0, padding: '150px 56px 110px 124px', overflow: 'auto', zIndex: 2 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 28 }}>
          <div>
            <div className="label-mono" style={{ fontSize: 11, color: 'var(--teal-2)' }}>VOICE PROFILES</div>
            <div style={{ fontSize: 40, fontWeight: 200, marginTop: 4 }}>Enrolled voices</div>
            <div style={{ fontSize: 14, color: 'var(--ink-mute)', marginTop: 6 }}>Each profile is a 192-dimensional fingerprint — not a recording.</div>
          </div>
          <button className="btn btn-primary" style={{ padding: '12px 22px', fontSize: 13 }}
                  onClick={() => setShowEnroll(true)}>
            + &nbsp;ENROLL NEW
          </button>
        </div>

        {profiles.length === 0 ? (
          <div className="panel" style={{ padding: 40, textAlign: 'center', color: 'var(--ink-mute)' }}>
            <div className="label-mono" style={{ fontSize: 10, marginBottom: 8, color: 'var(--teal-2)' }}>NO PROFILES YET</div>
            <div style={{ fontSize: 16, marginBottom: 16 }}>Enrol your first speaker to get started.</div>
            <button className="btn btn-primary" onClick={() => setShowEnroll(true)} style={{ padding: '10px 20px', fontSize: 13 }}>
              + &nbsp;ENROLL FIRST PROFILE
            </button>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 18 }}>
            {profiles.map((p, i) => (
              <div key={p.id} className="panel lift"
                onMouseEnter={() => setHover(p.id)} onMouseLeave={() => setHover(null)}
                style={{
                  padding: 24, position: 'relative', overflow: 'hidden',
                  animation: `fadeIn 500ms ${i * 60}ms ease both`,
                  opacity: deleting === p.userId ? 0.4 : 1,
                  transition: 'opacity 200ms',
                }}>
                <div style={{
                  position: 'absolute', top: -40, right: -40, width: 160, height: 160, borderRadius: '50%',
                  background: `radial-gradient(circle, ${p.color1}33, transparent)`, opacity: hover === p.id ? 1 : 0.5,
                  transition: 'opacity 300ms',
                }}></div>
                {/* Delete button — top-right corner of each card */}
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); handleDelete(p.userId); }}
                  disabled={deleting === p.userId}
                  title={`Delete ${p.userId}`}
                  aria-label={`Delete ${p.userId}`}
                  style={{
                    position: 'absolute', top: 10, right: 10, zIndex: 4,
                    width: 28, height: 28, minWidth: 28, minHeight: 28, borderRadius: '50%',
                    background: 'rgba(255,85,119,0.10)', color: '#ff5577',
                    border: '1px solid rgba(255,85,119,0.30)',
                    cursor: deleting === p.userId ? 'wait' : 'pointer',
                    fontSize: 14, lineHeight: 1, padding: 0,
                  }}>
                  ×
                </button>
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
                  <div style={{
                    width: 56, height: 56, borderRadius: '50%',
                    background: `linear-gradient(135deg, ${p.color1}, ${p.color2})`,
                    display: 'grid', placeItems: 'center',
                    color: '#04070d', fontWeight: 600, fontSize: 18,
                    boxShadow: `0 0 20px ${p.color1}66`,
                  }}>{p.initials}</div>
                  <div>
                    <div style={{ fontSize: 18 }}>{p.name}</div>
                    <div className="label-mono" style={{ fontSize: 10 }}>{p.id}</div>
                  </div>
                </div>
                <MiniWave color={p.color1} idx={i}/>
                <div className="biovoice-numerals" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 16, fontSize: 11 }}>
                  <Stat2 k="VERIFIED" v={verifyCounts[p.userId] ?? 0}/>
                  <Stat2 k="ENROLLED" v={`${daysSince(p.enrolledAt)}d`}/>
                  <Stat2 k="SAMPLES"  v={`${p.sampleCount}/3`}/>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showEnroll && <EnrollModal onClose={() => setShowEnroll(false)} audio={audio}/>}
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
  Sidebar, DeepfakeLab, IdentifyScreen, UserSettingsPage, ProfilesPage,
};
