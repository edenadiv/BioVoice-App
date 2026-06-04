// HTTP client for the BioVoice kiosk. All routes are public —
// auth/cookie/admin scaffolding was removed in the "strip the
// scaffolding" pass. API calls are same-origin/relative by default;
// `VITE_API_BASE_URL` can override the base when needed (see below).

import type {
  AnalysisDetails,
  AppConfig,
  CamSegment,
  ConfigModelInfo,
  ConfigPatch,
  EmbedResult,
  ExplainModelKey,
  ExplainResult,
  IdentificationMatch,
  IdentificationResult,
  LogDetail,
  LogEntry,
  ModelCAM,
  ModelProvenance,
  Speaker,
  SpoofBatchResult,
  SpoofDecision,
  SpoofEngines,
  SpoofGenerationResult,
  SpoofTestResult,
  UserEmbedding,
  VerificationResult,
  SpeakerModelKey,
} from "../types";
import { encodeWav } from "./wav";

// P1 — same-origin by default. The production Docker image serves the
// built React bundle from FastAPI on :8000, so all `fetch("/users/…")`
// calls hit the same host. For local dev (vite :5173) and `vite preview`,
// `vite.config.ts` proxies the backend route prefixes to :8000, so these
// relative paths work with no env needed. Set `VITE_API_BASE_URL` only to
// point at a remote/cross-origin backend (CORS must allow the origin).
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";

type SpeakerResponse = {
  user_id: string;
  enrolled_at: string;
  sample_count: number;
};

type StageBreakdownResponse = {
  load_ms: number;
  resample_ms: number;
  normalize_ms: number;
  vad_ms: number;
  embed_ms: number;
  detect_ms: number;
  total_ms: number;
};

type AnalysisDetailsResponse = {
  voice_naturalness: number;
  spectral_consistency: number;
  temporal_patterns: number;
  artifact_detection: number;
  mode?: "heuristic" | "trained_heads";
};

type ModelProvenanceResponse = {
  encoder: "redimnet_b5" | "ecapa_voxceleb" | "wespeaker_resnet293_lm" | "heuristic_placeholder";
  detector: "aasist" | "ensemble" | "heuristic";
  acoustic_probe: "heuristic" | "trained_heads";
  is_degraded: boolean;
};

type VerificationResponse = {
  result_id: string;
  user_id: string;
  decision: "ACCEPT" | "REJECT" | "DEEPFAKE";
  decision_reason: "accepted" | "mismatch" | "synthetic" | "not_enrolled";
  similarity_score: number;
  deepfake_score: number;
  spoof_votes?: number;
  spoof_total?: number;
  centroid_similarity: number;
  sample_similarities: number[];
  speaker_model_scores?: SpeakerModelScoreResponse[];
  speaker_fusion?: SpeakerFusionDecisionResponse | null;
  message: string;
  session_id: string;
  stage_breakdown?: StageBreakdownResponse;
  analysis_details?: AnalysisDetailsResponse | null;
  model_provenance?: ModelProvenanceResponse | null;
  query_embeddings?: Record<string, number[]>;
  created_at: string;
};

type SpeakerModelScoreResponse = {
  model_key: "redimnet_b5" | "ecapa_voxceleb" | "wespeaker_resnet293_lm";
  similarity_score: number;
  centroid_similarity: number;
  sample_similarities: number[];
  threshold: number;
  passed_threshold: boolean;
  drives_decision: boolean;
};

type SpeakerFusionDecisionResponse = {
  strategy: "majority_vote";
  combined_match: boolean;
  combined_similarity_score: number;
  matched_models: number;
  total_models: number;
  majority_required: number;
  decisive_model_keys: Array<"redimnet_b5" | "ecapa_voxceleb" | "wespeaker_resnet293_lm">;
};

type SampleQualityResponse = {
  score: number;
  snr_db: number;
  clipping_pct: number;
  speech_ratio: number;
  acceptable: boolean;
};

