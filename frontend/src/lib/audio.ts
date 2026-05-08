// useVoiceRecorder — captures real microphone audio, encodes a 16 kHz mono WAV
// and returns it as a `File` ready for multipart upload.
//
// Hard segregation: this hook is the ONLY producer of WAV blobs that get sent
// to the backend. It refuses to start without a real `MediaStream` so the
// synthetic-audio fallback in `audio.jsx` can never reach the server.
//
// Capture path (F3.1):
//   - Primary: AudioWorkletNode + `/audio-worklets/recorder-processor.js`. The
//     worklet runs on the audio rendering thread, posts ~85 ms PCM batches
//     back to the main thread, and is the path Chrome 64+, Safari 14.5+, and
//     Firefox 76+ all support.
//   - Fallback: ScriptProcessorNode (deprecated, main-thread). Kicks in when
//     the browser lacks `audioWorklet`, the worklet module fails to load, or
//     `addModule` rejects. Older Safari and corporate-locked-down browsers
//     end up here. Behaviourally identical from the consumer's perspective.
//
// Resampling to 16 kHz happens on `stop()` via `OfflineAudioContext`, not in
// real-time, so the captured Float32 chunks stay at device rate until the
// recording ends. WAV encoding reuses `lib/wav.ts:encodeWav`.

import { useCallback, useEffect, useRef, useState } from "react";
import { encodeWav } from "./wav";

const TARGET_SAMPLE_RATE = 16_000 as const;
const DEFAULT_MIN_MS = 1_000;
const DEFAULT_MAX_MS = 10_000;
const ANALYSER_FFT_SIZE = 2048;
const WORKLET_URL = "/audio-worklets/recorder-processor.js";

export type RecorderState =
  | "idle"
  | "requesting"
  | "recording"
  | "stopped"
  | "denied"
  | "error";

export type RecordingResult = {
  wavFile: File;
  durationSec: number;
  sampleRate: typeof TARGET_SAMPLE_RATE;
  /** Which capture path produced the recording. Useful for the QA matrix
   *  + observability (we surface it on the verification overlay's debug
   *  panel and the bench harness in F8). */
  captureMode: "audioworklet" | "scriptprocessor";
};

export type RecorderOptions = {
  minMs?: number;
  maxMs?: number;
};

type RecorderRefs = {
  ctx: AudioContext | null;
  stream: MediaStream | null;
  source: MediaStreamAudioSourceNode | null;
  analyser: AnalyserNode | null;
  workletNode: AudioWorkletNode | null;
  processor: ScriptProcessorNode | null;
  chunks: Float32Array[];
  startedAt: number;
  raf: number | null;
  autoStop: number | null;
  captureMode: "audioworklet" | "scriptprocessor" | null;
};

const initialRefs = (): RecorderRefs => ({
  ctx: null,
  stream: null,
  source: null,
  analyser: null,
  workletNode: null,
  processor: null,
  chunks: [],
  startedAt: 0,
  raf: null,
  autoStop: null,
  captureMode: null,
});

export type RecorderHandle = {
  state: RecorderState;
  level: number;
  durationMs: number;
  samples: Uint8Array;  // byte time-domain — for waveform visualizers
  freqs: Uint8Array;    // byte frequency — for spectrogram visualizers
  start: () => Promise<void>;
  stop: () => Promise<RecordingResult | null>;
  cancel: () => void;
};

// Module-level guard so we only addModule() once per AudioContext-class
// lifetime. Subsequent recorders can skip the network fetch.
const workletRegistry = new WeakSet<AudioContext>();

async function ensureWorkletLoaded(ctx: AudioContext): Promise<boolean> {
  if (!ctx.audioWorklet) return false;
  if (workletRegistry.has(ctx)) return true;
  try {
    await ctx.audioWorklet.addModule(WORKLET_URL);
    workletRegistry.add(ctx);
    return true;
  } catch (err) {
    // Network 404, CSP block, or processor-script syntax error all land
    // here. Surface to the console (the fallback path still produces a
    // usable WAV) so the QA matrix surfaces broken deployments.
    // eslint-disable-next-line no-console
    console.warn("[biovoice] AudioWorklet load failed; falling back to ScriptProcessor:", err);
    return false;
  }
}

