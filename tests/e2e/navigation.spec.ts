import { test, expect } from "@playwright/test";

test.describe("Navigation and layout", () => {
  test("root redirects to /dashboard", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.screenshot({ path: "tests/screenshots/navigation-root-redirect.png", fullPage: true });
  });

  test("sidebar shows branding and section labels", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByText("Tokenmaxxing", { exact: true })).toBeVisible();
    await expect(page.getByText("Workspace", { exact: true })).toBeVisible();
    await expect(page.getByText("Configuration", { exact: true })).toBeVisible();
    await page.screenshot({ path: "tests/screenshots/navigation-sidebar-labels.png", fullPage: true });
  });

  test("workspace sidebar links navigate to correct URLs", async ({ page }) => {
    const workspace: { label: string; path: string }[] = [
      { label: "Dashboard", path: "/dashboard" },
      { label: "Agents", path: "/agents" },
      { label: "Org Chart", path: "/org-chart" },
      { label: "Routines", path: "/routines" },
      { label: "Costs", path: "/costs" },
      { label: "Activity", path: "/activity" },
    ];

    await page.goto("/dashboard");

    for (const { label, path } of workspace) {
      await page.getByRole("link", { name: label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${path.replace(/\//g, "\\/")}$`));
      await expect(page.locator("header").getByText(label, { exact: true })).toBeVisible();
    }

    await page.screenshot({ path: "tests/screenshots/navigation-workspace-links.png", fullPage: true });
  });

  test("configuration sidebar links navigate to correct URLs", async ({ page }) => {
    const configuration: { label: string; path: string }[] = [
      { label: "API Keys", path: "/settings/keys" },
      { label: "Integrations", path: "/integrations" },
      { label: "Settings", path: "/settings" },
    ];

    await page.goto("/dashboard");

    for (const { label, path } of configuration) {
      await page.getByRole("link", { name: label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${path.replace(/\//g, "\\/")}$`));
      await expect(page.locator("header").getByText(label, { exact: true })).toBeVisible();
    }

    await page.screenshot({ path: "tests/screenshots/navigation-configuration-links.png", fullPage: true });
  });

  test("header reflects current page label", async ({ page }) => {
    await page.goto("/routines");
    await expect(page.locator("header").getByText("Routines", { exact: true })).toBeVisible();

    await page.goto("/costs");
    await expect(page.locator("header").getByText("Costs", { exact: true })).toBeVisible();

    await page.screenshot({ path: "tests/screenshots/navigation-header-label.png", fullPage: true });
  });
});
