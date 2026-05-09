// G7 — Playwright config for the kiosk E2E suite.
//
// Three browser projects + chromium-only mobile viewport:
//   chromium-desktop  1920×1080  fake mic enabled
//   webkit-desktop    1440×900   no fake mic (Safari has no equivalent flag)
//   firefox-desktop   1920×1080  no fake mic (Firefox has no equivalent flag)
//   chromium-phone    iPhone 14 Pro viewport, fake mic enabled
//
// Visual regression (toHaveScreenshot) is intentionally NOT wired in
// this round — see plan-agent critique: snapshots drift by ~2 px
// between Linux + macOS rendering and the maintenance burden outweighs
// the value before we have a stable production deployment to compare
// against.
//
// `webServer.start` boots both the backend uvicorn and the vite dev
// server before the test suite. The backend is started in-band so the
// suite can rely on /readyz being green before tests run.

import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fakeMic = path.join(__dirname, "tests", "fixtures", "test-audio.wav");

const fakeMicArgs = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  `--use-file-for-fake-audio-capture=${fakeMic}`,
];

export default defineConfig({
  testDir: "./tests/e2e",
  // Each project gets its own short timeout — flaky network or laggy CI
  // catches a real failure earlier instead of timing out at 60 s.
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",

  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [
    {
      name: "chromium-desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1920, height: 1080 },
        launchOptions: { args: fakeMicArgs },
      },
    },
    {
      name: "webkit-desktop",
      use: {
        ...devices["Desktop Safari"],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "firefox-desktop",
      use: {
        ...devices["Desktop Firefox"],
        viewport: { width: 1920, height: 1080 },
      },
    },
    {
      name: "chromium-phone",
      use: {
        ...devices["iPhone 14 Pro"],
        launchOptions: { args: fakeMicArgs },
      },
    },
  ],

  webServer: [
    {
      // Backend — uvicorn. Auth + admin env vars dropped after the strip;
      // the kiosk has no auth surface left.
      command:
        "cd ../backend && BIOVOICE_LOG_FORMAT=plain " +
        ".venv/bin/uvicorn app.main:app --host localhost --port 8000",
      url: "http://localhost:8000/readyz",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      // Frontend — Vite preview is faster than dev for E2E (no HMR
      // overhead) and matches the production bundle the user actually
      // runs in the kiosk.
      command: "npm run build && npx vite preview --host localhost --port 5173 --strictPort",
      url: "http://localhost:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
