// HF1 — visible warning when any backend subsystem is in heuristic
// fallback. Operators see this above any result panel that came from
// a degraded pipeline.
//
// Per audit-v1.0.md F-1 + F-2: previously the API silently swapped
// AASIST for a 3-line linear formula when weights were missing; the
// UI had no signal. This banner makes the swap visible.

import type { CSSProperties } from "react";
import type { ModelProvenance } from "../types";

interface DegradedBannerProps {
  provenance: ModelProvenance | null | undefined;
  /** Subset of subsystems to surface. Defaults to all three. Use
   *  `["encoder"]` on enrolment-only flows, etc. */
  show?: Array<"encoder" | "detector" | "acoustic_probe">;
  /** Override the default "compact" inline rendering for a fuller banner. */
  variant?: "compact" | "full";
  style?: CSSProperties;
}

export function DegradedBanner({ provenance, show, variant = "compact", style }: DegradedBannerProps) {
  if (!provenance) return null;

  const tracked = show ?? ["encoder", "detector", "acoustic_probe"];
  const offenders: string[] = [];

  if (tracked.includes("encoder") && provenance.encoder !== "redimnet_b5") {
    offenders.push("speaker encoder (heuristic fallback)");
  }
  if (tracked.includes("detector") && provenance.detector !== "aasist") {
    offenders.push("anti-spoof detector (heuristic fallback)");
  }
  // acoustic_probe is intentionally NOT surfaced as a degradation in
  // v1.0 — every operator runs heuristic mode by design (trained heads
  // are v1.1). Surfacing it would create banner noise. The HF3 mode
  // flag on AnalysisDetails handles this disclosure separately.

  if (offenders.length === 0) return null;

  return (
    <div role="alert" style={{ ...bannerStyle(variant), ...style }}>
      <span style={iconStyle}>⚠</span>
      <div style={{ flex: 1 }}>
        <div style={titleStyle}>
          {variant === "full" ? "Heuristic fallback active" : "Heuristic fallback"}
        </div>
        <div style={bodyStyle}>
          {offenders.join(" · ")}.
          {variant === "full" && (
            <> Restore the model weights at <code style={codeStyle}>backend/models/</code> and restart the backend.</>
          )}
        </div>
      </div>
    </div>
  );
}

const bannerStyle = (variant: "compact" | "full"): CSSProperties => ({
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
  padding: variant === "full" ? "12px 16px" : "8px 12px",
  borderRadius: 10,
  background: "rgba(255, 85, 119, 0.08)",
  border: "1px solid rgba(255, 85, 119, 0.45)",
  color: "#ff7aa8",
  fontSize: variant === "full" ? 12 : 11,
  fontFamily: "JetBrains Mono, monospace",
  letterSpacing: "0.02em",
});

const iconStyle: CSSProperties = {
  fontSize: 14,
  lineHeight: 1,
  color: "#ff5577",
  marginTop: 1,
};

const titleStyle: CSSProperties = {
  fontWeight: 600,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  fontSize: 9,
  marginBottom: 3,
};

const bodyStyle: CSSProperties = {
  color: "#ffadad",
  lineHeight: 1.4,
};

const codeStyle: CSSProperties = {
  background: "rgba(0,0,0,0.3)",
  padding: "1px 5px",
  borderRadius: 3,
  fontSize: 10,
};
