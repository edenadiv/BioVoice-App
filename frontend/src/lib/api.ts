import type {
  AnalysisDetails,
  ReferenceSample,
  Session,
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

type EnrollmentResponse = {
  user_id: string;
  status: string;
  message: string;
  enrolled_at: string;
};

type SessionResponse = {
  session_token: string;
  user_id: string;
  created_at: string;
  expires_at: string;
};

type ReferenceSampleResponse = {
  sample_id: string;
  user_id: string;
  original_filename: string;
  source: string;
  created_at: string;
};

type AuthSessionResponse = {
  session: SessionResponse;
  verification: VerificationResponse;
};

// F2.5 — every request opts into cookie auth. The `biovoice_session` cookie
// is HttpOnly so this code can never read it; the browser sends it for us
// when we set `credentials: "include"` and the server echoes
// `Access-Control-Allow-Credentials: true` (CORS config in backend/app/main.py).
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
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
          embedMs: stage.embed_ms,
          detectMs: stage.detect_ms,
          totalMs: stage.total_ms,
        }
      : { loadMs: 0, resampleMs: 0, normalizeMs: 0, embedMs: 0, detectMs: 0, totalMs: 0 },
    analysisDetails: details ? toAnalysisDetails(details) : null,
    createdAt: response.created_at,
  };
}

function toSession(response: SessionResponse): Session {
  return {
    sessionToken: response.session_token,
    userId: response.user_id,
    createdAt: response.created_at,
  };
}

export async function listSpeakers(): Promise<Speaker[]> {
  const response = await request<SpeakerResponse[]>("/users");
  return response.map((item) => ({
    userId: item.user_id,
    enrolledAt: item.enrolled_at,
    sampleCount: item.sample_count,
  }));
}

export async function listResults(): Promise<VerificationResult[]> {
  const response = await request<VerificationResponse[]>("/results");
  return response.map(toVerificationResult);
}

async function postForm<T>(path: string, formData: FormData): Promise<T> {
  return request<T>(path, {
    method: "POST",
    body: formData,
  });
}

export async function enrollSpeaker(userId: string, file: File): Promise<string> {
  const formData = new FormData();
  formData.append("user_id", userId);
  formData.append("audio", file);
  const response = await postForm<EnrollmentResponse>("/enroll", formData);
  return response.message;
}

export async function verifySpeaker(userId: string, file: File): Promise<VerificationResult> {
  const formData = new FormData();
  formData.append("user_id", userId);
  formData.append("audio", file);
  const response = await postForm<VerificationResponse>("/verify", formData);
  return toVerificationResult(response);
}

export async function enrollAuthenticatedSpeaker(file: File): Promise<string> {
  const formData = new FormData();
  formData.append("audio", file);
  const response = await postForm<EnrollmentResponse>("/me/enroll", formData);
  return response.message;
}

export async function verifyAuthenticatedSpeaker(file: File): Promise<VerificationResult> {
  const formData = new FormData();
  formData.append("audio", file);
  const response = await postForm<VerificationResponse>("/me/verify", formData);
  return toVerificationResult(response);
}

export async function loginWithVoice(userId: string, file: File): Promise<{ session: Session; verification: VerificationResult }> {
  const formData = new FormData();
  formData.append("user_id", userId);
  formData.append("audio", file);
  // The server pins the session cookie on the response. The body still
  // carries the session token for the sake of the typed `Session` we surface
  // upward — the cookie is the source of truth for subsequent requests.
  const response = await postForm<AuthSessionResponse>("/auth/login", formData);
  return {
    session: toSession(response.session),
    verification: toVerificationResult(response.verification),
  };
}

export async function getSession(): Promise<Session> {
  const response = await request<SessionResponse>("/auth/session");
  return toSession(response);
}

type AvailabilityResponse = { available: boolean };

export async function getAvailability(userId: string): Promise<boolean> {
  const response = await request<AvailabilityResponse>(`/users/${encodeURIComponent(userId)}/availability`);
  return response.available;
}

type SpoofTestResponse = {
  deepfake_score: number;
  decision: SpoofDecision;
  analysis_details: AnalysisDetailsResponse;
};

export async function spoofTest(file: File): Promise<SpoofTestResult> {
  const formData = new FormData();
  formData.append("audio", file);
  const response = await postForm<SpoofTestResponse>("/me/spoof/test", formData);
  return {
    deepfakeScore: response.deepfake_score,
    decision: response.decision,
    analysisDetails: toAnalysisDetails(response.analysis_details),
  };
}

function toAnalysisDetails(payload: AnalysisDetailsResponse): AnalysisDetails {
  return {
    voiceNaturalness: payload.voice_naturalness,
    spectralConsistency: payload.spectral_consistency,
    temporalPatterns: payload.temporal_patterns,
    artifactDetection: payload.artifact_detection,
  };
}

export async function getMyVerification(resultId: string): Promise<VerificationResult> {
  const response = await request<VerificationResponse>(
    `/me/verifications/${encodeURIComponent(resultId)}`,
  );
  return toVerificationResult(response);
}

export async function logoutSession(): Promise<void> {
  await request("/auth/session", { method: "DELETE" });
}

export async function listReferenceSamples(): Promise<ReferenceSample[]> {
  const response = await request<ReferenceSampleResponse[]>("/me/reference-samples");
  return response.map((item) => ({
    sampleId: item.sample_id,
    userId: item.user_id,
    originalFilename: item.original_filename,
    source: item.source,
    createdAt: item.created_at,
  }));
}

function parseFileName(contentDisposition: string | null): string {
  const match = contentDisposition?.match(/filename="([^"]+)"/i);
  return match?.[1] ?? "spoof.wav";
}

export async function generateSpoofSample(payload: {
  text: string;
  language: string;
  referenceSampleId?: string;
  file?: File | null;
}): Promise<SpoofGenerationResult> {
  const formData = new FormData();
  formData.append("text", payload.text);
  formData.append("language", payload.language);
  if (payload.referenceSampleId) {
    formData.append("reference_sample_id", payload.referenceSampleId);
  }
  if (payload.file) {
    formData.append("audio", payload.file);
  }

  const response = await fetch(`${API_BASE}/me/spoof`, {
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
    language: payload.language,
  };
}
