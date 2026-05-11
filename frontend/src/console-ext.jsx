// Console extras — high-impact visualizations and overlays for the operator console.
// Components: AmbientField, EmbeddingConstellation, LiveFeatures, VerificationOverlay,
// LiveClock, ThreatLevel, ScanLine.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Waveform, EmbeddingCloud } from "./visuals.jsx";
import {
  decodeAudioFileToWav,
  listAudioInputs,
  requestMicPermission,
  useVoiceRecorder,
} from "./lib/audio";
import { verifySpeaker } from "./lib/api";
import { useAppDispatch } from "./lib/session";
import { useCalibratedTimeline } from "./lib/useCalibratedTimeline";
import { SIM_THRESHOLD, DF_THRESHOLD } from "./lib/thresholds";
import { DegradedBanner } from "./components/DegradedBanner";
import {
  formantsLPC,
  jitterPercent,
  pitchAutocorrelation,
  snrFromVad,
} from "./lib/dsp";

// ============================================================================
// AmbientField — slow-drifting particles with parallax depth in the backdrop.
// Sits absolute-fill at z-index 1, behind all panels.
// ============================================================================
function AmbientField({ count = 80 }) {
  const ref = useRef();
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const ctx = c.getContext('2d');
    const dpr = 2;
    const W = 1920, H = 1080;
    c.width = W * dpr; c.height = H * dpr;
    c.style.width = W + 'px'; c.style.height = H + 'px';
    ctx.scale(dpr, dpr);
    const parts = Array.from({ length: count }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      z: 0.2 + Math.random() * 0.8,           // parallax depth
      vx: (Math.random() - 0.5) * 0.12,
      vy: -0.04 - Math.random() * 0.08,
      r: 0.6 + Math.random() * 1.6,
      tw: Math.random() * Math.PI * 2,        // twinkle phase
    }));
    let raf, t = 0;
    const draw = () => {
      t += 0.012;
      ctx.clearRect(0, 0, W, H);
      parts.forEach(p => {
        p.x += p.vx * p.z; p.y += p.vy * p.z;
        if (p.y < -10) { p.y = H + 10; p.x = Math.random() * W; }
        if (p.x < -10) p.x = W + 10;
        if (p.x > W + 10) p.x = -10;
        const tw = 0.45 + 0.55 * Math.sin(t * 1.4 + p.tw);
        ctx.fillStyle = `rgba(126,240,255,${0.15 * p.z * tw})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * p.z, 0, Math.PI * 2);
        ctx.fill();
        if (p.z > 0.7 && tw > 0.85) {
          ctx.strokeStyle = `rgba(126,240,255,${0.18 * p.z})`;
          ctx.lineWidth = 0.5;
          ctx.beginPath();
          ctx.moveTo(p.x - 4, p.y); ctx.lineTo(p.x + 4, p.y);
          ctx.moveTo(p.x, p.y - 4); ctx.lineTo(p.x, p.y + 4);
          ctx.stroke();
        }
      });
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [count]);
  return <canvas ref={ref} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 1, opacity: 0.55 }}/>;
}

// ============================================================================
// EmbeddingConstellation — 3D-rotating projection of the real ReDimNet
// 192-d voice space (PCA(3) computed from every enrolled centroid +
// per-sample embedding). The optional `livePoint` is the live mic
// embedding projected through the same basis — same coordinate system
// as the cluster centers, so spatial proximity is meaningful.
// ============================================================================
function EmbeddingConstellation({
  width = 420,
  height = 340,
  projectedProfiles,
  livePoint,
  matchId = null,
  loading = false,
}) {
  const ref = useRef();
  const matchRef = useRef(matchId);
  const liveRef = useRef(livePoint);
  matchRef.current = matchId;
  liveRef.current = livePoint;

  // Normalise the projected coords to a unit sphere for rendering.
  // PCA component magnitudes vary with the input scale; this keeps the
  // canvas geometry stable regardless of how many speakers are enrolled.
  const { centers, sampleDots, scale } = useMemo(() => {
    const profiles = projectedProfiles || [];
    if (profiles.length === 0) {
      return { centers: [], sampleDots: [], scale: 1 };
    }
    let maxMag = 0;
    for (const p of profiles) {
      for (const v of [p.centroid, ...(p.samples || [])]) {
        const m = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        if (m > maxMag) maxMag = m;
      }
    }
    const norm = maxMag > 0 ? 0.78 / maxMag : 1;
    const centers = profiles.map((p, idx) => ({
      id: p.userId,
      initials: p.initials,
      color: p.color1 || '#7ef0ff',
      cluster: idx,
      x: p.centroid[0] * norm,
      y: p.centroid[1] * norm,
      z: p.centroid[2] * norm,
    }));
    const dots = [];
    profiles.forEach((p, idx) => {
      for (const s of p.samples || []) {
        dots.push({
          x: s[0] * norm,
          y: s[1] * norm,
          z: s[2] * norm,
          cluster: idx,
          color: p.color1 || '#7ef0ff',
          id: p.userId,
        });
      }
    });
    return { centers, sampleDots: dots, scale: norm };
  }, [projectedProfiles]);

  useEffect(() => {
    const c = ref.current; if (!c) return;
    const ctx = c.getContext('2d');
    const dpr = 2;
    c.width = width * dpr; c.height = height * dpr;
    c.style.width = width + 'px'; c.style.height = height + 'px';
    ctx.scale(dpr, dpr);

    let raf, t = 0;
    const cx = width / 2, cy = height / 2;
    const proj = 320;
    const baseR = Math.min(width, height) * 0.42;

    function project(x, y, z, time) {
      const cy_ = Math.cos(time), sy_ = Math.sin(time);
      let x1 = x * cy_ - z * sy_;
      let z1 = x * sy_ + z * cy_;
      const cx_ = Math.cos(0.35), sx_ = Math.sin(0.35);
      let y1 = y * cx_ - z1 * sx_;
      let z2 = y * sx_ + z1 * cx_;
      const f = proj / (proj + z2 * baseR);
      return {
        x: cx + x1 * baseR * f,
        y: cy + y1 * baseR * f,
        depth: z2,
        scale: f,
      };
    }

    const draw = () => {
      t += 0.005;
      ctx.clearRect(0, 0, width, height);

      // ambient halo
      const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, baseR * 1.3);
      halo.addColorStop(0, 'rgba(61,169,252,0.12)');
      halo.addColorStop(1, 'rgba(4,7,13,0)');
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, width, height);

      // grid sphere wireframe (soft)
      ctx.strokeStyle = 'rgba(125,200,255,0.10)';
      ctx.lineWidth = 0.6;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI;
        ctx.beginPath();
        for (let j = 0; j <= 64; j++) {
          const u = (j / 64) * Math.PI * 2;
          const x = Math.cos(u) * Math.sin(a);
          const y = Math.cos(a);
          const z = Math.sin(u) * Math.sin(a);
          const p = project(x, y, z, t);
          if (j === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
      }

      // Per-sample dots — real per-recording 192-d embeddings projected.
      const projected = sampleDots.map((p) => {
        const pp = project(p.x, p.y, p.z, t);
        return { ...p, ...pp };
      }).sort((a, b) => a.depth - b.depth);

      projected.forEach(p => {
        const alpha = 0.45 + (p.scale - 0.5) * 0.6;
        const r = 1.6 * p.scale;
        const isMatch = matchRef.current === p.id;
        if (isMatch) {
          ctx.shadowBlur = 10;
          ctx.shadowColor = p.color;
        }
        ctx.fillStyle = hexA(p.color, isMatch ? Math.min(1, alpha + 0.3) : alpha);
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * (isMatch ? 1.3 : 1), 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      });

      // Cluster centres + labels.
      centers.forEach((c) => {
        const pp = project(c.x, c.y, c.z, t);
        const isMatch = matchRef.current === c.id;
        if (isMatch) {
          ctx.shadowBlur = 16;
          ctx.shadowColor = c.color;
        }
        ctx.fillStyle = hexA(c.color, isMatch ? 0.95 : 0.8);
        ctx.beginPath();
        ctx.arc(pp.x, pp.y, isMatch ? 4.5 : 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        if (pp.depth <= 0.15) {
          ctx.fillStyle = isMatch ? '#7ef0ff' : 'rgba(231,243,255,0.7)';
          ctx.font = `${isMatch ? 600 : 400} 9.5px "JetBrains Mono", monospace`;
          ctx.fillText(c.initials, pp.x + 6, pp.y - 6);
        }
        if (isMatch) {
          ctx.strokeStyle = '#7ef0ff';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(pp.x, pp.y, 14, 0, Math.PI * 2);
          ctx.stroke();
        }
      });

      // Live voice — real /embed projection, only if we have one.
      const live = liveRef.current;
      if (live) {
        const lp = project(live[0] * scale, live[1] * scale, live[2] * scale, t);
        ctx.shadowBlur = 18; ctx.shadowColor = '#7ef0ff';
        ctx.fillStyle = '#bff4ff';
        ctx.beginPath();
        ctx.arc(lp.x, lp.y, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        const pulse = 0.4 + 0.4 * Math.sin(t * 6);
        ctx.strokeStyle = `rgba(126,240,255,${pulse})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(lp.x, lp.y, 11, 0, Math.PI * 2);
        ctx.stroke();
        if (matchRef.current) {
          const m = centers.find(c => c.id === matchRef.current);
          if (m) {
            const mp = project(m.x, m.y, m.z, t);
            ctx.strokeStyle = `rgba(126,240,255,${0.3 + 0.3 * Math.sin(t * 4)})`;
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(lp.x, lp.y); ctx.lineTo(mp.x, mp.y);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        }
      }

      // Empty / loading state.
      if (centers.length === 0) {
        ctx.fillStyle = 'rgba(125,200,255,0.45)';
        ctx.font = '11px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(loading ? 'LOADING EMBEDDINGS…' : 'NO PROFILES ENROLLED', cx, cy);
        ctx.textAlign = 'start';
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [width, height, centers, sampleDots, scale, loading]);

  return <canvas ref={ref} style={{ display: 'block' }}/>;
}

// ============================================================================
// LiveFeatures — pitch / formants / jitter / SNR computed from the real
// rolling Float32 mic buffer using the algorithms in `lib/dsp.ts`:
// time-domain autocorrelation pitch, Levinson-Durbin LPC formants,
// cycle-to-cycle jitter, VAD-gated SNR. No FFT-bin shortcuts, no
// magic offsets, no per-frame faux jitter.
// ============================================================================
function LiveFeatures({ getRecentFloat, sampleRate, vadThreshold = 0.018 }) {
  const [feat, setFeat] = useState({ pitch: 0, f1: 0, f2: 0, f3: 0, jitter: 0, snr: 0, vad: false });
  const periodBufRef = useRef([]);

  useEffect(() => {
    let raf;
    const tick = () => {
      const samples = getRecentFloat ? getRecentFloat(0.5) : null;
      if (samples && samples.length > 256) {
        // Pitch — autocorrelation, sub-sample peak refinement.
        const pitch = pitchAutocorrelation(samples, sampleRate);
        // Formants — pre-emphasis + Hamming + LPC(order=12) + roots.
        const [f1, f2, f3] = formantsLPC(samples, sampleRate, 12);
        // Cycle-to-cycle jitter — keep a buffer of detected periods.
        if (pitch > 0) {
          const periodSamples = sampleRate / pitch;
          const buf = periodBufRef.current;
          buf.push(periodSamples);
          if (buf.length > 20) buf.shift();
        }
        const jitter = jitterPercent(periodBufRef.current);
        // SNR — VAD-gated, energy-based per-sample mask.
        // Window-averaged frame energy keeps the mask stable across short bursts.
        const FRAME = 320; // 20 ms at 16 kHz; scales naturally to 48 kHz too
        const energies = new Float32Array(Math.floor(samples.length / FRAME));
        for (let f = 0; f < energies.length; f++) {
          let sum = 0;
          const start = f * FRAME;
          for (let i = 0; i < FRAME; i++) {
            const v = samples[start + i];
            sum += v * v;
          }
          energies[f] = Math.sqrt(sum / FRAME);
        }
        // VAD threshold: bigger than absolute floor AND ≥ noise floor × 3.
        const sortedE = Array.from(energies).sort((a, b) => a - b);
        const noiseFloor = sortedE[Math.floor(sortedE.length * 0.2)] || 0;
        const vadMask = new Array(samples.length);
        for (let f = 0; f < energies.length; f++) {
          const isVoice = energies[f] > Math.max(vadThreshold, noiseFloor * 3);
          for (let i = 0; i < FRAME; i++) vadMask[f * FRAME + i] = isVoice;
        }
        for (let i = energies.length * FRAME; i < samples.length; i++) vadMask[i] = false;
        const snr = snrFromVad(samples, vadMask);
        const anyVoice = vadMask.some(Boolean);
        setFeat({ pitch, f1, f2, f3, jitter, snr, vad: anyVoice });
      } else {
        // Mic not yet active or ring not full enough.
        setFeat({ pitch: 0, f1: 0, f2: 0, f3: 0, jitter: 0, snr: 0, vad: false });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [getRecentFloat, sampleRate, vadThreshold]);

  const Cell = ({ label, value, unit, hint }) => (
    <div style={{
      padding: '10px 12px',
      borderRadius: 8,
      background: 'rgba(125,200,255,0.04)',
      border: '1px solid var(--line)',
      minWidth: 0,
    }}>
      <div className="label-mono" style={{ fontSize: 8.5, color: 'var(--ink-soft)' }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, marginTop: 2 }}>
        <span className="num-mono" style={{ fontSize: 17, color: 'var(--teal-2)', fontWeight: 300 }}>{value}</span>
        <span className="num-mono" style={{ fontSize: 9, color: 'var(--ink-soft)' }}>{unit}</span>
      </div>
      {hint && <div className="label-mono" style={{ fontSize: 8, color: 'var(--ink-soft)', marginTop: 2 }}>{hint}</div>}
    </div>
  );

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
      <Cell label="Pitch · F0" value={feat.pitch ? feat.pitch.toFixed(0) : '—'} unit="Hz" hint={feat.pitch > 165 ? 'female range' : feat.pitch > 0 ? 'male range' : 'silence'}/>
      <Cell label="Formant F1" value={feat.f1 ? feat.f1.toFixed(0) : '—'} unit="Hz" hint={feat.f2 ? `F2 ${feat.f2.toFixed(0)} · F3 ${feat.f3.toFixed(0)}` : 'LPC'}/>
      <Cell label="Jitter"     value={feat.jitter ? feat.jitter.toFixed(2) : '—'} unit="%" hint="cycle-to-cycle"/>
      <Cell label="SNR"        value={feat.snr ? feat.snr.toFixed(1) : '—'} unit="dB" hint={feat.vad ? 'voiced / unvoiced' : 'no voice'}/>
    </div>
  );
}

// ============================================================================
// LiveClock — UTC + local + session timer for chrome.
// ============================================================================
function LiveClock({ sessionStart }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const utc = new Date(now).toISOString().slice(11, 19);
  return (
    <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--teal-2)', letterSpacing: '0.18em', fontWeight: 500, whiteSpace: 'nowrap', flexShrink: 0 }}>
      {utc}<span style={{ color: 'var(--ink-soft)', marginLeft: 6 }}>UTC</span>
    </span>
  );
}

// ============================================================================
// ThreatLevel — animated indicator: GREEN/AMBER/RED depending on recent threats.
// ============================================================================
function ThreatLevel({ level = 'green' }) {
  const config = {
    green: { color: '#6affc8', label: 'NOMINAL' },
    amber: { color: '#ffb24a', label: 'ELEVATED' },
    red:   { color: '#ff5577', label: 'CRITICAL' },
  }[level];
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '5px 10px', borderRadius: 999, flexShrink: 0,
      border: `1px solid ${config.color}55`,
      background: `linear-gradient(135deg, ${config.color}15, transparent)`,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: config.color, boxShadow: `0 0 8px ${config.color}` }}></span>
      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9, color: config.color, letterSpacing: '0.18em', fontWeight: 600, whiteSpace: 'nowrap' }}>
        {config.label}
      </span>
    </div>
  );
}