type EnrollmentResponse = {
  user_id: string;
  status: string;
  message: string;
  enrolled_at: string;
  quality?: SampleQualityResponse | null;
  model_provenance?: ModelProvenanceResponse | null;
};

type SpoofTestResponse = {
  deepfake_score: number;
  decision: SpoofDecision;
  analysis_details: AnalysisDetailsResponse;
  model_provenance?: ModelProvenanceResponse | null;
  spoof_votes?: number;
  spoof_total?: number;
};

type IdentificationMatchResponse = {
  user_id: string;
  similarity_score: number;
  centroid_similarity: number;
  sample_count: number;
  enrolled_at: string;
};

type IdentificationResponse = {
  matches: IdentificationMatchResponse[];
  speaker_model_matches?: SpeakerModelMatchesResponse[];
  speaker_fusion?: SpeakerFusionDecisionResponse | null;
  deepfake_score: number;
  spoof_votes?: number;
  spoof_total?: number;
  analysis_details: AnalysisDetailsResponse | null;
  would_accept_top1: boolean;
  similarity_threshold: number;
  deepfake_threshold: number;
  n_enrolled_total: number;
  model_provenance?: ModelProvenanceResponse | null;
  query_embeddings?: Record<string, number[]>;
};

type SpeakerModelMatchesResponse = {
  model_key: "redimnet_b5" | "ecapa_voxceleb" | "wespeaker_resnet293_lm";
  matches: IdentificationMatchResponse[];
  drives_decision: boolean;
};

type MetricsSummaryResponse = {
  verifications_total: number;
  throughput_per_sec: number;
  uptime_sec: number;
  cold_start_at: string;
  p50_verify_ms: number | null;
};

type ReadyzResponse = {
  ready: boolean;
  checks: {
    database?: { ok: boolean };
    ensemble_models?: { ok: boolean; path?: string };
    redimnet_weights?: { ok: boolean; path?: string };
  };
  models_note?: string;
};

export type MetricsSummary = {
  verificationsTotal: number;
  throughputPerSec: number;
  uptimeSec: number;
  coldStartAt: string;
  p50VerifyMs: number | null;
};

export type ReadyState = {
  ready: boolean;
  databaseOk: boolean;
  ensembleModelsOk: boolean;
  redimnetWeightsOk: boolean;
};

type CamSegmentResponse = { start_ms: number; end_ms: number; peak: number };
type ModelCAMResponse = {
  model_key: ExplainModelKey;
  frame_times_ms: number[];
  freq_hz: number[];
  heatmap: number[][];
  threshold: number;
  salient_segments: CamSegmentResponse[];
};
type ExplainResponse = {
  cams: ModelCAMResponse[];
  spectrogram: number[][];
  frame_times_ms: number[];
  freq_hz: number[];
  duration_ms: number;
};

