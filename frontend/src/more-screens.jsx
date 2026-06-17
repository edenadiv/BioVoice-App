// Additional pages: Sidebar nav, Deepfake Creation Lab, Profile manager.

import React, { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { LivePulse, VoiceOrb, Waveform, SimilarityGauge, PipelineFlow } from "./visuals.jsx";
import { AmbientField } from "./console-ext.jsx";
import { Chrome } from "./screens.jsx";
import { generateSpoof, generateSpoofBatch, wavUrlFromBase64, getSpoofEngines, spoofTest, deleteUser, identifySpeaker, listLogs, getLogDetail, fetchLogAudio, getConfig, patchConfig } from "./lib/api";
import { usePerProfileVerifyCounts, daysSince, useRefreshSpeakers, useAppDispatch } from "./lib/session";
import { EnrollModal } from "./components/EnrollModal.tsx";
import { DegradedBanner } from "./components/DegradedBanner";
import { ExplainTab } from "./components/ExplainTab.tsx";
import { InfoButton } from "./components/InfoButton";
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
    { id: 'logs',     label: 'Logs',         icon: <><path d="M5 3h7l4 4v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M7 9h6M7 12h6M7 15h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></> },
    { id: 'lab',      label: 'Deepfake Lab', icon: <><circle cx="10" cy="10" r="6" stroke="currentColor" strokeWidth="1.5"/><path d="M6 10h8M10 6v8" stroke="currentColor" strokeWidth="1.5"/></> },
    { id: 'profiles', label: 'Profiles',     icon: <><circle cx="10" cy="7" r="3" stroke="currentColor" strokeWidth="1.5"/><path d="M3 17c0-3.3 3.1-6 7-6s7 2.7 7 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></> },
    { id: 'settings', label: 'Settings',     icon: <><circle cx="10" cy="10" r="2.6" stroke="currentColor" strokeWidth="1.5"/><path d="M10 2.5v2M10 15.5v2M17.5 10h-2M4.5 10h-2M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4M15.3 15.3l-1.4-1.4M6.1 6.1L4.7 4.7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></> },
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
            className="biovoice-sidebar-item"
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
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase' }}>{it.label}</span>
          </button>
        );
      })}
      <div style={{ flex: 1 }}></div>
      {/* Avatar at the bottom */}
      <div style={{
        width: 44, height: 44, borderRadius: '50%',
        background: 'linear-gradient(135deg, #7ef0ff, #3da9fc)',
        display: 'grid', placeItems: 'center', color: '#04070d',
        fontWeight: 600, fontSize: 18, cursor: 'pointer',
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
        spoofVotes: detection.spoofVotes ?? 0,
        spoofTotal: detection.spoofTotal ?? 0,
        spoofCluster: detection.spoofCluster ?? null,
        analysisDetails: detection.analysisDetails,
        modelProvenance: detection.modelProvenance,
        time: (elapsedMs / 1000).toFixed(2),
        engine: generation.engine ?? engineId,
        voice: generation.voice ?? voiceId,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      let friendly = msg;
      if (msg.includes('503') || msg.toLowerCase().includes('xtts') || msg.toLowerCase().includes('f5') || msg.toLowerCase().includes('cloning') || msg.toLowerCase().includes('tts')) {
        friendly = 'Spoof generation requires a voice-cloning engine (F5-TTS or XTTS-v2). Install it on the backend (see backend/README.md §voice-cloning spoof generation).';
      } else if (msg.toLowerCase().includes('reference') || msg.toLowerCase().includes('enrol') || msg.includes('404')) {
        friendly = `No reference sample for "${target}" — enrol them first via the Profiles page.`;
      }
      setError(friendly);
      setStage(0);
    } finally {
      setGenerating(false);
    }
  }, [target, text, engineId, voiceId]);

  // Batch Forge — generate many clones against the target and keep only
  // the candidates whose speaker-similarity to the target clears the bar.
  const [batchMode, setBatchMode] = useState(false);
  const [candidatesPerText, setCandidatesPerText] = useState(4);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchResult, setBatchResult] = useState(null);
  const [batchError, setBatchError] = useState(null);

  const generateBatch = useCallback(async () => {
    if (!target) { setBatchError('Enrol at least one profile first.'); return; }
    const texts = text.split('\n').map((t) => t.trim()).filter(Boolean);
    if (texts.length === 0) { setBatchError('Enter at least one utterance (one per line).'); return; }
    setBatchError(null);
    setBatchResult(null);
    setBatchRunning(true);
    try {
      const res = await generateSpoofBatch({
        targetUserId: target,
        texts,
        candidatesPerText,
        engine: engineId || undefined,
        voice: voiceId || undefined,
        language: 'en',
      });
      setBatchResult(res);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      let friendly = msg;
      if (msg.includes('503') || msg.toLowerCase().includes('xtts') || msg.toLowerCase().includes('f5') || msg.toLowerCase().includes('cloning') || msg.toLowerCase().includes('tts')) {
        friendly = 'Batch forge needs a voice-cloning engine (F5-TTS or XTTS-v2) on the backend.';
      } else if (msg.includes('404') || msg.toLowerCase().includes('enrol')) {
        friendly = `"${target}" isn't enrolled — add them in Profiles first.`;
      }
      setBatchError(friendly);
    } finally {
      setBatchRunning(false);
    }
  }, [target, text, candidatesPerText, engineId, voiceId]);

  // Precompute object URLs for kept candidates once per batch result so
  // we don't leak a new URL on every render.
  const batchUrls = useMemo(() => {
    const map = {};
    if (batchResult) {
      for (const c of batchResult.candidates) {
        if (c.kept && c.audioB64) map[c.index] = wavUrlFromBase64(c.audioB64);
      }
    }
    return map;
  }, [batchResult]);

  // Pipeline stage labels — names mirror the real backend pipeline.
  const stages = [
    { label: 'Cloning voice timbre', sub: 'Voice-cloning engine → 24 kHz waveform' },
    { label: 'Running BioVoice detector', sub: 'ECAPA Cluster Ensemble (K=7)' },
  ];

  return (
    <div className="screen fade-enter">
      <Chrome status="DEEPFAKE LABORATORY · ETHICAL USE ONLY" statusKind="warn" subtitle="Adversarial testing" screenName="DF LAB"/>
      <AmbientField count={50}/>

      <div className="biovoice-page-content biovoice-split-grid" style={{ position: 'absolute', inset: 0, padding: '150px 56px 90px 124px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 28, zIndex: 2 }}>

        {/* LEFT: Forge */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0, minHeight: 0 }}>
          <div>
            <div className="label-mono" style={{ fontSize: 13, color: 'var(--warn)', display: 'inline-flex', alignItems: 'center', gap: 8 }}>RED-TEAM · FORGE <InfoButton k="lab.generate"/></div>
            <div style={{ fontSize: 38, fontWeight: 200, marginTop: 4 }}>Create a deepfake</div>
            <div style={{ fontSize: 18, color: 'var(--ink-mute)', marginTop: 6, maxWidth: 540 }}>
              Try to clone an enrolled voice and use it to authenticate. BioVoice catches the fakes — even ones a human ear can't distinguish.
            </div>
          </div>

          <div className="panel" style={{ padding: 22, display: 'flex', flexDirection: 'column', gap: 18 }}>
            <Field label="TARGET VOICE">
              <div className="biovoice-target-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
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
                      display: 'grid', placeItems: 'center', color: '#04070d', fontWeight: 600, fontSize: 13,
                    }}>{p.initials}</div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</div>
                      <div className="label-mono" style={{ fontSize: 10 }}>{p.id}</div>
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
                  fontFamily: 'Sora, sans-serif', fontSize: 18,
                  outline: 'none',
                }}/>
            </Field>

            <Field label="TTS ENGINE  ·  PICK ONE">
              {enginesPayload === null ? (
                <div className="label-mono" style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
                  LOADING ENGINES…
                </div>
              ) : enginesPayload.engines.filter((e) => e.available).length === 0 ? (
                <div className="label-mono" style={{ fontSize: 13, color: 'var(--warn)' }}>
                  No voice-cloning engine available on the backend. Install F5-TTS or XTTS-v2 (see backend/README.md §voice-cloning spoof generation).
                </div>
              ) : (
                <div className="biovoice-engine-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
                  {enginesPayload.engines.map((e) => {
                    const disabled = !e.available;
                    const selected = engineId === e.id;
                    const isCloud = e.requiresNetwork;
                    return (
                      <button
                        key={e.id}
                        onClick={() => !disabled && handleEngineChange(e.id)}
                        disabled={disabled}
                        title={disabled ? `${e.label} isn't available on this backend.` : e.description}
                        className="lift"
                        style={{
                          padding: '12px 14px', borderRadius: 10,
                          cursor: disabled ? 'not-allowed' : 'pointer',
                          background: selected ? 'rgba(255,178,74,0.10)' : 'rgba(125,200,255,0.03)',
                          border: selected ? '1px solid rgba(255,178,74,0.55)' : '1px solid var(--line)',
                          color: disabled ? 'var(--ink-mute)' : 'var(--ink)',
                          textAlign: 'left', transition: 'all 200ms',
                          position: 'relative', opacity: disabled ? 0.5 : 1,
                          minHeight: 70,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                          <span style={{ fontSize: 15, fontWeight: 500 }}>{e.label}</span>
                          <span
                            className="label-mono"
                            style={{
                              fontSize: 10, padding: '2px 7px', borderRadius: 999,
                              letterSpacing: '0.18em', flexShrink: 0,
                              color: isCloud ? '#7ef0ff' : '#6affc8',
                              border: isCloud ? '1px solid rgba(126,240,255,0.45)' : '1px solid rgba(106,255,200,0.45)',
                              background: isCloud ? 'rgba(126,240,255,0.06)' : 'rgba(106,255,200,0.06)',
                            }}
                          >
                            {isCloud ? 'CLOUD' : 'LOCAL'}
                          </span>
                        </div>
                        <div className="label-mono" style={{ fontSize: 10, marginTop: 6, color: 'var(--ink-soft)' }}>
                          {disabled
                            ? 'UNAVAILABLE ON THIS BACKEND'
                            : 'CLONES FROM REFERENCE WAV'}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </Field>

            {selectedEngine && selectedEngine.voices.length > 1 && (
              <Field label={`VOICE  ·  ${selectedEngine.voices.length} AVAILABLE  ·  ${selectedEngine.requiresNetwork ? 'CLOUD' : 'LOCAL'}`}>
                <select
                  value={voiceId}
                  onChange={(e) => setVoiceId(e.target.value)}
                  size={1}
                  style={{
                    width: '100%', padding: '12px 14px',
                    background: 'rgba(125,200,255,0.04)',
                    border: '1px solid var(--line-2)',
                    borderRadius: 10, color: 'var(--ink)',
                    fontFamily: 'JetBrains Mono, monospace', fontSize: 15,
                    outline: 'none', cursor: 'pointer',
                  }}
                >
                  {(() => {
                    // Group voices by their `language` so a 400-entry
                    // dropdown stays navigable. Browser type-ahead still
                    // works inside each <optgroup>.
                    const groups = new Map();
                    for (const v of selectedEngine.voices) {
                      const key = v.language || '—';
                      if (!groups.has(key)) groups.set(key, []);
                      groups.get(key).push(v);
                    }
                    const sortedKeys = Array.from(groups.keys()).sort();
                    return sortedKeys.map((lang) => (
                      <optgroup key={lang} label={lang} style={{ background: '#070b14', color: 'var(--teal-2)' }}>
                        {groups.get(lang).map((v) => (
                          <option key={v.id} value={v.id} style={{ background: '#04070d', color: 'var(--ink)' }}>
                            {v.label}
                          </option>
                        ))}
                      </optgroup>
                    ));
                  })()}
                </select>
                <div className="label-mono" style={{ fontSize: 10, color: 'var(--ink-soft)', marginTop: 6 }}>
                  TYPE A LETTER TO JUMP · GROUPED BY LANGUAGE
                </div>
              </Field>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              {[['single', 'SINGLE'], ['batch', 'BATCH']].map(([m, label]) => {
                const active = batchMode === (m === 'batch');
                return (
                  <button key={m} onClick={() => setBatchMode(m === 'batch')} className="lift"
                    style={{ flex: 1, padding: '8px', borderRadius: 8, cursor: 'pointer',
                      background: active ? 'rgba(255,178,74,0.10)' : 'rgba(125,200,255,0.03)',
                      border: active ? '1px solid rgba(255,178,74,0.55)' : '1px solid var(--line)',
                      color: 'var(--ink)', fontFamily: 'JetBrains Mono, monospace', fontSize: 13, letterSpacing: '0.18em' }}>
                    {label}
                  </button>
                );
              })}
            </div>

            {batchMode && (
              <Field label="CANDIDATES PER UTTERANCE  ·  ONE UTTERANCE PER LINE">
                <input type="number" min={1} max={32} value={candidatesPerText}
                  onChange={(e) => setCandidatesPerText(Math.max(1, Math.min(32, Number(e.target.value) || 1)))}
                  style={{ width: '100%', padding: '10px 14px', background: 'rgba(125,200,255,0.04)',
                    border: '1px solid var(--line-2)', borderRadius: 10, color: 'var(--ink)',
                    fontFamily: 'JetBrains Mono, monospace', fontSize: 15, outline: 'none' }}/>
                <div className="label-mono" style={{ fontSize: 11, color: 'var(--ink-soft)', marginTop: 6 }}>
                  Every candidate is cloned from the target's reference voice, then kept only if it resembles them.
                </div>
              </Field>
            )}

            <button onClick={batchMode ? generateBatch : generate}
              disabled={batchMode ? batchRunning : generating} className="btn btn-primary"
              style={{ width: '100%', justifyContent: 'center', padding: '16px', fontSize: 18,
                opacity: (batchMode ? batchRunning : generating) ? 0.7 : 1,
                cursor: (batchMode ? batchRunning : generating) ? 'wait' : 'pointer' }}>
              {batchMode
                ? (batchRunning ? 'Forging batch…' : <>⚡  Forge batch &amp; keep matches</>)
                : (generating
                    ? (stage === 1 ? 'Cloning voice…' : 'Running detector…')
                    : <>⚡  Forge &amp; test attack</>)}
            </button>
            {!target && (
              <div className="label-mono" style={{ fontSize: 11, color: 'var(--warn)', marginTop: 4 }}>
                Enrol at least one profile in Profiles before forging.
              </div>
            )}
          </div>
        </div>

        {/* RIGHT: Outcome */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0, minHeight: 0 }}>
          <div>
            <div className="label-mono" style={{ fontSize: 13, color: 'var(--teal-2)', display: 'inline-flex', alignItems: 'center', gap: 8 }}>BLUE-TEAM · DETECTOR <InfoButton k="lab.test"/></div>
            <div style={{ fontSize: 38, fontWeight: 200, marginTop: 4 }}>BioVoice response</div>
          </div>

          {batchMode && (
            <div className="panel outline-glow" style={{ padding: 20, flex: 1, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, overflow: 'auto' }}>
              {batchRunning && (
                <div style={{ display: 'grid', placeItems: 'center', flex: 1, padding: 30 }}><ScanRings/></div>
              )}
              {batchError && !batchRunning && (
                <div style={{ color: '#ff8080', textAlign: 'center', padding: 20, fontFamily: 'JetBrains Mono, monospace', fontSize: 16 }}>{batchError}</div>
              )}
              {!batchRunning && !batchError && !batchResult && (
                <div style={{ display: 'grid', placeItems: 'center', flex: 1, color: 'var(--ink-soft)', textAlign: 'center', padding: 24 }}>
                  <div>
                    <div style={{ fontSize: 56, opacity: 0.3, marginBottom: 12 }}>◍</div>
                    <div style={{ fontSize: 18 }}>Forge a batch to keep only the clones that match the target.</div>
                    <div className="label-mono" style={{ fontSize: 11, marginTop: 6 }}>ONE UTTERANCE PER LINE</div>
                  </div>
                </div>
              )}
              {batchResult && !batchRunning && (
                <>
                  <DegradedBanner provenance={batchResult.modelProvenance} variant="full"/>
                  <div className="label-mono" style={{ fontSize: 13 }}>
                    KEPT {batchResult.kept} / {batchResult.generated} GENERATED · THRESHOLD {batchResult.keepThreshold.toFixed(2)}
                  </div>
                  {batchResult.candidates.length === 0 && (
                    <div style={{ color: 'var(--ink-soft)', fontSize: 16 }}>No candidates generated.</div>
                  )}
                  {batchResult.candidates.map((c) => (
                    <div key={c.index} style={{ padding: 12, borderRadius: 10,
                      background: c.kept ? 'rgba(106,255,200,0.06)' : 'rgba(125,200,255,0.03)',
                      border: c.kept ? '1px solid rgba(106,255,200,0.3)' : '1px solid var(--line)',
                      opacity: c.kept ? 1 : 0.6 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                        <span className="label-mono" style={{ fontSize: 11, color: c.kept ? '#6affc8' : 'var(--ink-soft)' }}>
                          #{c.index} · {c.kept ? 'KEPT' : 'DISCARDED'}
                        </span>
                        <span className="num-mono" style={{ fontSize: 20, color: c.kept ? '#6affc8' : 'var(--ink-mute)' }}>
                          {(c.similarityToTarget * 100).toFixed(1)}%
                        </span>
                      </div>
                      <div style={{ fontSize: 15, color: 'var(--ink-mute)', margin: '4px 0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.text}</div>
                      {c.decision && (
                        <div className="label-mono" style={{ fontSize: 10, color: c.decision === 'FAKE' ? 'var(--bad)' : 'var(--warn)' }}>
                          Ensemble {c.decision} · {c.deepfakeScore != null ? c.deepfakeScore.toFixed(3) : '—'}
                        </div>
                      )}
                      {c.kept && batchUrls[c.index] && (
                        <audio src={batchUrls[c.index]} controls style={{ width: '100%', marginTop: 8, borderRadius: 8 }}/>
                      )}
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
          {!batchMode && (<>
          {/* Pipeline */}
          <div className="panel" style={{ padding: 20 }}>
            <div className="label-mono" style={{ fontSize: 13, marginBottom: 14 }}>ATTACK PIPELINE</div>
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
                      color, fontSize: 14, fontWeight: 700,
                      animation: active ? 'breathe 1.2s ease-in-out infinite' : 'none',
                    }}>{done ? '✓' : i + 1}</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 16, color: pending ? 'var(--ink-soft)' : 'var(--ink)' }}>{s.label}</div>
                      <div className="label-mono" style={{ fontSize: 11 }}>{s.sub}</div>
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
                  <div style={{ fontSize: 56, opacity: 0.3, marginBottom: 12 }}>◌</div>
                  <div style={{ fontSize: 18 }}>Run an attack to see how BioVoice catches it.</div>
                  <div className="label-mono" style={{ fontSize: 11, marginTop: 6 }}>WAITING</div>
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
                  <div className="label-mono" style={{ fontSize: 13, marginBottom: 10, color: '#ff8080' }}>FORGE FAILED</div>
                  <div style={{ fontSize: 16, fontFamily: 'JetBrains Mono, monospace', maxWidth: 380, lineHeight: 1.5 }}>
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
                      fontSize: 14, letterSpacing: '0.2em', fontWeight: 600,
                    }}>⚠  DEEPFAKE DETECTED</div>
                  ) : (
                    <div style={{
                      padding: '6px 14px', borderRadius: 999,
                      border: '1px solid rgba(255,178,74,0.55)',
                      background: 'rgba(255,178,74,0.10)',
                      color: '#ffb24a', fontFamily: 'JetBrains Mono, monospace',
                      fontSize: 14, letterSpacing: '0.2em', fontWeight: 600,
                    }}>⚠  CLONE PASSED THE GATE</div>
                  )}
                  <div className="label-mono" style={{ fontSize: 11 }}>
                    ROUND-TRIP {result.time}s · {result.sourceDescription}
                  </div>
                </div>

                {/* Real audio playback of the generated clone — closes the
                     loop on "did the synthesis actually work?". */}
                <audio src={result.audioUrl} controls style={{
                  width: '100%', marginBottom: 16, borderRadius: 8,
                  background: 'rgba(0,0,0,0.4)',
                }}/>

                <div className="biovoice-lab-stats" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
                  <div style={{
                    padding: 14, borderRadius: 10,
                    background: result.decision === 'FAKE' ? 'rgba(255,85,119,0.06)' : 'rgba(255,178,74,0.06)',
                    border: '1px solid ' + (result.decision === 'FAKE' ? 'rgba(255,85,119,0.2)' : 'rgba(255,178,74,0.25)'),
                  }}>
                    <div className="label-mono" style={{ fontSize: 11 }}>ENSEMBLE DETECTION</div>
                    <div className="num-mono biovoice-numerals" style={{
                      fontSize: 38, marginTop: 4, fontWeight: 200,
                      color: result.decision === 'FAKE' ? '#ff5577' : '#ffb24a',
                    }}>
                      {result.spoofTotal > 0 ? `${result.spoofVotes}/${result.spoofTotal}` : result.dfScore.toFixed(3)}
                    </div>
                    <div className="label-mono" style={{
                      fontSize: 10, marginTop: 2,
                      color: result.decision === 'FAKE' ? 'var(--bad)' : 'var(--warn)',
                    }}>
                      {result.spoofTotal > 0
                        ? result.spoofVotes > 0
                          ? `${result.spoofVotes} SYSTEM${result.spoofVotes > 1 ? 'S' : ''} FLAGGED · SYNTHETIC`
                          : 'NO SYSTEMS FLAGGED · GATE FAILED TO CATCH'
                        : result.decision === 'FAKE' ? 'SYNTHETIC' : 'GATE FAILED TO CATCH'}
                    </div>
                    {result.spoofVotes > 0 && result.spoofCluster && (
                      <div className="label-mono" style={{ fontSize: 10, color: 'var(--ink-soft)', marginTop: 2 }}>
                        Flagged as: {result.spoofCluster.label} (cluster {result.spoofCluster.clusterId})
                      </div>
                    )}
                  </div>
                  <div style={{ padding: 14, borderRadius: 10, background: 'rgba(126,240,255,0.06)', border: '1px solid rgba(126,240,255,0.2)' }}>
                    <div className="label-mono" style={{ fontSize: 11 }}>ATTACK MODEL</div>
                    <div style={{ fontSize: 23, marginTop: 6, fontWeight: 300 }}>{result.model}</div>
                    <div className="label-mono" style={{ fontSize: 10, marginTop: 2 }}>VIA /me/spoof + /me/spoof/test</div>
                  </div>
                </div>

                <div className="label-mono" style={{ fontSize: 11, marginBottom: 8 }}>
                  {result.analysisDetails.mode === "trained_heads"
                    ? "ACOUSTIC SUB-AXES · TRAINED PROBE"
                    : "ACOUSTIC FEATURES (heuristic v1.0)"}
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
          </>)}
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
  const dispatch = useAppDispatch();

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
      dispatch({ type: "set-last-query", query: { embeddings: r.queryEmbeddings ?? {}, label: r.matches[0]?.userId ?? null } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg.length > 240 ? msg.slice(0, 240) + "…" : msg);
    } finally {
      setBusy(false);
    }
  }, [sample, dispatch]);

  const handleReset = useCallback(() => {
    setSample(null);
    setResult(null);
    setError(null);
    if (recorder.state === "recording") recorder.cancel();
  }, [recorder]);

  const stage = result ? 'results'
    : busy ? 'analyzing'
    : recorder.state === 'recording' ? 'recording'
    : sample ? 'captured'
    : 'idle';

  // Cycle the analyzing pipeline highlight while the request is in flight.
  const [analyzeStep, setAnalyzeStep] = useState(0);
  useEffect(() => {
    if (stage !== 'analyzing') { setAnalyzeStep(0); return; }
    const id = setInterval(() => setAnalyzeStep((s) => (s + 1) % 6), 360);
    return () => clearInterval(id);
  }, [stage]);

  const micPicker = (
    <div className="biovoice-input-row" style={{ display: 'flex', gap: 8, width: '100%', maxWidth: 520 }}>
      <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} disabled={recorder.state === 'recording'}
        aria-label="Microphone"
        style={{ flex: 1, padding: '13px 14px', borderRadius: 12, background: 'rgba(0,0,0,0.35)', color: 'var(--ink)', border: '1px solid rgba(125,200,255,0.18)', fontFamily: 'JetBrains Mono, monospace', fontSize: 15 }}>
        <option value="">Browser default mic</option>
        {devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
      </select>
      {devices.every((d) => !d.label || d.label === 'Microphone') && (
        <button onClick={handleEnableMicLabels} style={{ padding: '8px 12px', fontSize: 14, background: 'transparent', color: 'var(--teal-2)', border: '1px solid rgba(126,240,255,0.3)', borderRadius: 8, cursor: 'pointer' }}>Enable labels</button>
      )}
    </div>
  );

  const renderCapture = () => (
    <div className="biovoice-identify-center" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 26, height: '100%', textAlign: 'center' }}>
      <div>
        <div className="label-mono" style={{ fontSize: 15, color: 'var(--teal-2)', letterSpacing: '0.32em', display: 'inline-flex', alignItems: 'center', gap: 8 }}>WHO IS THIS VOICE? <InfoButton k="identify.capture"/></div>
        <div className="biovoice-identify-hero" style={{ fontSize: 68, fontWeight: 200, marginTop: 10, lineHeight: 1.02 }}>Most similar match</div>
        <div style={{ fontSize: 20, color: 'var(--ink-mute)', marginTop: 14, maxWidth: 620, marginInline: 'auto' }}>
          Record or upload a voice — it’s ranked against all <strong style={{ color: 'var(--ink)' }}>{profiles.length}</strong> enrolled profile{profiles.length === 1 ? '' : 's'} across three speaker models.
        </div>
      </div>

      <VoiceOrb size={300} level={sample ? 0.2 : 0.06} samples={recorder.samples} hue="cyan" intensity={sample ? 0.95 : 0.55}/>

      {!sample ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, width: '100%', maxWidth: 520 }}>
          {micPicker}
          <div style={{ display: 'flex', gap: 14, width: '100%' }}>
            <button onClick={handleStartRec} disabled={busy} className="biovoice-identify-cta"
              style={{ flex: 2, padding: '20px', borderRadius: 14, background: 'linear-gradient(180deg, #ff5577, #c8194a)', color: '#fff', border: 'none', cursor: 'pointer', fontFamily: 'JetBrains Mono, monospace', fontSize: 18, fontWeight: 700, letterSpacing: '0.1em', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
              <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#fff' }}/> START RECORDING
            </button>
            <button onClick={handleUploadClick} disabled={busy}
              style={{ flex: 1, padding: '20px', borderRadius: 14, background: 'transparent', color: 'var(--teal-2)', border: '1px solid rgba(126,240,255,0.35)', cursor: 'pointer', fontFamily: 'JetBrains Mono, monospace', fontSize: 16, fontWeight: 600, letterSpacing: '0.08em' }}>⤴ UPLOAD</button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18, width: '100%', maxWidth: 660 }}>
          <div style={{ width: '100%' }}>
            <Waveform samples={recorder.samples} width={660} height={88} bars={120} mirror/>
            <div className="label-mono" style={{ fontSize: 13, color: 'var(--ink-mute)', marginTop: 8 }}>READY · {sample.source.toUpperCase()} · {sample.durationSec.toFixed(1)}s</div>
          </div>
          <div style={{ display: 'flex', gap: 14, width: '100%' }}>
            <button onClick={handleSubmit} disabled={profiles.length === 0} className="biovoice-identify-cta"
              style={{ flex: 2, padding: '22px', borderRadius: 14, background: profiles.length > 0 ? 'linear-gradient(180deg, #7ef0ff, #3da9fc)' : 'rgba(125,200,255,0.06)', color: profiles.length > 0 ? '#04070d' : 'var(--ink-mute)', border: 'none', cursor: profiles.length > 0 ? 'pointer' : 'not-allowed', fontFamily: 'JetBrains Mono, monospace', fontSize: 19, fontWeight: 700, letterSpacing: '0.12em' }}>
              {profiles.length === 0 ? 'ENROL A PROFILE FIRST' : 'FIND TOP 3 MATCHES'}
            </button>
            <button onClick={handleReset}
              style={{ flex: 1, padding: '22px', borderRadius: 14, background: 'transparent', color: 'var(--ink-mute)', border: '1px solid rgba(125,200,255,0.18)', cursor: 'pointer', fontFamily: 'JetBrains Mono, monospace', fontSize: 15 }}>↺ REDO</button>
          </div>
        </div>
      )}
    </div>
  );

  const renderRecording = () => (
    <div className="biovoice-identify-center" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 28, height: '100%' }}>
      <div style={{ position: 'relative', display: 'grid', placeItems: 'center' }}>
        <div style={{ position: 'absolute', width: 380, height: 380, borderRadius: '50%', border: '1px solid rgba(255,85,119,0.4)', animation: 'scanring 2.4s ease-out infinite', pointerEvents: 'none' }}/>
        <VoiceOrb size={380} level={recorder.level} samples={recorder.samples} hue="cyan" intensity={1 + recorder.level * 2.4}/>
      </div>
      <div style={{ width: 'min(780px, 82vw)' }}>
        <Waveform samples={recorder.samples} width={780} height={130} bars={140} mirror color="#ff8aa6"/>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <LivePulse color="#ff5577" size={12}/>
        <span className="label-mono" style={{ fontSize: 16, color: '#ff8aa6', letterSpacing: '0.34em' }}>LISTENING</span>
        <span className="num-mono" style={{ fontSize: 48, fontWeight: 200, color: 'var(--ink)' }}>{(recorder.durationMs / 1000).toFixed(1)}s</span>
      </div>
      <button onClick={handleStopRec} className="biovoice-identify-cta"
        style={{ padding: '20px 56px', borderRadius: 14, background: 'linear-gradient(180deg, rgba(126,240,255,0.25), rgba(106,255,200,0.15))', color: '#fff', border: '1px solid rgba(126,240,255,0.55)', cursor: 'pointer', fontFamily: 'JetBrains Mono, monospace', fontSize: 19, fontWeight: 700, letterSpacing: '0.14em', display: 'flex', alignItems: 'center', gap: 14 }}>
        <span style={{ width: 14, height: 14, borderRadius: 3, background: '#fff' }}/> STOP
      </button>
    </div>
  );

  const renderAnalyzing = () => (
    <div className="biovoice-identify-center" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 30, height: '100%' }}>
      <VoiceOrb size={220} level={0.5} samples={recorder.samples} hue="cyan" intensity={1.7}/>
      <div className="biovoice-identify-hero" style={{ fontSize: 50, fontWeight: 200 }}>Comparing…</div>
      <div className="label-mono" style={{ fontSize: 15, color: 'var(--ink-mute)', letterSpacing: '0.2em' }}>
        RANKING ACROSS {profiles.length} ENROLLED VOICE{profiles.length === 1 ? '' : 'S'} · 3 MODELS
      </div>
      <div style={{ width: 'min(860px, 88vw)' }}>
        <PipelineFlow stages={[
          { icon: '🎙', title: 'Capture', subtitle: 'PCM 16k' },
          { icon: '▦', title: 'Mel-Spec', subtitle: '80 ch' },
          { icon: '◈', title: 'ReDimNet', subtitle: '192-d' },
          { icon: '◇', title: 'ECAPA', subtitle: '192-d' },
          { icon: '◆', title: 'WeSpeaker', subtitle: '256-d' },
          { icon: '⚖', title: 'Fuse', subtitle: 'vote' },
        ]} activeIdx={analyzeStep}/>
      </div>
    </div>
  );

  return (
    <div className="screen fade-enter">
      <Chrome status="OPEN-SET IDENTIFICATION" statusKind="info" subtitle="Most similar across all enrolled profiles" screenName="IDENTIFY"/>
      <AmbientField count={40}/>
      <input ref={fileInputRef} type="file" accept="audio/*,.wav,.mp3,.m4a,.ogg,.flac" onChange={handleFilePicked} style={{ display: 'none' }}/>

      <div className="biovoice-page-content" style={{ position: 'absolute', inset: 0, padding: '118px 48px 78px 120px', zIndex: 2, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {(error || (recorder.lastError && stage !== 'results')) && (
          <div style={{ padding: '10px 16px', borderRadius: 10, marginBottom: 14, background: 'rgba(255,128,128,0.08)', border: '1px solid rgba(255,128,128,0.35)', color: '#ffadad', fontSize: 15, fontFamily: 'JetBrains Mono, monospace' }}>
            {error || recorder.lastError}
          </div>
        )}
        <div key={stage} style={{ flex: 1, minHeight: 0, animation: 'fadeIn 520ms cubic-bezier(0.2,0.8,0.2,1) both' }}>
          {stage === 'recording' ? renderRecording()
            : stage === 'analyzing' ? renderAnalyzing()
            : stage === 'results' ? (
                <IdentifyResults result={result} profiles={profiles} wavFile={sample?.wavFile ?? null} onReset={handleReset}/>
              )
            : renderCapture()}
        </div>
      </div>
    </div>
  );
}

function IdentifyResults({ result, profiles, wavFile, onReset, resetLabel = '↺ IDENTIFY ANOTHER', eyebrow = 'RANKED MATCHES' }) {
  const scrollRef = useRef(null);
  const scrollByCard = (dir) => {
    const el = scrollRef.current;
    if (el) el.scrollBy({ left: dir * Math.min(760, el.clientWidth * 0.82), behavior: 'smooth' });
  };
  const modelLabel = (k) =>
    k === 'redimnet_b5' ? 'ReDimNet B5' :
    k === 'ecapa_voxceleb' ? 'ECAPA VoxCeleb' :
    k === 'wespeaker_resnet293_lm' ? 'WeSpeaker ResNet293' : k;

  const top = result.matches[0];
  const combined = result.speakerFusion?.combinedSimilarityScore ?? top?.similarityScore ?? 0;
  const cardBase = {
    flex: '0 0 auto', scrollSnapAlign: 'start', minHeight: 0,
    borderRadius: 18, padding: '20px 22px',
    background: 'linear-gradient(180deg, rgba(10,20,34,0.72), rgba(8,13,22,0.6))',
    border: '1px solid var(--line-2)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
  };
  const arrowStyle = {
    width: 38, height: 38, borderRadius: 10, display: 'grid', placeItems: 'center',
    background: 'rgba(8,14,24,0.6)', border: '1px solid var(--line-2)', color: 'var(--ink)',
    cursor: 'pointer', fontSize: 25, fontFamily: 'JetBrains Mono, monospace',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, height: '100%', minHeight: 0 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div className="label-mono" style={{ fontSize: 14, color: 'var(--teal-2)', letterSpacing: '0.32em' }}>{eyebrow}</div>
          <div className="biovoice-identify-hero" style={{ fontSize: 48, fontWeight: 200, marginTop: 4 }}>
            {top ? top.userId : 'No match'}
            <span style={{ color: 'var(--ink-soft)', fontSize: 28, marginLeft: 12 }}>{(combined * 100).toFixed(1)}%</span>
          </div>
          <div className="label-mono" style={{ fontSize: 13, color: 'var(--ink-mute)', marginTop: 4 }}>
            compared against {result.nEnrolledTotal} profile{result.nEnrolledTotal === 1 ? '' : 's'} · scroll →
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={() => scrollByCard(-1)} aria-label="Scroll results left" style={arrowStyle}>‹</button>
          <button onClick={() => scrollByCard(1)} aria-label="Scroll results right" style={arrowStyle}>›</button>
          <button onClick={onReset} aria-label="Reset results"
            style={{ ...arrowStyle, width: 'auto', padding: '0 18px', fontSize: 15, color: 'var(--teal-2)', letterSpacing: '0.1em' }}>{resetLabel}</button>
        </div>
      </div>

      <DegradedBanner provenance={result.modelProvenance} variant="compact"/>

      {/* Horizontal filmstrip of large result cards */}
      <div
        ref={scrollRef}
        className="biovoice-identify-filmstrip"
        role="region"
        aria-label="Identification results"
        tabIndex={0}
        style={{ flex: 1, minHeight: 0, display: 'flex', gap: 20, overflowX: 'auto', overflowY: 'hidden', scrollSnapType: 'x mandatory', padding: '2px 2px 12px' }}
      >
        {/* CARD 1 — Per-model Grad-CAM spectrograms, side by side */}
        <div className="biovoice-rise" style={{ ...cardBase, width: 'min(860px, 90vw)', animationDelay: '0ms' }}>
          <div className="label-mono" style={{ fontSize: 14, color: 'var(--teal-2)', marginBottom: 10, letterSpacing: '0.2em', display: 'inline-flex', alignItems: 'center', gap: 8 }}>PER-MODEL GRAD-CAM · vs {top?.userId ?? '—'} <InfoButton k="explain.gradcam"/></div>
          <div style={{ flex: 1, display: 'grid', placeItems: 'center', minHeight: 0, overflowY: 'auto' }}>
            <ExplainTab
              wavFile={wavFile ?? null}
              open={!!wavFile}
              matchUserId={top?.userId ?? null}
              layout="grid"
              panelWidth={800}
            />
          </div>
        </div>

        {/* CARD 2 — Top 3 + gauge */}
        <div className="biovoice-rise" style={{ ...cardBase, width: 'min(460px, 88vw)', animationDelay: '90ms' }}>
          <div className="label-mono" style={{ fontSize: 14, color: 'var(--teal-2)', marginBottom: 6, letterSpacing: '0.2em', display: 'inline-flex', alignItems: 'center', gap: 8 }}>TOP 3 · FUSED SCORE <InfoButton k="identify.gauge"/></div>
          <div style={{ display: 'grid', placeItems: 'center' }}>
            <SimilarityGauge value={combined} threshold={result.similarityThreshold} size={250} label={top?.userId ?? '—'}/>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4, overflowY: 'auto', minHeight: 0 }}>
            {result.matches.map((m, i) => {
              const profile = profiles.find((p) => (p.id ?? p.userId) === m.userId);
              const pct = (m.similarityScore * 100).toFixed(1);
              const above = m.similarityScore >= result.similarityThreshold;
              const accent = i === 0 ? (above ? '#7ef0ff' : '#ffb24a') : 'var(--ink-mute)';
              return (
                <div key={m.userId} style={{ padding: '12px 14px', borderRadius: 12, background: i === 0 ? 'rgba(126,240,255,0.06)' : 'rgba(125,200,255,0.02)', border: `1px solid ${i === 0 ? 'rgba(126,240,255,0.3)' : 'rgba(125,200,255,0.12)'}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span className="label-mono" style={{ fontSize: 20, color: accent, minWidth: 24 }}>#{i + 1}</span>
                    {profile && <div style={{ width: 30, height: 30, borderRadius: '50%', background: `linear-gradient(135deg, ${profile.color1}, ${profile.color2})`, display: 'grid', placeItems: 'center', color: '#04070d', fontSize: 14, fontWeight: 600 }}>{profile.initials}</div>}
                    <div style={{ flex: 1, minWidth: 0, fontSize: 18, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.userId}</div>
                    <div className="num-mono" style={{ fontSize: 25, color: accent, fontWeight: 600 }}>{pct}%</div>
                  </div>
                  <div style={{ height: 6, borderRadius: 3, background: 'rgba(0,0,0,0.4)', overflow: 'hidden', marginTop: 8 }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: i === 0 ? `linear-gradient(90deg, ${accent}88, ${accent})` : 'rgba(125,200,255,0.5)', transition: 'width 600ms cubic-bezier(.2,.8,.2,1)' }}/>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* CARD 3 — Per-model rankings */}
        {result.speakerModelMatches?.length > 0 && (
          <div className="biovoice-rise" style={{ ...cardBase, width: 'min(540px, 88vw)', animationDelay: '180ms' }}>
            <div className="label-mono" style={{ fontSize: 14, color: 'var(--teal-2)', marginBottom: 10, letterSpacing: '0.2em' }}>PER-MODEL RANKINGS</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto', minHeight: 0 }}>
              {result.speakerModelMatches.map((group) => (
                <div key={group.modelKey} style={{ padding: '12px 14px', borderRadius: 12, background: group.drivesDecision ? 'rgba(126,240,255,0.06)' : 'rgba(125,200,255,0.03)', border: `1px solid ${group.drivesDecision ? 'rgba(126,240,255,0.3)' : 'rgba(125,200,255,0.14)'}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <div style={{ fontSize: 18, fontWeight: 500 }}>{modelLabel(group.modelKey)}</div>
                    <div className="label-mono" style={{ fontSize: 10, color: 'var(--ink-soft)' }}>{group.drivesDecision ? 'ACTIVE' : 'COMPARISON'}</div>
                  </div>
                  <div style={{ display: 'grid', gap: 6 }}>
                    {group.matches.slice(0, 3).map((match, index) => {
                      const accent = index === 0 ? (group.drivesDecision ? '#7ef0ff' : '#bff4ff') : 'var(--ink-soft)';
                      return (
                        <div key={`${group.modelKey}-${match.userId}`} style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr) auto', gap: 10, alignItems: 'center', padding: '6px 10px', borderRadius: 8, background: 'rgba(0,0,0,0.16)' }}>
                          <span className="label-mono" style={{ fontSize: 13, color: accent, minWidth: 20 }}>#{index + 1}</span>
                          <span style={{ fontSize: 16, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{match.userId}</span>
                          <span className="num-mono" style={{ fontSize: 20, color: accent }}>{(match.similarityScore * 100).toFixed(1)}%</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* CARD 4 — Verdict */}
        <div className="biovoice-rise" style={{ ...cardBase, width: 'min(420px, 88vw)', animationDelay: '270ms', justifyContent: 'center', gap: 22 }}>
          <div className="label-mono" style={{ fontSize: 14, color: 'var(--teal-2)', letterSpacing: '0.2em' }}>VERDICT</div>
          <div>
            <div className="label-mono" style={{ fontSize: 11, color: 'var(--ink-mute)' }}>WOULD /VERIFY ACCEPT?</div>
            <div style={{ fontSize: 64, fontWeight: 700, lineHeight: 1, marginTop: 6, color: result.wouldAcceptTop1 ? 'var(--good)' : 'var(--bad)' }}>{result.wouldAcceptTop1 ? 'YES' : 'NO'}</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <div className="label-mono" style={{ fontSize: 11, color: 'var(--ink-mute)' }}>ENSEMBLE DETECTION</div>
              {result.spoofTotal > 0 ? (
                <>
                  <div className="num-mono" style={{ fontSize: 33, marginTop: 4, color: result.spoofVotes > 0 ? 'var(--bad)' : 'var(--good)' }}>
                    {result.spoofVotes}/{result.spoofTotal}
                  </div>
                  <div className="label-mono" style={{ fontSize: 10, color: 'var(--ink-soft)', marginTop: 2 }}>
                    {result.spoofVotes > 0 ? `${result.spoofVotes} SYSTEM${result.spoofVotes > 1 ? 'S' : ''} FLAGGED · FAKE` : 'NONE FLAGGED · GENUINE'}
                  </div>
                  {result.spoofVotes > 0 && result.spoofCluster && (
                    <div className="label-mono" style={{ fontSize: 10, color: 'var(--ink-soft)', marginTop: 2 }}>
                      Flagged as: {result.spoofCluster.label} (cluster {result.spoofCluster.clusterId})
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="num-mono" style={{ fontSize: 33, marginTop: 4, color: result.deepfakeScore >= result.deepfakeThreshold ? 'var(--good)' : 'var(--bad)' }}>{result.deepfakeScore.toFixed(3)}</div>
                  <div className="label-mono" style={{ fontSize: 10, color: 'var(--ink-soft)', marginTop: 2 }}>{result.deepfakeScore >= result.deepfakeThreshold ? 'GENUINE' : 'FAKE'} · thr {result.deepfakeThreshold.toFixed(2)}</div>
                </>
              )}
            </div>
            {result.speakerFusion && (
              <div>
                <div className="label-mono" style={{ fontSize: 11, color: 'var(--ink-mute)' }}>FUSION VOTE</div>
                <div className="num-mono" style={{ fontSize: 33, marginTop: 4, color: result.speakerFusion.combinedMatch ? 'var(--good)' : 'var(--warn)' }}>{result.speakerFusion.matchedModels}/{result.speakerFusion.totalModels}</div>
                <div className="label-mono" style={{ fontSize: 10, color: 'var(--ink-soft)', marginTop: 2 }}>need {result.speakerFusion.majorityRequired} · majority</div>
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
        <div style={{ fontSize: 15 }}>{name}</div>
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
      <span className="num-mono" style={{ fontSize: 16, color: '#ff7aa8', textAlign: 'right' }}>{(strength * 100).toFixed(0)}%</span>
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
      <div style={{ position: 'absolute', fontFamily: 'JetBrains Mono, monospace', fontSize: 13, letterSpacing: '0.2em', color: '#ffb24a' }}>ANALYZING</div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <div className="label-mono" style={{ fontSize: 11, marginBottom: 8 }}>{label}</div>
      {children}
    </div>
  );
}

// ============================================================================
// LogsScreen — unified verify + identify run history. Click a row to reopen
// the full result in the same filmstrip the Identify tab renders.
// ============================================================================
const MODEL_SHORT = {
  redimnet_b5: 'ReDimNet',
  ecapa_voxceleb: 'ECAPA',
  wespeaker_resnet293_lm: 'WeSpeaker',
};

const DECISION_TONE = {
  ACCEPT: 'var(--good)',
  REJECT: 'var(--warn)',
  DEEPFAKE: 'var(--bad)',
  'NO MATCH': 'var(--ink-mute)',
};

// Adapt a stored verify run into the IdentificationResult shape so the Logs
// detail reuses the exact same results view as a fresh identify run.
function verifyToIdentification(v, config) {
  const redimnet = v.speakerModelScores.find((s) => s.modelKey === 'redimnet_b5');
  const simThr = redimnet?.threshold ?? config?.similarityThreshold ?? 0.75;
  const dfThr = config?.deepfakeThreshold ?? 0.5;
  const mkMatch = (score, centroid) => ({
    userId: v.userId, similarityScore: score, centroidSimilarity: centroid, sampleCount: 0, enrolledAt: v.createdAt,
  });
  return {
    matches: [mkMatch(v.similarityScore, v.centroidSimilarity)],
    speakerModelMatches: v.speakerModelScores.map((s) => ({
      modelKey: s.modelKey,
      matches: [mkMatch(s.similarityScore, s.centroidSimilarity)],
      drivesDecision: s.drivesDecision,
    })),
    speakerFusion: v.speakerFusion,
    deepfakeScore: v.deepfakeScore,
    spoofVotes: v.spoofVotes ?? 0,
    spoofTotal: v.spoofTotal ?? 0,
    spoofCluster: v.spoofCluster ?? null,
    analysisDetails: v.analysisDetails,
    wouldAcceptTop1: v.decision === 'ACCEPT',
    similarityThreshold: simThr,
    deepfakeThreshold: dfThr,
    nEnrolledTotal: 1,
    modelProvenance: v.modelProvenance,
    queryEmbeddings: v.queryEmbeddings,
  };
}

function LogsScreen({ profiles }) {
  const [logs, setLogs] = useState(null);
  const [error, setError] = useState(null);
  const [config, setConfig] = useState(null);
  const [selected, setSelected] = useState(null); // { entry, result, wavFile }
  const [opening, setOpening] = useState(false);

  const loadLogs = useCallback(async () => {
    setError(null);
    try {
      const [entries, cfg] = await Promise.all([listLogs(), getConfig().catch(() => null)]);
      setLogs(entries);
      setConfig(cfg);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLogs([]);
    }
  }, []);

  useEffect(() => { loadLogs(); }, [loadLogs]);

  const openEntry = useCallback(async (entry) => {
    setOpening(true);
    try {
      const detail = await getLogDetail(entry.id);
      const result = detail.kind === 'verify'
        ? verifyToIdentification(detail.verify, config)
        : detail.identify;
      let wavFile = null;
      if (detail.hasAudio) {
        wavFile = await fetchLogAudio(entry.id).catch(() => null);
      }
      setSelected({ entry, result, wavFile });
    } catch (err) {
      window.alert(`Could not open run: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setOpening(false);
    }
  }, [config]);

  if (selected) {
    const k = selected.entry.kind;
    return (
      <div className="screen fade-enter">
        <Chrome status={`${k === 'verify' ? 'VERIFICATION' : 'IDENTIFICATION'} RUN`} subtitle={fmtTime(selected.entry.createdAt)} screenName="LOGS"/>
        <AmbientField count={30}/>
        <div style={{ position: 'absolute', inset: 0, padding: '128px 40px 40px 116px', overflow: 'hidden', zIndex: 2 }}>
          <IdentifyResults
            result={selected.result}
            profiles={profiles}
            wavFile={selected.wavFile}
            onReset={() => setSelected(null)}
            resetLabel="← BACK TO LOGS"
            eyebrow={k === 'verify' ? `VERIFY · ${selected.entry.label}` : 'RANKED MATCHES'}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="screen fade-enter">
      <Chrome status="RUN HISTORY" subtitle={logs ? `${logs.length} recorded run${logs.length === 1 ? '' : 's'}` : 'loading…'} screenName="LOGS"/>
      <AmbientField count={36}/>
      <div className="biovoice-scroll-page" style={{ position: 'absolute', inset: 0, padding: '150px 56px 110px 124px', overflow: 'auto', zIndex: 2 }}>
        <div style={{ maxWidth: 1180, margin: '0 auto' }}>
          <div className="biovoice-page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 24, gap: 16, flexWrap: 'wrap' }}>
            <div>
              <div className="label-mono" style={{ fontSize: 14, color: 'var(--teal-2)', display: 'inline-flex', alignItems: 'center', gap: 8 }}>VERIFY · IDENTIFY <InfoButton k="logs.list"/></div>
              <div style={{ fontSize: 48, fontWeight: 200, marginTop: 4 }}>Run logs</div>
              <div style={{ fontSize: 18, color: 'var(--ink-mute)', marginTop: 6 }}>Every verification and identification, newest first. Click a run to reopen its full result.</div>
            </div>
            <button onClick={loadLogs} className="btn" style={{ padding: '10px 18px', fontSize: 15, border: '1px solid var(--line-2)', borderRadius: 10, background: 'rgba(125,200,255,0.04)', color: 'var(--ink)', cursor: 'pointer' }}>↻ REFRESH</button>
          </div>

          {error && <div className="panel" style={{ padding: 20, color: '#ff7aa8', marginBottom: 16 }}>Failed to load logs: {error}</div>}

          {logs && logs.length === 0 && !error && (
            <div className="panel" style={{ padding: 40, textAlign: 'center', color: 'var(--ink-mute)' }}>
              <div className="label-mono" style={{ fontSize: 13, marginBottom: 8, color: 'var(--teal-2)' }}>NO RUNS YET</div>
              <div style={{ fontSize: 20 }}>Run a verification (Console) or identification (Identify) to populate the log.</div>
            </div>
          )}

          {logs && logs.length > 0 && (
            <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
              {/* Header row */}
              <div className="label-mono biovoice-log-row" style={{ display: 'grid', gridTemplateColumns: '96px 86px minmax(0,1fr) 110px 86px minmax(0,160px)', gap: 12, padding: '12px 18px', fontSize: 11, color: 'var(--ink-soft)', borderBottom: '1px solid var(--line-2)', letterSpacing: '0.12em' }}>
                <span>WHEN</span><span>TYPE</span><span>SUBJECT</span><span>DECISION</span><span>SCORE</span><span>MODELS</span>
              </div>
              {logs.map((e, i) => {
                const tone = DECISION_TONE[e.decision] ?? 'var(--ink)';
                return (
                  <button
                    key={e.id}
                    onClick={() => openEntry(e)}
                    disabled={opening}
                    className="biovoice-log-row"
                    style={{
                      width: '100%', textAlign: 'left', display: 'grid',
                      gridTemplateColumns: '96px 86px minmax(0,1fr) 110px 86px minmax(0,160px)', gap: 12,
                      alignItems: 'center', padding: '13px 18px', cursor: opening ? 'wait' : 'pointer',
                      background: i % 2 ? 'rgba(125,200,255,0.02)' : 'transparent',
                      border: 'none', borderBottom: '1px solid var(--line)', color: 'var(--ink)',
                      fontFamily: 'inherit',
                    }}
                    onMouseEnter={(ev) => (ev.currentTarget.style.background = 'rgba(126,240,255,0.06)')}
                    onMouseLeave={(ev) => (ev.currentTarget.style.background = i % 2 ? 'rgba(125,200,255,0.02)' : 'transparent')}
                  >
                    <span className="num-mono" style={{ fontSize: 14, color: 'var(--ink-mute)' }}>{fmtTime(e.createdAt)}</span>
                    <span className="label-mono" style={{ fontSize: 11, color: e.kind === 'verify' ? '#7ef0ff' : '#b27bff', border: `1px solid ${e.kind === 'verify' ? 'rgba(126,240,255,0.4)' : 'rgba(178,123,255,0.4)'}`, borderRadius: 6, padding: '3px 7px', textAlign: 'center', letterSpacing: '0.08em' }}>{e.kind === 'verify' ? 'VERIFY' : 'IDENTIFY'}</span>
                    <span style={{ fontSize: 18, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.label}</span>
                    <span className="label-mono" style={{ fontSize: 13, color: tone, letterSpacing: '0.06em' }}>{e.decision}</span>
                    <span className="num-mono" style={{ fontSize: 18, color: 'var(--teal-2)' }}>{(e.score * 100).toFixed(1)}%</span>
                    <span className="label-mono" style={{ fontSize: 11, color: 'var(--ink-soft)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {e.models.map((m) => MODEL_SHORT[m] ?? m).join(' · ')}{e.hasAudio ? '' : ' · no audio'}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function fmtTime(iso) {
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

// ============================================================================
// UserSettingsPage — comprehensive in-app settings (not the demo-mode panel).
// ============================================================================
const MODEL_FULL = {
  redimnet_b5: 'ReDimNet B5',
  ecapa_voxceleb: 'ECAPA-TDNN',
  wespeaker_resnet293_lm: 'WeSpeaker ResNet293',
};

function UserSettingsPage() {
  const [cfg, setCfg] = useState(null);
  const [err, setErr] = useState(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const flashRef = useRef(null);

  useEffect(() => {
    getConfig().then(setCfg).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  const apply = useCallback(async (partial) => {
    setErr(null);
    // Optimistic local update for instant feedback.
    setCfg((c) => (c ? { ...c, ...partial } : c));
    try {
      const next = await patchConfig(partial);
      setCfg(next);
      setSavedFlash(true);
      clearTimeout(flashRef.current);
      flashRef.current = setTimeout(() => setSavedFlash(false), 1400);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      getConfig().then(setCfg).catch(() => {}); // resync truth after a rejected patch
    }
  }, []);

  const setLocal = (partial) => setCfg((c) => (c ? { ...c, ...partial } : c));

  if (err && !cfg) {
    return (
      <div className="screen fade-enter">
        <Chrome status="CONFIG UNAVAILABLE" statusKind="bad" subtitle="settings" screenName="SETTINGS"/>
        <AmbientField count={30}/>
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', zIndex: 2 }}>
          <div className="panel" style={{ padding: 28, color: '#ff7aa8', maxWidth: 480 }}>Couldn’t load config: {err}</div>
        </div>
      </div>
    );
  }
  if (!cfg) {
    return (
      <div className="screen fade-enter">
        <Chrome status="LOADING" subtitle="settings" screenName="SETTINGS"/>
        <AmbientField count={30}/>
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', zIndex: 2, color: 'var(--ink-mute)' }}>Loading config…</div>
      </div>
    );
  }

  const matchHint = cfg.similarityThreshold < 0.7 ? 'Permissive · more false accepts' : cfg.similarityThreshold > 0.85 ? 'Strict · more false rejects' : 'Balanced';
  const toggleable = Object.fromEntries(cfg.models.map((m) => [m.key, m]));

  return (
    <div className="screen fade-enter">
      <Chrome
        status={cfg.provenance?.isDegraded ? 'DEGRADED · HEURISTIC FALLBACK' : 'OPERATIONAL · MODELS HEALTHY'}
        statusKind={cfg.provenance?.isDegraded ? 'warn' : 'good'}
        subtitle={savedFlash ? 'saved ✓' : 'live engine config'}
        screenName="SETTINGS"
      />
      <AmbientField count={40}/>

      <div className="biovoice-scroll-page" style={{ position: 'absolute', inset: 0, padding: '150px 56px 110px 124px', overflow: 'auto', zIndex: 2 }}>
        <div style={{ maxWidth: 1180, margin: '0 auto', paddingBottom: 40 }}>
          <div className="label-mono" style={{ fontSize: 14, color: 'var(--teal-2)' }}>ENGINE · LIVE</div>
          <div style={{ fontSize: 48, fontWeight: 200, marginTop: 6, marginBottom: 4 }}>Settings</div>
          <div style={{ fontSize: 18, color: 'var(--ink-mute)', marginBottom: 8 }}>
            Decision thresholds and model participation apply to the running backend immediately and persist across restarts.
          </div>
          {err && <div className="label-mono" style={{ fontSize: 14, color: '#ff7aa8', marginBottom: 18 }}>⚠ {err}</div>}
          <div style={{ marginBottom: 24 }}><DegradedBanner provenance={cfg.provenance} variant="compact"/></div>

          <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 32 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {['Detection', 'Per-model', 'Models', 'Engine'].map((s, i) => (
                <a key={s} href={`#sec-${i}`}
                  style={{ padding: '10px 14px', borderRadius: 10, color: 'var(--ink-mute)', textDecoration: 'none', fontSize: 16, background: 'transparent', cursor: 'pointer', transition: 'background 180ms, color 180ms' }}
                  onMouseEnter={e => { e.target.style.background = 'rgba(125,200,255,0.06)'; e.target.style.color = '#7ef0ff'; }}
                  onMouseLeave={e => { e.target.style.background = 'transparent'; e.target.style.color = 'var(--ink-mute)'; }}
                >{s}</a>
              ))}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <SectionCard id="sec-0" infoKey="settings.thresholds" title="Detection thresholds" desc="When does the system call something a match — or a fake? These gate ACCEPT / REJECT / DEEPFAKE.">
                <SliderRow label="Voice match threshold" value={cfg.similarityThreshold} min={0.5} max={0.95} step={0.01}
                  onChange={(v) => setLocal({ similarityThreshold: v })} onCommit={(v) => apply({ similarityThreshold: v })} hint={matchHint}/>
                <SliderRow label="Anti-spoof threshold" value={cfg.deepfakeThreshold} min={0.3} max={0.8} step={0.01}
                  onChange={(v) => setLocal({ deepfakeThreshold: v })} onCommit={(v) => apply({ deepfakeThreshold: v })} hint="Below = audio considered synthetic (DEEPFAKE)"/>
                <NumberRow label="Identify · top-N matches" value={cfg.identifyTopN} min={1} max={20} step={1}
                  onChange={(v) => apply({ identifyTopN: v })}/>
                <NumberRow label="Min enrollment samples" value={cfg.minEnrollmentSamples} min={1} max={10} step={1}
                  onChange={(v) => apply({ minEnrollmentSamples: v })}/>
              </SectionCard>

              <SectionCard id="sec-1" title="Per-model thresholds" desc="Each speaker model votes against its own cutoff; fusion takes the majority.">
                <SliderRow label="ReDimNet B5 (primary)" value={cfg.redimnetSimilarityThreshold} min={0.5} max={0.95} step={0.01}
                  onChange={(v) => setLocal({ redimnetSimilarityThreshold: v })} onCommit={(v) => apply({ redimnetSimilarityThreshold: v })}/>
                <SliderRow label="ECAPA-TDNN" value={cfg.ecapaSimilarityThreshold} min={0.5} max={0.95} step={0.01}
                  onChange={(v) => setLocal({ ecapaSimilarityThreshold: v })} onCommit={(v) => apply({ ecapaSimilarityThreshold: v })}/>
                <SliderRow label="WeSpeaker ResNet293" value={cfg.wespeakerSimilarityThreshold} min={0.5} max={0.95} step={0.01}
                  onChange={(v) => setLocal({ wespeakerSimilarityThreshold: v })} onCommit={(v) => apply({ wespeakerSimilarityThreshold: v })}/>
              </SectionCard>

              <SectionCard id="sec-2" infoKey="settings.models" title="Comparison models" desc="Toggle which encoders join the fusion vote. A model that didn’t load can’t be enabled.">
                <ToggleRow
                  label="ECAPA-TDNN" sub={toggleable.ecapa_voxceleb?.loaded ? 'SpeechBrain · 192-d' : 'not loaded on this server'}
                  value={cfg.enableEcapaComparison} disabled={!toggleable.ecapa_voxceleb?.canToggle}
                  onChange={(v) => apply({ enableEcapaComparison: v })}/>
                <ToggleRow
                  label="WeSpeaker ResNet293" sub={toggleable.wespeaker_resnet293_lm?.loaded ? 'ONNX · 256-d' : 'not loaded on this server'}
                  value={cfg.enableWespeakerComparison} disabled={!toggleable.wespeaker_resnet293_lm?.canToggle}
                  onChange={(v) => apply({ enableWespeakerComparison: v })}/>
              </SectionCard>

              <SectionCard id="sec-3" title="Engine" desc="Read-only runtime status.">
                <KV k="Sample rate" v={`${cfg.sampleRate} Hz`}/>
                <KV k="Active speaker models" v={cfg.models.filter((m) => m.participating).map((m) => MODEL_FULL[m.key] ?? m.key).join(' · ') || '—'}/>
                <KV k="Loaded encoders" v={cfg.models.filter((m) => m.loaded).map((m) => MODEL_FULL[m.key] ?? m.key).join(' · ') || '—'}/>
                <KV k="Detector" v={
                  cfg.provenance?.detector === 'ecapa_cluster_ensemble' ? 'ECAPA Cluster Ensemble (7 clusters)'
                  : cfg.provenance?.detector === 'ensemble' ? 'Ensemble (A01–A16)'
                  : cfg.provenance?.detector === 'aasist' ? 'AASIST'
                  : (cfg.provenance?.detector ?? '—')
                }/>
                <KV k="Encoder provenance" v={cfg.provenance?.encoder ?? '—'}/>
                <KV k="Status" v={cfg.provenance?.isDegraded ? 'Degraded (heuristic fallback)' : 'Healthy'}/>
              </SectionCard>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionCard({ id, title, desc, children, infoKey }) {
  return (
    <div id={id} className="panel" style={{ padding: 26 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ fontSize: 23, fontWeight: 400 }}>{title}</div>
        {infoKey && <InfoButton k={infoKey} />}
      </div>
      {desc && <div style={{ fontSize: 15, color: 'var(--ink-mute)', marginTop: 4, marginBottom: 18 }}>{desc}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>
    </div>
  );
}

function SliderRow({ label, value, min, max, step, onChange, onCommit, unit = '', hint }) {
  const commit = (e) => onCommit && onCommit(parseFloat(e.target.value));
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px 70px', alignItems: 'center', gap: 14, padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
      <div>
        <div style={{ fontSize: 16 }}>{label}</div>
        {hint && <div className="label-mono" style={{ fontSize: 11, marginTop: 2 }}>{hint}</div>}
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        onMouseUp={commit} onTouchEnd={commit} onKeyUp={commit}
        style={{ accentColor: '#7ef0ff', width: '100%' }}/>
      <span className="num-mono" style={{ fontSize: 20, color: '#7ef0ff', textAlign: 'right' }}>
        {value.toFixed(2)}{unit}
      </span>
    </div>
  );
}

function ToggleRow({ label, sub, value, onChange, disabled = false }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--line)', gap: 14, opacity: disabled ? 0.5 : 1 }}>
      <div>
        <div style={{ fontSize: 16 }}>{label}</div>
        {sub && <div className="label-mono" style={{ fontSize: 11, marginTop: 2 }}>{sub}</div>}
      </div>
      <button onClick={() => !disabled && onChange(!value)} disabled={disabled}
        title={disabled ? 'Model not loaded on this server' : undefined}
        style={{
          width: 46, height: 26, borderRadius: 999, position: 'relative', cursor: disabled ? 'not-allowed' : 'pointer',
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
      <div style={{ fontSize: 16 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button onClick={() => onChange(Math.max(min, value - step))}
          style={{ width: 28, height: 28, borderRadius: 8, border: '1px solid var(--line-2)', background: 'transparent', color: 'var(--ink)', cursor: 'pointer' }}>−</button>
        <span className="num-mono" style={{ width: 50, textAlign: 'center', fontSize: 20, color: '#7ef0ff' }}>{value}</span>
        <button onClick={() => onChange(Math.min(max, value + step))}
          style={{ width: 28, height: 28, borderRadius: 8, border: '1px solid var(--line-2)', background: 'transparent', color: 'var(--ink)', cursor: 'pointer' }}>+</button>
      </div>
    </div>
  );
}

function SelectRow({ label, value, onChange, options }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
      <div style={{ fontSize: 16 }}>{label}</div>
      <select value={value} onChange={e => onChange(e.target.value)}
        style={{
          background: 'rgba(125,200,255,0.04)', color: 'var(--ink)',
          border: '1px solid var(--line-2)', borderRadius: 8,
          padding: '8px 12px', fontFamily: 'Sora, sans-serif', fontSize: 16,
        }}>
        {options.map(o => <option key={o} value={o} style={{ background: '#0a1422' }}>{o}</option>)}
      </select>
    </div>
  );
}

function KV({ k, v }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
      <span className="label-mono" style={{ fontSize: 13 }}>{k}</span>
      <span className="num-mono" style={{ fontSize: 15, color: 'var(--ink)' }}>{v}</span>
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
      <div className="biovoice-page-content biovoice-scroll-page" style={{ position: 'absolute', inset: 0, padding: '150px 56px 110px 124px', overflow: 'auto', zIndex: 2 }}>
        <div className="biovoice-page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 28 }}>
          <div>
            <div className="label-mono" style={{ fontSize: 14, color: 'var(--teal-2)', display: 'inline-flex', alignItems: 'center', gap: 8 }}>VOICE PROFILES <InfoButton k="profiles.list"/></div>
            <div style={{ fontSize: 48, fontWeight: 200, marginTop: 4 }}>Enrolled voices</div>
            <div style={{ fontSize: 18, color: 'var(--ink-mute)', marginTop: 6 }}>Each profile is a 192-dimensional fingerprint — not a recording.</div>
          </div>
          <button className="btn btn-primary" style={{ padding: '12px 22px', fontSize: 16 }}
                  onClick={() => setShowEnroll(true)}>
            + &nbsp;ENROLL NEW
          </button>
        </div>

        {profiles.length === 0 ? (
          <div className="panel" style={{ padding: 40, textAlign: 'center', color: 'var(--ink-mute)' }}>
            <div className="label-mono" style={{ fontSize: 13, marginBottom: 8, color: 'var(--teal-2)' }}>NO PROFILES YET</div>
            <div style={{ fontSize: 20, marginBottom: 16 }}>Enrol your first speaker to get started.</div>
            <button className="btn btn-primary" onClick={() => setShowEnroll(true)} style={{ padding: '10px 20px', fontSize: 16 }}>
              + &nbsp;ENROLL FIRST PROFILE
            </button>
          </div>
        ) : (
          <div className="biovoice-profiles-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 18 }}>
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
                    fontSize: 18, lineHeight: 1, padding: 0,
                  }}>
                  ×
                </button>
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
                  <div style={{
                    width: 56, height: 56, borderRadius: '50%',
                    background: `linear-gradient(135deg, ${p.color1}, ${p.color2})`,
                    display: 'grid', placeItems: 'center',
                    color: '#04070d', fontWeight: 600, fontSize: 23,
                    boxShadow: `0 0 20px ${p.color1}66`,
                  }}>{p.initials}</div>
                  <div>
                    <div style={{ fontSize: 23 }}>{p.name}</div>
                    <div className="label-mono" style={{ fontSize: 13 }}>{p.id}</div>
                  </div>
                </div>
                <MiniWave color={p.color1} idx={i}/>
                <div className="biovoice-numerals biovoice-profile-stats" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 16, fontSize: 14 }}>
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
      <div className="label-mono" style={{ fontSize: 10 }}>{k}</div>
      <div className="num-mono" style={{ fontSize: 18, color: 'var(--teal-2)', marginTop: 2 }}>{v}</div>
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
  Sidebar, DeepfakeLab, IdentifyScreen, LogsScreen, UserSettingsPage, ProfilesPage,
};
