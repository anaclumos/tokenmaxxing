import { test, expect } from "@playwright/test";

test.describe("Activity", () => {
  test("loads with Activity heading", async ({ page }) => {
    await page.goto("/activity");

    await expect(
      page.getByRole("heading", { name: "Activity", exact: true }),
    ).toBeVisible();

    await page.screenshot({ path: "tests/screenshots/activity-heading.png" });
  });

  test("shows seed activity rows with actor, action, resource, and timestamps", async ({
    page,
  }) => {
    await page.goto("/activity");

    await expect(page.getByText("No activity yet.")).not.toBeVisible();
    const boardCount = await page.getByText("board", { exact: true }).count();
    const actionCount = await page.getByText("agent.created").count();
    const resourceCount = await page.getByText("agent/00000000").count();

    expect(boardCount).toBeGreaterThanOrEqual(5);
    expect(actionCount).toBeGreaterThanOrEqual(5);
    expect(resourceCount).toBeGreaterThanOrEqual(5);

    const times = page.locator("time");
    const timeCount = await times.count();
    expect(timeCount).toBeGreaterThanOrEqual(5);
    for (let i = 0; i < timeCount; i++) {
      await expect(times.nth(i)).not.toBeEmpty();
      await expect(times.nth(i)).toHaveText(/\d/);
    }

    await page.screenshot({
      path: "tests/screenshots/activity-seed-rows.png",
    });
  });
});
