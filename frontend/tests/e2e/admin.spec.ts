// G7 — admin screen E2E. Asserts the admin-key gating behaviour:
//   - The admin nav is reachable (5th sidebar button).
//   - Without a key, the panel shows the empty-state hint.
//   - Pasting the configured backend key loads thresholds + audit
//     (skipped when the key isn't known to the test process — local
//     dev usually reuses the operator's own uvicorn with a personal
//     admin key the spec doesn't have a way to discover).
//
// CI runs against the playwright.config.ts webServer block which
// boots its own uvicorn with `BIOVOICE_ADMIN_API_KEY=playwright-admin-key`
// — that's the default below.

import { test, expect } from "@playwright/test";

const ADMIN_KEY = process.env.BIOVOICE_ADMIN_API_KEY ?? "playwright-admin-key";

test.describe("admin screen", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.locator('.biovoice-sidebar button[title="Admin"]').click();
  });

  test("shows the empty-state hint without a key", async ({ page }) => {
    // Make sure no leftover key from prior test.
    await page.evaluate(() => window.localStorage.removeItem("biovoice_admin_api_key"));
    await page.reload();
    await page.locator('.biovoice-sidebar button[title="Admin"]').click();

    await expect(
      page.getByText(/Paste the deployment's admin key/i),
    ).toBeVisible();
  });

  test("loads thresholds + audit log after key entry", async ({ page }) => {
    // Paste the key into the X-Admin-API-Key input.
    const input = page.locator('input[placeholder*="paste admin key"]');
    await input.fill(ADMIN_KEY);

    // Threshold sliders panel renders the 6 known threshold rows.
    await expect(page.getByText("Similarity threshold")).toBeVisible();
    await expect(page.getByText("Deepfake threshold")).toBeVisible();
    await expect(page.getByText("Voice naturalness")).toBeVisible();
    await expect(page.getByText("Spectral consistency")).toBeVisible();
    await expect(page.getByText("Temporal patterns")).toBeVisible();
    await expect(page.getByText("Artifact detection")).toBeVisible();

    // Audit log panel renders its header — match the exact label-mono
    // text to avoid colliding with body copy that mentions "audit log".
    await expect(page.getByText(/AUDIT LOG · F6\.2/)).toBeVisible();
  });
});
