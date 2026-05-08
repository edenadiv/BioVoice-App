import { useEffect } from "react";
import { listResults } from "./api";
import type { VerificationResult } from "../types";

/**
 * Polls GET /results on a fixed interval. Errors back off exponentially
 * (5 s → 10 s → 20 s, capped at 30 s) so a downed backend doesn't melt the
 * dev console. Mounted exactly once inside the session provider.
 */
export function useResultsPolling(
  onResults: (results: VerificationResult[]) => void,
  intervalMs = 5000,
  maxBackoffMs = 30000,
): void {
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let backoff = intervalMs;

    const tick = async () => {
      try {
        const next = await listResults();
        if (!alive) return;
        onResults(next);
        backoff = intervalMs;
      } catch {
        backoff = Math.min(backoff * 2, maxBackoffMs);
      }
      if (alive) {
        timer = setTimeout(tick, backoff);
      }
    };

    void tick();

    return () => {
      alive = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [onResults, intervalMs, maxBackoffMs]);
}
