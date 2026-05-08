// Real-microphone audio engine + analysis hooks.
// Exports: useMicrophone (live mic + FFT), useFakeAudio (auto/scripted), useStaticBars.

import { useEffect, useRef, useState, useCallback } from "react";

// ---------------------------------------------------------------------------
// useMicrophone
// Manages a getUserMedia stream + AnalyserNode. Returns:
//   { state, start, stop, samples, freqs, level, durationMs }
//
//   state: 'idle' | 'requesting' | 'live' | 'stopped' | 'denied'
//   samples: Uint8Array (time-domain, 0..255, 128 = silence)
//   freqs:   Uint8Array (frequency-domain, 0..255)
//   level:   smoothed amplitude 0..1
// ---------------------------------------------------------------------------
function useMicrophone() {
  const [state, setState] = useState('idle');
  const [, force] = useState(0);
  const tickRef = useRef();

  const ctxRef = useRef(null);
  const streamRef = useRef(null);
  const analyserRef = useRef(null);
  const samplesRef = useRef(new Uint8Array(2048));
  const freqsRef = useRef(new Uint8Array(512));
  const levelRef = useRef(0);
  const startedAtRef = useRef(0);
  const durRef = useRef(0);

  const stop = useCallback(() => {
    if (tickRef.current) { cancelAnimationFrame(tickRef.current); tickRef.current = null; }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (ctxRef.current && ctxRef.current.state !== 'closed') {
      try { ctxRef.current.close(); } catch (e) {}
      ctxRef.current = null;
    }
    analyserRef.current = null;
    levelRef.current = 0;
    setState('stopped');
  }, []);

  const start = useCallback(async () => {
    if (state === 'live' || state === 'requesting') return;
    setState('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      streamRef.current = stream;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      ctxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.78;
      src.connect(analyser);
      analyserRef.current = analyser;
      samplesRef.current = new Uint8Array(analyser.fftSize);
      freqsRef.current = new Uint8Array(analyser.frequencyBinCount);
      startedAtRef.current = performance.now();
      setState('live');

      const tick = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteTimeDomainData(samplesRef.current);
        analyserRef.current.getByteFrequencyData(freqsRef.current);
        // RMS-ish level
        let sum = 0;
        const s = samplesRef.current;
        for (let i = 0; i < s.length; i++) {
          const v = (s[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / s.length);
        levelRef.current = levelRef.current * 0.7 + rms * 0.3;
        durRef.current = performance.now() - startedAtRef.current;
        force(t => t + 1);
        tickRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) {
      console.warn('mic denied', e);
      setState('denied');
    }
  }, [state]);

  useEffect(() => () => stop(), []);

  return {
    state,
    start, stop,
    samples: samplesRef.current,
    freqs: freqsRef.current,
    get level() { return levelRef.current; },
    durationMs: durRef.current,
    levelRef,
  };
}

// ---------------------------------------------------------------------------
// useSyntheticAudio — for auto-loop / fallback when no mic.
// Generates a believable speech-like waveform (multiple modulated sines with envelope).
// ---------------------------------------------------------------------------
function useSyntheticAudio(active = true, opts = {}) {
  const { variant = 'human' } = opts;
  const samplesRef = useRef(new Uint8Array(2048));
  const freqsRef = useRef(new Uint8Array(512));
  const levelRef = useRef(0);
  const tRef = useRef(0);
  const [, force] = useState(0);
  const rafRef = useRef();

  useEffect(() => {
    if (!active) return;
    const tick = () => {
      tRef.current += 1 / 60;
      const t = tRef.current;
      const s = samplesRef.current;
      const f = freqsRef.current;

      // Speech-like envelope (slow words, short pauses)
      const word = 0.5 + 0.5 * Math.sin(t * 2.1);
      const breath = Math.max(0, Math.sin(t * 0.7) * 0.7 + 0.3);
      let env = word * breath;
      if (variant === 'fake') {
        // deepfake: too steady, too clean
        env = 0.6 + 0.15 * Math.sin(t * 4);
      }

      for (let i = 0; i < s.length; i++) {
        const x = i / s.length;
        const phase = t * 14 + x * Math.PI * 2;
        let v =
          Math.sin(phase) * 0.45 +
          Math.sin(phase * 2.3 + Math.sin(t)) * 0.25 +
          Math.sin(phase * 5.1) * 0.15 +
          (Math.random() - 0.5) * (variant === 'fake' ? 0.02 : 0.12);
        v *= env;
        s[i] = Math.max(0, Math.min(255, 128 + Math.round(v * 110)));
      }

      // Frequency bins — formants around 200 / 1000 / 2500 Hz
      for (let i = 0; i < f.length; i++) {
        const hz = i / f.length;
        const formants =
          Math.exp(-Math.pow((hz - 0.05) * 18, 2)) * 0.95 +
          Math.exp(-Math.pow((hz - 0.18) * 12, 2)) * 0.7 +
          Math.exp(-Math.pow((hz - 0.36) * 14, 2)) * 0.5 +
          Math.exp(-Math.pow((hz - 0.55) * 22, 2)) * 0.25;
        const noise = (Math.random() * 0.15);
        const wobble = 0.85 + 0.15 * Math.sin(t * 3 + hz * 8);
        let v = (formants * wobble + noise) * env;
        if (variant === 'fake') {
          // suspicious spectral periodicity
          v *= 0.7 + 0.3 * Math.sin(hz * 80);
        }
        f[i] = Math.max(0, Math.min(255, Math.round(v * 220)));
      }

      levelRef.current = env * 0.6;
      force(x => x + 1);
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(rafRef.current);
  }, [active, variant]);

  return {
    samples: samplesRef.current,
    freqs: freqsRef.current,
    get level() { return levelRef.current; },
    levelRef,
  };
}

// ---------------------------------------------------------------------------
// Deterministic seeded random for stable visualizations
// ---------------------------------------------------------------------------
function seedRand(seed) {
  let x = seed | 0;
  return () => {
    x = (x * 9301 + 49297) % 233280;
    return x / 233280;
  };
}

export { useMicrophone, useSyntheticAudio, seedRand };
