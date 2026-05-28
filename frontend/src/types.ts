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
  /** HF3 — `heuristic` (sigmoid-squashed acoustic features, v1.0
   *  default) or `trained_heads` (per-axis MLPs, v1.1). UI labels
   *  the panel accordingly so operators don't read these as AASIST
   *  sub-scores. */
  mode: "heuristic" | "trained_heads";
};

export type SpeakerModelKey = "redimnet_b5" | "ecapa_voxceleb" | "wespeaker_resnet293_lm";
export type ExplainModelKey = "aasist" | "redimnet_b5" | "ecapa_voxceleb";

export type CamSegment = {
  startMs: number;
  endMs: number;
  peak: number;
};

export type ModelCAM = {
  modelKey: ExplainModelKey;
  frameTimesMs: number[];
  freqHz: number[];
  heatmap: number[][];
  threshold: number;
  salientSegments: CamSegment[];
};

export type ExplainResult = {
  cams: ModelCAM[];
  // Input log-mel spectrogram on the same [T][F] grid as each CAM heatmap.
  spectrogram: number[][];
  frameTimesMs: number[];
  freqHz: number[];
  durationMs: number;
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
  speakerModelScores: SpeakerModelScore[];
  speakerFusion: SpeakerFusionDecision | null;
  message: string;
  sessionId: string;
  stageBreakdown: StageBreakdown;
  analysisDetails: AnalysisDetails | null;
  modelProvenance: ModelProvenance | null;
  queryEmbeddings: Record<string, number[]>;
  createdAt: string;
};

export type SpeakerModelScore = {
  modelKey: SpeakerModelKey;
  similarityScore: number;
  centroidSimilarity: number;
  sampleSimilarities: number[];
  threshold: number;
  passedThreshold: boolean;
  drivesDecision: boolean;
};

export type SpeakerFusionDecision = {
  strategy: "majority_vote";
  combinedMatch: boolean;
  combinedSimilarityScore: number;
  matchedModels: number;
  totalModels: number;
  majorityRequired: number;
  decisiveModelKeys: SpeakerModelKey[];
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
  engine?: string;
  voice?: string;
};

export type SpoofDecision = "FAKE" | "GENUINE";

export type SpoofTestResult = {
  deepfakeScore: number;
  decision: SpoofDecision;
  analysisDetails: AnalysisDetails;
  modelProvenance: ModelProvenance | null;
};

export type SpoofBatchCandidate = {
  index: number;
  text: string;
  similarityToTarget: number;
  kept: boolean;
  deepfakeScore: number | null;
  decision: SpoofDecision | null;
  engineId: string;
  voiceId: string | null;
  fileName: string;
  /** base64-encoded WAV — only present for kept candidates. */
  audioB64: string | null;
};

export type SpoofBatchResult = {
  targetUserId: string;
  centroidPresent: boolean;
  keepThreshold: number;
  requested: number;
  generated: number;
  kept: number;
  candidates: SpoofBatchCandidate[];
  modelProvenance: ModelProvenance | null;
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
  speakerModelMatches: SpeakerModelMatches[];
  speakerFusion: SpeakerFusionDecision | null;
  deepfakeScore: number;
  analysisDetails: AnalysisDetails | null;
  wouldAcceptTop1: boolean;
  similarityThreshold: number;
  deepfakeThreshold: number;
  nEnrolledTotal: number;
  modelProvenance: ModelProvenance | null;
  queryEmbeddings: Record<string, number[]>;
};

export type SpeakerModelMatches = {
  modelKey: SpeakerModelKey;
  matches: IdentificationMatch[];
  drivesDecision: boolean;
};

export type ModelProvenance = {
  encoder: "redimnet_b5" | "ecapa_voxceleb" | "wespeaker_resnet293_lm" | "heuristic_placeholder";
  detector: "aasist" | "heuristic";
  acousticProbe: "heuristic" | "trained_heads";
  isDegraded: boolean;
};

export type UserEmbedding = {
  userId: string;
  modelKey: SpeakerModelKey;
  centroid: number[];
  samples: number[][];
  sampleCount: number;
  enrolledAt: string;
};

export type EmbedResult = {
  modelKey: SpeakerModelKey;
  embedding: number[];
  durationMs: number;
  snrDb: number;
  frameCount: number;
  modelProvenance: ModelProvenance | null;
};

export type SpoofVoice = {
  id: string;
  label: string;
  language: string | null;
};

export type SpoofEngineInfo = {
  id: string;
  label: string;
  description: string;
  requiresNetwork: boolean;
  available: boolean;
  voices: SpoofVoice[];
  defaultVoice: string | null;
};

export type SpoofEngines = {
  engines: SpoofEngineInfo[];
  defaultEngine: string | null;
};

// -- Logs (unified verify + identify history) --------------------------------

export type LogKind = "verify" | "identify";

export type LogEntry = {
  id: string;
  kind: LogKind;
  createdAt: string;
  label: string;
  decision: string;
  score: number;
  deepfakeScore: number;
  models: SpeakerModelKey[];
  hasAudio: boolean;
};

export type LogDetail = {
  kind: LogKind;
  verify: VerificationResult | null;
  identify: IdentificationResult | null;
  hasAudio: boolean;
};

// -- Runtime config (Settings tab) -------------------------------------------

export type ConfigModelInfo = {
  key: SpeakerModelKey;
  label: string;
  loaded: boolean;
  participating: boolean;
  canToggle: boolean;
};

export type AppConfig = {
  similarityThreshold: number;
  deepfakeThreshold: number;
  redimnetSimilarityThreshold: number;
  ecapaSimilarityThreshold: number;
  wespeakerSimilarityThreshold: number;
  minEnrollmentSamples: number;
  identifyTopN: number;
  enableEcapaComparison: boolean;
  enableWespeakerComparison: boolean;
  sampleRate: number;
  models: ConfigModelInfo[];
  provenance: ModelProvenance | null;
};

export type ConfigPatch = Partial<{
  similarityThreshold: number;
  deepfakeThreshold: number;
  redimnetSimilarityThreshold: number;
  ecapaSimilarityThreshold: number;
  wespeakerSimilarityThreshold: number;
  minEnrollmentSamples: number;
  identifyTopN: number;
  enableEcapaComparison: boolean;
  enableWespeakerComparison: boolean;
}>;
