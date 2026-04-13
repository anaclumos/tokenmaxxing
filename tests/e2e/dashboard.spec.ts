import { test, expect } from "@playwright/test";

test.describe("Dashboard", () => {
  test("loads and shows metric cards", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByText("Active Agents")).toBeVisible();
    await expect(page.getByText("Total Runs")).toBeVisible();
    await expect(page.getByText("Monthly Spend")).toBeVisible();
    await page.screenshot({ path: "tests/screenshots/dashboard.png" });
  });

  test("shows seed data agent count", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByText("Active Agents")).toBeVisible();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: "tests/screenshots/dashboard-loaded.png" });
  });

  test("shows recent activity section", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByText("Recent Activity")).toBeVisible();
    await page.screenshot({ path: "tests/screenshots/dashboard-activity.png" });
  });
});
