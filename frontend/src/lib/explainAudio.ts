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

export type SalientPlayback = { stop: () => void; promise: Promise<void> };

export function playSalient(buffer: AudioBuffer, segments: CamSegment[] | null): SalientPlayback {
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

  const promise = new Promise<void>((resolve) => {
    src.onended = () => {
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
