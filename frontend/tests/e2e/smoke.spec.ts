// G7 — kiosk smoke E2E. Asserts the basics: page loads, sidebar
// renders the five nav items, /readyz reports green from the running
// backend, no console errors.

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

    // 5 sidebar nav items. The t() labels resolve to these strings in
    // EN. Multiple buttons in the page can carry the same accessible
    // name (e.g. SettingsPanel has its own "Console" button), so scope
    // the selector to the sidebar via the .biovoice-sidebar class
    // (added in F5.3).
    const sidebar = page.locator(".biovoice-sidebar");
    for (const id of ["Console", "Deepfake Lab", "Profiles", "Settings", "Admin"]) {
      await expect(sidebar.locator(`button[title="${id}"]`)).toBeVisible();
    }

    // Filter expected 401s from getSession() probing on first paint
    // (page asks the backend if a session exists; backend responds 401
    // when the cookie isn't present yet — normal logged-out state).
    const unexpected = consoleErrors.filter(
      (msg) => !msg.includes("status of 401"),
    );
    expect(unexpected).toEqual([]);
  });

  test("/readyz responds with all checks green", async ({ request }) => {
    const resp = await request.get("http://127.0.0.1:8000/readyz");
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.ready).toBe(true);
    expect(body.checks.database.ok).toBe(true);
  });
});
