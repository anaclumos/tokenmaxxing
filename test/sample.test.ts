import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { probeParkedUsage } from "../src/lib/sample.ts";
import { deleteItem, parkedTarget, writeItem } from "../src/lib/credstore.ts";
import type { Account } from "../src/lib/types.ts";

const account = (): Account => ({
  accountUuid: "S",
  email: "S@e.com",
  organizationUuid: "org-S",
  label: "S",
  keychainItem: "tokenmaxxing-cred-S",
  oauthAccount: { accountUuid: "S", emailAddress: "S@e.com", organizationUuid: "org-S" },
  addedAt: new Date(0).toISOString(),
});

const blob = (org: string) =>
  JSON.stringify({ claudeAiOauth: { accessToken: `at-S|${org}`, refreshToken: "rt-S", expiresAt: Date.now() + 3_600_000 } });

let rolesMode: "down" | "mismatch" = "down";
let server: ReturnType<typeof Bun.serve> | null = null;

function startServer(): void {
  if (server) return;
  server = Bun.serve({
    port: Number(new URL(process.env.TOKENMAXXING_OAUTH_ROLES_URL!).port),
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/roles" && rolesMode === "mismatch") {
        return Response.json({ organization_uuid: "org-OTHER", organization_name: "someone else" });
      }
      return new Response("boom", { status: 500 });
    },
  });
}

afterAll(async () => {
  server?.stop(true);
  await deleteItem(parkedTarget("tokenmaxxing-cred-S"));
});

describe("parked identity check severity", () => {
  beforeEach(async () => {
    await writeItem(parkedTarget("tokenmaxxing-cred-S"), blob("org-S"));
  });

  test("an unreachable roles endpoint fails the sample WITHOUT flagging needs-reauth", async () => {
    const a = account();
    const outcome = await probeParkedUsage(a);
    expect(outcome.ok).toBe(false);
    expect(a.needsReauth).toBeUndefined();
  });

  test("an HTTP failure from the roles endpoint is also transient, not a dead credential", async () => {
    startServer();
    rolesMode = "down";
    const a = account();
    const outcome = await probeParkedUsage(a);
    expect(outcome.ok).toBe(false);
    expect(a.needsReauth).toBeUndefined();
  });

  test("a definitive org disagreement still flags needs-reauth", async () => {
    startServer();
    rolesMode = "mismatch";
    const a = account();
    const outcome = await probeParkedUsage(a);
    expect(outcome.ok).toBe(false);
    expect(a.needsReauth).toBe(true);
  });
});
