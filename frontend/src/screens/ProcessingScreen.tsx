import { type Dispatch, useEffect, useState } from "react";
import { ProgressBar } from "../components/ProgressBar";
import { type Stage, StageList } from "../components/StageList";
import type { FlowAction, FlowState } from "../lib/flowState";

/**
 * Stub. Yoav owns the calibrated stage timeline (Y-4). This stub fakes a 1.2 s pipeline,
 * then routes to the next screen based on flow intent.
 */

const STAGE_LABELS: { id: string; label: string }[] = [
  { id: "load", label: "Load Audio" },
  { id: "rs", label: "Resample 16 kHz" },
  { id: "norm", label: "Normalize" },
  { id: "mel", label: "Mel-Spectrogram" },
  { id: "feat", label: "Extract Features" },
];

const TOTAL_MS = 1200;

type Props = {
  state: FlowState;
  dispatch: Dispatch<FlowAction>;
};

export function ProcessingScreen({ state, dispatch }: Props) {
  const [activeIdx, setActiveIdx] = useState(0);
  const [pct, setPct] = useState(0);

  useEffect(() => {
    const tickMs = 30;
    let elapsed = 0;
    const timer = setInterval(() => {
      elapsed += tickMs;
      const ratio = Math.min(1, elapsed / TOTAL_MS);
      setPct(Math.min(100, Math.round(ratio * 100)));
      const idx = Math.min(STAGE_LABELS.length - 1, Math.floor(ratio * STAGE_LABELS.length));
      setActiveIdx(idx);
    }, tickMs);

    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      setPct(100);
      setActiveIdx(STAGE_LABELS.length - 1);
      setTimeout(() => {
        if (!ok) {
          dispatch({ type: "set-pending", promise: null, error: "Processing failed." });
          dispatch({ type: "navigate", screen: state.intent === "enroll" ? "enroll" : "login" });
          return;
        }
        if (state.intent === "verify") {
          dispatch({ type: "navigate", screen: "deepfake_result" });
        } else {
          dispatch({ type: "navigate", screen: "verify_result" });
        }
      }, 220);
    };

    const promise = state.pendingPromise ?? new Promise((r) => setTimeout(r, TOTAL_MS));
    promise.then(() => settle(true)).catch(() => settle(false));

    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stages: Stage[] = STAGE_LABELS.map((s, i) => ({
    id: s.id,
    label: s.label,
    status: i < activeIdx ? "done" : i === activeIdx ? "active" : "pending",
  }));

  return (
    <>
      <div className="bv-page-header">
        <h1>Processing Audio</h1>
        <p>Converting your voice to a secure voiceprint.</p>
      </div>

      <StageList stages={stages} />

      <ProgressBar value={pct} label={`${pct}% Complete`} />
    </>
  );
}
