import { test, expect } from "@playwright/test";

const ORG = "org_test";
const CEO_ID = "00000000-0000-7000-8000-000000000001";

test.describe("Routines REST API", () => {
  test("GET /routines returns routines with required fields", async ({
    request,
  }) => {
    const res = await request.get(`/api/orgs/${ORG}/routines`);
    expect(res.status()).toBe(200);
    const routines = await res.json();
    expect(Array.isArray(routines)).toBe(true);
    expect(routines.length).toBeGreaterThanOrEqual(2);
    for (const r of routines) {
      expect(r).toMatchObject({
        id: expect.anything(),
        name: expect.any(String),
        orgId: ORG,
        agentId: expect.anything(),
        status: expect.any(String),
      });
    }
  });

  test("POST /routines creates routine (201)", async ({ request }) => {
    const res = await request.post(`/api/orgs/${ORG}/routines`, {
      data: {
        name: "Test routine",
        agentId: CEO_ID,
        triggers: [{ cronExpression: "0 * * * *" }],
      },
    });
    expect(res.status()).toBe(201);
    const routine = await res.json();
    expect(routine.name).toBe("Test routine");
    expect(routine.agentId).toBe(CEO_ID);
    expect(routine.orgId).toBe(ORG);
  });

  test("POST /routines without name returns 400", async ({ request }) => {
    const res = await request.post(`/api/orgs/${ORG}/routines`, {
      data: {
        agentId: CEO_ID,
        triggers: [{ cronExpression: "0 * * * *" }],
      },
    });
    expect(res.status()).toBe(400);
  });

  test("POST /routines without agentId returns 400", async ({ request }) => {
    const res = await request.post(`/api/orgs/${ORG}/routines`, {
      data: {
        name: "No agent",
        triggers: [{ cronExpression: "0 * * * *" }],
      },
    });
    expect(res.status()).toBe(400);
  });
});
