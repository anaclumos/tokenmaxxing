import { test, expect } from "@playwright/test";

test.describe("Agents", () => {
  test("lists seed agents", async ({ page }) => {
    await page.goto("/agents");
    await expect(
      page.getByRole("heading", { name: "Agents" }),
    ).toBeVisible();
    await expect(page.getByText("Chief Executive Officer")).toBeVisible();
    await expect(page.getByText("Chief Technology Officer")).toBeVisible();
    await expect(page.getByText("Senior Frontend Engineer")).toBeVisible();
    await page.screenshot({ path: "tests/screenshots/agents-list.png" });
  });

  test("creates a new agent", async ({ page }) => {
    await page.goto("/agents");
    await page.getByRole("button", { name: "New Agent" }).click();
    await expect(
      page.getByRole("heading", { name: "Create Agent" }),
    ).toBeVisible();

    await page.getByLabel("Name").fill("QA Engineer");
    await page.getByLabel("Shortname").fill("qa");
    await page.getByLabel("Model").fill("gpt-5.4");
    await page.getByLabel("Role").fill("engineer");
    await page.getByLabel("Title").fill("QA Automation Engineer");

    await page.locator("#provider").click();
    await page.getByRole("option", { name: "OpenAI" }).click();

    await page.screenshot({
      path: "tests/screenshots/agents-create-dialog.png",
    });

    await page.getByRole("button", { name: "Create Agent" }).click();
    await page.waitForTimeout(1000);

    await expect(page.getByText("QA Engineer")).toBeVisible();
    await page.screenshot({
      path: "tests/screenshots/agents-after-create.png",
    });
  });

  test("views agent detail", async ({ page }) => {
    await page.goto("/agents");
    await page.getByText("Chief Executive Officer").click();
    await expect(
      page.getByRole("heading", { name: "Agent Details" }),
    ).toBeVisible();
    await expect(page.getByText("openai")).toBeVisible();
    await page.screenshot({ path: "tests/screenshots/agent-detail.png" });
  });
});
