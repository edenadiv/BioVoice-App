import type { VerificationResult } from "../types";
import { Panel } from "./Panel";
import { StatusPill } from "./StatusPill";

type VerificationHistoryProps = {
  results: VerificationResult[];
};

export function VerificationHistory({ results }: VerificationHistoryProps) {
  return (
    <Panel title="Recent verification history" subtitle="Latest attempts for the authenticated user.">
      <div className="history-list">
        {results.length === 0 ? (
          <p className="muted">No verification history yet for this user.</p>
        ) : (
          results.map((result) => (
            <div key={result.resultId} className="history-row">
              <div className="history-meta">
                <StatusPill decision={result.decision} />
                <span className="muted">{new Date(result.createdAt).toLocaleString()}</span>
              </div>
              <div className="history-scores">
                <span>Similarity {Math.round(result.similarityScore * 100)}%</span>
                <span>Genuineness {Math.round(result.deepfakeScore * 100)}%</span>
              </div>
              <p className="history-message">{result.message}</p>
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}
