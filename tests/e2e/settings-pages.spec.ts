import { test, expect } from "@playwright/test";

test.describe("Settings placeholder pages", () => {
  test("/settings shows Settings and General", async ({ page }) => {
    await page.goto("/settings");

    await expect(
      page.getByRole("heading", { name: "Settings", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "General", exact: true }),
    ).toBeVisible();

    await page.screenshot({ path: "tests/screenshots/settings-general.png" });
  });

  test("/settings/budgets shows Budgets and Organization Budget", async ({
    page,
  }) => {
    await page.goto("/settings/budgets");

    await expect(
      page.getByRole("heading", { name: "Budgets", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Organization Budget", exact: true }),
    ).toBeVisible();

    await page.screenshot({ path: "tests/screenshots/settings-budgets.png" });
  });

  test("/settings/members shows Members heading", async ({ page }) => {
    await page.goto("/settings/members");

    await expect(
      page.getByRole("heading", { name: "Members", exact: true }),
    ).toBeVisible();

    await page.screenshot({ path: "tests/screenshots/settings-members.png" });
  });
});
