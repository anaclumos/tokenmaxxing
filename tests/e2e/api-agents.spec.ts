import { test, expect } from "@playwright/test";

const ORG = "org_test";
const CEO_ID = "00000000-0000-7000-8000-000000000001";
const NON_EXISTENT_AGENT = "00000000-0000-7000-8000-999999999999";

test.describe("Agents REST API", () => {
  test("GET /agents returns 200 with at least five agents", async ({
    request,
  }) => {
    const res = await request.get(`/api/orgs/${ORG}/agents`);
    expect(res.status()).toBe(200);
    const agents = await res.json();
    expect(Array.isArray(agents)).toBe(true);
    expect(agents.length).toBeGreaterThanOrEqual(5);
  });

  test("GET /agents?status=active returns only active agents", async ({
    request,
  }) => {
    const res = await request.get(`/api/orgs/${ORG}/agents?status=active`);
    expect(res.status()).toBe(200);
    const agents = await res.json();
    expect(Array.isArray(agents)).toBe(true);
    expect(agents.length).toBeGreaterThanOrEqual(5);
    for (const a of agents) {
      expect(a.status).toBe("active");
    }
  });

  test.describe.serial("mutations", () => {
    let createdAgentId: string;

    test("POST /agents with valid body creates agent (201)", async ({
      request,
    }) => {
      const res = await request.post(`/api/orgs/${ORG}/agents`, {
        data: {
          name: "Test Bot",
          shortname: "testbot",
          model: "gpt-4o",
          provider: "openai",
          role: "tester",
          title: "QA Bot",
        },
      });
      expect(res.status()).toBe(201);
      const agent = await res.json();
      expect(agent.id).toBeTruthy();
      expect(agent.name).toBe("Test Bot");
      createdAgentId = agent.id;
    });

    test("DELETE /agents/{id} archives the created agent", async ({
      request,
    }) => {
      const res = await request.delete(
        `/api/orgs/${ORG}/agents/${createdAgentId}`,
      );
      expect(res.status()).toBe(200);
      const agent = await res.json();
      expect(agent.status).toBe("archived");
    });
  });

  test("POST /agents with empty name returns 400", async ({ request }) => {
    const res = await request.post(`/api/orgs/${ORG}/agents`, {
      data: {
        name: "",
        shortname: "bad",
        model: "gpt-4o",
        provider: "openai",
        role: "tester",
        title: "Bad",
      },
    });
    expect(res.status()).toBe(400);
  });

  test("GET /agents/{ceoId} returns expected fields", async ({ request }) => {
    const res = await request.get(`/api/orgs/${ORG}/agents/${CEO_ID}`);
    expect(res.status()).toBe(200);
    const agent = await res.json();
    expect(agent).toMatchObject({
      name: "CEO",
      provider: "openai",
      model: "gpt-5.4",
      role: "executive",
      title: "Chief Executive Officer",
      status: "active",
    });
  });

  test("PATCH /agents/{ceoId} updates name then restores seed", async ({
    request,
  }) => {
    const patchRes = await request.patch(`/api/orgs/${ORG}/agents/${CEO_ID}`, {
      data: { name: "Updated CEO" },
    });
    expect(patchRes.status()).toBe(200);
    const updated = await patchRes.json();
    expect(updated.name).toBe("Updated CEO");

    const restoreRes = await request.patch(`/api/orgs/${ORG}/agents/${CEO_ID}`, {
      data: { name: "CEO" },
    });
    expect(restoreRes.status()).toBe(200);
    const restored = await restoreRes.json();
    expect(restored.name).toBe("CEO");
  });

  test("GET /agents/{nonExistentUUID} returns 404", async ({ request }) => {
    const res = await request.get(
      `/api/orgs/${ORG}/agents/${NON_EXISTENT_AGENT}`,
    );
    expect(res.status()).toBe(404);
  });
});
