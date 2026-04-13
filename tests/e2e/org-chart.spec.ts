import { test, expect } from "@playwright/test";

test.describe("Org Chart", () => {
  test("loads and shows agent hierarchy", async ({ page }) => {
    await page.goto("/org-chart");
    await expect(
      page.getByRole("heading", { name: "Org Chart" }),
    ).toBeVisible();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: "tests/screenshots/org-chart.png" });
  });

  test("shows seed agents in hierarchy", async ({ page }) => {
    await page.goto("/org-chart");
    await page.waitForTimeout(1500);
    await expect(page.getByText("CEO")).toBeVisible();
    await expect(page.getByText("CTO")).toBeVisible();
    await page.screenshot({ path: "tests/screenshots/org-chart-loaded.png" });
  });
});
