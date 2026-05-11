import { useEffect, useRef, useState } from "react";
import { embedAudio } from "../lib/api";
import { projectPCA3, type PCA3 } from "../lib/pca";

const LIVE_TOGGLE_KEY = "biovoice.constellation.liveOn";
const LIVE_WINDOW_SECONDS = 1.5;
const DEFAULT_INTERVAL_MS = 500;

export function readLiveToggle(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const v = window.localStorage.getItem(LIVE_TOGGLE_KEY);
    if (v === null) return true;
    return v !== "0" && v.toLowerCase() !== "false";
  } catch {
    return true;
  }
}

export function writeLiveToggle(on: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LIVE_TOGGLE_KEY, on ? "1" : "0");
  } catch {
    /* noop */
  }
}

export type LiveEmbeddingState = {
  liveProjected: [number, number, number] | null;
  loading: boolean;
  enabled: boolean;
  setEnabled: (on: boolean) => void;
};

/**
 * V3 — pulls the most recent ~1.5 s out of `useMicrophone`'s rolling
 * Float32 ring (via `getRecentFloat`), posts to `POST /embed`, and
 * projects the resulting 192-d vector through the supplied PCA basis
 * (must come from `useEmbeddingProjection`).
 *
 * Settings toggle: localStorage `biovoice.constellation.liveOn`
 * (default true). Setting it to "0" / "false" stops all polling.
 *
 * Concurrency: at most one in-flight request — newer ticks short-
 * circuit. Errors are swallowed (live preview is decorative — a 4xx
 * on a 1.5 s mic burst with no speech shouldn't surface to the
 * operator).
 */
export function useLiveEmbedding(opts: {
  getRecentFloat: ((seconds: number) => Float32Array | null) | null;
  sampleRate: number;
  basis: PCA3 | null;
  intervalMs?: number;
}): LiveEmbeddingState {
  const { getRecentFloat, sampleRate, basis } = opts;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const [liveProjected, setLiveProjected] = useState<[number, number, number] | null>(null);
  const [loading, setLoading] = useState(false);
  const [enabled, setEnabledState] = useState<boolean>(() => readLiveToggle());
  const inFlight = useRef(false);

  const setEnabled = (on: boolean) => {
    writeLiveToggle(on);
    setEnabledState(on);
    if (!on) setLiveProjected(null);
  };

  useEffect(() => {
    if (!enabled || basis === null || !getRecentFloat) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled || inFlight.current) return;
      const window = getRecentFloat(LIVE_WINDOW_SECONDS);
      if (!window) return; // ring not yet full
      inFlight.current = true;
      setLoading(true);
      try {
        const result = await embedAudio(window, sampleRate);
        if (cancelled) return;
        const projected = projectPCA3(result.embedding, basis);
        setLiveProjected(projected);
      } catch {
        // Decorative preview — silent on errors (no speech, network blip).
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
  }, [enabled, basis, intervalMs, getRecentFloat, sampleRate]);

  // External callers can mutate localStorage too — keep state in sync.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (e: StorageEvent) => {
      if (e.key !== LIVE_TOGGLE_KEY) return;
      setEnabledState(readLiveToggle());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return { liveProjected, loading, enabled, setEnabled };
}
