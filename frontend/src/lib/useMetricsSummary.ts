// Polls /metrics/summary every 5 s. Drives the Console panel's
// Metric components (replaces the old hardcoded "11ms / 62/s / 14d").
//
// Mirrors the useResultsPolling pattern: AbortController per request,
// exponential backoff on error so a backend hiccup doesn't burn the
// kiosk's network. Returns null until the first poll lands.

import { useEffect, useRef, useState } from "react";
import { getMetricsSummary, type MetricsSummary } from "./api";

const POLL_MS = 5_000;
const MAX_BACKOFF_MS = 30_000;

export function useMetricsSummary(): MetricsSummary | null {
  const [summary, setSummary] = useState<MetricsSummary | null>(null);
  const backoffRef = useRef(POLL_MS);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | null = null;
    let abortController: AbortController | null = null;

    const tick = async () => {
      abortController = new AbortController();
      try {
        const next = await getMetricsSummary();
        if (cancelled) return;
        setSummary(next);
        backoffRef.current = POLL_MS;
      } catch {
        // Backend hiccup — keep the last good value, back off.
        backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF_MS);
      }
      if (cancelled) return;
      timeoutId = window.setTimeout(tick, backoffRef.current);
    };

    void tick();

    return () => {
      cancelled = true;
      if (timeoutId !== null) clearTimeout(timeoutId);
      abortController?.abort();
    };
  }, []);

  return summary;
}

/** Format seconds-since-boot as a compact `Xd Yh` / `Xh Ym` / `Xm Ys`
 *  string for the Console Uptime metric. */
export function formatUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  if (sec < 86_400) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3600);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

/** Format the throughput as a compact rate string for the Console. */
export function formatThroughput(perSec: number): string {
  if (perSec === 0) return "0 / s";
  if (perSec >= 1) return `${perSec.toFixed(1)} / s`;
  // Sub-1/s — show per-minute for readability.
  const perMin = perSec * 60;
  if (perMin >= 1) return `${perMin.toFixed(1)} / m`;
  return `${(perMin * 60).toFixed(1)} / h`;
}

/** Format the p50 latency in milliseconds, or "—" if no observations. */
export function formatLatency(p50Ms: number | null): string {
  if (p50Ms === null) return "—";
  if (p50Ms < 1) return "<1 ms";
  if (p50Ms < 1000) return `${Math.round(p50Ms)} ms`;
  return `${(p50Ms / 1000).toFixed(2)} s`;
}
