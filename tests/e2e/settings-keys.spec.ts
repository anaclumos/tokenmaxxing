import { test, expect } from "@playwright/test";

test.describe("Settings - API Keys", () => {
  test("loads BYOK key management page", async ({ page }) => {
    await page.goto("/settings/keys");
    await expect(
      page.getByRole("heading", { name: "API Keys" }),
    ).toBeVisible();
    await expect(page.getByText("OpenAI")).toBeVisible();
    await expect(page.getByText("Anthropic")).toBeVisible();
    await expect(page.getByText("Google AI")).toBeVisible();
    await page.screenshot({ path: "tests/screenshots/settings-keys.png" });
  });

  test("shows save buttons for each provider", async ({ page }) => {
    await page.goto("/settings/keys");
    const saveButtons = page.getByRole("button", { name: "Save" });
    await expect(saveButtons).toHaveCount(3);
    await page.screenshot({
      path: "tests/screenshots/settings-keys-form.png",
    });
  });
});
