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
// EmbeddingConstellation — 3D-rotating point cloud projecting the 192-dim
// voice space. Profile clusters are rendered as named constellations; the
// live voice "drops in" as a bright comet that finds its match.
// ============================================================================
function EmbeddingConstellation({ width = 420, height = 340, profiles, audioLevel = 0, matchId = null }) {
  const ref = useRef();
  const matchRef = useRef(matchId);
  const levelRef = useRef(audioLevel);
  matchRef.current = matchId;
  levelRef.current = audioLevel;

  // Generate stable cluster centers per profile (seeded from id)
  const centers = useMemo(() => {
    return (profiles || []).map((p, i) => {
      const seed = hash(p.id);
      const a = (seed % 1000) / 1000 * Math.PI * 2;
      const b = ((seed >> 4) % 1000) / 1000 * Math.PI;
      const r = 0.62 + ((seed >> 8) % 100) / 400;
      return {
        ...p,
        cx: r * Math.sin(b) * Math.cos(a),
        cy: r * Math.sin(b) * Math.sin(a),
        cz: r * Math.cos(b),
      };
    });
  }, [profiles]);

  // Points for each cluster (small Gaussian around center)
  const points = useMemo(() => {
    const all = [];
    centers.forEach((c, idx) => {
      const n = 22;
      const rand = seedRandom(hash(c.id) + 7);
      for (let i = 0; i < n; i++) {
        all.push({
          x: c.cx + (rand() - 0.5) * 0.18,
          y: c.cy + (rand() - 0.5) * 0.18,
          z: c.cz + (rand() - 0.5) * 0.18,
          cluster: idx,
          color: c.color1 || '#7ef0ff',
        });
      }
    });
    // background noise points
    const bgRand = seedRandom(99);
    for (let i = 0; i < 90; i++) {
      const a = bgRand() * Math.PI * 2;
      const b = bgRand() * Math.PI;
      const r = 0.35 + bgRand() * 0.55;
      all.push({
        x: r * Math.sin(b) * Math.cos(a),
        y: r * Math.sin(b) * Math.sin(a),
        z: r * Math.cos(b),
        cluster: -1,
        color: '#3da9fc',
      });
    }
    return all;
  }, [centers]);

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

      // Sort points by depth for proper layering
      const projected = points.map(p => {
        const pp = project(p.x, p.y, p.z, t);
        return { ...p, ...pp };
      }).sort((a, b) => a.depth - b.depth);

      function project(x, y, z, time) {
        // rotate Y
        const cy_ = Math.cos(time), sy_ = Math.sin(time);
        let x1 = x * cy_ - z * sy_;
        let z1 = x * sy_ + z * cy_;
        // rotate X (slight tilt)
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

      // draw points
      projected.forEach(p => {
        const alpha = p.cluster < 0 ? 0.18 + (p.scale - 0.5) * 0.4 : 0.55 + (p.scale - 0.5) * 0.6;
        const r = (p.cluster < 0 ? 1.0 : 1.8) * p.scale;
        const isMatch = p.cluster >= 0 && centers[p.cluster] && matchRef.current === centers[p.cluster].id;
        if (isMatch) {
          ctx.shadowBlur = 12;
          ctx.shadowColor = p.color;
        }
        ctx.fillStyle = hexA(p.color, isMatch ? Math.min(1, alpha + 0.3) : alpha);
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * (isMatch ? 1.4 : 1), 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      });

      // draw cluster labels (front-most only)
      centers.forEach((c, idx) => {
        const pp = project(c.cx, c.cy, c.cz, t);
        if (pp.depth > 0.1) return;             // backside hidden
        const isMatch = matchRef.current === c.id;
        ctx.fillStyle = isMatch ? '#7ef0ff' : 'rgba(231,243,255,0.65)';
        ctx.font = `${isMatch ? 600 : 400} 9.5px "JetBrains Mono", monospace`;
        ctx.fillText(c.initials, pp.x + 6, pp.y - 6);
        if (isMatch) {
          ctx.strokeStyle = '#7ef0ff';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(pp.x, pp.y, 14, 0, Math.PI * 2);
          ctx.stroke();
        }
      });

      // live voice "comet" — orbiting/bouncing centroid
      const lvl = Math.min(1, levelRef.current * 2);
      const lt = t * 1.6;
      const lx = Math.sin(lt * 0.7) * 0.5;
      const ly = Math.cos(lt * 0.5) * 0.3 + lvl * 0.1;
      const lz = Math.sin(lt * 0.3) * 0.4;
      const lp = project(lx, ly, lz, t);
      ctx.shadowBlur = 18; ctx.shadowColor = '#7ef0ff';
      ctx.fillStyle = '#bff4ff';
      ctx.beginPath();
      ctx.arc(lp.x, lp.y, 3 + lvl * 3, 0, Math.PI * 2);
      ctx.fill();
      // ring
      ctx.shadowBlur = 0;
      ctx.strokeStyle = `rgba(126,240,255,${0.4 + lvl * 0.4})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(lp.x, lp.y, 8 + lvl * 6, 0, Math.PI * 2);
      ctx.stroke();
      // line to matched cluster
      if (matchRef.current) {
        const m = centers.find(c => c.id === matchRef.current);
        if (m) {
          const mp = project(m.cx, m.cy, m.cz, t);
          const pulse = 0.4 + 0.4 * Math.sin(t * 6);
          ctx.strokeStyle = `rgba(126,240,255,${pulse})`;
          ctx.lineWidth = 1.2;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(lp.x, lp.y); ctx.lineTo(mp.x, mp.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [width, height, points, centers]);

  return <canvas ref={ref} style={{ display: 'block' }}/>;
}

// ============================================================================
// LiveFeatures — extracts pitch, formants F1/F2, jitter, shimmer from FFT.
// Animated readouts.
// ============================================================================
function LiveFeatures({ freqs, samples, level }) {
  const [feat, setFeat] = useState({ pitch: 0, f1: 0, f2: 0, f3: 0, jitter: 0, shimmer: 0, snr: 0, vad: false });
  const histRef = useRef({ pitches: [], levels: [] });

  useEffect(() => {
    let raf;
    const tick = () => {
      const f = freqs || [];
      const s = samples || [];
      // pitch via spectral peak in 80–400 Hz range (assume 16 kHz, nyquist 8 kHz, FFT size = freqs.length*2)
      // bin = freq / (sampleRate / fftSize); approximate sampleRate=16000, fftSize=f.length*2
      const fftSize = f.length * 2 || 1024;
      const sr = 16000;
      const binToHz = (b) => b * sr / fftSize;
      let peakBin = 0, peakVal = 0;
      const lo = Math.floor(80 * fftSize / sr);
      const hi = Math.floor(400 * fftSize / sr);
      for (let i = lo; i < Math.min(hi, f.length); i++) {
        if (f[i] > peakVal) { peakVal = f[i]; peakBin = i; }
      }
      const pitch = peakVal > 35 ? binToHz(peakBin) : 0;
      // formants — first 3 spectral peaks above 200 Hz
      const peaks = [];
      const minBin = Math.floor(200 * fftSize / sr);
      for (let i = minBin + 4; i < f.length - 4; i++) {
        if (f[i] > 30 && f[i] >= f[i-2] && f[i] >= f[i+2] && f[i] > f[i-4] && f[i] > f[i+4]) {
          peaks.push({ b: i, v: f[i] });
          i += 6;
        }
      }
      peaks.sort((a, b) => a.b - b.b);
      const f1 = peaks[0] ? binToHz(peaks[0].b) : 0;
      const f2 = peaks[1] ? binToHz(peaks[1].b) : 0;
      const f3 = peaks[2] ? binToHz(peaks[2].b) : 0;
      // jitter / shimmer simulated
      const h = histRef.current;
      h.pitches.push(pitch); if (h.pitches.length > 30) h.pitches.shift();
      h.levels.push(level || 0); if (h.levels.length > 30) h.levels.shift();
      const meanP = h.pitches.reduce((a, b) => a + b, 0) / Math.max(1, h.pitches.length);
      const jitter = meanP > 0
        ? h.pitches.reduce((a, p) => a + Math.abs(p - meanP), 0) / h.pitches.length / meanP * 100
        : 0;
      const meanL = h.levels.reduce((a, b) => a + b, 0) / Math.max(1, h.levels.length);
      const shimmer = meanL > 0
        ? h.levels.reduce((a, l) => a + Math.abs(l - meanL), 0) / h.levels.length / meanL * 100
        : 0;
      // SNR approximation
      let signal = 0, noise = 0;
      for (let i = 0; i < f.length; i++) {
        if (i > lo && i < hi * 4) signal += f[i];
        else noise += f[i];
      }
      const snr = noise > 0 ? 10 * Math.log10(signal / noise + 0.001) : 0;
      const vad = (level || 0) > 0.02;
      setFeat({ pitch, f1, f2, f3, jitter, shimmer, snr: Math.max(0, snr + 18), vad });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [freqs, samples, level]);

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
      <Cell label="Formants"   value={feat.f1 ? feat.f1.toFixed(0) : '—'} unit="Hz" hint="vowel space"/>
      <Cell label="SNR"        value={feat.snr.toFixed(1)} unit="dB" hint="signal qual"/>
      <Cell label="Voice"      value={feat.vad ? 'ACTIVE' : 'IDLE'}    unit="" hint={feat.vad ? 'speech detected' : 'no voice'}/>
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
