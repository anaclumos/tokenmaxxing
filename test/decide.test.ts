import { chmodSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { evaluateAndMaybeSwap } from "../src/lib/decide.ts";
import { paths } from "../src/lib/paths.ts";
import { loadAccounts, loadDepletedWait, loadModelUsage, loadUsage, saveAccounts, saveDepletedWait, saveLastSwapAt } from "../src/lib/state.ts";
import { writeItem, parkedTarget, liveTarget, deleteItem } from "../src/lib/credstore.ts";
import type { Account } from "../src/lib/types.ts";

const D = 86_400_000;
const fakeClaude = join(paths.home, "fake-claude");
const probeMarker = join(paths.home, "probe-ran");

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
    `Current week (all models): 72% used · resets ${usageClock(resetAt)}`,
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

function installFixtures(extraAccounts: Account[] = [], thresholds = { session: 95, weekly: 95 }): void {
  writeFileSync(
    paths.configJson,
    JSON.stringify({ thresholds, claudeBin: fakeClaude, policy: { switchModels: ["fable"] } }),
  );
  writeFileSync(
    paths.claudeJson,
    JSON.stringify({ oauthAccount: { accountUuid: "A", emailAddress: "A@e.com", organizationUuid: "org-A" } }),
  );
  saveAccounts({ version: 1, activeAccountUuid: "A", accounts: [poolAccount("A"), ...extraAccounts] });
}

function clearState(): void {
  const files = [
    paths.usageJson, paths.modelUsageJson, paths.lastSwapJson, paths.accountsJson,
    paths.configJson, paths.claudeJson, paths.depletedJson, probeMarker, fakeClaude,
  ];
  for (const f of files) rmSync(f, { force: true });
}

function writeUsageJson(over: Record<string, unknown>, ageMs = 0): void {
  writeFileSync(
    paths.usageJson,
    JSON.stringify({
      fiveHour: { usedPercentage: 10, resetsAt: null },
      sevenDay: { usedPercentage: 20, resetsAt: Date.now() + 2 * D },
      org: "org-A",
      ts: Date.now() - ageMs,
      model: null,
      ...over,
    }),
  );
  if (ageMs > 0) {
    const then = new Date(Date.now() - ageMs);
    utimesSync(paths.usageJson, then, then);
  }
}

describe("evaluateAndMaybeSwap headless snapshot handling", () => {
  beforeEach(() => {
    clearState();
    installFixtures();
  });
  afterAll(clearState);

  test("one probe persists BOTH snapshots and a burnt Fable cap gates despite healthy aggregates", async () => {
    installFakeClaude(96, Date.now() + 2 * D);
    const d = await evaluateAndMaybeSwap();
    expect(d.reason).toBe("last-drop-hold");
    expect(d.swapped).toBe(false);
    expect(loadUsage()?.sevenDay.usedPercentage).toBe(72);
    expect(loadUsage()?.model).toBe(null);
    expect(loadModelUsage()?.perModel["Fable"]?.usedPercentage).toBe(96);
    expect(loadAccounts().accounts[0]?.lastPerModel?.["Fable"]?.usedPercentage).toBe(96);
  });

  test("a Fable cap under the floor stays put and still persists both snapshots", async () => {
    installFakeClaude(50, Date.now() + 2 * D);
    const d = await evaluateAndMaybeSwap();
    expect(d.reason).toBe("under-threshold-or-stale");
    expect(loadUsage()?.fiveHour.usedPercentage).toBe(22);
    expect(loadModelUsage()?.perModel["Fable"]?.usedPercentage).toBe(50);
  });

  test("a fresh statusLine tee naming an unconstrained model keeps the gate (and the probe) off", async () => {
    installFakeClaude(96, Date.now() + 2 * D);
    writeUsageJson({ model: { id: "claude-3-5-sonnet-20241022", display: "Sonnet" } });
    const d = await evaluateAndMaybeSwap();
    expect(d.reason).toBe("under-threshold-or-stale");
    expect(await Bun.file(probeMarker).exists()).toBe(false);
  });

  test("a snapshot older than the poll TTL is re-probed, not trusted (frozen aggregates, stale model label)", async () => {
    installFakeClaude(96, Date.now() + 2 * D);
    writeUsageJson({ model: { id: "claude-3-5-sonnet-20241022", display: "Sonnet" } }, 120_000);
    const d = await evaluateAndMaybeSwap();
    expect(d.reason).toBe("last-drop-hold");
    expect(loadUsage()?.model).toBe(null);
    expect(loadUsage()?.sevenDay.usedPercentage).toBe(72);
  });

  test("an alive tee whose figures held still (aged ts, fresh mtime) stays trusted, model intact", async () => {
    installFakeClaude(96, Date.now() + 2 * D);
    writeUsageJson({ ts: Date.now() - 300_000, model: { id: "claude-sonnet-5", display: "Sonnet 5" } });
    const d = await evaluateAndMaybeSwap();
    expect(d.reason).toBe("under-threshold-or-stale");
    expect(await Bun.file(probeMarker).exists()).toBe(false);
    expect(loadUsage()?.model?.display).toBe("Sonnet 5");
  });

  test("an org-drifted usage.json is re-probed instead of suppressing every future decision", async () => {
    installFakeClaude(96, Date.now() + 2 * D);
    writeUsageJson({ org: "org-ELSEWHERE" });
    const d = await evaluateAndMaybeSwap();
    expect(d.reason).toBe("last-drop-hold");
    expect(loadUsage()?.org).toBe("org-A");
  });

  test("a fresh window whose cached reset has passed reads as empty, never a switch reason", async () => {
    installFakeClaude(96, Date.now() + 2 * D);
    writeUsageJson({
      fiveHour: { usedPercentage: 99, resetsAt: Date.now() - 60_000 },
      model: { id: "claude-3-5-sonnet-20241022", display: "Sonnet" },
    });
    const d = await evaluateAndMaybeSwap();
    expect(d.reason).toBe("under-threshold-or-stale");
  });

  test("holds still inside the post-swap cooldown, before any probe", async () => {
    installFakeClaude(96, Date.now() + 2 * D);
    writeFileSync(paths.lastSwapJson, JSON.stringify({ ts: Date.now() - 10_000 }));
    const d = await evaluateAndMaybeSwap();
    expect(d.reason).toBe("post-swap-cooldown");
    expect(await Bun.file(probeMarker).exists()).toBe(false);
  });

  test("greedy: at the session floor, a pace-behind account takes the seat", async () => {
    const D2 = 2 * D;
    installFakeClaude(50, Date.now() + D2);
    installFixtures([
      poolAccount("B", {
        lastUsage: {
          fiveHour: { usedPercentage: 5, resetsAt: null },
          sevenDay: { usedPercentage: 10, resetsAt: Date.now() + D2 },
        },
        lastUsageAt: Date.now(),
      }),
    ]);
    writeUsageJson({
      fiveHour: { usedPercentage: 55, resetsAt: Date.now() + 3_600_000 },
      sevenDay: { usedPercentage: 60, resetsAt: Date.now() + D2 },
      model: { id: "claude-3-5-sonnet-20241022", display: "Sonnet" },
    });
    await expect(evaluateAndMaybeSwap()).rejects.toThrow(/no parked credential/);
  });

  test("greedy: the current account keeps its seat while it has the most at-risk quota", async () => {
    installFakeClaude(50, Date.now() + 2 * D);
    installFixtures([
      poolAccount("B", {
        lastUsage: {
          fiveHour: { usedPercentage: 5, resetsAt: null },
          sevenDay: { usedPercentage: 80, resetsAt: Date.now() + 2 * D },
        },
        lastUsageAt: Date.now(),
      }),
    ]);
    writeUsageJson({
      fiveHour: { usedPercentage: 55, resetsAt: Date.now() + 3_600_000 },
      sevenDay: { usedPercentage: 60, resetsAt: Date.now() + 2 * D },
      model: { id: "claude-3-5-sonnet-20241022", display: "Sonnet" },
    });
    const d = await evaluateAndMaybeSwap();
    expect(d.reason).toBe("current-best");
    expect(d.swapped).toBe(false);
  });

  test("greedy: below the session floor the decision stays disengaged", async () => {
    installFakeClaude(50, Date.now() + 2 * D);
    installFixtures([
      poolAccount("B", {
        lastUsage: {
          fiveHour: { usedPercentage: 5, resetsAt: null },
          sevenDay: { usedPercentage: 10, resetsAt: Date.now() + 2 * D },
        },
        lastUsageAt: Date.now(),
      }),
    ]);
    writeUsageJson({
      fiveHour: { usedPercentage: 45, resetsAt: Date.now() + 3_600_000 },
      sevenDay: { usedPercentage: 60, resetsAt: Date.now() + 2 * D },
      model: { id: "claude-3-5-sonnet-20241022", display: "Sonnet" },
    });
    const d = await evaluateAndMaybeSwap();
    expect(d.reason).toBe("under-threshold-or-stale");
  });

  test("under label drift both the usage stamp AND the greedy seat resolve by the LIVE org", async () => {
    installFakeClaude(10, Date.now() + 2 * D);
    installFixtures([poolAccount("B")]);
    saveAccounts({ version: 1, activeAccountUuid: "B", accounts: [poolAccount("A"), poolAccount("B")] });
    writeUsageJson({ fiveHour: { usedPercentage: 60, resetsAt: Date.now() + 3_600_000 } });
    const d = await evaluateAndMaybeSwap(Date.now(), false);
    expect(d.reason).toBe("current-best");
    const after = loadAccounts();
    expect(after.accounts.find((x) => x.accountUuid === "A")!.lastUsage?.fiveHour.usedPercentage).toBe(60);
    expect(after.accounts.find((x) => x.accountUuid === "B")!.lastUsage).toBeUndefined();
  });

  test("a KNOWN live org outside the pool stands down instead of seating the stale label", async () => {
    installFakeClaude(10, Date.now() + 2 * D);
    installFixtures();
    writeFileSync(
      paths.claudeJson,
      JSON.stringify({ oauthAccount: { accountUuid: "X", emailAddress: "x@e.com", organizationUuid: "org-X" } }),
    );
    writeUsageJson({ org: "org-X", fiveHour: { usedPercentage: 97, resetsAt: Date.now() + 3_600_000 } });
    const d = await evaluateAndMaybeSwap(Date.now(), true);
    expect(d.reason).toBe("live-credential-not-in-pool");
    expect(d.swapped).toBe(false);
    expect(loadDepletedWait()).toBeNull();
  });

  test("split thresholds: a session window over its own bar triggers below the weekly bar", async () => {
    installFakeClaude(50, Date.now() + 2 * D);
    installFixtures([], { session: 95, weekly: 98 });
    writeUsageJson({
      fiveHour: { usedPercentage: 96, resetsAt: Date.now() + 2 * D },
      model: { id: "claude-3-5-sonnet-20241022", display: "Sonnet" },
    });
    const d = await evaluateAndMaybeSwap();
    expect(d.reason).toBe("last-drop-hold");
    expect(await Bun.file(probeMarker).exists()).toBe(false);
  });

  test("split thresholds: weekly windows between the bars do not trigger", async () => {
    installFakeClaude(96, Date.now() + 2 * D);
    installFixtures([], { session: 95, weekly: 98 });
    writeUsageJson({
      sevenDay: { usedPercentage: 96, resetsAt: Date.now() + 2 * D },
      model: { id: "claude-fable-5", display: "Fable" },
    });
    const d = await evaluateAndMaybeSwap();
    expect(d.reason).toBe("under-threshold-or-stale");
  });

  test("split thresholds: a per-model cap at the weekly bar still triggers", async () => {
    installFakeClaude(98, Date.now() + 2 * D);
    installFixtures([], { session: 95, weekly: 98 });
    const d = await evaluateAndMaybeSwap();
    expect(d.reason).toBe("last-drop-hold");
    expect(loadModelUsage()?.perModel["Fable"]?.usedPercentage).toBe(98);
  });

  test("only a pause-capable caller may pre-park on a still-blocked account", async () => {
    installFakeClaude(100, Date.now() + 2 * D);
    installFixtures([
      poolAccount("B", {
        lastUsage: {
          fiveHour: { usedPercentage: 100, resetsAt: Date.now() + 30 * 60_000 },
          sevenDay: { usedPercentage: 30, resetsAt: Date.now() + 3 * D },
        },
        lastUsageAt: Date.now(),
      }),
    ]);
    const d = await evaluateAndMaybeSwap();
    expect(d.reason).toBe("all-depleted");
    expect(loadAccounts().activeAccountUuid).toBe("A");
    await expect(evaluateAndMaybeSwap(Date.now(), true)).rejects.toThrow(/no parked credential/);
  });

  test("a recorded depleted-wait replays through the cooldown so sibling hooks get their marker", async () => {
    const now = Date.now();
    installFakeClaude(96, now + 2 * D);
    saveLastSwapAt(now - 1_000);
    saveDepletedWait({ waitUntil: now + 10 * 60_000, accountUuid: "A", ts: now });
    const replay = await evaluateAndMaybeSwap(now, true);
    expect(replay.reason).toBe("depleted-wait");
    expect(replay.account?.accountUuid).toBe("A");
    expect(replay.waitUntil).toBe(now + 10 * 60_000);

    saveDepletedWait({ waitUntil: now - 1, accountUuid: "A", ts: now });
    expect((await evaluateAndMaybeSwap(now, true)).reason).toBe("post-swap-cooldown");

    saveDepletedWait({ waitUntil: now + 10 * 60_000, accountUuid: "B", ts: now });
    expect((await evaluateAndMaybeSwap(now, true)).reason).toBe("post-swap-cooldown");

    saveDepletedWait({ waitUntil: now + 10 * 60_000, accountUuid: "A", ts: now });
    writeFileSync(paths.claudeJson, JSON.stringify({ oauthAccount: { accountUuid: "F", emailAddress: "F@e.com", organizationUuid: "org-F" } }));
    expect((await evaluateAndMaybeSwap(now, true)).reason).toBe("post-swap-cooldown");
  });

  test("a dead grant on the earliest-reset pre-park target falls through to the next account", async () => {
    const now = Date.now();
    const server = Bun.serve({
      port: Number(new URL(process.env.TOKENMAXXING_OAUTH_ROLES_URL!).port),
      fetch: async (req) => {
        const body = await req.json();
        const rt = body != null && body instanceof Object && "refresh_token" in body ? body.refresh_token : null;
        if (rt === "DEAD-B") return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
        return Response.json({ access_token: "at-C-fresh", refresh_token: "rt-C-2", expires_in: 3600 });
      },
    });
    try {
      installFakeClaude(100, now + 2 * D);
      installFixtures([
        poolAccount("B", {
          lastUsage: {
            fiveHour: { usedPercentage: 100, resetsAt: now + 20 * 60_000 },
            sevenDay: { usedPercentage: 30, resetsAt: now + 3 * D },
          },
          lastUsageAt: now,
        }),
        poolAccount("C", {
          lastUsage: {
            fiveHour: { usedPercentage: 100, resetsAt: now + 40 * 60_000 },
            sevenDay: { usedPercentage: 30, resetsAt: now + 3 * D },
          },
          lastUsageAt: now,
        }),
      ]);
      await writeItem(parkedTarget("tokenmaxxing-cred-B"), JSON.stringify({ claudeAiOauth: { accessToken: "at-B", refreshToken: "DEAD-B", expiresAt: 0 } }));
      await writeItem(parkedTarget("tokenmaxxing-cred-C"), JSON.stringify({ claudeAiOauth: { accessToken: "at-C", refreshToken: "OK-C", expiresAt: 0 } }));

      const d = await evaluateAndMaybeSwap(now, true);
      expect(d.reason).toBe("depleted-wait");
      expect(d.account?.accountUuid).toBe("C");
      expect(d.waitUntil).toBe(now + 40 * 60_000);
      const idx = loadAccounts();
      expect(idx.activeAccountUuid).toBe("C");
      expect(idx.accounts.find((a) => a.accountUuid === "B")?.needsReauth).toBe(true);
    } finally {
      server.stop(true);
      await deleteItem(parkedTarget("tokenmaxxing-cred-B"));
      await deleteItem(parkedTarget("tokenmaxxing-cred-C"));
      await deleteItem(liveTarget());
    }
  });

  test("candidates whose gated cap is burnt are screened out down the whole chain", async () => {
    installFakeClaude(100, Date.now() + 2 * D);
    installFixtures([
      poolAccount("B", {
        lastUsage: {
          fiveHour: { usedPercentage: 5, resetsAt: null },
          sevenDay: { usedPercentage: 30, resetsAt: Date.now() + 3 * D },
        },
        lastPerModel: { Fable: { usedPercentage: 100, resetsAt: Date.now() + 3 * D } },
        lastUsageAt: Date.now(),
      }),
    ]);
    const d = await evaluateAndMaybeSwap();
    expect(d.reason).toBe("all-depleted");
    expect(d.swapped).toBe(false);
    expect(loadAccounts().activeAccountUuid).toBe("A");
  });

  test("Layer 2 hold: a hard-usable seat squeezes in place, never ping-ponging onto an equally squeezable sibling", async () => {
    installFakeClaude(96, Date.now() + 2 * D);
    installFixtures([
      poolAccount("B", {
        lastUsage: { fiveHour: { usedPercentage: 5, resetsAt: null }, sevenDay: { usedPercentage: 30, resetsAt: Date.now() + 3 * D } },
        lastPerModel: { Fable: { usedPercentage: 96, resetsAt: Date.now() + 3 * D } },
        lastUsageAt: Date.now(),
      }),
    ]);
    const d = await evaluateAndMaybeSwap();
    expect(d.reason).toBe("last-drop-hold");
    expect(d.swapped).toBe(false);
    expect(loadAccounts().activeAccountUuid).toBe("A");
  });

  test("Layer 2 swap: a walled seat moves onto a still-squeezable account to keep pumping", async () => {
    installFakeClaude(100, Date.now() + 2 * D);
    installFixtures([
      poolAccount("B", {
        lastUsage: { fiveHour: { usedPercentage: 5, resetsAt: null }, sevenDay: { usedPercentage: 30, resetsAt: Date.now() + 3 * D } },
        lastPerModel: { Fable: { usedPercentage: 96, resetsAt: Date.now() + 3 * D } },
        lastUsageAt: Date.now(),
      }),
    ]);
    await expect(evaluateAndMaybeSwap()).rejects.toThrow(/no parked credential/);
  });

  test("Layer 2 is disabled when hardThresholds == thresholds, even with a projection margin", async () => {
    installFakeClaude(50, Date.now() + 2 * D);
    installFixtures([], { session: 95, weekly: 95 });
    writeFileSync(
      paths.configJson,
      JSON.stringify({
        thresholds: { session: 95, weekly: 95 },
        hardThresholds: { session: 95, weekly: 95 },
        claudeBin: fakeClaude,
        policy: { projectionMargin: 3, switchModels: ["fable"] },
      }),
    );
    writeUsageJson({
      fiveHour: { usedPercentage: 93, resetsAt: Date.now() + 2 * D },
      model: { id: "claude-3-5-sonnet-20241022", display: "Sonnet" },
    });
    const d = await evaluateAndMaybeSwap();
    expect(d.reason).toBe("all-depleted");
  });
});
