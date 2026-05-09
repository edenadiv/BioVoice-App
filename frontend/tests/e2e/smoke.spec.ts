// Kiosk smoke E2E. Verifies the page loads, the trimmed-down sidebar
// renders the three operator screens (Console / Deepfake Lab /
// Profiles), and the backend reports ready.

import { test, expect } from "@playwright/test";

test.describe("kiosk smoke", () => {
  test("loads the kiosk without unexpected console errors", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("pageerror", (err) => consoleErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto("/");

    // Every kiosk screen renders the BIOVOICE wordmark in the chrome.
    await expect(page.getByText(/BIO\s*VOICE/i).first()).toBeVisible();

    // Three sidebar nav items only after the auth/admin/settings strip.
    // SettingsPanel still ships its own "Console" button so we scope to
    // the sidebar by class.
    const sidebar = page.locator(".biovoice-sidebar");
    for (const id of ["Console", "Deepfake Lab", "Profiles"]) {
      await expect(sidebar.locator(`button[title="${id}"]`)).toBeVisible();
    }
    // Admin + Settings entries are gone.
    await expect(sidebar.locator(`button[title="Admin"]`)).toHaveCount(0);
    await expect(sidebar.locator(`button[title="Settings"]`)).toHaveCount(0);

    expect(consoleErrors).toEqual([]);
  });

  test("/readyz responds with all checks green", async ({ request }) => {
    const resp = await request.get("http://localhost:8000/readyz");
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.ready).toBe(true);
    expect(body.checks.database.ok).toBe(true);
  });
});
