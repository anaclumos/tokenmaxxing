import { test, expect } from "@playwright/test";

const ORG = "org_test";
const BASE = "http://localhost:3000";

test.describe("SSE events REST API", () => {
  test("GET /api/events/{org} streams connected event with headers", async () => {
    const res = await fetch(`${BASE}/api/events/${ORG}`);
    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toMatch(/no-cache/i);

    const reader = res.body!.getReader();
    let raw = "";
    const decoder = new TextDecoder();

    while (!raw.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
    }

    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }

    const line = raw
      .split("\n")
      .find((l) => l.startsWith("data: "));
    expect(line).toBeTruthy();
    const json = JSON.parse(line!.slice("data: ".length));
    expect(json).toMatchObject({
      type: "connected",
      orgId: ORG,
    });
  });
});
