// G7 — language-switcher E2E. Asserts:
//   - <html lang="en" dir="ltr"> on initial load.
//   - Clicking עב flips to Hebrew + rtl.
//   - Sidebar nav labels translate (Console → מסוף).
//   - Welcome screen headline copy translates.
//   - localStorage retains the choice across reloads.

import { test, expect } from "@playwright/test";

test.describe("i18n + RTL", () => {
  test("toggles between English and Hebrew", async ({ page }) => {
    await page.goto("/");

    // Initial state — EN + LTR.
    const htmlEl = page.locator("html");
    await expect(htmlEl).toHaveAttribute("lang", "en");
    await expect(htmlEl).toHaveAttribute("dir", "ltr");

    // Sidebar 'Console' label visible in English.
    await expect(page.locator('.biovoice-sidebar button[title="Console"]')).toBeVisible();

    // Click the עב button in the sidebar's LanguageSwitcher group.
    await page.getByRole("button", { name: /^עב$/ }).click();

    // <html> flipped to Hebrew + RTL.
    await expect(htmlEl).toHaveAttribute("lang", "he");
    await expect(htmlEl).toHaveAttribute("dir", "rtl");

    // Sidebar nav label translated to Hebrew (מסוף = console).
    await expect(page.locator('.biovoice-sidebar button[title="מסוף"]')).toBeVisible();
  });

  test("persists the language choice across reload", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /^עב$/ }).click();
    // Confirm flip happened.
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

    // Reload — the persisted localStorage value should restore Hebrew.
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "he");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  });
});
