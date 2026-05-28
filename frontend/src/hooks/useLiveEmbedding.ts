import { useEffect, useRef, useState } from "react";
import { embedAudio } from "../lib/api";
import { projectPCA3, type PCA3 } from "../lib/pca";
import type { SpeakerModelKey } from "../types";

const LIVE_WINDOW_SECONDS = 1.5;
const DEFAULT_INTERVAL_MS = 500;

export type LiveEmbeddingState = {
  liveProjected: [number, number, number] | null;
  loading: boolean;
};

/**
 * Streams the latest mic window through `/embed` for the selected
 * speaker model, then projects that embedding into the active PCA basis.
 */
export function useLiveEmbedding(opts: {
  getRecentFloat: ((seconds: number) => Float32Array | null) | null;
  sampleRate: number;
  basis: PCA3 | null;
  modelKey: SpeakerModelKey;
  intervalMs?: number;
}): LiveEmbeddingState {
  const { getRecentFloat, sampleRate, basis, modelKey } = opts;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const [liveProjected, setLiveProjected] = useState<[number, number, number] | null>(null);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    if (basis === null || !getRecentFloat) {
      setLiveProjected(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      if (cancelled || inFlight.current) return;
      const window = getRecentFloat(LIVE_WINDOW_SECONDS);
      if (!window) return;
      inFlight.current = true;
      setLoading(true);
      try {
        const result = await embedAudio(window, sampleRate, modelKey);
        if (cancelled) return;
        setLiveProjected(projectPCA3(result.embedding, basis));
      } catch {
        // Decorative preview only — stay silent on errors.
      } finally {
        inFlight.current = false;
        if (!cancelled) setLoading(false);
      }
    };
    const id = window.setInterval(tick, intervalMs);
    void tick();
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [basis, getRecentFloat, intervalMs, modelKey, sampleRate]);

  return { liveProjected, loading };
}
