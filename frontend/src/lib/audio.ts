// useVoiceRecorder — captures real microphone audio, encodes a 16 kHz mono
// WAV, and returns it as a `File` ready for multipart upload.
//
// Hard segregation: this hook is the ONLY producer of WAV blobs that get
// sent to the backend. It refuses to start without a real `MediaStream` so
// no synthetic-audio fallback ever reaches the server.
//
// Capture path: MediaRecorder API. Universally supported (Chrome 49+,
// Firefox 25+, Safari 14.1+). Browser handles encoding natively in webm/
// opus or audio/mp4/aac depending on what's available; on stop() we
// decode the blob via AudioContext.decodeAudioData → mono-mix → resample
// to 16 kHz → encodeWav. No AudioWorklet, no ScriptProcessor — both of
// those failed in the wild (worklet load fails on Vite + some browser
// configs; ScriptProcessor is deprecated and routes audio through the
// speakers as a side-effect of pulling from `ctx.destination`).
//
// Live visualization comes from an AnalyserNode that only needs to be
// CONNECTED to the source — it doesn't have to be in the path to
// destination, so there's zero speaker feedback.

import { useCallback, useEffect, useRef, useState } from "react";
import { encodeWav } from "./wav";

const TARGET_SAMPLE_RATE = 16_000 as const;
const DEFAULT_MIN_MS = 800;
/** When `maxMs === null` the recorder runs until the operator stops it
 *  manually. Otherwise it auto-stops after `maxMs`. */
const DEFAULT_MAX_MS: number | null = null;
const ANALYSER_FFT_SIZE = 2048;
/** MediaRecorder timeslice — emit a chunk every N ms so we have data
 *  even on a force-cancel. */
const TIMESLICE_MS = 200;

/** Browser-supported mime types we'll try in order. Browser picks the
 *  first one it can encode. */
const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "audio/mpeg",
];

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
  /** The mime type the MediaRecorder used for the source recording. */
  captureMode: string;
};

export type RecorderOptions = {
  minMs?: number;
  /** Hard cap on capture length. `null` = no cap (operator-controlled stop). */
  maxMs?: number | null;
  /** Specific microphone to use. Pass a `deviceId` from `listAudioInputs()`.
   *  Undefined → browser default. */
  deviceId?: string;
};

export type AudioInputDevice = {
  deviceId: string;
  label: string;
  groupId: string;
};

/** Enumerate the operator's microphones. Labels are only populated after
 *  the user has granted at least one `getUserMedia` permission. */
export async function listAudioInputs(): Promise<AudioInputDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === "audioinput")
    .map((d) => ({
      deviceId: d.deviceId,
      label: d.label || "Microphone",
      groupId: d.groupId,
    }));
}

/** Touch the mic so the browser populates device labels for
 *  `listAudioInputs()`. Stops the resulting track immediately. */
export async function requestMicPermission(): Promise<boolean> {
  if (!navigator.mediaDevices?.getUserMedia) return false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    return false;
  }
}

function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) {
    return ""; // browser will pick its own default
  }
  for (const mime of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return "";
}

type RecorderRefs = {
  ctx: AudioContext | null;
  stream: MediaStream | null;
  source: MediaStreamAudioSourceNode | null;
  analyser: AnalyserNode | null;
  recorder: MediaRecorder | null;
  blobs: Blob[];
  startedAt: number;
  raf: number | null;
  autoStop: number | null;
  mimeType: string;
};

const initialRefs = (): RecorderRefs => ({
  ctx: null,
  stream: null,
  source: null,
  analyser: null,
  recorder: null,
  blobs: [],
  startedAt: 0,
  raf: null,
  autoStop: null,
  mimeType: "",
});

export type RecorderHandle = {
  state: RecorderState;
  level: number;
  durationMs: number;
  samples: Uint8Array;
  freqs: Uint8Array;
  /** Mime type the MediaRecorder is using for capture (e.g. "audio/webm;codecs=opus"). */
  captureMode: string | null;
  /** Last error message surfaced by start() or stop(). Cleared on a new start(). */
  lastError: string | null;
  start: () => Promise<void>;
  stop: () => Promise<RecordingResult | null>;
  cancel: () => void;
};

