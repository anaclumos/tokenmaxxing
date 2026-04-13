import { test, expect } from "@playwright/test";

test.describe("Routines", () => {
  test("loads and shows seed routines", async ({ page }) => {
    await page.goto("/routines");
    await expect(
      page.getByRole("heading", { name: "Routines" }),
    ).toBeVisible();
    await page.waitForTimeout(1500);
    await expect(page.getByText("Daily standup review")).toBeVisible();
    await expect(page.getByText("Weekly progress report")).toBeVisible();
    await page.screenshot({ path: "tests/screenshots/routines.png" });
  });

  test("opens create routine dialog", async ({ page }) => {
    await page.goto("/routines");
    await page.getByRole("button", { name: "New Routine" }).click();
    await expect(
      page.getByRole("heading", { name: "Create Routine" }),
    ).toBeVisible();
    await page.screenshot({
      path: "tests/screenshots/routines-create-dialog.png",
    });
  });
});
