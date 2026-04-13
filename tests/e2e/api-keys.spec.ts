import { test, expect } from "@playwright/test";

const ORG = "org_test";

test.describe("BYOK keys REST API", () => {
  test("GET /settings/keys returns masked keys only", async ({ request }) => {
    const res = await request.get(`/api/orgs/${ORG}/settings/keys`);
    expect(res.status()).toBe(200);
    const keys = await res.json();
    expect(Array.isArray(keys)).toBe(true);
    for (const row of keys) {
      expect(row).toMatchObject({
        provider: expect.any(String),
        maskedKey: "••••••••",
      });
      expect(row).not.toHaveProperty("apiKey");
    }
  });

  test.describe.serial("store and delete openai key", () => {
    test("POST /settings/keys stores key (201)", async ({ request }) => {
      const res = await request.post(`/api/orgs/${ORG}/settings/keys`, {
        data: { provider: "openai", apiKey: "sk-test-key-123" },
      });
      expect(res.status()).toBe(201);
      const body = await res.json();
      expect(body.provider).toBe("openai");
    });

    test("GET /settings/keys includes new openai row with maskedKey", async ({
      request,
    }) => {
      const res = await request.get(`/api/orgs/${ORG}/settings/keys`);
      expect(res.status()).toBe(200);
      const keys = await res.json();
      const openai = keys.find((k: { provider: string }) => k.provider === "openai");
      expect(openai).toBeTruthy();
      expect(openai.maskedKey).toBe("••••••••");
      expect(openai).not.toHaveProperty("apiKey");
    });

    test("DELETE /settings/keys removes provider", async ({ request }) => {
      const res = await request.fetch(`/api/orgs/${ORG}/settings/keys`, {
        method: "DELETE",
        data: { provider: "openai" },
      });
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ deleted: true });
    });
  });

  test("POST /settings/keys with empty provider returns 400", async ({
    request,
  }) => {
    const res = await request.post(`/api/orgs/${ORG}/settings/keys`, {
      data: { provider: "", apiKey: "sk-x" },
    });
    expect(res.status()).toBe(400);
  });

  test("POST /settings/keys with empty apiKey returns 400", async ({
    request,
  }) => {
    const res = await request.post(`/api/orgs/${ORG}/settings/keys`, {
      data: { provider: "openai", apiKey: "" },
    });
    expect(res.status()).toBe(400);
  });
});
