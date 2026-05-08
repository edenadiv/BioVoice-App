import type { Dispatch } from "react";
import { Button } from "../components/Button";
import { Gauge } from "../components/Gauge";
import { type FlowAction, type FlowState } from "../lib/flowState";

/**
 * Stub. Eden owns the real implementation (E-5) — pixel-snap to Fig. 18 and
 * View Details modal once E-7/E-8 land.
 */

type Props = {
  state: FlowState;
  dispatch: Dispatch<FlowAction>;
};

const SIM_THRESHOLD = 0.75;

export function VerifyResultScreen({ state, dispatch }: Props) {
  const result = state.lastVerification;
  const sim = result?.similarityScore ?? 0;
  const df = result?.deepfakeScore ?? 0;
  const accepted = result?.decision === "ACCEPT";
  const synthetic = result?.decision === "DEEPFAKE";

  return (
    <>
      <div className={`bv-card bv-card--banner-${accepted ? "success" : "danger"}`}>
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: "50%",
            background: accepted ? "var(--accent-success)" : "var(--accent-danger)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            fontSize: 26,
            flex: "0 0 auto",
          }}
          aria-hidden="true"
        >
          {accepted ? "✓" : "✕"}
        </div>
        <div>
          <div
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: accepted ? "var(--text-success)" : "var(--text-danger)",
              letterSpacing: "0.04em",
            }}
          >
            {accepted ? "IDENTITY VERIFIED" : "ACCESS DENIED"}
          </div>
          <p style={{ margin: "6px 0 0", fontSize: 14 }}>
            {accepted ? `Welcome back, ${state.userId || result?.userId}!` : synthetic ? "Audio flagged as synthetic." : "Speaker did not match enrolled profile."}
          </p>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            {accepted ? "Voice match confirmed" : "Try again with a fresh recording"}
          </div>
        </div>
      </div>

      <div className="bv-page-header" style={{ marginTop: 6 }}>
        <h1 style={{ fontSize: 14 }}>Verification Scores</h1>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <div className="bv-card" style={{ alignItems: "center" }}>
          <span className="muted" style={{ fontSize: 12 }}>Voice Similarity</span>
          <Gauge value={sim} threshold={SIM_THRESHOLD} />
          <span className="muted" style={{ fontSize: 11 }}>Threshold: {SIM_THRESHOLD.toFixed(2)}</span>
        </div>
        <div className="bv-card" style={{ alignItems: "center", justifyContent: "center" }}>
          <span className="muted" style={{ fontSize: 12 }}>Authenticity Check</span>
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: "50%",
              background: df >= 0.5 ? "var(--bg-success-strong)" : "var(--bg-danger)",
              color: df >= 0.5 ? "var(--text-success)" : "var(--text-danger)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 26,
            }}
            aria-hidden="true"
          >
            {df >= 0.5 ? "✓" : "✕"}
          </div>
          <span style={{ fontSize: 13, color: df >= 0.5 ? "var(--text-success)" : "var(--text-danger)" }}>
            {df >= 0.5 ? "Audio is genuine" : "Audio flagged as synthetic"}
          </span>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <Button variant="success" block onClick={() => dispatch({ type: "navigate", screen: "home" })}>
          Continue
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            dispatch({ type: "reset-flow" });
            dispatch({ type: "navigate", screen: state.intent === "enroll" ? "enroll" : "login" });
          }}
        >
          Try Again
        </Button>
        <Button variant="primary" disabled>View Details</Button>
      </div>

      <div className="muted" style={{ fontSize: 11, marginTop: "auto" }}>
        {result?.createdAt ? <>Verified at {new Date(result.createdAt).toLocaleString()}</> : null}
        {result?.resultId ? (
          <>
            {" · "}Session ID: VRF-{new Date(result.createdAt).toISOString().slice(0, 4)}-
            {new Date(result.createdAt).toISOString().slice(5, 7)}
            {new Date(result.createdAt).toISOString().slice(8, 10)}-
            {result.resultId.slice(-4).toUpperCase()}
          </>
        ) : null}
      </div>
    </>
  );
}
