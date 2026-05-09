// Enrolment-modal smoke E2E.
//
// Exercising the full mic-capture path is too fragile for CI (the
// fake-audio WAV may or may not pass SNR). What we can deterministically
// verify is the UI wiring:
//   - "+ ENROLL NEW" mounts the modal
//   - mic device picker renders
//   - user-id input enforces the 2–32 char regex
//   - START RECORDING button enables once the id is valid
//   - cancel closes the modal cleanly
//
// The full record path is covered by the manual smoke documented in
// `docs/operator-guide.md`.

import { test, expect } from "@playwright/test";

test.describe("enrolment modal", () => {
  test("+ ENROLL NEW opens the modal and gates START RECORDING on user-id format", async ({ page }) => {
    await page.goto("/");
    await page.locator(`.biovoice-sidebar button[title="Profiles"]`).click();

    const cta = page.getByRole("button", { name: /ENROLL NEW/i }).first();
    await expect(cta).toBeVisible();
    await cta.click();

    const dialog = page.getByRole("dialog", { name: "Enrol new profile" });
    await expect(dialog).toBeVisible();

    // Mic device picker rendered (label "MICROPHONE" + a select element).
    await expect(dialog.getByText("MICROPHONE")).toBeVisible();
    await expect(dialog.locator("select")).toBeVisible();

    // START RECORDING starts disabled — empty user id fails the regex.
    const record = dialog.getByRole("button", { name: /START RECORDING/i });
    await expect(record).toBeVisible();
    await expect(record).toBeDisabled();

    // Bad id (single char) — still disabled.
    await dialog.locator("input[type='text']").fill("a");
    await expect(record).toBeDisabled();
    await expect(dialog.getByText(/must match/i)).toBeVisible();

    // Valid id — record enables.
    await dialog.locator("input[type='text']").fill("alice_e2e");
    await expect(dialog.getByText(/✓ valid/i)).toBeVisible();
    await expect(record).toBeEnabled();

    // UPLOAD AUDIO button is also enabled when the id is valid.
    await expect(dialog.getByRole("button", { name: /UPLOAD AUDIO/i })).toBeEnabled();

    // Cancel closes the modal (no samples captured yet → no confirm prompt).
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).not.toBeVisible();
  });
});
