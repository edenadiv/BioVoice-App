// Locale-aware Intl.* helpers. English-only after the i18n strip.
// Kept as a module so date / number / percent formatting stays
// consistent across the kiosk and so a future locale re-introduction
// can re-add the language switch in one place.

export function formatDateTime(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat("en-US", options).format(value);
}

export function formatPercent(value: number, fractionDigits = 0): string {
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
  const rtf = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });
  const abs = Math.abs(diffSeconds);
  if (abs < 60) return rtf.format(diffSeconds, "second");
  if (abs < 60 * 60) return rtf.format(Math.round(diffSeconds / 60), "minute");
  if (abs < 60 * 60 * 24) return rtf.format(Math.round(diffSeconds / 60 / 60), "hour");
  return rtf.format(Math.round(diffSeconds / 60 / 60 / 24), "day");
}
