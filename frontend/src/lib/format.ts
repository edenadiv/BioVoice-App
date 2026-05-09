// F5.7 — locale-aware date / number formatting.
//
// All string-facing dates and numbers should pass through here so an
// operator switching to Hebrew sees `09.05.2026, 14:23` instead of the
// US-style `5/9/2026, 2:23 PM`. The kiosk previously hard-coded
// `toLocaleString()` calls without a locale argument; this module is
// the single replacement for those.

import { currentLanguage } from "../i18n";

export function formatDateTime(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  // Hebrew gets the ISO 8601-aligned `dd.mm.yyyy, HH:MM` Israeli
  // convention; English gets the US "Jan 5, 2026, 2:23 PM" form.
  const lang = currentLanguage();
  if (lang === "he") {
    return new Intl.DateTimeFormat("he-IL", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  const lang = currentLanguage();
  return new Intl.NumberFormat(lang === "he" ? "he-IL" : "en-US", options).format(value);
}

export function formatPercent(value: number, fractionDigits = 0): string {
  // value is in [0, 1].
  return formatNumber(value, {
    style: "percent",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

export function formatRelativeTime(when: string | number | Date): string {
  const target = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(target.getTime())) return "";
  const diffSeconds = Math.round((target.getTime() - Date.now()) / 1000);
  const lang = currentLanguage();
  const rtf = new Intl.RelativeTimeFormat(lang === "he" ? "he-IL" : "en-US", { numeric: "auto" });
  const abs = Math.abs(diffSeconds);
  if (abs < 60) return rtf.format(diffSeconds, "second");
  if (abs < 60 * 60) return rtf.format(Math.round(diffSeconds / 60), "minute");
  if (abs < 60 * 60 * 24) return rtf.format(Math.round(diffSeconds / 60 / 60), "hour");
  return rtf.format(Math.round(diffSeconds / 60 / 60 / 24), "day");
}
