// Vitest unit tests for the lib/api request wrapper.
// Stub `fetch` so the tests are hermetic — no backend required.

import { describe, expect, it, beforeEach, afterEach, vi, type Mock } from "vitest";
import { listSpeakers, listResults, deleteUser, enrollSpeaker, verifySpeaker, identifySpeaker } from "./api";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn() as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function noContentResponse(status = 204): Response {
  return new Response(null, { status });
}

describe("api request wrapper — credentials + method contract", () => {
  it("listSpeakers passes credentials: 'include'", async () => {
    (globalThis.fetch as Mock).mockResolvedValueOnce(jsonResponse([]));
    await listSpeakers();
    const init = (globalThis.fetch as Mock).mock.calls[0][1];
    expect(init.credentials).toBe("include");
  });

  it("listResults passes credentials: 'include'", async () => {
    (globalThis.fetch as Mock).mockResolvedValueOnce(jsonResponse([]));
    await listResults();
    const init = (globalThis.fetch as Mock).mock.calls[0][1];
    expect(init.credentials).toBe("include");
  });

  it("deleteUser sends DELETE and handles 204", async () => {
    (globalThis.fetch as Mock).mockResolvedValueOnce(noContentResponse());
    await deleteUser("alice");
    const [url, init] = (globalThis.fetch as Mock).mock.calls[0];
    expect(String(url)).toMatch(/\/users\/alice$/);
    expect(init.method).toBe("DELETE");
    expect(init.credentials).toBe("include");
  });

  it("enrollSpeaker posts user_id + audio as form data", async () => {
    (globalThis.fetch as Mock).mockResolvedValueOnce(jsonResponse({
      user_id: "alice",
      status: "enrolled",
      message: "ok",
      enrolled_at: "2026-05-09T00:00:00Z",
      quality: { score: 90, snr_db: 60, clipping_pct: 0, speech_ratio: 1, acceptable: true },
    }));
    const file = new File([new Uint8Array([0])], "test.wav", { type: "audio/wav" });
    await enrollSpeaker("alice", file);
    const [url, init] = (globalThis.fetch as Mock).mock.calls[0];
    expect(String(url)).toMatch(/\/enroll$/);
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("verifySpeaker posts user_id + audio as form data", async () => {
    (globalThis.fetch as Mock).mockResolvedValueOnce(jsonResponse({
      result_id: "r1",
      user_id: "alice",
      decision: "ACCEPT",
      decision_reason: "accepted",
      similarity_score: 0.9,
      deepfake_score: 0.9,
      centroid_similarity: 0.9,
      sample_similarities: [],
      message: "ok",
      session_id: "VRF-20260509-00001",
      created_at: "2026-05-09T00:00:00Z",
    }));
    const file = new File([new Uint8Array([0])], "test.wav", { type: "audio/wav" });
    await verifySpeaker("alice", file);
    const [url] = (globalThis.fetch as Mock).mock.calls[0];
    expect(String(url)).toMatch(/\/verify$/);
  });

  it("identifySpeaker posts audio + top_n + transforms snake_case → camelCase", async () => {
    (globalThis.fetch as Mock).mockResolvedValueOnce(jsonResponse({
      matches: [
        { user_id: "alice", similarity_score: 0.94, centroid_similarity: 0.92, sample_count: 3, enrolled_at: "2026-05-09T00:00:00Z" },
        { user_id: "bob",   similarity_score: 0.71, centroid_similarity: 0.69, sample_count: 5, enrolled_at: "2026-05-08T00:00:00Z" },
        { user_id: "carol", similarity_score: 0.42, centroid_similarity: 0.40, sample_count: 4, enrolled_at: "2026-05-07T00:00:00Z" },
      ],
      deepfake_score: 0.97,
      analysis_details: { voice_naturalness: 0.5, spectral_consistency: 0.6, temporal_patterns: 0.7, artifact_detection: 0.8 },
      would_accept_top1: true,
      similarity_threshold: 0.75,
      deepfake_threshold: 0.5,
      n_enrolled_total: 3,
    }));
    const file = new File([new Uint8Array([0])], "query.wav", { type: "audio/wav" });
    const result = await identifySpeaker(file, 3);
    const [url, init] = (globalThis.fetch as Mock).mock.calls[0];
    expect(String(url)).toMatch(/\/identify$/);
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    expect(result.matches).toHaveLength(3);
    expect(result.matches[0].userId).toBe("alice");
    expect(result.matches[0].similarityScore).toBeCloseTo(0.94);
    expect(result.wouldAcceptTop1).toBe(true);
    expect(result.nEnrolledTotal).toBe(3);
    expect(result.analysisDetails?.voiceNaturalness).toBeCloseTo(0.5);
  });

  it("identifySpeaker handles null analysis_details", async () => {
    (globalThis.fetch as Mock).mockResolvedValueOnce(jsonResponse({
      matches: [],
      deepfake_score: 0,
      analysis_details: null,
      would_accept_top1: false,
      similarity_threshold: 0.75,
      deepfake_threshold: 0.5,
      n_enrolled_total: 0,
    }));
    const file = new File([new Uint8Array([0])], "query.wav", { type: "audio/wav" });
    const result = await identifySpeaker(file);
    expect(result.matches).toEqual([]);
    expect(result.analysisDetails).toBeNull();
  });
});

describe("model_provenance snake→camel transform", () => {
  it("verifySpeaker exposes modelProvenance from the backend response", async () => {
    (globalThis.fetch as Mock).mockResolvedValueOnce(jsonResponse({
      result_id: "r1",
      user_id: "alice",
      decision: "ACCEPT",
      decision_reason: "accepted",
      similarity_score: 0.9,
      deepfake_score: 0.9,
      centroid_similarity: 0.9,
      sample_similarities: [],
      message: "ok",
      session_id: "VRF-20260510-00001",
      created_at: "2026-05-10T00:00:00Z",
      model_provenance: {
        encoder: "redimnet_b5",
        detector: "heuristic",
        acoustic_probe: "heuristic",
        is_degraded: true,
      },
    }));
    const file = new File([new Uint8Array([0])], "q.wav", { type: "audio/wav" });
    const r = await verifySpeaker("alice", file);
    expect(r.modelProvenance).not.toBeNull();
    expect(r.modelProvenance!.detector).toBe("heuristic");
    expect(r.modelProvenance!.acousticProbe).toBe("heuristic");  // snake → camel
    expect(r.modelProvenance!.isDegraded).toBe(true);
  });

  it("verifySpeaker handles missing model_provenance (legacy backend)", async () => {
    (globalThis.fetch as Mock).mockResolvedValueOnce(jsonResponse({
      result_id: "r1",
      user_id: "alice",
      decision: "ACCEPT",
      decision_reason: "accepted",
      similarity_score: 0.9,
      deepfake_score: 0.9,
      centroid_similarity: 0.9,
      sample_similarities: [],
      message: "ok",
      session_id: "VRF-20260510-00001",
      created_at: "2026-05-10T00:00:00Z",
      // no model_provenance — older backend
    }));
    const file = new File([new Uint8Array([0])], "q.wav", { type: "audio/wav" });
    const r = await verifySpeaker("alice", file);
    expect(r.modelProvenance).toBeNull();
  });
});

describe("api request wrapper — error propagation", () => {
  it("throws when the server returns 400", async () => {
    (globalThis.fetch as Mock).mockResolvedValueOnce(
      new Response("user not found", { status: 400 }),
    );
    await expect(listSpeakers()).rejects.toThrow(/user not found|400/);
  });

  it("throws when the server returns 500", async () => {
    (globalThis.fetch as Mock).mockResolvedValueOnce(
      new Response("internal error", { status: 500 }),
    );
    await expect(listResults()).rejects.toThrow();
  });
});
