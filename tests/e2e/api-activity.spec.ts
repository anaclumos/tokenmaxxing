import { test, expect } from "@playwright/test";

const ORG = "org_test";

test.describe("Activity REST API", () => {
  test("GET /activity returns log entries", async ({ request }) => {
    const res = await request.get(`/api/orgs/${ORG}/activity`);
    expect(res.status()).toBe(200);
    const rows = await res.json();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const row of rows) {
      expect(row).toMatchObject({
        actorType: expect.any(String),
        actorId: expect.any(String),
        action: expect.any(String),
        resourceType: expect.any(String),
        resourceId: expect.any(String),
      });
    }
  });

  test("GET /activity?resourceType=agent filters", async ({ request }) => {
    const allRes = await request.get(`/api/orgs/${ORG}/activity`);
    expect(allRes.status()).toBe(200);
    const all = await allRes.json();

    const res = await request.get(
      `/api/orgs/${ORG}/activity?resourceType=agent`,
    );
    expect(res.status()).toBe(200);
    const rows = await res.json();
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const row of rows) {
      expect(row.resourceType).toBe("agent");
    }
    expect(rows.length).toBeLessThanOrEqual(all.length);
  });

  test("GET /activity?actorType=board filters", async ({ request }) => {
    const allRes = await request.get(`/api/orgs/${ORG}/activity`);
    expect(allRes.status()).toBe(200);
    const all = await allRes.json();

    const res = await request.get(
      `/api/orgs/${ORG}/activity?actorType=board`,
    );
    expect(res.status()).toBe(200);
    const rows = await res.json();
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const row of rows) {
      expect(row.actorType).toBe("board");
    }
    expect(rows.length).toBeLessThanOrEqual(all.length);
  });
});