// ============================================================================
// VerificationOverlay — runs the real verification.
//
// Operator-driven (no auto-record). Two ways to provide a sample:
//   1. START RECORDING → speak → STOP. No time limit. Live waveform / level.
//   2. UPLOAD AUDIO → file picker (mp3/m4a/wav/ogg/flac → in-browser decode).
//
// Once a sample is captured, the operator clicks SUBMIT VERIFICATION to
// POST /verify with profile.userId + the WAV. The decision panel shows
// the real similarity / deepfake score from the backend.
// ============================================================================

function VerificationOverlay({ profile, onClose }) {
  const dispatch = useAppDispatch();

  // Mic device picker
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState("");

  // Operator-driven recording (no auto-start, no time limit).
  const recorder = useVoiceRecorder({
    minMs: 800,
    maxMs: null,
    deviceId: deviceId || undefined,
  });

  // The captured sample — either from a recording or an upload.
  const [sample, setSample] = useState(null); // { wavFile: File, durationSec: number, source: "record" | "upload" }
  const [uploadError, setUploadError] = useState(null);
  const fileInputRef = useRef(null);

  // The in-flight verification promise drives the calibrated timeline.
  const [verifyPromise, setVerifyPromise] = useState(null);
  const [result, setResult] = useState(null); // VerificationResult on success
  const [error, setError] = useState(null);   // string on failure

  // -------- Mic device discovery --------
  const reloadDevices = useCallback(async () => {
    const list = await listAudioInputs();
    setDevices(list);
    if (deviceId && !list.some((d) => d.deviceId === deviceId)) {
      setDeviceId("");
    }
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

  // -------- Recording controls --------
  const handleStartRec = useCallback(async () => {
    setError(null);
    setUploadError(null);
    setSample(null);
    await recorder.start();
  }, [recorder]);

  const handleStopRec = useCallback(async () => {
    const rec = await recorder.stop();
    if (!rec) {
      setError(
        recorder.state === "denied"
          ? "Microphone access denied. Allow it in your browser to verify."
          : "Recording too short — speak for at least a second.",
      );
      return;
    }
    setSample({ wavFile: rec.wavFile, durationSec: rec.durationSec, source: "record" });
  }, [recorder]);

  // -------- File upload --------
  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);
  const handleFilePicked = useCallback(async (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setError(null);
    setUploadError(null);
    setSample(null);
    try {
      const wav = await decodeAudioFileToWav(files[0]);
      const dur = Math.max(0, (wav.size - 44) / 32_000);
      setSample({ wavFile: wav, durationSec: dur, source: "upload" });
    } catch (err) {
      setUploadError(`Couldn't decode "${files[0].name}": ${err instanceof Error ? err.message : String(err)}`);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  // -------- Submit --------
  const handleSubmit = useCallback(async () => {
    if (!sample) return;
    const userId = profile?.userId ?? profile?.id;
    const promise = verifySpeaker(userId, sample.wavFile);
    setVerifyPromise(promise);
    promise
      .then((verification) => {
        setResult(verification);
        dispatch({ type: "set-last-verification", result: verification });
        dispatch({ type: "prepend-result", result: verification });
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err ?? "Verification failed.");
        setError(message);
      });
  }, [sample, profile, dispatch]);

  const handleReset = useCallback(() => {
    setSample(null);
    setError(null);
    setUploadError(null);
    setVerifyPromise(null);
    setResult(null);
    if (recorder.state === "recording") recorder.cancel();
  }, [recorder]);

  const timeline = useCalibratedTimeline(verifyPromise, {
    stages: 2, // Embed, Match
    expectedTotalMs: 1500,
    slowAfterMs: 4000,
  });

  const phase = useMemo(() => {
    if (result || error) return 3;
    if (verifyPromise) return 1 + timeline.activeIdx;
    return 0;
  }, [verifyPromise, result, error, timeline.activeIdx]);

  const passing = result?.decision === "ACCEPT";
  const errored = error !== null;
  const accent = errored || (result && !passing) ? "#ff5577" : "#7ef0ff";

  // Pull display values straight from the response — no client-side derivation.
  const similarity = result?.similarityScore ?? 0;
  const dfScore = result?.deepfakeScore ?? 0;

  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 200,
      background: 'radial-gradient(ellipse at center, rgba(7,17,30,0.96) 0%, rgba(4,7,13,0.98) 70%)',
      backdropFilter: 'blur(14px)',
      animation: 'fadeIn 380ms ease both',
      display: 'grid',
      gridTemplateRows: '1fr auto',
    }}>
      {/* Scan line sweep */}
      <div style={{
        position: 'absolute', left: 0, right: 0, top: 0, height: 2,
        background: `linear-gradient(90deg, transparent, ${accent}, transparent)`,
        boxShadow: `0 0 18px ${accent}`,
        animation: 'scanY 2.4s ease-in-out infinite',
        opacity: phase < 3 ? 1 : 0.3,
      }}/>

      <div style={{ display: 'grid', placeItems: 'center', padding: 80 }}>
        <div style={{ width: 1100, textAlign: 'center', position: 'relative' }}>
          <div className="label-mono" style={{ fontSize: 11, color: accent, letterSpacing: '0.32em' }}>
            VERIFYING · {profile?.id || 'UNKNOWN'}
          </div>
          <div style={{ fontSize: 56, fontWeight: 200, marginTop: 14, letterSpacing: '-0.02em' }}>
            {phase === 0 && (
              recorder.state === 'denied'
                ? <>Microphone <em className="serif" style={{ color: accent }}>blocked</em></>
                : sample
                  ? <>Sample <em className="serif" style={{ color: accent }}>ready</em></>
                  : <>Provide a voice <em className="serif" style={{ color: accent }}>sample</em></>
            )}
            {phase === 1 && <>Computing <em className="serif" style={{ color: accent }}>embedding</em></>}
            {phase === 2 && (
              timeline.isSlow
                ? <>Still <em className="serif" style={{ color: accent }}>working</em>…</>
                : <>Matching against <em className="serif" style={{ color: accent }}>{profile?.name}</em></>
            )}
            {phase === 3 && errored && <>Verification <em className="serif" style={{ color: accent }}>failed</em></>}
            {phase === 3 && !errored && passing && <>Identity <em className="serif" style={{ color: accent }}>confirmed</em></>}
            {phase === 3 && !errored && !passing && <>Identity <em className="serif" style={{ color: accent }}>denied</em></>}
          </div>

          {/* Phase indicator dots */}
          <div style={{ display: 'flex', gap: 18, justifyContent: 'center', marginTop: 32 }}>
            {['Capture', 'Embed · 192-d', 'Cosine match', 'Decision'].map((p, i) => {
              const done = i < phase;
              const active = i === phase;
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, opacity: i > phase ? 0.35 : 1 }}>
                  <div style={{
                    width: 12, height: 12, borderRadius: '50%',
                    background: done ? accent : (active ? `${accent}88` : 'rgba(125,200,255,0.15)'),
                    boxShadow: active ? `0 0 14px ${accent}` : 'none',
                    border: active ? `1px solid ${accent}` : 'none',
                    animation: active ? 'pulse 1.2s ease-in-out infinite' : 'none',
                  }}/>
                  <span className="label-mono" style={{ fontSize: 10, whiteSpace: 'nowrap' }}>{p}</span>
                </div>
              );
            })}
          </div>

          {/* Phase-specific visualization */}
          <div style={{ marginTop: 60, height: 320, position: 'relative', display: 'grid', placeItems: 'center' }}>
            {phase === 0 && (
              <div style={{ width: 720, display: 'flex', flexDirection: 'column', gap: 16 }}>
                {/* Live waveform — flat unless recording */}
                <div style={{ position: 'relative', height: 200, background: 'rgba(0,0,0,0.3)', borderRadius: 12, border: `1px solid ${accent}33` }}>
                  <Waveform samples={recorder.samples} width={720} height={200} bars={120} mirror={true} color={accent}/>
                  <div style={{ position: 'absolute', left: 12, top: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className={`pill ${recorder.state === 'recording' ? 'good' : 'warn'}`}>
                      <span className="dot"></span>
                      {recorder.state === 'recording'
                        ? `RECORDING · ${(recorder.durationMs / 1000).toFixed(1)}s`
                        : recorder.state === 'requesting' ? 'AWAITING MIC'
                        : recorder.state === 'denied' ? 'MIC BLOCKED'
                        : sample ? `${sample.source.toUpperCase()} · ${sample.durationSec.toFixed(1)}s ready`
                        : 'IDLE'}
                    </span>
                  </div>
                </div>

                {/* Mic device picker */}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span className="label-mono" style={{ fontSize: 9, color: 'var(--ink-mute)', minWidth: 44 }}>MIC</span>
                  <select
                    value={deviceId}
                    onChange={(e) => setDeviceId(e.target.value)}
                    disabled={recorder.state === 'recording'}
                    style={{
                      flex: 1, padding: '8px 12px', borderRadius: 8,
                      background: 'rgba(0,0,0,0.35)', color: 'var(--ink)',
                      border: '1px solid rgba(125,200,255,0.18)',
                      fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
                    }}>
                    <option value="">Browser default</option>
                    {devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
                  </select>
                  {devices.every((d) => !d.label || d.label === "Microphone") && (
                    <button onClick={handleEnableMicLabels} style={{
                      padding: '8px 12px', fontSize: 10,
                      background: 'transparent', color: accent,
                      border: `1px solid ${accent}55`, borderRadius: 6, cursor: 'pointer',
                    }}>Enable labels</button>
                  )}
                </div>

                {/* Capture controls */}
                <div style={{ display: 'flex', gap: 12 }}>
                  {recorder.state !== 'recording' ? (
                    <button onClick={handleStartRec} disabled={!!sample} style={{
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
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
                    }}>
                      <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#7eF0FF', animation: 'pulse 0.9s infinite' }}/>
                      STOP — {(recorder.durationMs / 1000).toFixed(1)}s
                    </button>
                  )}
                  <button onClick={handleUploadClick} disabled={recorder.state === 'recording'} style={{
                    padding: '14px 22px', borderRadius: 10,
                    background: 'transparent', color: accent,
                    border: `1px solid ${accent}55`, cursor: recorder.state === 'recording' ? 'not-allowed' : 'pointer',
                    fontFamily: 'JetBrains Mono, monospace', fontSize: 12, fontWeight: 600, letterSpacing: '0.08em',
                  }}>⤴ UPLOAD AUDIO</button>
                  <input ref={fileInputRef} type="file"
                    accept="audio/*,.wav,.mp3,.m4a,.ogg,.flac" onChange={handleFilePicked}
                    style={{ display: 'none' }}/>
                </div>

                {uploadError && (
                  <div style={{
                    padding: '10px 14px', borderRadius: 8,
                    background: 'rgba(255,128,128,0.08)',
                    border: '1px solid rgba(255,128,128,0.35)',
                    color: '#ffadad', fontSize: 11,
                  }}>{uploadError}</div>
                )}

                {recorder.lastError && (
                  <div style={{
                    padding: '10px 14px', borderRadius: 8,
                    background: 'rgba(255,128,128,0.08)',
                    border: '1px solid rgba(255,128,128,0.35)',
                    color: '#ffadad', fontSize: 10, fontFamily: 'JetBrains Mono, monospace',
                  }}>{recorder.lastError}</div>
                )}

                {/* Submit */}
                <div style={{ display: 'flex', gap: 12 }}>
                  <button
                    onClick={handleSubmit}
                    disabled={!sample}
                    style={{
                      flex: 1, padding: '16px 24px', borderRadius: 10,
                      background: sample ? `linear-gradient(180deg, ${accent}, #3da9fc)` : 'rgba(125,200,255,0.05)',
                      color: sample ? '#04070d' : 'var(--ink-mute)',
                      border: 'none', cursor: sample ? 'pointer' : 'not-allowed',
                      fontFamily: 'JetBrains Mono, monospace', fontSize: 13, fontWeight: 700, letterSpacing: '0.12em',
                    }}>
                    {sample ? `SUBMIT VERIFICATION · ${profile?.id || ''}` : 'CAPTURE A SAMPLE FIRST'}
                  </button>
                  {sample && (
                    <button onClick={handleReset} style={{
                      padding: '16px 22px', borderRadius: 10,
                      background: 'transparent', color: 'var(--ink-mute)',
                      border: '1px solid rgba(125,200,255,0.18)', cursor: 'pointer',
                      fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
                    }}>RESET</button>
                  )}
                </div>
              </div>
            )}
            {phase === 1 && (
              <div style={{ position: 'relative', display: 'grid', placeItems: 'center', gap: 18 }}>
                <EmbeddingCloud cols={24} rows={8} size={20} gap={6}/>
                <div className="label-mono" style={{ fontSize: 10, color: 'var(--teal-2)' }}>192 DIMENSIONS · L2-NORMALIZED</div>
              </div>
            )}
            {phase === 2 && (
              <CosineMatchViz similarity={similarity || 0.5}/>
            )}
            {phase === 3 && errored && (
              <ErrorPanel message={error} profile={profile}/>
            )}
            {phase === 3 && !errored && (
              <ResultPanel passing={passing} similarity={similarity} dfScore={dfScore} profile={profile} result={result}/>
            )}
          </div>

          {/* Progress bar — calibrated timeline during embed/match (phases 1-2) only.
              Phase 0 is operator-driven (no fixed duration → no bar). */}
          {phase > 0 && phase < 3 && (
            <div style={{ marginTop: 40, width: 480, margin: '40px auto 0', height: 2, background: 'rgba(125,200,255,0.10)', borderRadius: 1, overflow: 'hidden' }}>
              <div style={{
                height: '100%',
                width: `${overlayProgress(phase, recorder.durationMs, timeline) * 100}%`,
                background: `linear-gradient(90deg, ${accent}55, ${accent})`,
                boxShadow: `0 0 12px ${accent}`,
                transition: 'width 60ms linear',
              }}/>
            </div>
          )}
        </div>
      </div>

      <button onClick={onClose} className="btn btn-ghost" style={{ position: 'absolute', top: 32, right: 32, padding: '10px 20px', fontSize: 11 }}>
        ✕ &nbsp;CLOSE
      </button>
    </div>
  );
}

function CosineMatchViz({ similarity }) {
  return (
    <div style={{ display: 'grid', placeItems: 'center', gap: 22 }}>
      <svg width="640" height="200" viewBox="0 0 640 200">
        <defs>
          <linearGradient id="vec1" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#3da9fc"/>
            <stop offset="1" stopColor="#7ef0ff"/>
          </linearGradient>
        </defs>
        {/* Two vectors radiating from center, separated by acos(similarity) */}
        {(() => {
          const angle = Math.acos(Math.min(1, similarity));   // radians
          const cx = 320, cy = 100, r = 80;
          const a1 = -angle / 2, a2 = angle / 2;
          const x1 = cx + Math.cos(a1) * r * 2.4, y1 = cy + Math.sin(a1) * r * 2.4;
          const x2 = cx + Math.cos(a2) * r * 2.4, y2 = cy + Math.sin(a2) * r * 2.4;
          // arc
          const arcX1 = cx + Math.cos(a1) * 60, arcY1 = cy + Math.sin(a1) * 60;
          const arcX2 = cx + Math.cos(a2) * 60, arcY2 = cy + Math.sin(a2) * 60;
          return <>
            <line x1={cx} y1={cy} x2={x1} y2={y1} stroke="url(#vec1)" strokeWidth="2"/>
            <circle cx={x1} cy={y1} r="6" fill="#7ef0ff"/>
            <text x={x1 + 12} y={y1 + 4} fontSize="11" fill="#7ef0ff" fontFamily="JetBrains Mono, monospace">enrolled</text>
            <line x1={cx} y1={cy} x2={x2} y2={y2} stroke="#bff4ff" strokeWidth="2" strokeDasharray="3 3"/>
            <circle cx={x2} cy={y2} r="6" fill="#bff4ff"/>
            <text x={x2 + 12} y={y2 + 4} fontSize="11" fill="#bff4ff" fontFamily="JetBrains Mono, monospace">live</text>
            <path d={`M ${arcX1} ${arcY1} A 60 60 0 0 1 ${arcX2} ${arcY2}`} stroke="#ffb24a" strokeWidth="1.4" fill="none" strokeDasharray="2 2"/>
            <text x={cx + 70} y={cy + 4} fontSize="10" fill="#ffb24a" fontFamily="JetBrains Mono, monospace">θ = {(angle * 180 / Math.PI).toFixed(1)}°</text>
            <circle cx={cx} cy={cy} r="4" fill="#04070d" stroke="#7ef0ff" strokeWidth="1.4"/>
          </>;
        })()}
      </svg>
      <div className="num-mono" style={{ fontSize: 36, color: '#7ef0ff', letterSpacing: '-0.02em' }}>
        cos θ = {similarity.toFixed(3)}
      </div>
      <div className="label-mono" style={{ fontSize: 10 }}>HIGHER = MORE SIMILAR · THRESHOLD 0.75</div>
    </div>
  );
}

function ResultPanel({ passing, similarity, dfScore, profile, result }) {
  const accent = passing ? '#7ef0ff' : '#ff5577';
  const totalMs = result?.stageBreakdown?.totalMs ?? 0;
  const reason = result?.decisionReason ?? (passing ? 'accepted' : 'mismatch');
  const reasonBlurb = {
    accepted: 'Voice matches the enrolled profile.',
    mismatch: 'Speaker did not match the enrolled profile.',
    synthetic: 'Audio was flagged as synthetic.',
    not_enrolled: 'No enrolled profile for this user.',
  }[reason] || result?.message || '';
  return (
    <div style={{
      width: 720, padding: '36px 48px',
      borderRadius: 18,
      border: `1px solid ${accent}55`,
      background: `linear-gradient(180deg, ${accent}10, transparent)`,
      display: 'grid', gap: 22,
    }}>
      <DegradedBanner provenance={result?.modelProvenance} variant="full"/>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <div style={{
            width: 56, height: 56, borderRadius: '50%',
            background: `linear-gradient(135deg, ${profile?.color1 || '#7ef0ff'}, ${profile?.color2 || '#3da9fc'})`,
            display: 'grid', placeItems: 'center', color: '#04070d', fontSize: 20, fontWeight: 600,
          }}>{profile?.initials}</div>
          <div style={{ textAlign: 'left' }}>
            <div style={{ fontSize: 26 }}>{profile?.name}</div>
            <div className="label-mono" style={{ fontSize: 10 }}>{profile?.id} · {result?.sessionId || '—'}</div>
          </div>
        </div>
        <div style={{
          padding: '10px 22px', borderRadius: 999,
          background: passing ? 'rgba(126,240,255,0.15)' : 'rgba(255,85,119,0.15)',
          border: `1px solid ${accent}`,
          color: accent,
          fontFamily: 'JetBrains Mono, monospace', fontSize: 12, letterSpacing: '0.2em', fontWeight: 600,
        }}>
          {passing ? 'ACCESS GRANTED' : 'ACCESS DENIED'}
        </div>
      </div>
      {reasonBlurb && (
        <div className="label-mono" style={{ fontSize: 11, color: 'var(--ink-mute)', letterSpacing: '0.06em' }}>
          {reasonBlurb}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}>
        <Stat label="Voice match" value={similarity.toFixed(3)} sub={`vs ${SIM_THRESHOLD.toFixed(2)} · ${passing ? 'PASS' : 'FAIL'}`} accent={accent}/>
        <Stat label="Authenticity" value={dfScore.toFixed(2)} sub={`vs ${DF_THRESHOLD.toFixed(2)} · ${dfScore >= DF_THRESHOLD ? 'genuine voice' : 'synthetic flag'}`} accent={dfScore >= DF_THRESHOLD ? '#6affc8' : '#ff5577'}/>
        <Stat label="Latency" value={totalMs > 0 ? `${(totalMs / 1000).toFixed(2)}s` : '—'} sub="end-to-end" accent="#7ef0ff"/>
      </div>
    </div>
  );
}

function ErrorPanel({ message, profile }) {
  const accent = '#ff5577';
  return (
    <div style={{
      width: 720, padding: '36px 48px',
      borderRadius: 18,
      border: `1px solid ${accent}55`,
      background: `linear-gradient(180deg, ${accent}10, transparent)`,
      display: 'grid', gap: 22,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <div style={{
            width: 56, height: 56, borderRadius: '50%',
            background: `linear-gradient(135deg, ${profile?.color1 || '#ff5577'}, ${profile?.color2 || '#9450d8'})`,
            display: 'grid', placeItems: 'center', color: '#04070d', fontSize: 20, fontWeight: 600,
          }}>{profile?.initials || '!'}</div>
          <div style={{ textAlign: 'left' }}>
            <div style={{ fontSize: 26 }}>Verification failed</div>
            <div className="label-mono" style={{ fontSize: 10 }}>{profile?.id || ''}</div>
          </div>
        </div>
        <div style={{
          padding: '10px 22px', borderRadius: 999,
          background: 'rgba(255,85,119,0.15)',
          border: `1px solid ${accent}`,
          color: accent,
          fontFamily: 'JetBrains Mono, monospace', fontSize: 12, letterSpacing: '0.2em', fontWeight: 600,
        }}>
          ERROR
        </div>
      </div>
      <div style={{ fontSize: 14, color: 'var(--ink-mute)', lineHeight: 1.55 }}>{message}</div>
    </div>
  );
}

// Phase-0 (operator capturing) doesn't render a progress bar (no fixed
// duration). Phases 1-2 fill 0..100% during the embed/match wait.
function overlayProgress(phase, _recordingMs, timeline) {
  if (phase === 0) return 0;
  if (phase === 3) return 1;
  return Math.min(1, timeline.progress);
}

function Stat({ label, value, sub, accent }) {
  return (
    <div style={{ padding: '14px 18px', borderRadius: 12, background: 'rgba(125,200,255,0.04)', border: '1px solid var(--line)' }}>
      <div className="label-mono" style={{ fontSize: 9 }}>{label}</div>
      <div className="num-mono" style={{ fontSize: 28, color: accent, marginTop: 6, letterSpacing: '-0.02em' }}>{value}</div>
      <div className="label-mono" style={{ fontSize: 8, marginTop: 2, color: 'var(--ink-soft)' }}>{sub}</div>
    </div>
  );
}

// ============================================================================
// helpers
// ============================================================================
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function seedRandom(seed) {
  let s = seed | 0 || 1;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}
function hexA(hex, a) {
  // accept #rgb / #rrggbb
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

export {
  AmbientField, EmbeddingConstellation, LiveFeatures,
  LiveClock, ThreatLevel, VerificationOverlay, CosineMatchViz, ResultPanel,
};
