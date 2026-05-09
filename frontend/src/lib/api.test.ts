// G7 — Vitest unit tests for the lib/api request wrapper.
//
// Goal: assert the cookie-auth contract (every fetch carries
// `credentials: 'include'`) and the 401 propagation behaviour. We
// stub `fetch` directly so the tests are hermetic — no backend needed.

import { describe, expect, it, beforeEach, vi, type Mock } from "vitest";
import { listSpeakers, listResults, logoutSession, getSession } from "./api";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  // Reset the mock before each test so call counts are predictable.
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

describe("api request wrapper — cookie auth contract", () => {
  it("listSpeakers passes credentials: 'include'", async () => {
    (globalThis.fetch as Mock).mockResolvedValueOnce(jsonResponse([]));
    await listSpeakers();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const init = (globalThis.fetch as Mock).mock.calls[0][1];
    expect(init.credentials).toBe("include");
  });

  it("listResults passes credentials: 'include'", async () => {
    (globalThis.fetch as Mock).mockResolvedValueOnce(jsonResponse([]));
    await listResults();
    const init = (globalThis.fetch as Mock).mock.calls[0][1];
    expect(init.credentials).toBe("include");
  });

  it("logoutSession sends DELETE with credentials and handles 204", async () => {
    (globalThis.fetch as Mock).mockResolvedValueOnce(noContentResponse());
    await logoutSession();
    const [, init] = (globalThis.fetch as Mock).mock.calls[0];
    expect(init.method).toBe("DELETE");
    expect(init.credentials).toBe("include");
  });
});

describe("api request wrapper — error propagation", () => {
  it("throws when the server returns 401", async () => {
    (globalThis.fetch as Mock).mockResolvedValueOnce(
      new Response("Missing Authorization header", { status: 401 }),
    );
    await expect(getSession()).rejects.toThrow(/Missing Authorization|401/);
  });

  it("throws when the server returns 500", async () => {
    (globalThis.fetch as Mock).mockResolvedValueOnce(
      new Response("internal error", { status: 500 }),
    );
    await expect(listSpeakers()).rejects.toThrow();
  });

  it("rejects unauthorised even when body is empty", async () => {
    (globalThis.fetch as Mock).mockResolvedValueOnce(noContentResponse(401));
    await expect(getSession()).rejects.toThrow(/401/);
  });
});

// --- Compatibility shim for the test runner --------------------------------
import { afterEach } from "vitest";
