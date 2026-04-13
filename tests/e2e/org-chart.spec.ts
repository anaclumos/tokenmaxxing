import { test, expect } from "@playwright/test";

test.describe("Org chart", () => {
  test("loads heading and description", async ({ page }) => {
    await page.goto("/org-chart");

    await expect(
      page.getByRole("heading", { name: "Org Chart", level: 2 }),
    ).toBeVisible();
    await expect(
      page.getByText("Agent hierarchy and reporting lines."),
    ).toBeVisible();

    await page.screenshot({
      path: "tests/screenshots/org-chart-heading.png",
      fullPage: true,
    });
  });

  test("renders seed agents in hierarchy with names, titles, and roles", async ({
    page,
  }) => {
    await page.goto("/org-chart");

    await expect(page.getByText("CEO").first()).toBeVisible();
    await expect(page.getByText("CTO").first()).toBeVisible();
    await expect(page.getByText("Frontend Engineer", { exact: true })).toBeVisible();
    await expect(page.getByText("Backend Engineer", { exact: true })).toBeVisible();
    await expect(page.getByText("Designer", { exact: true })).toBeVisible();

    await expect(page.getByText("Chief Executive Officer")).toBeVisible();
    await expect(page.getByText("Chief Technology Officer")).toBeVisible();
    await expect(page.getByText("Senior Frontend Engineer")).toBeVisible();
    await expect(page.getByText("Senior Backend Engineer")).toBeVisible();
    await expect(page.getByText("Lead Product Designer")).toBeVisible();

    await expect(page.getByText("executive").first()).toBeVisible();
    await expect(page.getByText("engineer").first()).toBeVisible();
    await expect(page.getByText("designer", { exact: true }).first()).toBeVisible();

    await page.screenshot({
      path: "tests/screenshots/org-chart-agents.png",
      fullPage: true,
    });
  });

  test("shows tree connectors for child nodes", async ({ page }) => {
    await page.goto("/org-chart");

    const connectors = page.getByText("└");
    await expect(connectors.first()).toBeVisible();
    const count = await connectors.count();
    expect(count).toBeGreaterThanOrEqual(4);

    await page.screenshot({
      path: "tests/screenshots/org-chart-hierarchy.png",
      fullPage: true,
    });
  });
});
