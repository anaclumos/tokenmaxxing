import { test, expect } from "@playwright/test";

const ORG = "org_test";
const GITHUB_CATALOG_ID = "00000000-0000-7000-8000-000000000090";
const LINEAR_CATALOG_ID = "00000000-0000-7000-8000-000000000091";

test.describe("MCP catalog and installations REST API", () => {
  test("GET /mcp/catalog returns catalog entries", async ({ request }) => {
    const res = await request.get("/api/mcp/catalog");
    expect(res.status()).toBe(200);
    const entries = await res.json();
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThanOrEqual(2);

    const github = entries.find(
      (e: { id: string }) => e.id === GITHUB_CATALOG_ID,
    );
    const linear = entries.find(
      (e: { id: string }) => e.id === LINEAR_CATALOG_ID,
    );

    expect(github).toMatchObject({
      id: GITHUB_CATALOG_ID,
      name: "GitHub",
      slug: "github",
      description: expect.any(String),
      authType: "oauth",
      serverUrl: expect.stringContaining("github"),
    });

    expect(linear).toMatchObject({
      id: LINEAR_CATALOG_ID,
      name: "Linear",
      slug: "linear",
      description: expect.any(String),
      authType: expect.any(String),
      serverUrl: expect.stringContaining("linear"),
    });
  });

  test("GET /orgs/.../mcp returns installations array", async ({
    request,
  }) => {
    const res = await request.get(`/api/orgs/${ORG}/mcp`);
    expect(res.status()).toBe(200);
    const rows = await res.json();
    expect(Array.isArray(rows)).toBe(true);
  });

  test("POST /orgs/.../mcp installs from catalog (201, active)", async ({
    request,
  }) => {
    const res = await request.post(`/api/orgs/${ORG}/mcp`, {
      data: { catalogEntryId: GITHUB_CATALOG_ID },
    });
    expect(res.status()).toBe(201);
    const installation = await res.json();
    expect(installation.status).toBe("active");
    expect(installation.catalogEntryId).toBe(GITHUB_CATALOG_ID);
  });

  test("POST /orgs/.../mcp without catalogEntryId or customUrl returns 400", async ({
    request,
  }) => {
    const res = await request.post(`/api/orgs/${ORG}/mcp`, {
      data: {},
    });
    expect(res.status()).toBe(400);
  });
});
