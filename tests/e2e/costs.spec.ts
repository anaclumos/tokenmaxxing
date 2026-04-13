import { test, expect } from "@playwright/test";

test.describe("Costs", () => {
  test("loads costs page with metrics", async ({ page }) => {
    await page.goto("/costs");
    await expect(page.getByRole("heading", { name: "Costs" })).toBeVisible();
    await expect(page.getByText("Total Spend")).toBeVisible();
    await expect(page.getByText("Input Tokens")).toBeVisible();
    await expect(page.getByText("Output Tokens")).toBeVisible();
    await page.screenshot({ path: "tests/screenshots/costs.png" });
  });

  test("shows seed cost data", async ({ page }) => {
    await page.goto("/costs");
    await page.waitForTimeout(1500);
    await expect(page.getByText("openai")).toBeVisible();
    await page.screenshot({ path: "tests/screenshots/costs-with-data.png" });
  });
});
