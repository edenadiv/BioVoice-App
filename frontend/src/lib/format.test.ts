// Vitest unit tests for the locale-aware Intl.* helpers.
// English-only after the i18n strip.

import { describe, expect, it } from "vitest";
import { formatDateTime, formatNumber, formatPercent, formatRelativeTime } from "./format";

describe("format helpers (English / en-US)", () => {
  it("formats a date with US conventions", () => {
    const out = formatDateTime("2026-05-09T14:23:00Z");
    // US locale yields 'May 9, 2026'-ish — assert the parts that don't
    // depend on the host's timezone.
    expect(out).toMatch(/May/);
    expect(out).toMatch(/2026/);
  });

  it("formats numbers with comma grouping", () => {
    expect(formatNumber(1234567)).toBe("1,234,567");
  });

  it("formats percent with no fraction digits by default", () => {
    expect(formatPercent(0.857)).toBe("86%");
  });

  it("returns empty string on an unparseable date", () => {
    expect(formatDateTime("not-a-date")).toBe("");
  });

  it("relative-time helper returns a string for a recent timestamp", () => {
    const out = formatRelativeTime(new Date(Date.now() - 60_000));
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });
});
