import { useEffect, useRef, useState } from "react";

/**
 * Drives a multi-stage progress animation against an in-flight promise.
 *
 *  - Stages 0..N-2 animate to ~95 % progress over `expectedTotalMs`.
 *  - The final stage holds at 95 % until the promise settles.
 *  - If the promise hasn't settled by `slowAfterMs`, `isSlow` flips to true so
 *    the UI can switch to an indeterminate "Still working…" state.
 *  - Once the promise resolves or rejects, `settled` is true and progress = 1.
 *
 * Used by `ProcessingScreen` (Y-14) and `VerificationOverlay` (E-18).
 */
export type CalibratedTimeline = {
  activeIdx: number;
  progress: number;
  isSlow: boolean;
  settled: boolean;
};

export function useCalibratedTimeline(
  promise: Promise<unknown> | null,
  opts: { stages: number; expectedTotalMs: number; slowAfterMs?: number },
): CalibratedTimeline {
  const { stages, expectedTotalMs, slowAfterMs = 4000 } = opts;
  const [state, setState] = useState<CalibratedTimeline>({
    activeIdx: 0,
    progress: 0,
    isSlow: false,
    settled: false,
  });
  const settledRef = useRef(false);

  useEffect(() => {
    if (!promise) return;
    settledRef.current = false;
    setState({ activeIdx: 0, progress: 0, isSlow: false, settled: false });

    const startedAt = performance.now();
    let cancelled = false;
    let raf: number | null = null;

    const tick = () => {
      if (cancelled) return;
      if (settledRef.current) return;
      const elapsed = performance.now() - startedAt;
      const ratio = Math.min(1, elapsed / expectedTotalMs);
      const idx = Math.min(stages - 1, Math.floor(ratio * stages));
      setState({
        activeIdx: idx,
        progress: Math.min(0.95, ratio),
        isSlow: elapsed > slowAfterMs,
        settled: false,
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    promise.finally(() => {
      if (cancelled) return;
      settledRef.current = true;
      setState({
        activeIdx: stages - 1,
        progress: 1,
        isSlow: false,
        settled: true,
      });
    });

    return () => {
      cancelled = true;
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, [promise, stages, expectedTotalMs, slowAfterMs]);

  return state;
}