export function useVoiceRecorder(opts: RecorderOptions = {}): RecorderHandle {
  const minMs = opts.minMs ?? DEFAULT_MIN_MS;
  const maxMs = opts.maxMs ?? DEFAULT_MAX_MS;

  const [state, setState] = useState<RecorderState>("idle");
  const [lastError, setLastError] = useState<string | null>(null);
  const [captureMode, setCaptureMode] = useState<string | null>(null);
  const refs = useRef<RecorderRefs>(initialRefs());
  const samplesRef = useRef<Uint8Array<ArrayBuffer>>(new Uint8Array(new ArrayBuffer(ANALYSER_FFT_SIZE)));
  const freqsRef = useRef<Uint8Array<ArrayBuffer>>(new Uint8Array(new ArrayBuffer(ANALYSER_FFT_SIZE / 4)));
  const levelRef = useRef(0);
  const durationMsRef = useRef(0);
  const [, force] = useState(0);

  const teardown = useCallback(() => {
    const r = refs.current;
    if (r.raf !== null) cancelAnimationFrame(r.raf);
    if (r.autoStop !== null) clearTimeout(r.autoStop);
    if (r.recorder && r.recorder.state !== "inactive") {
      try { r.recorder.stop(); } catch { /* may already be inactive */ }
    }
    if (r.recorder) {
      r.recorder.ondataavailable = null;
      r.recorder.onstop = null;
      r.recorder.onerror = null;
    }
    r.analyser?.disconnect();
    r.source?.disconnect();
    r.stream?.getTracks().forEach((t) => t.stop());
    if (r.ctx && r.ctx.state !== "closed") {
      void r.ctx.close().catch(() => {});
    }
    refs.current = initialRefs();
    levelRef.current = 0;
  }, []);

  const start = useCallback(async () => {
    if (state === "recording" || state === "requesting") return;
    setLastError(null);
    setCaptureMode(null);
    setState("requesting");

    if (!navigator.mediaDevices?.getUserMedia) {
      setLastError("This browser doesn't support getUserMedia.");
      setState("error");
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      setLastError("This browser doesn't support MediaRecorder.");
      setState("error");
      return;
    }

    try {
      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
      };
      if (opts.deviceId) {
        audioConstraints.deviceId = { exact: opts.deviceId };
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
      });

      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) {
        stream.getTracks().forEach((t) => t.stop());
        setLastError("AudioContext not available in this browser.");
        setState("error");
        return;
      }
      const ctx = new Ctx();
      if (ctx.state === "suspended") {
        try { await ctx.resume(); } catch { /* stream may still flow */ }
      }

      // AnalyserNode for live waveform/level. Only need to connect the
      // source TO the analyser — it doesn't need to forward to
      // destination, which is exactly what we want (no speaker feedback).
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = ANALYSER_FFT_SIZE;
      analyser.smoothingTimeConstant = 0.78;
      source.connect(analyser);

      // MediaRecorder for actual capture. The browser encodes natively;
      // we decode + re-encode as 16 kHz mono WAV in stop().
      const mimeType = pickMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      const actualMime = recorder.mimeType || mimeType || "audio/webm";

      const blobs: Blob[] = [];
      recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data && e.data.size > 0) blobs.push(e.data);
      };
      recorder.onerror = (e: Event) => {
        // eslint-disable-next-line no-console
        console.error("[biovoice] MediaRecorder error:", e);
        setLastError("MediaRecorder errored mid-capture; see browser devtools console.");
      };

      samplesRef.current = new Uint8Array(new ArrayBuffer(analyser.fftSize));
      freqsRef.current = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));

      const startedAt = performance.now();
      refs.current = {
        ctx,
        stream,
        source,
        analyser,
        recorder,
        blobs,
        startedAt,
        raf: null,
        autoStop: null,
        mimeType: actualMime,
      };

      // RAF tick — drives the live waveform + level meter. Mutates the
      // analyser-backed Uint8Arrays in place; consumers redraw on every
      // render thanks to `force()`.
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

      // Start MediaRecorder. Timeslice → periodic dataavailable events
      // so we always have at least one chunk on stop, and so a force-
      // teardown mid-recording doesn't lose everything.
      recorder.start(TIMESLICE_MS);

      if (maxMs !== null) {
        refs.current.autoStop = window.setTimeout(() => {
          // eslint-disable-next-line @typescript-eslint/no-use-before-define
          void stopInternal();
        }, maxMs);
      }

      setCaptureMode(actualMime);
      setState("recording");
    } catch (err) {
      teardown();
      const denied = err instanceof DOMException && err.name === "NotAllowedError";
      setLastError(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      setState(denied ? "denied" : "error");
    }
  }, [state, maxMs, opts.deviceId, teardown]);

  const stopInternal = useCallback(async (): Promise<RecordingResult | null> => {
    const r = refs.current;
    if (!r.recorder || r.recorder.state === "inactive") {
      // Nothing to stop. Make sure UI state isn't stuck.
      if (state === "recording" || state === "requesting") {
        teardown();
        setState("stopped");
      }
      return null;
    }

    const elapsedMs = performance.now() - r.startedAt;
    const mimeType = r.mimeType;
    const ctx = r.ctx;

    // Cancel auto-stop / RAF before we await — teardown will handle it,
    // but we want stop() itself to be the one driving the lifecycle now.
    if (r.autoStop !== null) {
      clearTimeout(r.autoStop);
      r.autoStop = null;
    }

    // Wait for MediaRecorder.stop() to fire its onstop event so we have
    // every blob (including the final one). This is the crucial step the
    // old worklet/scriptprocessor path didn't need.
    const recorder = r.recorder;
    const blobs = r.blobs;
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    try { recorder.stop(); } catch { /* already stopped */ }
    await stopped;

    // Concatenate the recorded chunks into one blob.
    const blob = new Blob(blobs, { type: mimeType || "audio/webm" });

    if (elapsedMs < minMs || blob.size === 0) {
      teardown();
      setState("stopped");
      return null;
    }

    // Decode → mono-mix → resample to 16 kHz → encodeWav. Use a fresh
    // AudioContext for decoding because the live-capture ctx may have
    // been closed by teardown by the time decodeAudioData lands. (We
    // only close it AFTER decoding completes.)
    let pcm: Float32Array;
    let sourceRate: number;
    try {
      const arrayBuf = await blob.arrayBuffer();
      const decodeCtx = ctx && ctx.state !== "closed"
        ? ctx
        : new (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!)();
      const decoded = await decodeCtx.decodeAudioData(arrayBuf.slice(0));
      sourceRate = decoded.sampleRate;
      pcm = monoMix(decoded);
    } catch (err) {
      teardown();
      setLastError(`Couldn't decode the recording: ${err instanceof Error ? err.message : String(err)}`);
      setState("error");
      return null;
    }

    teardown();
    setState("stopped");

    const resampled =
      sourceRate === TARGET_SAMPLE_RATE
        ? pcm
        : await resampleToTarget(pcm, sourceRate, TARGET_SAMPLE_RATE);

    const wavBlob = encodeWav(resampled, TARGET_SAMPLE_RATE);
    const wavFile = new File([wavBlob], `biovoice-${Date.now()}.wav`, { type: "audio/wav" });
    return {
      wavFile,
      durationSec: resampled.length / TARGET_SAMPLE_RATE,
      sampleRate: TARGET_SAMPLE_RATE,
      captureMode: mimeType,
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
    captureMode,
    lastError,
    start,
    stop: stopInternal,
    cancel,
  };
}

/** Decode any browser-supported audio file (mp3, m4a, wav, ogg, flac…)
 *  into the 16 kHz mono WAV the backend expects. Mono-mixes
 *  multi-channel files by averaging channels. */
export async function decodeAudioFileToWav(file: File): Promise<File> {
  const arrayBuf = await file.arrayBuffer();
  const Ctx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) throw new Error("AudioContext not available in this browser.");
  const ctx = new Ctx();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(arrayBuf.slice(0));
  } finally {
    void ctx.close().catch(() => {});
  }

  const mono = monoMix(decoded);
  const resampled =
    decoded.sampleRate === TARGET_SAMPLE_RATE
      ? mono
      : await resampleToTarget(mono, decoded.sampleRate, TARGET_SAMPLE_RATE);

  const blob = encodeWav(resampled, TARGET_SAMPLE_RATE);
  const baseName = file.name.replace(/\.[^.]+$/, "") || "upload";
  return new File([blob], `${baseName}-16k.wav`, { type: "audio/wav" });
}

function monoMix(decoded: AudioBuffer): Float32Array {
  const channels = decoded.numberOfChannels;
  const frames = decoded.length;
  const mono = new Float32Array(frames);
  for (let ch = 0; ch < channels; ch += 1) {
    const data = decoded.getChannelData(ch);
    for (let i = 0; i < frames; i += 1) mono[i] += data[i];
  }
  if (channels > 1) {
    for (let i = 0; i < frames; i += 1) mono[i] /= channels;
  }
  return mono;
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
    return linearResample(input, sourceRate, targetRate);
  }
  const offline = new OfflineCtx(1, targetLength, targetRate);
  const buffer = offline.createBuffer(1, input.length, sourceRate);
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
