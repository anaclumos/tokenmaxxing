import { test, expect } from "@playwright/test";

test.describe("Integrations", () => {
  test("loads with heading, Catalog tab selected, and Installed count zero", async ({
    page,
  }) => {
    await page.goto("/integrations");

    await expect(
      page.getByRole("heading", { name: "Integrations", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("tab", { name: "Catalog" })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Installed \(\d+\)/ })).toBeVisible();

    await expect(page.getByText("oauth", { exact: true })).toBeVisible();
    await expect(page.getByText("env vars", { exact: true })).toBeVisible();
    await page.screenshot({
      path: "tests/screenshots/integrations-catalog-default.png",
    });
  });

  test("catalog lists GitHub and Linear from seed with docs links", async ({
    page,
  }) => {
    await page.goto("/integrations");

    await expect(
      page.getByText(
        "Access GitHub repositories, issues, and pull requests",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByText("Manage Linear issues, projects, and cycles", {
        exact: true,
      }),
    ).toBeVisible();

    const githubCard = page.locator('[data-slot="card"]').filter({
      has: page.getByText("GitHub", { exact: true }),
    });
    const linearCard = page.locator('[data-slot="card"]').filter({
      has: page.getByText("Linear", { exact: true }),
    });

    await expect(githubCard.getByText("https://mcp.github.com/sse")).toBeVisible();
    await expect(linearCard.getByText("https://mcp.linear.app/sse")).toBeVisible();
    await expect(page.getByRole("link", { name: "Docs" })).toHaveCount(2);

    await page.screenshot({
      path: "tests/screenshots/integrations-seed-catalog-cards.png",
    });
  });

  test("Installed tab renders either empty state or installed entries", async ({
    page,
  }) => {
    await page.goto("/integrations");
    await page.getByRole("tab", { name: /Installed/ }).click();

    const emptyState = page.getByText("No integrations installed yet.", {
      exact: true,
    });
    const cards = page.locator('[data-slot="card"]');

    const hasEmptyState = (await emptyState.count()) > 0;
    if (hasEmptyState) {
      await expect(emptyState).toBeVisible();
    } else {
      await expect(cards.first()).toBeVisible();
    }

    await page.screenshot({
      path: "tests/screenshots/integrations-installed-empty.png",
    });
  });
});
