import { chmodSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { POST_SWAP_COOLDOWN_MS, checkDelayMs, evaluateAndMaybeSwap, postSwapProof, recordEnforcedLimit } from "../src/lib/decide.ts";
import { paths } from "../src/lib/paths.ts";
import { loadAccounts, loadModelUsage, loadUsage, saveAccounts, saveLastSwapAt, saveModelUsage } from "../src/lib/state.ts";
import { deleteItem, liveTarget, parkedTarget, writeItem } from "../src/lib/credstore.ts";
import type { Account } from "../src/lib/types.ts";

const D = 86_400_000;
const H = 3_600_000;
const fakeClaude = join(paths.home, "fake-claude-enforced");
const probeMarker = join(paths.home, "probe-ran-enforced");

function usageClock(epochMs: number): string {
  const d = new Date(epochMs);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const h24 = d.getUTCHours();
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${h}:${mm}${h24 >= 12 ? "pm" : "am"} (UTC)`;
}

function installFakeClaude(fablePct: number, resetAt: number): void {
  const text = [
    "You are currently using your subscription to power your Claude Code usage",
    "",
    `Current session: 22% used · resets ${usageClock(resetAt)}`,
    `Current week (all models): 30% used · resets ${usageClock(resetAt)}`,
    `Current week (Fable): ${fablePct}% used · resets ${usageClock(resetAt)}`,
  ].join("\n");
  writeFileSync(fakeClaude, `#!/bin/sh\ntouch ${JSON.stringify(probeMarker)}\nprintf '%s' ${JSON.stringify(JSON.stringify({ result: text }))}\n`);
  chmodSync(fakeClaude, 0o755);
}

function poolAccount(uuid: string, over: Partial<Account> = {}): Account {
  return {
    accountUuid: uuid,
    email: `${uuid}@e.com`,
    organizationUuid: `org-${uuid}`,
    label: uuid,
    keychainItem: `tokenmaxxing-cred-${uuid}`,
    oauthAccount: { accountUuid: uuid, emailAddress: `${uuid}@e.com`, organizationUuid: `org-${uuid}` },
    addedAt: new Date(0).toISOString(),
    ...over,
  };
}

function installFixtures(extraAccounts: Account[] = [], thresholds = { session: 95, weekly: 98 }): void {
  writeFileSync(paths.configJson, JSON.stringify({ thresholds, claudeBin: fakeClaude, policy: { switchModels: ["fable"] } }));
  writeFileSync(paths.claudeJson, JSON.stringify({ oauthAccount: { accountUuid: "A", emailAddress: "A@e.com", organizationUuid: "org-A" } }));
  saveAccounts({ version: 1, activeAccountUuid: "A", accounts: [poolAccount("A"), ...extraAccounts] });
}

function clearState(): void {
  for (const f of [paths.usageJson, paths.modelUsageJson, paths.lastSwapJson, paths.accountsJson, paths.configJson, paths.claudeJson, paths.depletedJson, paths.nextCheckJson, probeMarker, fakeClaude]) {
    rmSync(f, { force: true });
  }
}

function writeUsageJson(over: Record<string, unknown>, ageMs = 0): void {
  writeFileSync(
    paths.usageJson,
    JSON.stringify({
      fiveHour: { usedPercentage: 10, resetsAt: Date.now() + 2 * H },
      sevenDay: { usedPercentage: 20, resetsAt: Date.now() + 2 * D },
      org: "org-A",
      ts: Date.now() - ageMs,
      model: { id: "claude-fable-5", display: "Fable 5" },
      ...over,
    }),
  );
  if (ageMs > 0) {
    const then = new Date(Date.now() - ageMs);
    utimesSync(paths.usageJson, then, then);
  }
}

const at = (id: string) => `at-${id}|org-${id}`;
const creds = (id: string) => ({ accessToken: at(id), refreshToken: `rt-${id}`, expiresAt: Date.now() + H });

function oauthServer() {
  return Bun.serve({
    port: Number(new URL(process.env.TOKENMAXXING_OAUTH_ROLES_URL!).port),
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/token") {
        const body = await req.json();
        const rt = body != null && body instanceof Object && "refresh_token" in body ? String(body.refresh_token) : "";
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
}

describe("postSwapProof", () => {
  const now = 1_784_400_000_000;
  test("no swap ever: proven", () => {
    expect(postSwapProof({ swapAt: null, launchedAt: null, turnStartTs: null, now })).toBe(true);
  });
  test("a process launched after the swap is proven, whatever the turn anchor says", () => {
    expect(postSwapProof({ swapAt: now - 10_000, launchedAt: now - 5_000, turnStartTs: now - 60_000, now })).toBe(true);
  });
  test("an older process needs its turn to start after the swap plus the adoption cooldown", () => {
    expect(postSwapProof({ swapAt: now - 100_000, launchedAt: now - 200_000, turnStartTs: now - 100_000 + POST_SWAP_COOLDOWN_MS + 1, now })).toBe(true);
    expect(postSwapProof({ swapAt: now - 100_000, launchedAt: now - 200_000, turnStartTs: now - 100_000 + POST_SWAP_COOLDOWN_MS - 1, now })).toBe(false);
    expect(postSwapProof({ swapAt: now - 10_000, launchedAt: null, turnStartTs: now - 60_000, now })).toBe(false);
  });
  test("with no anchor at all the cooldown alone decides", () => {
    expect(postSwapProof({ swapAt: now - POST_SWAP_COOLDOWN_MS + 1, launchedAt: null, turnStartTs: null, now })).toBe(false);
    expect(postSwapProof({ swapAt: now - POST_SWAP_COOLDOWN_MS, launchedAt: null, turnStartTs: null, now })).toBe(true);
  });
});

describe("recordEnforcedLimit", () => {
  beforeEach(clearState);
  afterAll(clearState);

  test("a model cap stamps 100 under the family key with the account's weekly reset and dates the file now", async () => {
    installFixtures();
    const weeklyReset = Date.now() + 2 * D;
    writeUsageJson({ sevenDay: { usedPercentage: 20, resetsAt: weeklyReset } });
    saveModelUsage({ perModel: { Fable: { usedPercentage: 91, resetsAt: null } }, org: "org-A", ts: Date.now() - 10 * 60_000, sampledAt: Date.now() - 10 * 60_000 });
    const now = Date.now();
    expect(await recordEnforcedLimit({ limit: { kind: "model", family: "fable", resetsAt: null }, org: "org-A", now })).toBe("stamped");
    const mu = loadModelUsage();
    expect(mu?.perModel["fable"]).toEqual({ usedPercentage: 100, resetsAt: weeklyReset });
    expect(mu?.perModel["Fable"]?.usedPercentage).toBe(91);
    expect(mu?.ts).toBe(now);
    expect(loadUsage()?.fiveHour.usedPercentage).toBe(10);
  });

  test("a session limit stamps the 5h window with the server's reset, carries the weekly window, and bumps the probe stamp", async () => {
    installFixtures();
    writeUsageJson({});
    const now = Date.now();
    const resetsAt = now + 30 * 60_000;
    expect(await recordEnforcedLimit({ limit: { kind: "session", resetsAt }, org: "org-A", now })).toBe("stamped");
    const u = loadUsage();
    expect(u?.fiveHour).toEqual({ usedPercentage: 100, resetsAt });
    expect(u?.sevenDay.usedPercentage).toBe(20);
    expect(u?.model?.id).toBe("claude-fable-5");
    expect(loadModelUsage()?.ts).toBe(now);
  });

  test("without a tee the account's dated lastUsage carries the other window; with nothing there is no stamp", async () => {
    installFixtures();
    const now = Date.now();
    expect(await recordEnforcedLimit({ limit: { kind: "weekly", resetsAt: now + 3 * D }, org: "org-A", now })).toBe("no-carrier");
    expect(loadUsage()).toBeNull();
    const idx = loadAccounts();
    idx.accounts[0]!.lastUsage = { fiveHour: { usedPercentage: 33, resetsAt: now + H }, sevenDay: { usedPercentage: 44, resetsAt: now + 3 * D } };
    saveAccounts(idx);
    expect(await recordEnforcedLimit({ limit: { kind: "weekly", resetsAt: now + 3 * D }, org: "org-A", now })).toBe("stamped");
    expect(loadUsage()?.sevenDay).toEqual({ usedPercentage: 100, resetsAt: now + 3 * D });
    expect(loadUsage()?.fiveHour.usedPercentage).toBe(33);
  });

  test("never stamps once the live org has moved", async () => {
    installFixtures();
    writeUsageJson({});
    writeFileSync(paths.claudeJson, JSON.stringify({ oauthAccount: { accountUuid: "B", emailAddress: "B@e.com", organizationUuid: "org-B" } }));
    expect(await recordEnforcedLimit({ limit: { kind: "session", resetsAt: null }, org: "org-A", now: Date.now() })).toBe("org-moved");
    expect(loadUsage()?.fiveHour.usedPercentage).toBe(10);
  });
});

describe("evaluateAndMaybeSwap with an enforced limit", () => {
  beforeEach(clearState);
  afterAll(clearState);

  test("forces the hard path past a healthy-looking cache and clamps the seat's recovery to the enforced reset", async () => {
    const now = Date.now();
    installFakeClaude(50, now + 2 * D);
    installFixtures();
    writeUsageJson({});
    const resetsAt = now + 30 * 60_000;
    const d = await evaluateAndMaybeSwap(now, true, { org: "org-A", family: null, resetsAt, windowMs: 5 * H });
    expect(d.reason).toBe("depleted-wait");
    expect(d.account?.accountUuid).toBe("A");
    expect(d.waitUntil).toBe(resetsAt);
  });

  test("bypasses the post-swap cooldown, gates candidates by the enforced family, and refuses to hold the seat", async () => {
    const now = Date.now();
    installFakeClaude(50, now + 2 * D);
    installFixtures([
      poolAccount("B", {
        lastUsage: { fiveHour: { usedPercentage: 5, resetsAt: null }, sevenDay: { usedPercentage: 30, resetsAt: now + 3 * D } },
        lastPerModel: { Fable: { usedPercentage: 100, resetsAt: now + 3 * D } },
        lastUsageAt: now,
        lastPerModelAt: now,
      }),
    ]);
    writeUsageJson({ model: { id: "claude-sonnet-5", display: "Sonnet 5" } });
    saveLastSwapAt(now - 1_000);
    const d = await evaluateAndMaybeSwap(now, false, { org: "org-A", family: "fable", resetsAt: null, windowMs: 7 * D });
    expect(d.reason).toBe("all-depleted");
    expect(d.swapped).toBe(false);
    expect(loadAccounts().activeAccountUuid).toBe("A");
  });

  test("is ignored when it names an org that is no longer live", async () => {
    const now = Date.now();
    installFakeClaude(50, now + 2 * D);
    installFixtures();
    writeUsageJson({});
    const d = await evaluateAndMaybeSwap(now, false, { org: "org-Z", family: "fable", resetsAt: null, windowMs: 7 * D });
    expect(d.reason).toBe("under-threshold-or-stale");
  });

  test("swaps away from the refused seat onto a family-safe account", async () => {
    const now = Date.now();
    const server = oauthServer();
    try {
      installFakeClaude(50, now + 2 * D);
      installFixtures([
        poolAccount("B", {
          lastUsage: { fiveHour: { usedPercentage: 5, resetsAt: null }, sevenDay: { usedPercentage: 30, resetsAt: now + 3 * D } },
          lastPerModel: { Fable: { usedPercentage: 20, resetsAt: now + 3 * D } },
          lastUsageAt: now,
          lastPerModelAt: now,
        }),
      ]);
      writeUsageJson({});
      await writeItem(liveTarget(), JSON.stringify({ claudeAiOauth: creds("A") }));
      await writeItem(parkedTarget("tokenmaxxing-cred-B"), JSON.stringify({ claudeAiOauth: creds("B") }));
      const d = await evaluateAndMaybeSwap(now, true, { org: "org-A", family: "fable", resetsAt: null, windowMs: 7 * D });
      expect(d.swapped).toBe(true);
      expect(d.account?.accountUuid).toBe("B");
      expect(loadAccounts().activeAccountUuid).toBe("B");
    } finally {
      server.stop(true);
      await deleteItem(parkedTarget("tokenmaxxing-cred-A"));
      await deleteItem(parkedTarget("tokenmaxxing-cred-B"));
      await deleteItem(liveTarget());
    }
  });
});

describe("checkDelayMs", () => {
  beforeEach(clearState);
  afterAll(clearState);
  const cfg = () => ({
    thresholds: { session: 95, weekly: 98 },
    hardThresholds: { session: 100, weekly: 100 },
    claudeBin: "",
    codexBin: "",
    policy: { projectionMargin: 0, greedySessionFloor: 50, switchModels: ["fable"], usagePollTtlMs: 90_000, maxWaitMs: 3_600_000 },
  });
  const decision = { swapped: false, account: null, reason: "under-threshold-or-stale" };

  test("ample headroom sleeps five minutes; a bar in reach drops to the floor", () => {
    const now = Date.now();
    writeUsageJson({});
    saveModelUsage({ perModel: { Fable: { usedPercentage: 50, resetsAt: now + 2 * D } }, org: "org-A", ts: now, sampledAt: now });
    expect(checkDelayMs({ cfg: cfg(), org: "org-A", now, decision })).toBe(300_000);
    saveModelUsage({ perModel: { Fable: { usedPercentage: 75, resetsAt: now + 2 * D } }, org: "org-A", ts: now, sampledAt: now });
    expect(checkDelayMs({ cfg: cfg(), org: "org-A", now, decision })).toBe(180_000);
    writeUsageJson({ fiveHour: { usedPercentage: 85, resetsAt: now + H } });
    expect(checkDelayMs({ cfg: cfg(), org: "org-A", now, decision })).toBe(120_000);
    writeUsageJson({ fiveHour: { usedPercentage: 92, resetsAt: now + H } });
    expect(checkDelayMs({ cfg: cfg(), org: "org-A", now, decision })).toBe(60_000);
  });

  test("unmeasured never buys the slow lane: a stale tee, a foreign org, or a missing gated cap", () => {
    const now = Date.now();
    writeUsageJson({}, 10 * 60_000);
    expect(checkDelayMs({ cfg: cfg(), org: "org-A", now, decision })).toBe(180_000);
    writeUsageJson({});
    expect(checkDelayMs({ cfg: cfg(), org: "org-B", now, decision })).toBe(180_000);
    expect(checkDelayMs({ cfg: cfg(), org: "org-A", now, decision })).toBe(120_000);
    saveModelUsage({ perModel: {}, org: "org-A", ts: now, sampledAt: now });
    expect(checkDelayMs({ cfg: cfg(), org: "org-A", now, decision })).toBe(120_000);
  });

  test("a depleted wait sleeps toward its reset within the floor and ceiling", () => {
    const now = Date.now();
    expect(checkDelayMs({ cfg: cfg(), org: "org-A", now, decision: { ...decision, waitUntil: now + 10 * 60_000 } })).toBe(300_000);
    expect(checkDelayMs({ cfg: cfg(), org: "org-A", now, decision: { ...decision, waitUntil: now + 90_000 } })).toBe(90_000);
    expect(checkDelayMs({ cfg: cfg(), org: "org-A", now, decision: { ...decision, waitUntil: now - 1 } })).toBe(60_000);
  });
});
