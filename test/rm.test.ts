import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { cmdRm } from "../src/cli/rm.ts";
import { deleteItem, liveTarget, parkedTarget, readItem, writeItem } from "../src/lib/credstore.ts";
import { loadAccounts, saveAccounts } from "../src/lib/state.ts";
import type { Account } from "../src/lib/types.ts";

const account = (id: string): Account => ({
  accountUuid: id,
  email: `${id}@e.com`,
  organizationUuid: `org-${id}`,
  label: id,
  keychainItem: `tokenmaxxing-cred-${id}`,
  oauthAccount: { accountUuid: id, emailAddress: `${id}@e.com`, organizationUuid: `org-${id}` },
  addedAt: new Date(0).toISOString(),
});

const blob = (id: string) =>
  JSON.stringify({ claudeAiOauth: { accessToken: `at-${id}|org-${id}`, refreshToken: `rt-${id}`, expiresAt: Date.now() + 3_600_000 } });

let server: ReturnType<typeof Bun.serve> | null = null;

function startServer(): void {
  if (server) return;
  server = Bun.serve({
    port: Number(new URL(process.env.TOKENMAXXING_OAUTH_ROLES_URL!).port),
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/roles") {
        const bearer = req.headers.get("authorization") ?? "";
        const org = bearer.split("|")[1] ?? "org-unknown";
        return Response.json({ organization_uuid: org, organization_name: `${org} name` });
      }
      return new Response("not found", { status: 404 });
    },
  });
}

async function clearItems(): Promise<void> {
  await deleteItem(liveTarget());
  await deleteItem(parkedTarget("tokenmaxxing-cred-B"));
}

afterAll(async () => {
  server?.stop(true);
  await clearItems();
});

describe("rm live-identity guard", () => {
  beforeEach(async () => {
    await clearItems();
    await writeItem(parkedTarget("tokenmaxxing-cred-B"), blob("B"));
    saveAccounts({ version: 1, activeAccountUuid: "A", accounts: [account("A"), account("B")] });
  });

  test("an unreachable roles endpoint refuses the removal (fail closed)", async () => {
    await writeItem(liveTarget(), blob("B"));
    expect(await cmdRm("B")).toBe(1);
    expect(loadAccounts().accounts.map((a) => a.accountUuid)).toEqual(["A", "B"]);
    expect(await readItem(parkedTarget("tokenmaxxing-cred-B"))).not.toBeNull();
  });

  test("a drifted label does not fool the guard: the live token names the target", async () => {
    startServer();
    await writeItem(liveTarget(), blob("B"));
    expect(await cmdRm("B")).toBe(1);
    expect(loadAccounts().accounts.map((a) => a.accountUuid)).toEqual(["A", "B"]);
  });

  test("a verified non-live account is removed along with its parked credential", async () => {
    startServer();
    await writeItem(liveTarget(), blob("A"));
    expect(await cmdRm("B")).toBe(0);
    expect(loadAccounts().accounts.map((a) => a.accountUuid)).toEqual(["A"]);
    expect(await readItem(parkedTarget("tokenmaxxing-cred-B"))).toBeNull();
  });

  test("no live credential at all means nothing can be live: removal proceeds", async () => {
    expect(await cmdRm("B")).toBe(0);
    expect(loadAccounts().accounts.map((a) => a.accountUuid)).toEqual(["A"]);
  });

  test("an unparsable live blob refuses via the same controlled path, not a crash", async () => {
    await writeItem(liveTarget(), "not json at all");
    expect(await cmdRm("B")).toBe(1);
    expect(loadAccounts().accounts.map((a) => a.accountUuid)).toEqual(["A", "B"]);
    expect(await readItem(parkedTarget("tokenmaxxing-cred-B"))).not.toBeNull();
  });
});
