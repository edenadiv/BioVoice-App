import type { Dispatch } from "react";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { ProgressBar } from "../components/ProgressBar";
import type { FlowAction, FlowState } from "../lib/flowState";

/**
 * Stub. Yoav owns the real implementation (Y-5) — verdict banner with AASIST sub-scores.
 * This stub renders the response we already get from /verify; the four sub-bars are
 * placeholder values until Y-8 wires analysis_details.
 */

type Props = {
  state: FlowState;
  dispatch: Dispatch<FlowAction>;
};

export function DeepfakeResultScreen({ state, dispatch }: Props) {
  const score = state.lastDeepfakeScore ?? state.lastVerification?.deepfakeScore ?? 0;
  const isGenuine = score >= 0.5;
  const confidence = Math.round((isGenuine ? score : 1 - score) * 1000) / 10;

  // Placeholder sub-scores until Y-8 (Yoav). Today the values come from
  // `analysis_details` populated by the verification service from the AASIST score.
  const responseDetails =
    state.lastVerification?.analysisDetails ?? state.lastDeepfakeDetails ?? null;
  const sub = responseDetails ?? {
    voiceNaturalness: isGenuine ? 0.98 : 0.30,
    spectralConsistency: isGenuine ? 0.95 : 0.28,
    temporalPatterns: isGenuine ? 0.99 : 0.22,
    artifactDetection: isGenuine ? 0.02 : 0.86,
  };

  return (
    <>
      <div className="bv-page-header">
        <h1>Deepfake Detection Result</h1>
        <p>Audio authenticity analysis complete.</p>
      </div>

      <div className={`bv-card bv-card--banner-${isGenuine ? "success" : "danger"}`}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: isGenuine ? "var(--text-success)" : "var(--text-danger)", letterSpacing: "0.04em" }}>
            {isGenuine ? "GENUINE AUDIO" : "SYNTHETIC AUDIO DETECTED"}
          </div>
          <p style={{ margin: "6px 0 0", fontSize: 13 }}>
            {isGenuine
              ? "This audio appears to be from a real human speaker. No signs of synthetic generation or manipulation detected."
              : "This audio shows signs of AI generation or manipulation."}
          </p>
          <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-secondary)" }}>
            Confidence: {confidence}%
          </div>
        </div>
      </div>

      <div className="bv-page-header" style={{ marginTop: 6 }}>
        <h1 style={{ fontSize: 14 }}>Analysis Details</h1>
      </div>

      <ProgressBar layout="row" tone="success" caption="Voice Naturalness" value={Math.round(sub.voiceNaturalness * 100)} />
      <ProgressBar layout="row" tone="success" caption="Spectral Consistency" value={Math.round(sub.spectralConsistency * 100)} />
      <ProgressBar layout="row" tone="success" caption="Temporal Patterns" value={Math.round(sub.temporalPatterns * 100)} />
      <ProgressBar layout="row" tone="success" caption="Artifact Detection" value={Math.round(sub.artifactDetection * 100)} />

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 14 }}>
        <Badge tone="info" leadingIcon={<span style={{ fontSize: 14 }}>🛡️</span>}>AASIST</Badge>
        <span className="muted" style={{ fontSize: 12 }}>Powered by Audio Anti-Spoofing AI</span>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: "auto" }}>
        <Button variant="ghost" onClick={() => dispatch({ type: "navigate", screen: "home" })}>Home</Button>
        <Button
          variant="primary"
          block
          onClick={() => dispatch({ type: "navigate", screen: "verify_result" })}
        >
          Continue
        </Button>
      </div>
    </>
  );
}
