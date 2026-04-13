import { test, expect } from "@playwright/test";

test.describe("Integrations", () => {
  test("loads MCP marketplace", async ({ page }) => {
    await page.goto("/integrations");
    await expect(
      page.getByRole("heading", { name: "Integrations" }),
    ).toBeVisible();
    await expect(page.getByText("Catalog")).toBeVisible();
    await expect(page.getByText("Installed")).toBeVisible();
    await page.screenshot({ path: "tests/screenshots/integrations.png" });
  });

  test("shows catalog entries from seed", async ({ page }) => {
    await page.goto("/integrations");
    await page.waitForTimeout(1500);
    await expect(page.getByText("GitHub")).toBeVisible();
    await expect(page.getByText("Linear")).toBeVisible();
    await page.screenshot({
      path: "tests/screenshots/integrations-catalog.png",
    });
  });

  test("shows installed tab", async ({ page }) => {
    await page.goto("/integrations");
    await page.getByRole("tab", { name: "Installed" }).click();
    await page.screenshot({
      path: "tests/screenshots/integrations-installed.png",
    });
  });
});