export type { CamSegment, ModelCAM, ExplainModelKey, ExplainResult };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    // Kiosk + backend are same-origin in production (nginx fronts both)
    // and same-site in local dev (localhost:5173 + localhost:8000).
    // Sending credentials is harmless without auth.
    credentials: "include",
    ...init,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Request failed with status ${response.status}`);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

async function postForm<T>(path: string, formData: FormData): Promise<T> {
  return request<T>(path, {
    method: "POST",
    body: formData,
  });
}

function toModelProvenance(payload: ModelProvenanceResponse | null | undefined): ModelProvenance | null {
  if (!payload) return null;
  return {
    encoder: payload.encoder,
    detector: payload.detector,
    acousticProbe: payload.acoustic_probe,
    isDegraded: payload.is_degraded,
  };
}

function toAnalysisDetails(payload: AnalysisDetailsResponse): AnalysisDetails {
  return {
    voiceNaturalness: payload.voice_naturalness,
    spectralConsistency: payload.spectral_consistency,
    temporalPatterns: payload.temporal_patterns,
    artifactDetection: payload.artifact_detection,
    mode: payload.mode ?? "heuristic",
  };
}

function toSpeakerFusionDecision(payload: SpeakerFusionDecisionResponse | null | undefined) {
  if (!payload) return null;
  return {
    strategy: payload.strategy,
    combinedMatch: payload.combined_match,
    combinedSimilarityScore: payload.combined_similarity_score,
    matchedModels: payload.matched_models,
    totalModels: payload.total_models,
    majorityRequired: payload.majority_required,
    decisiveModelKeys: payload.decisive_model_keys,
  };
}

function toVerificationResult(response: VerificationResponse): VerificationResult {
  const stage = response.stage_breakdown;
  const details = response.analysis_details;
  return {
    resultId: response.result_id,
    userId: response.user_id,
    decision: response.decision,
    decisionReason: response.decision_reason,
    similarityScore: response.similarity_score,
    deepfakeScore: response.deepfake_score,
    centroidSimilarity: response.centroid_similarity,
    sampleSimilarities: response.sample_similarities,
    speakerModelScores: (response.speaker_model_scores ?? []).map((score) => ({
      modelKey: score.model_key,
      similarityScore: score.similarity_score,
      centroidSimilarity: score.centroid_similarity,
      sampleSimilarities: score.sample_similarities,
      threshold: score.threshold,
      passedThreshold: score.passed_threshold,
      drivesDecision: score.drives_decision,
    })),
    speakerFusion: toSpeakerFusionDecision(response.speaker_fusion),
    message: response.message,
    sessionId: response.session_id,
    stageBreakdown: stage
      ? {
          loadMs: stage.load_ms,
          resampleMs: stage.resample_ms,
          normalizeMs: stage.normalize_ms,
          vadMs: stage.vad_ms ?? 0,
          embedMs: stage.embed_ms,
          detectMs: stage.detect_ms,
          totalMs: stage.total_ms,
        }
      : { loadMs: 0, resampleMs: 0, normalizeMs: 0, vadMs: 0, embedMs: 0, detectMs: 0, totalMs: 0 },
    analysisDetails: details ? toAnalysisDetails(details) : null,
    modelProvenance: toModelProvenance(response.model_provenance),
    spoofVotes: response.spoof_votes ?? 0,
    spoofTotal: response.spoof_total ?? 0,
    queryEmbeddings: response.query_embeddings ?? {},
    createdAt: response.created_at,
  };
}

function parseFileName(contentDisposition: string | null): string {
  const match = contentDisposition?.match(/filename="([^"]+)"/i);
  return match?.[1] ?? "spoof.wav";
}

// -- Profiles -----------------------------------------------------------------

export async function listSpeakers(): Promise<Speaker[]> {
  const response = await request<SpeakerResponse[]>("/users");
  return response.map((item) => ({
    userId: item.user_id,
    enrolledAt: item.enrolled_at,
    sampleCount: item.sample_count,
  }));
}

export type EnrollResult = {
  message: string;
  quality: SampleQualityResponse | null;
  modelProvenance: ModelProvenance | null;
};

export async function enrollSpeaker(userId: string, file: File): Promise<EnrollResult> {
  const formData = new FormData();
  formData.append("user_id", userId);
  formData.append("audio", file);
  const response = await postForm<EnrollmentResponse>("/enroll", formData);
  return {
    message: response.message,
    quality: response.quality ?? null,
    modelProvenance: toModelProvenance(response.model_provenance),
  };
}

export async function deleteUser(userId: string): Promise<void> {
  await request(`/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
}

// -- Embeddings (V1 — visualization payloads) --------------------------------

type UserEmbeddingResponse = {
  user_id: string;
  model_key: "redimnet_b5" | "ecapa_voxceleb" | "wespeaker_resnet293_lm";
  centroid: number[];
  samples: number[][];
  sample_count: number;
  enrolled_at: string;
};

