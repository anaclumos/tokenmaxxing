import { test, expect } from "@playwright/test";

test.describe("Dashboard", () => {
  test("loads heading and three metric cards", async ({ page }) => {
    await page.goto("/dashboard");

    await expect(
      page.getByRole("heading", { name: "Dashboard", level: 2 }),
    ).toBeVisible();
    await expect(page.getByText("Active Agents")).toBeVisible();
    await expect(page.getByText("Total Runs")).toBeVisible();
    await expect(page.getByText("Monthly Spend")).toBeVisible();

    await page.screenshot({
      path: "tests/screenshots/dashboard-heading.png",
      fullPage: true,
    });
  });

  test("shows correct active agent count from seed data", async ({ page }) => {
    await page.goto("/dashboard");

    const activeCard = page
      .locator('[data-slot="card"]')
      .filter({ hasText: "Active Agents" });
    const activeValue = Number(
      (await activeCard.locator("dd").textContent())?.trim() ?? "0",
    );
    expect(activeValue).toBeGreaterThanOrEqual(5);

    await page.screenshot({
      path: "tests/screenshots/dashboard-agent-count.png",
      fullPage: true,
    });
  });

  test("shows Recent Activity section with seed entries", async ({ page }) => {
    await page.goto("/dashboard");

    await expect(page.getByText("Recent Activity")).toBeVisible();

    const entries = page.getByText("agent.created");
    await expect(entries.first()).toBeVisible();
    expect(await entries.count()).toBeGreaterThanOrEqual(5);

    await page.screenshot({
      path: "tests/screenshots/dashboard-activity.png",
      fullPage: true,
    });
  });

  test("shows monthly spend as dollar amount", async ({ page }) => {
    await page.goto("/dashboard");

    const spendCard = page
      .locator('[data-slot="card"]')
      .filter({ hasText: "Monthly Spend" });
    await expect(spendCard).toContainText("$");

    await page.screenshot({
      path: "tests/screenshots/dashboard-spend.png",
      fullPage: true,
    });
  });
});
