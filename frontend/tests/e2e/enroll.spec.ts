// Enrolment-modal smoke E2E.
//
// Exercising the full mic-capture + backend quality-gate path is too
// fragile for CI (the fake-audio WAV may or may not pass SNR + speech
// ratio depending on its contents). What we *can* deterministically
// verify here is the UI wiring:
//   - "+ ENROLL NEW" mounts the modal
//   - user-id input enforces the 2–32 char regex
//   - record button enables once the id is valid
//   - cancel closes the modal cleanly
//
// The full record path is covered by the manual smoke documented in
// `docs/operator-guide.md`.

import { test, expect } from "@playwright/test";

test.describe("enrolment modal", () => {
  test("+ ENROLL NEW opens the modal and the form gates the record button on user-id format", async ({ page }) => {
    await page.goto("/");
    await page.locator(`.biovoice-sidebar button[title="Profiles"]`).click();

    // Profiles screen is mounted — click the "+ ENROLL NEW" CTA.
    // Empty-state and populated states both render this button.
    const cta = page.getByRole("button", { name: /ENROLL NEW/i }).first();
    await expect(cta).toBeVisible();
    await cta.click();

    // The modal mounts as role="dialog" with aria-label "Enrol new profile".
    const dialog = page.getByRole("dialog", { name: "Enrol new profile" });
    await expect(dialog).toBeVisible();

    // Record button starts disabled — empty user id fails the regex.
    const record = dialog.getByRole("button", { name: /Record sample 1/i });
    await expect(record).toBeDisabled();

    // Bad id (single char) — still disabled.
    await dialog.locator("input[type='text']").fill("a");
    await expect(record).toBeDisabled();
    await expect(dialog.getByText(/must match/i)).toBeVisible();

    // Valid id — record enables, valid hint shows.
    await dialog.locator("input[type='text']").fill("alice_e2e");
    await expect(dialog.getByText(/✓ valid/i)).toBeVisible();
    await expect(record).toBeEnabled();

    // Cancel closes the modal (no samples captured yet → no confirm prompt).
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).not.toBeVisible();
  });
});