type EmbedResponse = {
  model_key: "redimnet_b5" | "ecapa_voxceleb" | "wespeaker_resnet293_lm";
  embedding: number[];
  duration_ms: number;
  snr_db: number;
  frame_count: number;
  model_provenance?: ModelProvenanceResponse | null;
};

export async function getUserEmbeddings(modelKey: SpeakerModelKey = "redimnet_b5"): Promise<UserEmbedding[]> {
  const response = await request<UserEmbeddingResponse[]>(
    `/users/embeddings?model_key=${encodeURIComponent(modelKey)}`,
  );
  return response.map((row) => ({
    userId: row.user_id,
    modelKey: row.model_key,
    centroid: row.centroid,
    samples: row.samples,
    sampleCount: row.sample_count,
    enrolledAt: row.enrolled_at,
  }));
}

/**
 * Encoder-only pass for the EmbeddingConstellation's live point.
 * Posts a 16 kHz Float32 buffer as a WAV; returns the 192-d ReDimNet
 * vector the backend would have produced for the same audio at /verify
 * time. Does NOT touch the verification log.
 */
export async function embedAudio(
  samples: Float32Array,
  sampleRate: number = 16000,
  modelKey: SpeakerModelKey = "redimnet_b5",
): Promise<EmbedResult> {
  const blob = encodeWav(samples, sampleRate);
  const formData = new FormData();
  formData.append("audio", blob, "preview.wav");
  formData.append("model_key", modelKey);
  const response = await postForm<EmbedResponse>("/embed", formData);
  return {
    modelKey: response.model_key,
    embedding: response.embedding,
    durationMs: response.duration_ms,
    snrDb: response.snr_db,
    frameCount: response.frame_count,
    modelProvenance: toModelProvenance(response.model_provenance),
  };
}

// -- Verification -------------------------------------------------------------

export async function verifySpeaker(userId: string, file: File): Promise<VerificationResult> {
  const formData = new FormData();
  formData.append("user_id", userId);
  formData.append("audio", file);
  const response = await postForm<VerificationResponse>("/verify", formData);
  return toVerificationResult(response);
}

export async function listResults(): Promise<VerificationResult[]> {
  const response = await request<VerificationResponse[]>("/results");
  return response.map(toVerificationResult);
}

// -- Deepfake lab -------------------------------------------------------------

