// cmdRm's live-identity guard (iteration-3 review, hardened by PR #31 review):
// rm fails CLOSED - removal proceeds only when the LIVE credential verifiably
// belongs to some OTHER account; a drifted label or an unverifiable live owner
// refuses, because deleting the live account's parked backup destroys its only
// copy while inference keeps using the live store.

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

// mirrors swap.test's convention: the bearer encodes the org after "|".
const blob = (id: string) =>
  JSON.stringify({ claudeAiOauth: { accessToken: `at-${id}|org-${id}`, refreshToken: `rt-${id}`, expiresAt: Date.now() + 3_600_000 } });

let server: ReturnType<typeof Bun.serve> | null = null;

function startServer(): void {
  server = Bun.serve({
    port: 8791,
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
    // no server bound yet: the live owner cannot be verified, so rm must not
    // trust the stale active label and delete a possibly-live account's backup.
    await writeItem(liveTarget(), blob("B"));
    expect(await cmdRm("B")).toBe(1);
    expect(loadAccounts().accounts.map((a) => a.accountUuid)).toEqual(["A", "B"]);
    expect(await readItem(parkedTarget("tokenmaxxing-cred-B"))).not.toBeNull();
  });

  test("a drifted label does not fool the guard: the live token names the target", async () => {
    startServer();
    // the label says A is active, but a manual /login made B live.
    await writeItem(liveTarget(), blob("B"));
    expect(await cmdRm("B")).toBe(1);
    expect(loadAccounts().accounts.map((a) => a.accountUuid)).toEqual(["A", "B"]);
  });

  test("a verified non-live account is removed along with its parked credential", async () => {
    await writeItem(liveTarget(), blob("A"));
    expect(await cmdRm("B")).toBe(0);
    expect(loadAccounts().accounts.map((a) => a.accountUuid)).toEqual(["A"]);
    expect(await readItem(parkedTarget("tokenmaxxing-cred-B"))).toBeNull();
  });

  test("no live credential at all means nothing can be live: removal proceeds", async () => {
    expect(await cmdRm("B")).toBe(0);
    expect(loadAccounts().accounts.map((a) => a.accountUuid)).toEqual(["A"]);
  });
});
