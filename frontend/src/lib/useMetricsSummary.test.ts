// Vitest unit tests for the metrics-summary helpers.
// The polling hook is exercised at the formatter level + via a stubbed
// fetch — happy-dom doesn't have RAF integration that's worth wiring
// for one polling loop, so we test the pure functions and the api
// helper's contract.

import { describe, expect, it, beforeEach, afterEach, vi, type Mock } from "vitest";
import { getMetricsSummary } from "./api";
import {
  formatLatency,
  formatThroughput,
  formatUptime,
} from "./useMetricsSummary";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn() as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("getMetricsSummary", () => {
  it("transforms snake_case backend fields into camelCase", async () => {
    (globalThis.fetch as Mock).mockResolvedValueOnce(
      jsonResponse({
        verifications_total: 42,
        throughput_per_sec: 0.7,
        uptime_sec: 600,
        cold_start_at: "2026-05-10T17:00:00Z",
        p50_verify_ms: 412.5,
      }),
    );
    const summary = await getMetricsSummary();
    expect(summary).toEqual({
      verificationsTotal: 42,
      throughputPerSec: 0.7,
      uptimeSec: 600,
      coldStartAt: "2026-05-10T17:00:00Z",
      p50VerifyMs: 412.5,
    });
  });

  it("propagates the null p50 case (no observations yet)", async () => {
    (globalThis.fetch as Mock).mockResolvedValueOnce(
      jsonResponse({
        verifications_total: 0,
        throughput_per_sec: 0,
        uptime_sec: 5,
        cold_start_at: "2026-05-10T17:00:00Z",
        p50_verify_ms: null,
      }),
    );
    const summary = await getMetricsSummary();
    expect(summary.p50VerifyMs).toBeNull();
  });
});

describe("formatLatency", () => {
  it("returns em-dash when p50 is null", () => {
    expect(formatLatency(null)).toBe("—");
  });
  it("formats sub-millisecond as <1 ms", () => {
    expect(formatLatency(0.4)).toBe("<1 ms");
  });
  it("formats milliseconds as integer ms", () => {
    expect(formatLatency(412)).toBe("412 ms");
    expect(formatLatency(999)).toBe("999 ms");
  });
  it("formats seconds with two decimals", () => {
    expect(formatLatency(1500)).toBe("1.50 s");
    expect(formatLatency(2750)).toBe("2.75 s");
  });
});

describe("formatThroughput", () => {
  it("formats zero as 0 / s", () => {
    expect(formatThroughput(0)).toBe("0 / s");
  });
  it("formats per-second when ≥ 1", () => {
    expect(formatThroughput(2.5)).toBe("2.5 / s");
  });
  it("downscales to per-minute under 1/s", () => {
    expect(formatThroughput(0.5)).toBe("30.0 / m");
  });
  it("downscales to per-hour under 1/m", () => {
    expect(formatThroughput(0.001)).toBe("3.6 / h");
  });
});

describe("formatUptime", () => {
  it("formats seconds-only when under a minute", () => {
    expect(formatUptime(42)).toBe("42s");
  });
  it("formats minutes-and-seconds", () => {
    expect(formatUptime(125)).toBe("2m 5s");
    expect(formatUptime(180)).toBe("3m");
  });
  it("formats hours-and-minutes", () => {
    expect(formatUptime(3700)).toBe("1h 1m");
    expect(formatUptime(7200)).toBe("2h");
  });
  it("formats days-and-hours", () => {
    expect(formatUptime(90_000)).toBe("1d 1h");
    expect(formatUptime(86_400)).toBe("1d");
  });
});
