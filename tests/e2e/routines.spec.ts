import { test, expect } from "@playwright/test";

test.describe("Routines", () => {
  test("lists seed routines with status badges", async ({ page }) => {
    await page.goto("/routines");

    const standupRow = page
      .locator("div.flex.items-center.justify-between.gap-4.p-4")
      .filter({ hasText: "Daily standup review" });
    await expect(
      standupRow.getByText("Daily standup review", { exact: true }),
    ).toBeVisible();
    await expect(standupRow.getByText("active", { exact: true })).toBeVisible();

    const weeklyRow = page
      .locator("div.flex.items-center.justify-between.gap-4.p-4")
      .filter({ hasText: "Weekly progress report" });
    await expect(
      weeklyRow.getByText("Weekly progress report", { exact: true }),
    ).toBeVisible();
    await expect(weeklyRow.getByText("active", { exact: true })).toBeVisible();

    await page.screenshot({
      path: "tests/screenshots/routines-seed-list.png",
      fullPage: true,
    });
  });

  test("create routine dialog renders the current form fields", async ({
    page,
  }) => {
    await page.goto("/routines");
    await page.getByRole("button", { name: "New Routine", exact: true }).click();

    await expect(page.getByRole("dialog", { name: "Create Routine" })).toBeVisible();
    await expect(page.getByLabel("Name", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Description", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Agent", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Cron Expression", { exact: true })).toBeVisible();

    await page.screenshot({
      path: "tests/screenshots/routines-create-dialog.png",
      fullPage: true,
    });
  });

  test("submits a new routine and shows it in the list", async ({ page }) => {
    const unique = Date.now();
    const routineName = `E2E nightly regression sweep ${unique}`;

    await page.goto("/routines");
    await page.getByRole("button", { name: "New Routine", exact: true }).click();

    await page.getByLabel("Name", { exact: true }).fill(routineName);
    await page
      .getByLabel("Description", { exact: true })
      .fill("Runs automated checks against staging each night.");
    await page
      .getByLabel("Agent", { exact: true })
      .selectOption({ label: "Chief Executive Officer" });
    await page.getByLabel("Cron Expression", { exact: true }).fill("15 2 * * *");

    await page.getByRole("button", { name: "Create Routine", exact: true }).click();

    await expect(page.getByText("Routine created.")).toBeVisible();

    const createdRow = page
      .locator("div.flex.items-center.justify-between.gap-4.p-4")
      .filter({ hasText: routineName });
    await expect(
      createdRow.getByText(routineName, { exact: true }),
    ).toBeVisible();
    await expect(
      createdRow.getByText(
        "Runs automated checks against staging each night.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(createdRow.getByText("active", { exact: true })).toBeVisible();

    await page.screenshot({
      path: "tests/screenshots/routines-after-create.png",
      fullPage: true,
    });
  });
});
