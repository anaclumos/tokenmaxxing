import { test, expect } from "@playwright/test";

test.describe("Activity", () => {
  test("loads activity page", async ({ page }) => {
    await page.goto("/activity");
    await expect(
      page.getByRole("heading", { name: "Activity" }),
    ).toBeVisible();
    await page.screenshot({ path: "tests/screenshots/activity.png" });
  });

  test("shows seed activity entries", async ({ page }) => {
    await page.goto("/activity");
    await page.waitForTimeout(1500);
    await expect(page.getByText("agent.created")).toBeVisible();
    await page.screenshot({
      path: "tests/screenshots/activity-with-data.png",
    });
  });
});