export function useVoiceRecorder(opts: RecorderOptions = {}): RecorderHandle {
  const minMs = opts.minMs ?? DEFAULT_MIN_MS;
  const maxMs = opts.maxMs ?? DEFAULT_MAX_MS;

  const [state, setState] = useState<RecorderState>("idle");
  const refs = useRef<RecorderRefs>(initialRefs());
  // Visualization buffers are stable references whose contents we mutate every
  // animation frame. A throwaway state setter forces React to re-read them.
  // Explicit ArrayBuffer generic to satisfy TS 5.5+ web-audio signatures.
  const samplesRef = useRef<Uint8Array<ArrayBuffer>>(new Uint8Array(new ArrayBuffer(ANALYSER_FFT_SIZE)));
  const freqsRef = useRef<Uint8Array<ArrayBuffer>>(new Uint8Array(new ArrayBuffer(ANALYSER_FFT_SIZE / 4)));
  const levelRef = useRef(0);
  const durationMsRef = useRef(0);
  const [, force] = useState(0);

  const teardown = useCallback(() => {
    const r = refs.current;
    if (r.raf !== null) cancelAnimationFrame(r.raf);
    if (r.autoStop !== null) clearTimeout(r.autoStop);
    if (r.workletNode) {
      r.workletNode.port.onmessage = null;
      try {
        r.workletNode.port.close();
      } catch {
        /* port may already be closed */
      }
      r.workletNode.disconnect();
    }
    if (r.processor) {
      r.processor.disconnect();
      r.processor.onaudioprocess = null as unknown as (event: AudioProcessingEvent) => void;
    }
    r.analyser?.disconnect();
    r.source?.disconnect();
    r.stream?.getTracks().forEach((t) => t.stop());
    if (r.ctx && r.ctx.state !== "closed") {
      // close() returns a promise we don't await — best-effort cleanup.
      void r.ctx.close().catch(() => {});
    }
    refs.current = initialRefs();
    levelRef.current = 0;
  }, []);

  const start = useCallback(async () => {
    if (state === "recording" || state === "requesting") return;
    setState("requesting");
    if (!navigator.mediaDevices?.getUserMedia) {
      setState("error");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) {
        stream.getTracks().forEach((t) => t.stop());
        setState("error");
        return;
      }
      const ctx = new Ctx();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = ANALYSER_FFT_SIZE;
      analyser.smoothingTimeConstant = 0.78;

      const chunks: Float32Array[] = [];
      const useWorklet = await ensureWorkletLoaded(ctx);

      let workletNode: AudioWorkletNode | null = null;
      let processor: ScriptProcessorNode | null = null;
      let captureMode: "audioworklet" | "scriptprocessor";

      if (useWorklet) {
        workletNode = new AudioWorkletNode(ctx, "biovoice-recorder", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
        });
        workletNode.port.onmessage = (event: MessageEvent) => {
          const data = event.data;
          if (data && data.type === "chunk" && data.samples instanceof Float32Array) {
            chunks.push(data.samples);
          }
        };
        // The worklet is a sink; route source → analyser → worklet, then
        // worklet → destination so the renderer pulls audio (the worklet
        // node's process() only fires while the graph is running). Output
        // is silent — the worklet returns nothing, but we connect anyway
        // to keep the audio graph resolved.
        source.connect(analyser);
        analyser.connect(workletNode);
        workletNode.connect(ctx.destination);
        captureMode = "audioworklet";
      } else {
        // Fallback: ScriptProcessorNode. 4096 frames per buffer at the
        // device rate ≈ 85 ms at 48 kHz — plenty of headroom for a 16 kHz
        // target. Runs on the main thread so a heavy React render can stall
        // it; on supported browsers AudioWorklet is preferred.
        processor = ctx.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = (event) => {
          chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
        };
        source.connect(analyser);
        analyser.connect(processor);
        processor.connect(ctx.destination);
        captureMode = "scriptprocessor";
      }

      samplesRef.current = new Uint8Array(new ArrayBuffer(analyser.fftSize));
      freqsRef.current = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));

      const startedAt = performance.now();
      refs.current = {
        ctx,
        stream,
        source,
        analyser,
        workletNode,
        processor,
        chunks,
        startedAt,
        raf: null,
        autoStop: null,
        captureMode,
      };

      const tick = () => {
        const r = refs.current;
        if (!r.analyser) return;
        r.analyser.getByteTimeDomainData(samplesRef.current);
        r.analyser.getByteFrequencyData(freqsRef.current);
        let sum = 0;
        const buf = samplesRef.current;
        for (let i = 0; i < buf.length; i += 1) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        levelRef.current = levelRef.current * 0.7 + rms * 0.3;
        durationMsRef.current = performance.now() - r.startedAt;
        force((t) => t + 1);
        r.raf = requestAnimationFrame(tick);
      };
      refs.current.raf = requestAnimationFrame(tick);

      refs.current.autoStop = window.setTimeout(() => {
        void stopInternal();
      }, maxMs);

      setState("recording");
    } catch (err) {
      teardown();
      const denied = err instanceof DOMException && err.name === "NotAllowedError";
      setState(denied ? "denied" : "error");
    }
    // `stopInternal` is referenced before declaration but only called from the
    // setTimeout once the closure runs; declared below.
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
  }, [state, maxMs, teardown]);

  const stopInternal = useCallback(async (): Promise<RecordingResult | null> => {
    if (state !== "recording") return null;
    const r = refs.current;
    const elapsedMs = performance.now() - r.startedAt;
    const sourceRate = r.ctx?.sampleRate ?? 48_000;
    const chunks = r.chunks;
    const captureMode = r.captureMode ?? "scriptprocessor";
    teardown();
    setState("stopped");

    if (elapsedMs < minMs || chunks.length === 0) return null;

    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    const resampled =
      sourceRate === TARGET_SAMPLE_RATE
        ? merged
        : await resampleToTarget(merged, sourceRate, TARGET_SAMPLE_RATE);

    const blob = encodeWav(resampled, TARGET_SAMPLE_RATE);
    const wavFile = new File([blob], `biovoice-${Date.now()}.wav`, { type: "audio/wav" });
    return {
      wavFile,
      durationSec: resampled.length / TARGET_SAMPLE_RATE,
      sampleRate: TARGET_SAMPLE_RATE,
      captureMode,
    };
  }, [state, minMs, teardown]);

  const cancel = useCallback(() => {
    teardown();
    setState("idle");
  }, [teardown]);

  // Cleanup if the consumer unmounts mid-recording.
  useEffect(() => () => teardown(), [teardown]);

  return {
    state,
    level: levelRef.current,
    durationMs: durationMsRef.current,
    samples: samplesRef.current,
    freqs: freqsRef.current,
    start,
    stop: stopInternal,
    cancel,
  };
}

