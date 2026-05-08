import type { VerificationResult } from "../types";
import { Panel } from "./Panel";

type SimilarityInsightsProps = {
  result: VerificationResult;
};

function toPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function describeSimilarity(score: number) {
  if (score >= 0.9) {
    return "Very strong match against the enrolled voice profile.";
  }
  if (score >= 0.75) {
    return "Strong enough match to pass the current acceptance threshold.";
  }
  if (score >= 0.6) {
    return "Borderline match. Similarity exists, but the profile is not confidently aligned.";
  }
  return "Weak match. The sample is far from the enrolled profile.";
}

function describeGenuineness(score: number) {
  if (score >= 0.85) {
    return "Low spoof concern under the current detector.";
  }
  if (score >= 0.5) {
    return "Acceptable genuineness, but not especially strong.";
  }
  return "Spoof risk is elevated. The backend will flag the sample as deepfake/manipulated.";
}

export function SimilarityInsights({ result }: SimilarityInsightsProps) {
  const topSampleSimilarity =
    result.sampleSimilarities.length > 0 ? Math.max(...result.sampleSimilarities) : result.similarityScore;

  return (
    <Panel title="Similarity details" subtitle="A clearer readout of the latest verification result.">
      <div className="insight-grid">
        <div className="detail-card">
          <strong>Similarity score</strong>
          <span className="score-value">{toPercent(result.similarityScore)}</span>
          <span>{describeSimilarity(result.similarityScore)}</span>
        </div>
        <div className="detail-card">
          <strong>Genuineness score</strong>
          <span className="score-value">{toPercent(result.deepfakeScore)}</span>
          <span>{describeGenuineness(result.deepfakeScore)}</span>
        </div>
        <div className="detail-card">
          <strong>Decision message</strong>
          <span>{result.message}</span>
        </div>
        <div className="detail-card">
          <strong>Centroid score</strong>
          <span className="score-value">{toPercent(result.centroidSimilarity)}</span>
          <span>Similarity against the averaged enrolled reference embedding.</span>
        </div>
        <div className="detail-card">
          <strong>Best sample score</strong>
          <span className="score-value">{toPercent(topSampleSimilarity)}</span>
          <span>
            {result.sampleSimilarities.length > 0
              ? `Computed from ${result.sampleSimilarities.length} stored enrollment sample(s).`
              : "No per-sample similarity detail available."}
          </span>
        </div>
      </div>
    </Panel>
  );
}
