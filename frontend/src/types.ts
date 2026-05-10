export type Decision = "ACCEPT" | "REJECT" | "DEEPFAKE" | "PENDING";

export type DecisionReason = "accepted" | "mismatch" | "synthetic" | "not_enrolled";

export type StageBreakdown = {
  loadMs: number;
  resampleMs: number;
  normalizeMs: number;
  vadMs: number;
  embedMs: number;
  detectMs: number;
  totalMs: number;
};

export type AnalysisDetails = {
  voiceNaturalness: number;
  spectralConsistency: number;
  temporalPatterns: number;
  artifactDetection: number;
};

export type VerificationResult = {
  resultId: string;
  userId: string;
  decision: Decision;
  decisionReason: DecisionReason;
  similarityScore: number;
  deepfakeScore: number;
  centroidSimilarity: number;
  sampleSimilarities: number[];
  message: string;
  sessionId: string;
  stageBreakdown: StageBreakdown;
  analysisDetails: AnalysisDetails | null;
  createdAt: string;
};

export type Speaker = {
  userId: string;
  sampleCount: number;
  enrolledAt: string;
};

export type ReferenceSample = {
  sampleId: string;
  userId: string;
  originalFilename: string;
  source: string;
  createdAt: string;
};

export type SpoofGenerationResult = {
  audioUrl: string;
  fileName: string;
  sourceDescription: string;
  text: string;
  language: string;
};

export type SpoofDecision = "FAKE" | "GENUINE";

export type SpoofTestResult = {
  deepfakeScore: number;
  decision: SpoofDecision;
  analysisDetails: AnalysisDetails;
};

export type IdentificationMatch = {
  userId: string;
  similarityScore: number;
  centroidSimilarity: number;
  sampleCount: number;
  enrolledAt: string;
};

export type IdentificationResult = {
  matches: IdentificationMatch[];
  deepfakeScore: number;
  analysisDetails: AnalysisDetails | null;
  wouldAcceptTop1: boolean;
  similarityThreshold: number;
  deepfakeThreshold: number;
  nEnrolledTotal: number;
};
