import type { Session, Speaker, VerificationResult } from "../types";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

type SpeakerResponse = {
  user_id: string;
  enrolled_at: string;
  sample_count: number;
};

type VerificationResponse = {
  result_id: string;
  user_id: string;
  decision: "ACCEPT" | "REJECT" | "DEEPFAKE";
  similarity_score: number;
  deepfake_score: number;
  centroid_similarity: number;
  sample_similarities: number[];
  message: string;
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
};

type AuthSessionResponse = {
  session: SessionResponse;
  verification: VerificationResponse;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init);
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
  return {
    resultId: response.result_id,
    userId: response.user_id,
    decision: response.decision,
    similarityScore: response.similarity_score,
    deepfakeScore: response.deepfake_score,
    centroidSimilarity: response.centroid_similarity,
    sampleSimilarities: response.sample_similarities,
    message: response.message,
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

async function postAuthorizedForm<T>(path: string, formData: FormData, sessionToken: string): Promise<T> {
  return request<T>(path, {
    method: "POST",
    body: formData,
    headers: {
      Authorization: `Bearer ${sessionToken}`,
    },
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

export async function enrollAuthenticatedSpeaker(sessionToken: string, file: File): Promise<string> {
  const formData = new FormData();
  formData.append("audio", file);
  const response = await postAuthorizedForm<EnrollmentResponse>("/me/enroll", formData, sessionToken);
  return response.message;
}

export async function verifyAuthenticatedSpeaker(sessionToken: string, file: File): Promise<VerificationResult> {
  const formData = new FormData();
  formData.append("audio", file);
  const response = await postAuthorizedForm<VerificationResponse>("/me/verify", formData, sessionToken);
  return toVerificationResult(response);
}

export async function loginWithVoice(userId: string, file: File): Promise<{ session: Session; verification: VerificationResult }> {
  const formData = new FormData();
  formData.append("user_id", userId);
  formData.append("audio", file);
  const response = await postForm<AuthSessionResponse>("/auth/login", formData);
  return {
    session: toSession(response.session),
    verification: toVerificationResult(response.verification),
  };
}

export async function getSession(sessionToken: string): Promise<Session> {
  const response = await request<SessionResponse>("/auth/session", {
    headers: {
      Authorization: `Bearer ${sessionToken}`,
    },
  });
  return toSession(response);
}

export async function logoutSession(sessionToken: string): Promise<void> {
  await request("/auth/session", {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${sessionToken}`,
    },
  });
}
