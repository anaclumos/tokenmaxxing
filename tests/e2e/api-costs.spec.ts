import { test, expect } from "@playwright/test";

const ORG = "org_test";
const CEO_ID = "00000000-0000-7000-8000-000000000001";

test.describe("Costs REST API", () => {
  test("GET /costs returns events and summary", async ({ request }) => {
    const res = await request.get(`/api/orgs/${ORG}/costs`);
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBeGreaterThanOrEqual(5);

    for (const e of body.events) {
      expect(e).toMatchObject({
        provider: expect.any(String),
        model: expect.any(String),
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
        estimatedCost: expect.anything(),
      });
    }

    expect(body.summary).toMatchObject({
      totalCost: expect.any(Number),
      totalInputTokens: expect.any(Number),
      totalOutputTokens: expect.any(Number),
    });
  });

  test("GET /costs?agentId filters to that agent", async ({ request }) => {
    const allRes = await request.get(`/api/orgs/${ORG}/costs`);
    expect(allRes.status()).toBe(200);
    const all = await allRes.json();

    const filteredRes = await request.get(
      `/api/orgs/${ORG}/costs?agentId=${CEO_ID}`,
    );
    expect(filteredRes.status()).toBe(200);
    const filtered = await filteredRes.json();

    expect(filtered.events.length).toBeLessThanOrEqual(all.events.length);
    expect(filtered.events).toHaveLength(1);
    for (const e of filtered.events) {
      expect(e.agentId).toBe(CEO_ID);
    }
  });
});
