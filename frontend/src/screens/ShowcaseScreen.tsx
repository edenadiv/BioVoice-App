import { useMemo } from "react";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Gauge } from "../components/Gauge";
import { ProgressBar } from "../components/ProgressBar";
import { StageList } from "../components/StageList";
import { Waveform } from "../components/Waveform";

export function ShowcaseScreen() {
  const samples = useMemo(() => {
    const arr = new Float32Array(2048);
    for (let i = 0; i < arr.length; i += 1) {
      arr[i] = Math.sin(i * 0.04) * 0.6 + (Math.random() - 0.5) * 0.2;
    }
    return arr;
  }, []);

  return (
    <div className="bv-showcase">
      <div className="bv-page-header">
        <h1>Design system showcase</h1>
        <p>Internal review surface — open with <code>?showcase=1</code>.</p>
      </div>

      <div className="bv-showcase__group">
        <h2>Buttons</h2>
        <div className="bv-showcase__row">
          <Button variant="primary">Primary</Button>
          <Button variant="success">Success</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="warn">Warn</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
        </div>
        <div className="bv-showcase__row">
          <Button variant="primary" size="lg">Large primary</Button>
          <Button variant="success" size="lg">Continue</Button>
          <Button variant="primary" disabled>Disabled</Button>
        </div>
      </div>

      <div className="bv-showcase__group">
        <h2>Badges</h2>
        <div className="bv-showcase__row">
          <Badge tone="success" showDot>ID Available</Badge>
          <Badge tone="danger" showDot>ID Taken</Badge>
          <Badge tone="info" showDot>Checking…</Badge>
          <Badge tone="warn" showDot>Testing mode</Badge>
          <Badge tone="neutral">Neutral</Badge>
        </div>
      </div>

      <div className="bv-showcase__group">
        <h2>Progress</h2>
        <ProgressBar value={60} label="60% Complete" />
        <ProgressBar value={98} tone="success" layout="row" caption="Voice Naturalness" />
        <ProgressBar value={95} tone="success" layout="row" caption="Spectral Consistency" />
        <ProgressBar value={2} tone="success" layout="row" caption="Artifact Detection" />
      </div>

      <div className="bv-showcase__group">
        <h2>Gauge</h2>
        <div className="bv-showcase__row" style={{ gap: 32 }}>
          <Gauge value={0.89} threshold={0.75} />
          <Gauge value={0.62} threshold={0.75} />
          <Gauge value={0.41} threshold={0.75} />
        </div>
      </div>

      <div className="bv-showcase__group">
        <h2>Stage list</h2>
        <StageList
          stages={[
            { id: "load", label: "Load Audio", status: "done" },
            { id: "rs", label: "Resample 16 kHz", status: "done" },
            { id: "norm", label: "Normalize", status: "done" },
            { id: "mel", label: "Mel-Spectrogram", status: "active" },
            { id: "feat", label: "Extract Features", status: "pending" },
          ]}
        />
      </div>

      <div className="bv-showcase__group">
        <h2>Waveform</h2>
        <Waveform mode="static" samples={samples} color="blue" />
        <Waveform mode="static" samples={samples} color="red" tint="red" />
        <Waveform mode="idle" color="idle" />
      </div>
    </div>
  );
}
