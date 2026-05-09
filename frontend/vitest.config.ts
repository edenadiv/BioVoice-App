// G7 — Vitest config for unit tests in src/lib/.
//
// `happy-dom` is the lightweight DOM env (faster than jsdom for our
// needs — we only test client utilities like format helpers and the
// fetch wrapper, not full component trees yet).
//
// `setupFiles` wires `@testing-library/jest-dom` matchers (toBeInTheDocument
// etc.) — handy when later phases add component-level tests.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    setupFiles: ["./tests/setup-vitest.ts"],
    // Restrict collection to the unit-test surface; Playwright owns the
    // E2E specs under tests/e2e/.
    include: ["src/**/*.test.{ts,tsx}", "tests/unit/**/*.test.{ts,tsx}"],
    globals: true,
  },
});
