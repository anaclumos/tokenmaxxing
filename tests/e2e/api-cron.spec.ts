import { test, expect } from "@playwright/test";

test.describe("Cron REST API", () => {
  test("GET /api/cron/tick without Authorization returns 401", async ({
    request,
  }) => {
    const res = await request.get("/api/cron/tick");
    expect(res.status()).toBe(401);
  });

  test("GET /api/cron/tick with wrong Bearer token returns 401", async ({
    request,
  }) => {
    const res = await request.get("/api/cron/tick", {
      headers: { Authorization: "Bearer wrong-secret-token" },
    });
    expect(res.status()).toBe(401);
  });

  test("GET /api/cron/reaper without Authorization returns 401", async ({
    request,
  }) => {
    const res = await request.get("/api/cron/reaper");
    expect(res.status()).toBe(401);
  });

  test("GET /api/cron/reaper with wrong Bearer token returns 401", async ({
    request,
  }) => {
    const res = await request.get("/api/cron/reaper", {
      headers: { Authorization: "Bearer definitely-not-cron-secret" },
    });
    expect(res.status()).toBe(401);
  });
});