export async function generateSpoof(payload: {
  targetUserId: string;
  text: string;
  language?: string;
  engine?: string;
  voice?: string;
  referenceSampleId?: string;
  file?: File | null;
}): Promise<SpoofGenerationResult> {
  const formData = new FormData();
  formData.append("target_user_id", payload.targetUserId);
  formData.append("text", payload.text);
  formData.append("language", payload.language ?? "en");
  if (payload.engine) formData.append("engine", payload.engine);
  if (payload.voice) formData.append("voice", payload.voice);
  if (payload.referenceSampleId) {
    formData.append("reference_sample_id", payload.referenceSampleId);
  }
  if (payload.file) {
    formData.append("audio", payload.file);
  }

  const response = await fetch(`${API_BASE}/spoof`, {
    method: "POST",
    body: formData,
    credentials: "include",
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Request failed with status ${response.status}`);
  }

  const blob = await response.blob();
  return {
    audioUrl: URL.createObjectURL(blob),
    fileName: parseFileName(response.headers.get("Content-Disposition")),
    sourceDescription: response.headers.get("X-Spoof-Source") ?? "Reference sample",
    text: payload.text,
    language: payload.language ?? "en",
    engine: response.headers.get("X-Spoof-Engine") ?? undefined,
    voice: response.headers.get("X-Spoof-Voice") ?? undefined,
  };
}

type SpoofVoiceResponse = { id: string; label: string; language: string | null };
type SpoofEngineInfoResponse = {
  id: string;
  label: string;
  description: string;
  requires_network: boolean;
  available: boolean;
  voices: SpoofVoiceResponse[];
  default_voice: string | null;
};
type SpoofEnginesResponse = {
  engines: SpoofEngineInfoResponse[];
  default_engine: string | null;
};

export async function getSpoofEngines(): Promise<SpoofEngines> {
  const response = await request<SpoofEnginesResponse>("/spoof/engines");
  return {
    defaultEngine: response.default_engine,
    engines: response.engines.map((e) => ({
      id: e.id,
      label: e.label,
      description: e.description,
      requiresNetwork: e.requires_network,
      available: e.available,
      voices: e.voices,
      defaultVoice: e.default_voice,
    })),
  };
}

export async function spoofTest(file: File): Promise<SpoofTestResult> {
  const formData = new FormData();
  formData.append("audio", file);
  const response = await postForm<SpoofTestResponse>("/spoof/test", formData);
  return {
    deepfakeScore: response.deepfake_score,
    decision: response.decision,
    analysisDetails: toAnalysisDetails(response.analysis_details),
    modelProvenance: toModelProvenance(response.model_provenance),
    spoofVotes: response.spoof_votes ?? 0,
    spoofTotal: response.spoof_total ?? 0,
  };
}

type SpoofBatchCandidateResponse = {
  index: number;
  text: string;
  similarity_to_target: number;
  kept: boolean;
  deepfake_score: number | null;
  decision: SpoofDecision | null;
  engine_id: string;
  voice_id: string | null;
  file_name: string;
  audio_b64: string | null;
};
type SpoofBatchResponse = {
  target_user_id: string;
  centroid_present: boolean;
  keep_threshold: number;
  requested: number;
  generated: number;
  kept: number;
  candidates: SpoofBatchCandidateResponse[];
  model_provenance?: ModelProvenanceResponse | null;
};

/**
 * Forge many clones of an enrolled target voice and keep only those that
 * resemble the target. `texts` are the utterance variations; the backend
 * generates `candidatesPerText` clones per text, scores each against the
 * target centroid, and discards those below `keepThreshold`.
 */
export async function generateSpoofBatch(payload: {
  targetUserId: string;
  texts: string[];
  candidatesPerText?: number;
  engine?: string;
  voice?: string;
  language?: string;
  keepThreshold?: number;
  runDetector?: boolean;
}): Promise<SpoofBatchResult> {
  const body: Record<string, unknown> = {
    target_user_id: payload.targetUserId,
    texts: payload.texts,
  };
  if (payload.candidatesPerText != null) body.candidates_per_text = payload.candidatesPerText;
  if (payload.engine) body.engine = payload.engine;
  if (payload.voice) body.voice = payload.voice;
  if (payload.language) body.language = payload.language;
  if (payload.keepThreshold != null) body.keep_threshold = payload.keepThreshold;
  if (payload.runDetector != null) body.run_detector = payload.runDetector;

  const response = await request<SpoofBatchResponse>("/spoof/batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  return {
    targetUserId: response.target_user_id,
    centroidPresent: response.centroid_present,
    keepThreshold: response.keep_threshold,
    requested: response.requested,
    generated: response.generated,
    kept: response.kept,
    candidates: response.candidates.map((c) => ({
      index: c.index,
      text: c.text,
      similarityToTarget: c.similarity_to_target,
      kept: c.kept,
      deepfakeScore: c.deepfake_score,
      decision: c.decision,
      engineId: c.engine_id,
      voiceId: c.voice_id,
      fileName: c.file_name,
      audioB64: c.audio_b64,
    })),
    modelProvenance: toModelProvenance(response.model_provenance),
  };
}

/** Decode a base64 WAV (e.g. a kept batch candidate) into an object URL. */
export function wavUrlFromBase64(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
}

// -- Explain (Grad-CAM) -------------------------------------------------------

export async function explainAudio(file: File, userId?: string): Promise<ExplainResult> {
  const formData = new FormData();
  formData.append("audio", file);
  if (userId) formData.append("user_id", userId);
  const response = await postForm<ExplainResponse>("/explain", formData);
  return {
    cams: response.cams.map((c) => ({
      modelKey: c.model_key,
      frameTimesMs: c.frame_times_ms,
      freqHz: c.freq_hz,
      heatmap: c.heatmap,
      threshold: c.threshold,
      salientSegments: c.salient_segments.map((s) => ({
        startMs: s.start_ms,
        endMs: s.end_ms,
        peak: s.peak,
      })),
    })),
    spectrogram: response.spectrogram ?? [],
    frameTimesMs: response.frame_times_ms ?? [],
    freqHz: response.freq_hz ?? [],
    durationMs: response.duration_ms ?? 0,
  };
}

// -- Open-set identification --------------------------------------------------

function toIdentificationResult(response: IdentificationResponse): IdentificationResult {
  return {
    matches: response.matches.map((m) => toIdentificationMatch(m)),
    speakerModelMatches: (response.speaker_model_matches ?? []).map((group) => ({
      modelKey: group.model_key,
      matches: group.matches.map((m) => toIdentificationMatch(m)),
      drivesDecision: group.drives_decision,
    })),
    speakerFusion: toSpeakerFusionDecision(response.speaker_fusion),
    deepfakeScore: response.deepfake_score,
    spoofVotes: response.spoof_votes ?? 0,
    spoofTotal: response.spoof_total ?? 0,
    analysisDetails: response.analysis_details ? toAnalysisDetails(response.analysis_details) : null,
    wouldAcceptTop1: response.would_accept_top1,
    similarityThreshold: response.similarity_threshold,
    deepfakeThreshold: response.deepfake_threshold,
    nEnrolledTotal: response.n_enrolled_total,
    modelProvenance: toModelProvenance(response.model_provenance),
    queryEmbeddings: response.query_embeddings ?? {},
  };
}

// `topN` omitted → the backend uses its runtime-configured default (PATCH /config).
export async function identifySpeaker(file: File, topN?: number): Promise<IdentificationResult> {
  const formData = new FormData();
  formData.append("audio", file);
  if (topN != null) formData.append("top_n", String(topN));
  const response = await postForm<IdentificationResponse>("/identify", formData);
  return toIdentificationResult(response);
}

function toIdentificationMatch(m: IdentificationMatchResponse): IdentificationMatch {
  return {
    userId: m.user_id,
    similarityScore: m.similarity_score,
    centroidSimilarity: m.centroid_similarity,
    sampleCount: m.sample_count,
    enrolledAt: m.enrolled_at,
  };
}

// -- Operational telemetry ----------------------------------------------------

export async function getMetricsSummary(): Promise<MetricsSummary> {
  const response = await request<MetricsSummaryResponse>("/metrics/summary");
  return {
    verificationsTotal: response.verifications_total,
    throughputPerSec: response.throughput_per_sec,
    uptimeSec: response.uptime_sec,
    coldStartAt: response.cold_start_at,
    p50VerifyMs: response.p50_verify_ms,
  };
}

export async function getReady(): Promise<ReadyState> {
  const response = await request<ReadyzResponse>("/readyz");
  return {
    ready: response.ready,
    databaseOk: response.checks.database?.ok ?? false,
    ensembleModelsOk: response.checks.ensemble_models?.ok ?? false,
    redimnetWeightsOk: response.checks.redimnet_weights?.ok ?? false,
  };
}

// -- Logs (unified verify + identify history) --------------------------------

type LogEntryResponse = {
  id: string;
  kind: "verify" | "identify";
  created_at: string;
  label: string;
  decision: string;
  score: number;
  deepfake_score: number;
  models: SpeakerModelKey[];
  has_audio: boolean;
};

type LogDetailResponse = {
  kind: "verify" | "identify";
  verify: VerificationResponse | null;
  identify: IdentificationResponse | null;
  has_audio: boolean;
};

export async function listLogs(): Promise<LogEntry[]> {
  const response = await request<LogEntryResponse[]>("/logs");
  return response.map((e) => ({
    id: e.id,
    kind: e.kind,
    createdAt: e.created_at,
    label: e.label,
    decision: e.decision,
    score: e.score,
    deepfakeScore: e.deepfake_score,
    models: e.models,
    hasAudio: e.has_audio,
  }));
}

export async function getLogDetail(id: string): Promise<LogDetail> {
  const response = await request<LogDetailResponse>(`/logs/${encodeURIComponent(id)}`);
  return {
    kind: response.kind,
    verify: response.verify ? toVerificationResult(response.verify) : null,
    identify: response.identify ? toIdentificationResult(response.identify) : null,
    hasAudio: response.has_audio,
  };
}

/** Fetch a logged run's captured audio as a File, for re-running /explain. */
export async function fetchLogAudio(id: string): Promise<File> {
  const response = await fetch(`${API_BASE}/logs/${encodeURIComponent(id)}/audio`, { credentials: "include" });
  if (!response.ok) throw new Error(`Audio fetch failed (${response.status})`);
  const blob = await response.blob();
  return new File([blob], `${id}.wav`, { type: "audio/wav" });
}

// -- Runtime config (Settings tab) -------------------------------------------

type ConfigModelInfoResponse = {
  key: SpeakerModelKey;
  label: string;
  loaded: boolean;
  participating: boolean;
  can_toggle: boolean;
};

type ConfigResponse = {
  similarity_threshold: number;
  deepfake_threshold: number;
  redimnet_similarity_threshold: number;
  ecapa_similarity_threshold: number;
  wespeaker_similarity_threshold: number;
  min_enrollment_samples: number;
  identify_top_n: number;
  enable_ecapa_comparison: boolean;
  enable_wespeaker_comparison: boolean;
  sample_rate: number;
  models: ConfigModelInfoResponse[];
  model_provenance?: ModelProvenanceResponse | null;
  provenance?: ModelProvenanceResponse | null;
};

function toAppConfig(c: ConfigResponse): AppConfig {
  return {
    similarityThreshold: c.similarity_threshold,
    deepfakeThreshold: c.deepfake_threshold,
    redimnetSimilarityThreshold: c.redimnet_similarity_threshold,
    ecapaSimilarityThreshold: c.ecapa_similarity_threshold,
    wespeakerSimilarityThreshold: c.wespeaker_similarity_threshold,
    minEnrollmentSamples: c.min_enrollment_samples,
    identifyTopN: c.identify_top_n,
    enableEcapaComparison: c.enable_ecapa_comparison,
    enableWespeakerComparison: c.enable_wespeaker_comparison,
    sampleRate: c.sample_rate,
    models: c.models.map((m): ConfigModelInfo => ({
      key: m.key,
      label: m.label,
      loaded: m.loaded,
      participating: m.participating,
      canToggle: m.can_toggle,
    })),
    provenance: toModelProvenance(c.provenance ?? c.model_provenance),
  };
}

const CONFIG_PATCH_KEYS: Record<keyof ConfigPatch, string> = {
  similarityThreshold: "similarity_threshold",
  deepfakeThreshold: "deepfake_threshold",
  redimnetSimilarityThreshold: "redimnet_similarity_threshold",
  ecapaSimilarityThreshold: "ecapa_similarity_threshold",
  wespeakerSimilarityThreshold: "wespeaker_similarity_threshold",
  minEnrollmentSamples: "min_enrollment_samples",
  identifyTopN: "identify_top_n",
  enableEcapaComparison: "enable_ecapa_comparison",
  enableWespeakerComparison: "enable_wespeaker_comparison",
};

export async function getConfig(): Promise<AppConfig> {
  return toAppConfig(await request<ConfigResponse>("/config"));
}

export async function patchConfig(patch: ConfigPatch): Promise<AppConfig> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    body[CONFIG_PATCH_KEYS[key as keyof ConfigPatch]] = value;
  }
  const response = await request<ConfigResponse>("/config", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return toAppConfig(response);
}
