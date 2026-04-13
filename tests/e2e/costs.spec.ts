import { test, expect } from "@playwright/test";

test.describe("Costs", () => {
  test("loads with heading, metric cards, and this month labels", async ({
    page,
  }) => {
    await page.goto("/costs");

    await expect(
      page.getByRole("heading", { name: "Costs", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Total Spend")).toBeVisible();
    await expect(page.getByText("Input Tokens")).toBeVisible();
    await expect(page.getByText("Output Tokens")).toBeVisible();

    const monthLabels = page.getByText("this month");
    await expect(monthLabels).toHaveCount(3);

    await page.screenshot({
      path: "tests/screenshots/costs-metrics-loaded.png",
    });
  });

  test("shows aggregated spend and token totals", async ({ page }) => {
    await page.goto("/costs");

    await expect(
      page.locator("dt", { hasText: "Total Spend" }).locator("+ dd"),
    ).toHaveText(/\$4\.60/);

    const inputDd = page.locator("dt", { hasText: "Input Tokens" }).locator("+ dd");
    const outputDd = page
      .locator("dt", { hasText: "Output Tokens" })
      .locator("+ dd");
    await expect(inputDd).not.toHaveText("0");
    await expect(outputDd).not.toHaveText("0");

    await page.screenshot({
      path: "tests/screenshots/costs-summary-populated.png",
    });
  });

  test("lists cost events with provider/model, token counts, and dollar amounts", async ({
    page,
  }) => {
    await page.goto("/costs");

    await expect(page.getByRole("heading", { name: "Cost Events" })).toBeVisible();
    await expect(page.getByText("No cost data yet")).not.toBeVisible();

    await expect(page.getByText("openai/gpt-5.4")).toHaveCount(2);
    await expect(page.getByText("anthropic/claude-sonnet-4.6")).toHaveCount(2);
    await expect(page.getByText("google/gemini-2.5-flash")).toBeVisible();
    await expect(page.getByText(/\d[\d,]* in \/ \d[\d,]* out/)).toHaveCount(5);
    await expect(page.getByText(/\$\d+\.\d{4}/)).toHaveCount(5);

    await page.screenshot({
      path: "tests/screenshots/costs-events-detail.png",
    });
  });
});
