import type { VerificationResult } from "../types";
import { StatusPill } from "./StatusPill";
import { Panel } from "./Panel";

type ResultCardProps = {
  result: VerificationResult;
};

export function ResultCard({ result }: ResultCardProps) {
  return (
    <Panel title="Latest result" subtitle="Web-native status and model output">
      <div className="result-card">
        <div className="result-row">
          <StatusPill decision={result.decision} />
          <span className="muted">{new Date(result.createdAt).toLocaleString()}</span>
        </div>
        <div className="result-grid">
          <div>
            <strong>Similarity</strong>
            <span>{Math.round(result.similarityScore * 100)}%</span>
          </div>
          <div>
            <strong>Genuineness</strong>
            <span>{Math.round(result.deepfakeScore * 100)}%</span>
          </div>
        </div>
        <p>{result.message}</p>
      </div>
    </Panel>
  );
}

