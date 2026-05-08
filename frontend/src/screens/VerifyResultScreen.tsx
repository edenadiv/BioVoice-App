import { type Dispatch, useEffect, useState } from "react";
import { Button } from "../components/Button";
import { Gauge } from "../components/Gauge";
import { getMyVerification } from "../lib/api";
import {
  type FlowAction,
  type FlowState,
  SESSION_STORAGE_KEY,
} from "../lib/flowState";
import type { VerificationResult } from "../types";

const SIM_THRESHOLD = 0.75;
const DF_THRESHOLD = 0.5;

type Props = {
  state: FlowState;
  dispatch: Dispatch<FlowAction>;
};

export function VerifyResultScreen({ state, dispatch }: Props) {
  const result = state.lastVerification;
  const [showDetails, setShowDetails] = useState(false);

  if (!result) {
    return (
      <>
        <div className="bv-page-header">
          <h1>No verification on record yet</h1>
          <p>Run a verification flow to populate this screen.</p>
        </div>
        <div style={{ marginTop: "auto" }}>
          <Button variant="primary" onClick={() => dispatch({ type: "navigate", screen: "home" })}>
            Back home
          </Button>
        </div>
      </>
    );
  }

  const accepted = result.decision === "ACCEPT";
  const synthetic = result.decision === "DEEPFAKE";
  const sim = result.similarityScore;
  const df = result.deepfakeScore;

  function tryAgain() {
    dispatch({ type: "reset-flow" });
    dispatch({ type: "navigate", screen: state.intent === "enroll" ? "enroll" : "login" });
  }

  function continueHome() {
    dispatch({ type: "reset-flow" });
    dispatch({ type: "navigate", screen: "home" });
  }

  function logout() {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
    dispatch({ type: "logout" });
  }

  return (
    <>
      <div
        className={`bv-card bv-card--banner-${accepted ? "success" : "danger"}`}
        style={{ animation: "bv-fade-in 320ms ease-out both" }}
      >
        <div
          style={{
            width: 60,
            height: 60,
            borderRadius: "50%",
            background: accepted ? "var(--accent-success)" : "var(--accent-danger)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            fontSize: 30,
            flex: "0 0 auto",
            fontWeight: 700,
          }}
          aria-hidden="true"
        >
          {accepted ? "✓" : "✕"}
        </div>
        <div style={{ flex: 1 }}>
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
            {accepted
              ? `Welcome back, ${state.userId || result.userId}!`
              : synthetic
                ? "Audio flagged as synthetic."
                : "Speaker did not match the enrolled profile."}
          </p>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            {accepted
              ? "Voice match confirmed"
              : synthetic
                ? "Try recording again with your real voice"
                : "Try again with a clearer recording"}
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
          <span className="muted" style={{ fontSize: 11 }}>
            Threshold: {SIM_THRESHOLD.toFixed(2)}
          </span>
        </div>
        <div className="bv-card" style={{ alignItems: "center", justifyContent: "center", textAlign: "center" }}>
          <span className="muted" style={{ fontSize: 12 }}>Authenticity Check</span>
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: "50%",
              background: df >= DF_THRESHOLD ? "var(--bg-success-strong)" : "var(--bg-danger)",
              color: df >= DF_THRESHOLD ? "var(--text-success)" : "var(--text-danger)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 28,
              margin: "8px 0 6px",
            }}
            aria-hidden="true"
          >
            {df >= DF_THRESHOLD ? "✓" : "✕"}
          </div>
          <span style={{ fontSize: 13, color: df >= DF_THRESHOLD ? "var(--text-success)" : "var(--text-danger)" }}>
            {df >= DF_THRESHOLD ? "Audio is genuine" : "Audio flagged as synthetic"}
          </span>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <Button variant="success" block onClick={continueHome}>
          Continue
        </Button>
        <Button variant="secondary" onClick={tryAgain}>
          Try Again
        </Button>
        <Button variant="primary" onClick={() => setShowDetails(true)}>
          View Details
        </Button>
      </div>

      <div className="muted" style={{ fontSize: 11, marginTop: "auto", paddingTop: 8 }}>
        Verified at {new Date(result.createdAt).toLocaleString()}
        <br />
        Session ID: {result.sessionId}
        {state.session ? (
          <>
            {" · "}
            <button
              type="button"
              onClick={logout}
              style={{ color: "inherit", textDecoration: "underline", background: "none" }}
            >
              Sign out
            </button>
          </>
        ) : null}
      </div>

      {showDetails ? (
        <DetailsModal
          result={result}
          sessionToken={state.session?.sessionToken ?? null}
          onClose={() => setShowDetails(false)}
        />
      ) : null}
    </>
  );
}

function DetailsModal({
  result,
  sessionToken,
  onClose,
}: {
  result: VerificationResult;
  sessionToken: string | null;
  onClose: () => void;
}) {
  const [enriched, setEnriched] = useState<VerificationResult>(result);

  useEffect(() => {
    if (!sessionToken) return;
    let alive = true;
    getMyVerification(sessionToken, result.resultId)
      .then((next) => {
        if (alive) setEnriched(next);
      })
      .catch(() => {
        // ignore — we already have the inline result
      });
    return () => {
      alive = false;
    };
  }, [sessionToken, result.resultId]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(20, 26, 36, 0.42)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bv-card"
        style={{
          maxWidth: 560,
          width: "calc(100% - 48px)",
          background: "var(--bg-window)",
          boxShadow: "var(--shadow-pop)",
          padding: 24,
          gap: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Verification details</div>
            <div className="muted" style={{ fontSize: 12 }}>{enriched.sessionId}</div>
          </div>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>

        <Row label="Decision" value={`${enriched.decision} · ${enriched.decisionReason}`} />
        <Row label="Similarity score" value={enriched.similarityScore.toFixed(4)} />
        <Row label="Centroid similarity" value={enriched.centroidSimilarity.toFixed(4)} />
        <Row
          label="Per-sample similarities"
          value={enriched.sampleSimilarities.map((s) => s.toFixed(3)).join("  ·  ") || "—"}
        />
        <Row label="Deepfake score" value={enriched.deepfakeScore.toFixed(4)} />

        <div className="bv-page-header" style={{ marginTop: 8 }}>
          <h1 style={{ fontSize: 12 }}>Stage breakdown (server-measured)</h1>
        </div>
        <div className="mono" style={{ fontSize: 12, display: "grid", gridTemplateColumns: "1fr auto", rowGap: 4 }}>
          <span>load</span><span>{enriched.stageBreakdown.loadMs.toFixed(2)} ms</span>
          <span>resample</span><span>{enriched.stageBreakdown.resampleMs.toFixed(2)} ms</span>
          <span>normalize</span><span>{enriched.stageBreakdown.normalizeMs.toFixed(2)} ms</span>
          <span>embed (ReDimNet-B5)</span><span>{enriched.stageBreakdown.embedMs.toFixed(2)} ms</span>
          <span>detect (AASIST)</span><span>{enriched.stageBreakdown.detectMs.toFixed(2)} ms</span>
          <span style={{ fontWeight: 700 }}>total</span><span style={{ fontWeight: 700 }}>{enriched.stageBreakdown.totalMs.toFixed(2)} ms</span>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13 }}>
      <span className="muted">{label}</span>
      <span className="mono" style={{ textAlign: "right" }}>{value}</span>
    </div>
  );
}
