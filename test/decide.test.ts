// The headless paths of evaluateAndMaybeSwap: no rendering statusLine, so the
// decision runs off `claude -p '/usage'` probes with the model unknown. The
// probe must feed BOTH snapshots, refresh them once they age past the poll TTL
// or drift orgs, and gate on every configured family - on 2026-07-12 the ARM box sat
// at its Fable cap for hours of periodic checks because the per-model half was
// discarded and nothing ever refreshed the aggregates. Every case here resolves
// without touching a credential store; decisions that would perform a real swap
// fail loudly on the missing parked credential, which is itself an assertion
// that the picker screened the candidates it was supposed to.

import { chmodSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { evaluateAndMaybeSwap } from "../src/lib/decide.ts";
import { paths } from "../src/lib/paths.ts";
import { loadAccounts, loadModelUsage, loadUsage, saveAccounts } from "../src/lib/state.ts";
import type { Account } from "../src/lib/types.ts";

const D = 86_400_000;
const fakeClaude = join(paths.home, "fake-claude");
const probeMarker = join(paths.home, "probe-ran");

/** A `/usage` reset clock the parser accepts (comma glue), `epochMs` in UTC. */
function usageClock(epochMs: number): string {
  const d = new Date(epochMs);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const h24 = d.getUTCHours();
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${h}:${mm}${h24 >= 12 ? "pm" : "am"} (UTC)`;
}

/** Install a fake claude whose `/usage` reports the given Fable percentage. */
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
    paths.configJson, paths.claudeJson, probeMarker, fakeClaude,
  ];
  for (const f of files) rmSync(f, { force: true });
}

/** Write a usage.json fixture; `ageMs` backdates BOTH ts and the mtime
 *  heartbeat, the way a genuinely idle feed looks. */
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
    // sole account, so the gate resolves to the depleted path, never a swap.
    expect(d.reason).toBe("all-depleted");
    expect(d.swapped).toBe(false);
    expect(loadUsage()?.sevenDay.usedPercentage).toBe(72);
    expect(loadUsage()?.model).toBe(null);
    expect(loadModelUsage()?.perModel["Fable"]?.usedPercentage).toBe(96);
    // the locked section stamped the snapshot onto the account for the picker.
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
    // Stale tee from a session that may be long gone: healthy values, sonnet
    // model. Trusting either would leave the box blind to the burnt Fable cap.
    writeUsageJson({ model: { id: "claude-3-5-sonnet-20241022", display: "Sonnet" } }, 120_000);
    const d = await evaluateAndMaybeSwap();
    expect(d.reason).toBe("all-depleted");
    expect(loadUsage()?.model).toBe(null);
    expect(loadUsage()?.sevenDay.usedPercentage).toBe(72);
  });

  test("an alive tee whose figures held still (aged ts, fresh mtime) stays trusted, model intact", async () => {
    installFakeClaude(96, Date.now() + 2 * D);
    // write-on-change suppression lets ts age up to 10min under an alive feed;
    // the mtime heartbeat is what proves liveness. A live sonnet session must
    // not be treated as headless (model erased -> fable gate misfires).
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
    expect(d.reason).toBe("all-depleted");
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
    // fresh sonnet tee, under every bar, session half-used: B (90 left) out-pressures A (40 left).
    writeUsageJson({
      fiveHour: { usedPercentage: 55, resetsAt: Date.now() + 3_600_000 },
      sevenDay: { usedPercentage: 60, resetsAt: Date.now() + D2 },
      model: { id: "claude-3-5-sonnet-20241022", display: "Sonnet" },
    });
    // the greedy path chose to swap onto B - proven by the loud missing-credential throw.
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

  test("split thresholds: a session window over its own bar triggers below the weekly bar", async () => {
    installFakeClaude(50, Date.now() + 2 * D);
    installFixtures([], { session: 95, weekly: 98 });
    // fresh sonnet tee: no per-model gate, no probe; session 96 >= 95 is the sole trigger.
    writeUsageJson({
      fiveHour: { usedPercentage: 96, resetsAt: Date.now() + 2 * D },
      model: { id: "claude-3-5-sonnet-20241022", display: "Sonnet" },
    });
    const d = await evaluateAndMaybeSwap();
    expect(d.reason).toBe("all-depleted");
    expect(await Bun.file(probeMarker).exists()).toBe(false);
  });

  test("split thresholds: weekly windows between the bars do not trigger", async () => {
    // week-all 96 and week-Fable 96 both sit under the 98 weekly bar; the old
    // single 95 bar would have swapped on either.
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
    expect(d.reason).toBe("all-depleted");
    expect(loadModelUsage()?.perModel["Fable"]?.usedPercentage).toBe(98);
  });

  test("only a pause-capable caller may pre-park on a still-blocked account", async () => {
    // B recovers within maxWaitMs but is blocked NOW. A non-anticipatory caller
    // (check timer, unsupervised hook) must stay put; the supervised stop hook
    // may pre-park, which here fails loudly on the missing parked credential -
    // proving the flag, not the picker, is what withheld the swap.
    installFakeClaude(96, Date.now() + 2 * D);
    installFixtures([
      poolAccount("B", {
        lastUsage: {
          fiveHour: { usedPercentage: 99, resetsAt: Date.now() + 30 * 60_000 },
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

  test("candidates whose gated cap is burnt are screened out down the whole chain", async () => {
    // Parked account with healthy aggregates but a burnt Fable cap: pickBest
    // must skip it and the depleted path must wait, not swap. If either loses
    // the switchFamilies screen, performSwap on the missing parked credential
    // throws and fails this test.
    installFakeClaude(96, Date.now() + 2 * D);
    installFixtures([
      poolAccount("B", {
        lastUsage: {
          fiveHour: { usedPercentage: 5, resetsAt: null },
          sevenDay: { usedPercentage: 30, resetsAt: Date.now() + 3 * D },
        },
        lastPerModel: { Fable: { usedPercentage: 97, resetsAt: Date.now() + 3 * D } },
        lastUsageAt: Date.now(),
      }),
    ]);
    const d = await evaluateAndMaybeSwap();
    expect(d.reason).toBe("all-depleted");
    expect(d.swapped).toBe(false);
    expect(loadAccounts().activeAccountUuid).toBe("A");
  });
});
