import type { Dispatch } from "react";
import { Button } from "../components/Button";
import { Waveform } from "../components/Waveform";
import type { FlowAction, FlowState } from "../lib/flowState";

/**
 * Stub. Yoav owns the real implementation (Y-6) — Generate Fake / Test Detection wiring
 * against /me/spoof and /me/spoof/test (Y-9).
 */

type Props = {
  state: FlowState;
  dispatch: Dispatch<FlowAction>;
};

export function TestLabScreen({ dispatch }: Props) {
  return (
    <>
      <div className="bv-card bv-card--banner-warn" style={{ padding: 14 }}>
        <span style={{ fontSize: 18 }}>⚠️</span>
        <div>
          <div style={{ fontWeight: 700, color: "var(--text-warn)" }}>TESTING MODE</div>
          <div className="muted" style={{ fontSize: 12 }}>For validation purposes only.</div>
        </div>
      </div>

      <div className="bv-page-header">
        <h1>Deepfake Audio Generator</h1>
        <p>Generate synthetic audio to test detection capabilities.</p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <div className="bv-card">
          <span className="muted" style={{ fontSize: 12 }}>Source Audio</span>
          <Waveform mode="idle" />
          <span className="muted" style={{ fontSize: 12 }}>(stub)</span>
        </div>
        <div className="bv-card bv-card--info-strong">
          <span style={{ color: "var(--text-info)", fontSize: 12, fontWeight: 600 }}>External TTS API</span>
          <span style={{ fontSize: 13 }}>Service: Voice Cloning API</span>
          <textarea defaultValue="Hello, this is a test message" rows={3} />
        </div>
      </div>

      <Button variant="warn" block disabled>Generate Fake (stub — Yoav)</Button>

      <div style={{ display: "flex", gap: 8, marginTop: "auto" }}>
        <Button variant="ghost" onClick={() => dispatch({ type: "navigate", screen: "home" })}>Home</Button>
      </div>
    </>
  );
}
