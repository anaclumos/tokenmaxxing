import { test, expect } from "@playwright/test";

test.describe("Settings - API Keys", () => {
  test("loads with BYOK copy, provider forms, password fields, Save, and Not configured", async ({
    page,
  }) => {
    await page.goto("/settings/keys");

    await expect(
      page.getByRole("heading", { name: "API Keys", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(/Bring your own LLM provider keys.*encrypt them at rest/s),
    ).toBeVisible();
    await expect(
      page.getByText("Not configured", { exact: true }),
    ).toHaveCount(3);

    await expect(page.getByLabel("OpenAI API key")).toBeVisible();
    await expect(page.getByLabel("Anthropic API key")).toBeVisible();
    await expect(page.getByLabel("Google AI API key")).toBeVisible();

    await expect(page.getByLabel("OpenAI API key")).toHaveAttribute(
      "type",
      "password",
    );
    await expect(page.getByLabel("Anthropic API key")).toHaveAttribute(
      "type",
      "password",
    );
    await expect(page.getByLabel("Google AI API key")).toHaveAttribute(
      "type",
      "password",
    );

    await expect(
      page.locator("form").getByRole("button", { name: "Save" }),
    ).toHaveCount(3);

    await page.screenshot({
      path: "tests/screenshots/settings-keys-initial-state.png",
    });
  });

  test("accepts a key value and shows Configured after save", async ({
    page,
  }) => {
    await page.goto("/settings/keys");

    const openaiKey = "sk-test01234567890123456789012345678901234567890";
    await page.getByLabel("OpenAI API key").fill(openaiKey);
    await expect(page.getByLabel("OpenAI API key")).toHaveValue(openaiKey);

    await page
      .locator("form")
      .filter({ has: page.getByLabel("OpenAI API key") })
      .getByRole("button", { name: "Save" })
      .click();

    await expect(page.getByText("OpenAI key saved.")).toBeVisible();

    const openaiSection = page.locator("div.space-y-2").filter({
      has: page.getByText("OpenAI", { exact: true }),
    });
    await expect(
      openaiSection.getByText("Configured", { exact: true }),
    ).toBeVisible();

    await page.screenshot({
      path: "tests/screenshots/settings-keys-openai-configured.png",
    });
  });
});
