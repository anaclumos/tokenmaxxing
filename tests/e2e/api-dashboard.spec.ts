import { test, expect } from "@playwright/test";

const ORG = "org_test";

test.describe("Dashboard REST API", () => {
  test("GET /dashboard returns metrics and recent activity", async ({
    request,
  }) => {
    const res = await request.get(`/api/orgs/${ORG}/dashboard`);
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(typeof body.activeAgents).toBe("number");
    expect(body.activeAgents).toBeGreaterThanOrEqual(5);

    expect(typeof body.totalRuns).toBe("number");

    expect(typeof body.monthlySpend).toBe("number");

    expect(Array.isArray(body.recentActivity)).toBe(true);
    expect(body.recentActivity.length).toBeGreaterThan(0);

    for (const row of body.recentActivity) {
      expect(row).toMatchObject({
        id: expect.anything(),
        action: expect.any(String),
        actorType: expect.any(String),
        resourceType: expect.any(String),
      });
    }
  });
});
