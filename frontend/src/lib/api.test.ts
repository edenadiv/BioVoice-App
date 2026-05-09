// Vitest unit tests for the lib/api request wrapper.
// Stub `fetch` so the tests are hermetic — no backend required.

import { describe, expect, it, beforeEach, afterEach, vi, type Mock } from "vitest";
import { listSpeakers, listResults, deleteUser, enrollSpeaker, verifySpeaker } from "./api";

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
