import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { performSwap } from "../src/lib/swap.ts";
import { InvalidGrantError } from "../src/lib/oauth.ts";
import { deleteItem, liveTarget, parkedTarget, readItem, writeItem } from "../src/lib/credstore.ts";
import { loadAccounts, loadDepletedWait, saveAccounts, saveDepletedWait } from "../src/lib/state.ts";
import { paths } from "../src/lib/paths.ts";
import { CredentialBlobSchema, type Account } from "../src/lib/types.ts";

const at = (id: string) => `at-${id}|org-${id}`;
const creds = (id: string, over: Record<string, unknown> = {}) => ({
  accessToken: at(id),
  refreshToken: `rt-${id}`,
  expiresAt: Date.now() + 3_600_000,
  ...over,
});

function poolAccount(id: string): Account {
  return {
    accountUuid: id,
    email: `${id}@e.com`,
    organizationUuid: `org-${id}`,
    label: id,
    keychainItem: `tokenmaxxing-cred-${id}`,
    oauthAccount: { accountUuid: id, emailAddress: `${id}@e.com`, organizationUuid: `org-${id}` },
    addedAt: new Date(0).toISOString(),
  };
}

let tokenCalls: string[] = [];
let onTokenCall: (() => Promise<void>) | null = null;
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: Number(new URL(process.env.TOKENMAXXING_OAUTH_ROLES_URL!).port),
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/token") {
        const body = await req.json();
        const rt = body != null && body instanceof Object && "refresh_token" in body ? String(body.refresh_token) : "";
        tokenCalls.push(rt);
        if (onTokenCall) {
          const effect = onTokenCall;
          onTokenCall = null;
          await effect();
        }
        if (rt.startsWith("DEAD")) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
        return Response.json({ access_token: `fresh-${rt}|org-${rt.split("-")[1]}`, refresh_token: `${rt}-rot`, expires_in: 3600 });
      }
      if (url.pathname === "/roles") {
        const bearer = req.headers.get("authorization") ?? "";
        const org = bearer.split("|")[1] ?? "org-unknown";
        return Response.json({ organization_uuid: org, organization_name: `${org} name` });
      }
      return new Response("not found", { status: 404 });
    },
  });
});
afterAll(() => server.stop(true));

async function clearItems(): Promise<void> {
  await deleteItem(liveTarget());
  await deleteItem(parkedTarget("tokenmaxxing-cred-A"));
  await deleteItem(parkedTarget("tokenmaxxing-cred-B"));
}

describe("performSwap owner-first ordering", () => {
  beforeEach(async () => {
    tokenCalls = [];
    onTokenCall = null;
    await clearItems();
    rmSync(paths.lastSwapJson, { force: true });
    rmSync(paths.usageJson, { force: true });
    rmSync(paths.depletedJson, { force: true });
    writeFileSync(paths.claudeJson, JSON.stringify({ oauthAccount: poolAccount("A").oauthAccount }));
    saveAccounts({ version: 1, activeAccountUuid: "A", accounts: [poolAccount("A"), poolAccount("B")] });
  });
  afterAll(clearItems);

  test("label-drifted self-swap repairs the backup without rotating or installing", async () => {
    await writeItem(liveTarget(), JSON.stringify({ claudeAiOauth: creds("B"), sibling: "keep" }));
    await writeItem(parkedTarget("tokenmaxxing-cred-B"), JSON.stringify({ claudeAiOauth: creds("B", { refreshToken: "DEAD-B-old" }) }));

    await performSwap(poolAccount("B"));

    const idx = loadAccounts();
    expect(idx.activeAccountUuid).toBe("B");
    expect(idx.accounts.find((a) => a.accountUuid === "B")?.needsReauth).toBe(false);
    expect(tokenCalls).toEqual([]);
    const parked = CredentialBlobSchema.parse(JSON.parse((await readItem(parkedTarget("tokenmaxxing-cred-B")))!));
    expect(parked.claudeAiOauth.refreshToken).toBe("rt-B");
    const live = CredentialBlobSchema.parse(JSON.parse((await readItem(liveTarget()))!));
    expect(live.claudeAiOauth.refreshToken).toBe("rt-B");
  });

  test("a normal swap still harvests the outgoing owner and installs the refreshed target", async () => {
    await writeItem(liveTarget(), JSON.stringify({ claudeAiOauth: creds("A"), sibling: "keep" }));
    await writeItem(parkedTarget("tokenmaxxing-cred-B"), JSON.stringify({ claudeAiOauth: creds("B") }));

    await performSwap(poolAccount("B"));

    expect(tokenCalls).toEqual(["rt-B"]);
    expect(loadAccounts().activeAccountUuid).toBe("B");
    const parkedA = CredentialBlobSchema.parse(JSON.parse((await readItem(parkedTarget("tokenmaxxing-cred-A")))!));
    expect(parkedA.claudeAiOauth.refreshToken).toBe("rt-A");
    const live = CredentialBlobSchema.parse(JSON.parse((await readItem(liveTarget()))!));
    expect(live.claudeAiOauth.refreshToken).toBe("rt-B-rot");
  });

  test("a live credential replaced while unlocked aborts before any harvest or install", async () => {
    await writeItem(liveTarget(), JSON.stringify({ claudeAiOauth: creds("A") }));
    await writeItem(parkedTarget("tokenmaxxing-cred-B"), JSON.stringify({ claudeAiOauth: creds("B") }));
    onTokenCall = async () => {
      await writeItem(liveTarget(), JSON.stringify({ claudeAiOauth: creds("C") }));
    };

    await expect(performSwap(poolAccount("B"))).rejects.toThrow("changed while unlocked");

    const live = CredentialBlobSchema.parse(JSON.parse((await readItem(liveTarget()))!));
    expect(live.claudeAiOauth.refreshToken).toBe("rt-C");
    expect(await readItem(parkedTarget("tokenmaxxing-cred-A"))).toBeNull();
    expect(loadAccounts().activeAccountUuid).toBe("A");
  });

  test("a completed swap clears a recorded depleted-wait (the decision moved on)", async () => {
    await writeItem(liveTarget(), JSON.stringify({ claudeAiOauth: creds("A") }));
    await writeItem(parkedTarget("tokenmaxxing-cred-B"), JSON.stringify({ claudeAiOauth: creds("B") }));
    saveDepletedWait({ waitUntil: Date.now() + 10 * 60_000, accountUuid: "A", ts: Date.now() });

    await performSwap(poolAccount("B"));

    expect(loadDepletedWait()).toBeNull();
  });

  test("a genuinely dead parked target still throws and flags needs-reauth", async () => {
    await writeItem(liveTarget(), JSON.stringify({ claudeAiOauth: creds("A") }));
    await writeItem(parkedTarget("tokenmaxxing-cred-B"), JSON.stringify({ claudeAiOauth: creds("B", { refreshToken: "DEAD-B" }) }));

    await expect(performSwap(poolAccount("B"))).rejects.toBeInstanceOf(InvalidGrantError);
    expect(loadAccounts().accounts.find((a) => a.accountUuid === "B")?.needsReauth).toBe(true);
  });
});
