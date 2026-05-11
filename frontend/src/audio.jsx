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
// Length of the rolling Float32 buffer kept by useMicrophone — drives
// LiveFeatures DSP + the EmbeddingConstellation live point.
const RING_SECONDS = 2.0;

function useMicrophone() {
  const [state, setState] = useState('idle');
  const [, force] = useState(0);
  const tickRef = useRef();

  const ctxRef = useRef(null);
  const streamRef = useRef(null);
  const analyserRef = useRef(null);
  const procRef = useRef(null);
  const sinkRef = useRef(null);
  const samplesRef = useRef(new Uint8Array(2048));
  const freqsRef = useRef(new Uint8Array(512));
  const levelRef = useRef(0);
  const startedAtRef = useRef(0);
  const durRef = useRef(0);
  // V3 — rolling Float32 ring buffer (native sample rate). `floatRingFill`
  // tracks how many leading samples are valid; once it reaches the ring
  // length it stays there and the buffer slides on every audio chunk.
  const floatRingRef = useRef(null);
  const floatRingFillRef = useRef(0);
  const sampleRateRef = useRef(16000);

  const stop = useCallback(() => {
    if (tickRef.current) { cancelAnimationFrame(tickRef.current); tickRef.current = null; }
    if (procRef.current) {
      try { procRef.current.disconnect(); } catch (e) {}
      procRef.current.onaudioprocess = null;
      procRef.current = null;
    }
    if (sinkRef.current) {
      try { sinkRef.current.disconnect(); } catch (e) {}
      sinkRef.current = null;
    }
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
    floatRingRef.current = null;
    floatRingFillRef.current = 0;
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
      sampleRateRef.current = ctx.sampleRate;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.78;
      src.connect(analyser);
      analyserRef.current = analyser;
      samplesRef.current = new Uint8Array(analyser.fftSize);
      freqsRef.current = new Uint8Array(analyser.frequencyBinCount);

      // ScriptProcessorNode is deprecated but still works in every
      // current browser; AudioWorklet would need a separate worker
      // file and adds complexity that isn't worth it for a 2-second
      // ring buffer feeding the visualization layer.
      const ringLen = Math.floor(ctx.sampleRate * RING_SECONDS);
      floatRingRef.current = new Float32Array(ringLen);
      floatRingFillRef.current = 0;
      const proc = ctx.createScriptProcessor(2048, 1, 1);
      procRef.current = proc;
      const sink = ctx.createGain();
      sink.gain.value = 0;
      sinkRef.current = sink;
      src.connect(proc);
      proc.connect(sink);
      sink.connect(ctx.destination);
      proc.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        const ring = floatRingRef.current;
        if (!ring) return;
        const inLen = input.length;
        const fill = floatRingFillRef.current;
        if (fill + inLen <= ring.length) {
          ring.set(input, fill);
          floatRingFillRef.current = fill + inLen;
        } else {
          // Slide-left: drop the oldest `inLen` samples then append.
          ring.copyWithin(0, inLen);
          ring.set(input, ring.length - inLen);
          floatRingFillRef.current = ring.length;
        }
      };

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

  // Returns the latest `seconds` of Float32 audio at the native sample
  // rate, or null if the buffer doesn't yet have that much. Allocates a
  // fresh slice — callers can pass directly to /embed without worrying
  // about the ring being mutated mid-request.
  const getRecentFloat = useCallback((seconds) => {
    const ring = floatRingRef.current;
    if (!ring) return null;
    const want = Math.floor(sampleRateRef.current * seconds);
    if (want <= 0) return null;
    const fill = floatRingFillRef.current;
    if (fill < want) return null;
    if (fill >= ring.length) {
      return ring.slice(ring.length - want);
    }
    return ring.slice(fill - want, fill);
  }, []);

  return {
    state,
    start, stop,
    samples: samplesRef.current,
    freqs: freqsRef.current,
    get level() { return levelRef.current; },
    durationMs: durRef.current,
    levelRef,
    sampleRateRef,
    floatRingRef,
    getRecentFloat,
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
// useSilentAudio — G16 honest no-signal placeholder.
//
// When the kiosk is in expert/live/self modes and the operator hasn't
// granted mic access yet, we used to fall back to `useSyntheticAudio`,
// which renders a believable speech-like waveform. That made the
// visualisations look "alive" when the system was actually idle — a
// subtle mockup that misled viewers into thinking real audio was being
// processed. Use this hook instead: zero-filled buffers + level 0,
// honest representation of "nothing recording yet".
// ---------------------------------------------------------------------------
function useSilentAudio() {
  // Stable references; never mutated. Visualisations read length and
  // values; both are fine at zero.
  const samplesRef = useRef(new Uint8Array(2048));
  const freqsRef = useRef(new Uint8Array(512));
  const sampleRateRef = useRef(16000);
  return {
    samples: samplesRef.current,
    freqs: freqsRef.current,
    get level() { return 0; },
    sampleRateRef,
    getRecentFloat: () => null,
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

export { useMicrophone, useSyntheticAudio, useSilentAudio, seedRand };
