import { test, expect } from "@playwright/test";

const SEED_AGENTS = [
  {
    id: "00000000-0000-7000-8000-000000000001",
    name: "CEO",
    title: "Chief Executive Officer",
    role: "executive",
    providerModel: "openai/gpt-5.4",
  },
  {
    id: "00000000-0000-7000-8000-000000000002",
    name: "CTO",
    title: "Chief Technology Officer",
    role: "executive",
    providerModel: "anthropic/claude-sonnet-4.6",
  },
  {
    id: "00000000-0000-7000-8000-000000000003",
    name: "Frontend Engineer",
    title: "Senior Frontend Engineer",
    role: "engineer",
    providerModel: "anthropic/claude-sonnet-4.6",
  },
  {
    id: "00000000-0000-7000-8000-000000000004",
    name: "Backend Engineer",
    title: "Senior Backend Engineer",
    role: "engineer",
    providerModel: "openai/gpt-5.4",
  },
  {
    id: "00000000-0000-7000-8000-000000000005",
    name: "Designer",
    title: "Lead Product Designer",
    role: "designer",
    providerModel: "google/gemini-2.5-flash",
  },
] as const;

test.describe("Agents", () => {
  test("lists all seed agents with title, role badge, and provider/model", async ({
    page,
  }) => {
    await page.goto("/agents");

    await expect(
      page.getByRole("heading", { name: "Agents", level: 2 }),
    ).toBeVisible();

    for (const agent of SEED_AGENTS) {
      const row = page.getByRole("link", { name: new RegExp(agent.title) });
      await expect(row).toBeVisible();
      await expect(row.getByText(agent.role, { exact: true })).toBeVisible();
      await expect(row).toContainText(agent.providerModel);
    }

    await page.screenshot({
      path: "tests/screenshots/agents-list.png",
      fullPage: true,
    });
  });

  test("New Agent button opens create dialog with all form fields", async ({
    page,
  }) => {
    await page.goto("/agents");
    await page.getByRole("button", { name: "New Agent" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("heading", { name: "Create Agent" }),
    ).toBeVisible();

    await expect(dialog.getByLabel("Name", { exact: true })).toBeVisible();
    await expect(dialog.getByLabel("Shortname", { exact: true })).toBeVisible();
    await expect(dialog.getByLabel("Provider")).toBeVisible();
    await expect(dialog.getByLabel("Model")).toBeVisible();
    await expect(dialog.getByLabel("Role")).toBeVisible();
    await expect(dialog.getByLabel("Title")).toBeVisible();
    await expect(dialog.getByLabel("System Prompt")).toBeVisible();
    await expect(dialog.getByLabel("Monthly Budget (cents)")).toBeVisible();

    await page.screenshot({
      path: "tests/screenshots/agents-create-dialog.png",
      fullPage: true,
    });
  });

  test("creates a new agent and verifies it in the list", async ({ page }) => {
    const unique = Date.now();

    await page.goto("/agents");
    await page.getByRole("button", { name: "New Agent" }).click();

    await page.getByLabel("Name", { exact: true }).fill(`QA Engineer ${unique}`);
    await page.getByLabel("Shortname", { exact: true }).fill(`qa-${unique}`);
    await page.getByLabel("Provider").selectOption("openai");
    await page.getByLabel("Model").fill("gpt-4o");
    await page.getByLabel("Role").fill("engineer");
    await page.getByLabel("Title").fill(`QA Automation Engineer ${unique}`);
    await page.getByLabel("System Prompt").fill("You are a QA engineer.");
    await page.getByLabel("Monthly Budget (cents)").fill("5000");

    await page.getByRole("button", { name: "Create Agent" }).click();

    await expect(page.getByText("Agent created.")).toBeVisible();
    await expect(
      page.getByText(`QA Automation Engineer ${unique}`),
    ).toBeVisible();

    await page.screenshot({
      path: "tests/screenshots/agents-after-create.png",
      fullPage: true,
    });
  });

  test("views agent detail page with profile and stats", async ({ page }) => {
    const ceo = SEED_AGENTS[0];

    await page.goto(`/agents/${ceo.id}`);

    await expect(
      page.getByRole("heading", { name: ceo.title, level: 2 }),
    ).toBeVisible();
    await expect(page.getByText("active", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Profile")).toBeVisible();
    await expect(page.getByText(ceo.name, { exact: true }).first()).toBeVisible();
    await expect(
      page.getByText(ceo.providerModel, { exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByText("$500/mo")).toBeVisible();
    await expect(page.getByText("Stats")).toBeVisible();
    await expect(page.getByText(`@${ceo.name.toLowerCase()}`)).toBeVisible();
    await expect(page.getByText("Assigned Routines")).toBeVisible();

    await page.screenshot({
      path: "tests/screenshots/agent-detail-ceo.png",
      fullPage: true,
    });
  });

  test("clicking agent in list navigates to detail page", async ({ page }) => {
    await page.goto("/agents");

    await page
      .getByRole("link", { name: new RegExp(SEED_AGENTS[0].title) })
      .click();

    await expect(page).toHaveURL(new RegExp(`/agents/${SEED_AGENTS[0].id}`));
    await expect(
      page.getByRole("heading", { name: SEED_AGENTS[0].title, level: 2 }),
    ).toBeVisible();

    await page.screenshot({
      path: "tests/screenshots/agents-navigate-to-detail.png",
      fullPage: true,
    });
  });
});
