// G7 — Vitest unit tests for the locale-aware Intl.* helpers.
//
// Goal: lock down that switching i18n.language between 'en' and 'he'
// actually changes the formatting (US vs Israeli conventions). The
// helpers consume `currentLanguage()` from `i18n/index.ts`, so we
// switch the language directly and re-call the helper.

import { describe, expect, it, beforeEach } from "vitest";
import i18n, { changeLanguage } from "../i18n";
import { formatDateTime, formatNumber, formatPercent, formatRelativeTime } from "./format";

describe("format helpers — English locale", () => {
  beforeEach(async () => {
    if (i18n.language !== "en") {
      await changeLanguage("en");
    }
  });

  it("formats a date with US conventions", () => {
    const out = formatDateTime("2026-05-09T14:23:00Z");
    // US locale yields 'May 9, 2026' (or 'May 9, 2026, 2:23 PM') —
    // assert the parts that don't depend on the host's timezone.
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
});

describe("format helpers — Hebrew locale", () => {
  beforeEach(async () => {
    if (i18n.language !== "he") {
      await changeLanguage("he");
    }
  });

  it("formats a date with Israeli conventions (24h, dd.mm.yyyy)", () => {
    const out = formatDateTime("2026-05-09T14:23:00Z");
    // Israeli format uses dot separators between day/month/year and
    // 24-hour time. Assert the structural shape — '/' is also accepted
    // because some platforms emit `dd/mm/yyyy`.
    expect(out).toMatch(/\d{2}[.\/]\d{2}[.\/]\d{4}/);
    // No AM/PM markers in 24-hour mode.
    expect(out).not.toMatch(/AM|PM/i);
  });

  it("formats numbers using he-IL grouping", () => {
    // he-IL uses commas the same way en-US does for thousands
    // separators; the assertion is that the helper doesn't blow up
    // on the locale switch.
    expect(formatNumber(1234567)).toMatch(/1.234.567/);
  });

  it("relative-time helper returns a string for a recent timestamp", () => {
    const out = formatRelativeTime(new Date(Date.now() - 60_000));
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });
});
