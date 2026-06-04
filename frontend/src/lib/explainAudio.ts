import type { CamSegment } from "./api";

const FADE_MS = 5;

function getAudioCtx(): AudioContext {
  const Ctx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) throw new Error("AudioContext not available in this browser.");
  return new Ctx();
}

export async function decodeFileToBuffer(file: Blob): Promise<AudioBuffer> {
  const ctx = getAudioCtx();
  try {
    const arr = await file.arrayBuffer();
    return await ctx.decodeAudioData(arr.slice(0));
  } finally {
    void ctx.close();
  }
}

// Extract the [startMs, endMs] slice of an AudioBuffer's first channel as a
// Float32Array at the buffer's native sample rate. Used to embed a Grad-CAM
// salient region via /embed and project it into the voice-space constellation.
// Mirrors the offset/duration math in playSegment.
export function sliceBufferToFloat32(
  buffer: Pick<AudioBuffer, "sampleRate" | "getChannelData">,
  startMs: number,
  endMs: number,
): Float32Array {
  const sr = buffer.sampleRate;
  const channel = buffer.getChannelData(0);
  const startSample = Math.max(0, Math.floor((startMs / 1000) * sr));
  const endSample = Math.min(channel.length, Math.ceil((endMs / 1000) * sr));
  if (endSample <= startSample) return new Float32Array(0);
  return channel.slice(startSample, endSample);
}

// The gaps BETWEEN the salient bands across [0, durationMs] — i.e. the audio
// the faithfulness "delete" pass keeps. Mirrors the backend's complement mask
// so what you hear matches what the model was re-scored on.
export function complementSegments(segments: CamSegment[], durationMs: number): CamSegment[] {
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs);
  const out: CamSegment[] = [];
  let cursor = 0;
  for (const seg of sorted) {
    if (seg.startMs > cursor) out.push({ startMs: cursor, endMs: seg.startMs, peak: seg.peak });
    cursor = Math.max(cursor, seg.endMs);
  }
  if (cursor < durationMs) out.push({ startMs: cursor, endMs: durationMs, peak: 0 });
  return out;
}

export type SalientPlayback = { stop: () => void; promise: Promise<void> };

// `onTick` reports the current playhead position in milliseconds along the
// FULL clip timeline (not relative to a slice), so callers can place a
// playhead over the spectrogram regardless of which segment is playing.
export type PlayOptions = { onTick?: (clipMs: number) => void };

// Drives an rAF loop that reports the playhead position until cancelled.
function runPlayhead(
  ctx: AudioContext,
  startTime: number,
  baseMs: number,
  onTick?: (clipMs: number) => void,
): () => void {
  if (!onTick) return () => {};
  let raf = 0;
  let cancelled = false;
  const tick = () => {
    if (cancelled) return;
    onTick(baseMs + (ctx.currentTime - startTime) * 1000);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    cancelled = true;
    if (raf) cancelAnimationFrame(raf);
  };
}

// Play the whole clip (segments === null) or play the full clip with audio
// gated to the salient bands (gain envelope). Playhead runs across the clip.
export function playSalient(
  buffer: AudioBuffer,
  segments: CamSegment[] | null,
  opts?: PlayOptions,
): SalientPlayback {
  const ctx = getAudioCtx();
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const gain = ctx.createGain();
  src.connect(gain).connect(ctx.destination);

  if (segments === null) {
    gain.gain.setValueAtTime(1, ctx.currentTime);
  } else {
    gain.gain.setValueAtTime(0, ctx.currentTime);
    const fade = FADE_MS / 1000;
    for (const seg of segments) {
      const start = ctx.currentTime + seg.startMs / 1000;
      const end = ctx.currentTime + seg.endMs / 1000;
      gain.gain.setValueAtTime(0, Math.max(ctx.currentTime, start - fade));
      gain.gain.linearRampToValueAtTime(1, start);
      gain.gain.setValueAtTime(1, Math.max(start, end - fade));
      gain.gain.linearRampToValueAtTime(0, end);
    }
  }

  const stopPlayhead = runPlayhead(ctx, ctx.currentTime, 0, opts?.onTick);
  const promise = new Promise<void>((resolve) => {
    src.onended = () => {
      stopPlayhead();
      void ctx.close();
      resolve();
    };
  });

  src.start();

  return {
    stop: () => {
      try { src.stop(); } catch { /* already stopped */ }
    },
    promise,
  };
}

// Play ONLY the [startMs, endMs] slice of the clip. The playhead reports
// absolute clip position (startMs + elapsed) so it lands under the band.
export function playSegment(
  buffer: AudioBuffer,
  startMs: number,
  endMs: number,
  opts?: PlayOptions,
): SalientPlayback {
  const ctx = getAudioCtx();
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);

  const offset = Math.max(0, startMs / 1000);
  const duration = Math.max(0.01, (endMs - startMs) / 1000);

  const stopPlayhead = runPlayhead(ctx, ctx.currentTime, startMs, opts?.onTick);
  const promise = new Promise<void>((resolve) => {
    src.onended = () => {
      stopPlayhead();
      void ctx.close();
      resolve();
    };
  });

  src.start(0, offset, duration);

  return {
    stop: () => {
      try { src.stop(); } catch { /* already stopped */ }
    },
    promise,
  };
}
