// HTTP client for the BioVoice kiosk. All routes are public —
// auth/cookie/admin scaffolding was removed in the "strip the
// scaffolding" pass. The kiosk talks to a single FastAPI backend at
// `VITE_API_BASE_URL` (defaults to http://localhost:8000).

import type {
  AnalysisDetails,
  Speaker,
  SpoofDecision,
  SpoofGenerationResult,
  SpoofTestResult,
  VerificationResult,
} from "../types";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

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
};

type VerificationResponse = {
  result_id: string;
  user_id: string;
  decision: "ACCEPT" | "REJECT" | "DEEPFAKE";
  decision_reason: "accepted" | "mismatch" | "synthetic" | "not_enrolled";
  similarity_score: number;
  deepfake_score: number;
  centroid_similarity: number;
  sample_similarities: number[];
  message: string;
  session_id: string;
  stage_breakdown?: StageBreakdownResponse;
  analysis_details?: AnalysisDetailsResponse | null;
  created_at: string;
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
};

type SpoofTestResponse = {
  deepfake_score: number;
  decision: SpoofDecision;
  analysis_details: AnalysisDetailsResponse;
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
    aasist_weights?: { ok: boolean; path?: string };
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
  aasistWeightsOk: boolean;
  redimnetWeightsOk: boolean;
};

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

function toAnalysisDetails(payload: AnalysisDetailsResponse): AnalysisDetails {
  return {
    voiceNaturalness: payload.voice_naturalness,
    spectralConsistency: payload.spectral_consistency,
    temporalPatterns: payload.temporal_patterns,
    artifactDetection: payload.artifact_detection,
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
};

export async function enrollSpeaker(userId: string, file: File): Promise<EnrollResult> {
  const formData = new FormData();
  formData.append("user_id", userId);
  formData.append("audio", file);
  const response = await postForm<EnrollmentResponse>("/enroll", formData);
  return { message: response.message, quality: response.quality ?? null };
}

export async function deleteUser(userId: string): Promise<void> {
  await request(`/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
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
  referenceSampleId?: string;
  file?: File | null;
}): Promise<SpoofGenerationResult> {
  const formData = new FormData();
  formData.append("target_user_id", payload.targetUserId);
  formData.append("text", payload.text);
  formData.append("language", payload.language ?? "en");
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
    aasistWeightsOk: response.checks.aasist_weights?.ok ?? false,
    redimnetWeightsOk: response.checks.redimnet_weights?.ok ?? false,
  };
}
