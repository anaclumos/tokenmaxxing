import { test, expect } from "@playwright/test";

test.describe("Navigation", () => {
  test("redirects / to /dashboard", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("sidebar navigation works", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByText("Tokenmaxxing")).toBeVisible();

    await page.getByRole("link", { name: "Agents" }).click();
    await expect(page).toHaveURL(/\/agents/);

    await page.getByRole("link", { name: "Costs" }).click();
    await expect(page).toHaveURL(/\/costs/);

    await page.getByRole("link", { name: "Org Chart" }).click();
    await expect(page).toHaveURL(/\/org-chart/);

    await page.screenshot({ path: "tests/screenshots/navigation.png" });
  });

  test("sidebar shows workspace and configuration sections", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByText("Workspace")).toBeVisible();
    await expect(page.getByText("Configuration")).toBeVisible();
    await page.screenshot({ path: "tests/screenshots/sidebar.png" });
  });
});
