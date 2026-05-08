import type { Dispatch } from "react";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Waveform } from "../components/Waveform";
import type { FlowAction, FlowState } from "../lib/flowState";

/**
 * Stub. Yoav owns the real implementation (Y-3) — live mic, ID-availability pill,
 * 1–10 s recording, POST /enroll. This stub keeps the routing alive end-to-end.
 */

type Props = {
  state: FlowState;
  dispatch: Dispatch<FlowAction>;
};

export function EnrollScreen({ state, dispatch }: Props) {
  const sample = Math.max(1, state.sampleIndex + 1);

  return (
    <>
      <div className="bv-page-header">
        <h1>New User Enrollment</h1>
        <p>Record your voice to create a unique voiceprint.</p>
      </div>

      <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
        <input placeholder="john_doe_123" style={{ flex: 1 }} />
        <Badge tone="success" showDot>ID Available</Badge>
      </div>

      <div className="bv-card">
        <div className="bv-page-header">
          <h1 style={{ fontSize: 14 }}>Voice Recording</h1>
          <p>Stub — live mic + 16 kHz capture lands in Y-1.</p>
        </div>
        <Waveform mode="idle" />
        <div className="muted mono" style={{ textAlign: "center", fontSize: 13 }}>00:00.0</div>
      </div>

      <div className="bv-card bv-card--info-strong" style={{ padding: 14, fontSize: 13 }}>
        💡 Tip: Speak naturally for 3–10 seconds. A quiet environment will give best results.
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: "auto" }}>
        <Button variant="ghost" onClick={() => dispatch({ type: "navigate", screen: "home" })}>Back</Button>
        <Button
          variant="primary"
          block
          onClick={() => {
            dispatch({ type: "set-pending", promise: Promise.resolve() });
            dispatch({ type: "navigate", screen: "processing" });
          }}
        >
          Save sample {sample} / 3 (stub)
        </Button>
      </div>
    </>
  );
}