async function resampleToTarget(
  input: Float32Array,
  sourceRate: number,
  targetRate: number,
): Promise<Float32Array> {
  const duration = input.length / sourceRate;
  const targetLength = Math.max(1, Math.round(duration * targetRate));
  const OfflineCtx =
    window.OfflineAudioContext ??
    (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  if (!OfflineCtx) {
    // Fallback: linear interpolation. Not Safari-iOS prior to 14.5; we expect
    // OfflineAudioContext on every supported browser.
    return linearResample(input, sourceRate, targetRate);
  }
  const offline = new OfflineCtx(1, targetLength, targetRate);
  const buffer = offline.createBuffer(1, input.length, sourceRate);
  // copyToChannel wants a Float32Array<ArrayBuffer>; allocate a copy that owns
  // its buffer to satisfy the generic without changing what we feed downstream.
  const owned = new Float32Array(new ArrayBuffer(input.length * 4));
  owned.set(input);
  buffer.copyToChannel(owned, 0);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

function linearResample(input: Float32Array, sourceRate: number, targetRate: number): Float32Array {
  const ratio = sourceRate / targetRate;
  const targetLength = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(targetLength);
  for (let i = 0; i < targetLength; i += 1) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(left + 1, input.length - 1);
    const t = pos - left;
    out[i] = input[left] * (1 - t) + input[right] * t;
  }
  return out;
}
