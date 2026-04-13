import { test, expect } from "@playwright/test";

test.describe("Dashboard", () => {
  test("loads and shows metric cards", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByText("Active Agents")).toBeVisible();
    await expect(page.getByText("Open Issues")).toBeVisible();
    await expect(page.getByText("Monthly Spend")).toBeVisible();
    await page.screenshot({ path: "tests/screenshots/dashboard.png" });
  });

  test("shows seed data counts", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForTimeout(1000);
    await expect(page.getByText("5")).toBeVisible();
    await page.screenshot({
      path: "tests/screenshots/dashboard-with-data.png",
    });
  });
});
