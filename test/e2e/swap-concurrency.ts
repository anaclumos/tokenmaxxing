// Hermetic end-to-end test of the credential SWAP + flocked concurrency, using
// throwaway credential targets (keychain services on darwin, sandboxed files on
// linux), a mock OAuth server, and a temp claude.json - no real second account
// or real credentials involved. Run: `bun test/e2e/swap-concurrency.ts`.
//
// Env is set BEFORE importing our modules (which capture it at load), so all
// dynamic imports come after this block.

import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";

const base = join(tmpdir(), `tm-e2e-${process.pid}`);
rmSync(base, { recursive: true, force: true });
mkdirSync(join(base, "home"), { recursive: true });
mkdirSync(join(base, "claudedir"), { recursive: true });

const LIVE_SVC = `tokenmaxxing-e2e-live-${process.pid}`;
const CRED_A = `tokenmaxxing-e2e-credA-${process.pid}`;
const CRED_B = `tokenmaxxing-e2e-credB-${process.pid}`;
const CRED_C = `tokenmaxxing-e2e-credC-${process.pid}`;

process.env.TOKENMAXXING_HOME = join(base, "home");
process.env.CLAUDE_CONFIG_DIR = join(base, "claudedir");
process.env.TOKENMAXXING_CLAUDE_JSON = join(base, "claude.json");
process.env.TOKENMAXXING_KEYCHAIN_SERVICE = LIVE_SVC;
process.env.TOKENMAXXING_OAUTH_TOKEN_URL = "http://127.0.0.1:8792/token";
process.env.TOKENMAXXING_OAUTH_ROLES_URL = "http://127.0.0.1:8792/roles";
process.env.NO_COLOR = "1";

const { writeItem, readItem, deleteItem, liveTarget, parkedTarget } = await import("../../src/lib/credstore.ts");
const { saveAccounts, loadAccounts, saveConfig } = await import("../../src/lib/state.ts");
const { evaluateAndMaybeSwap } = await import("../../src/lib/decide.ts");
import type { Account, UsageState } from "../../src/lib/types.ts";

const RefreshGrantSchema = z.looseObject({ refresh_token: z.string() });

let refreshCalls = 0;
const server = Bun.serve({
  port: 8792,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/roles") {
      // every test token embeds its account tag: A-access / FRESH-A-rt / ROT-B-rt ...
      const token = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      const tag = token.match(/(?:^|-)([ABC])-/)?.[1];
      if (!tag) return new Response("unknown test token", { status: 401 });
      return Response.json({ organization_uuid: `org-${tag}`, organization_name: `Org ${tag}`, organization_role: "admin" });
    }
    const body = RefreshGrantSchema.parse(await req.json());
    refreshCalls++;
    // a DEAD-prefixed refresh token is a dead grant (test 9's needs-reauth winner).
    if (body.refresh_token.startsWith("DEAD")) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }
    return Response.json({
      access_token: `FRESH-${body.refresh_token}`,
      refresh_token: `ROT-${body.refresh_token}`,
      expires_in: 3600,
      refresh_token_expires_in: 7776000,
      scope: "user:inference user:profile",
    });
  },
});

const future = Date.now() + 3600_000;
const blob = (tag: string, refreshToken = `${tag}-rt`) => JSON.stringify({
  claudeAiOauth: { accessToken: `${tag}-access`, refreshToken, expiresAt: future, scopes: ["user:inference"], subscriptionType: "max" },
});
const oauthAccount = (tag: string, org: string) => ({ accountUuid: `uuid-${tag}`, emailAddress: `${tag}@e.com`, organizationUuid: org });
const acct = (tag: string, org: string, item: string, low: boolean): Account => ({
  accountUuid: `uuid-${tag}`, email: `${tag}@e.com`, organizationUuid: org, label: `${tag}@e.com`,
  keychainItem: item, oauthAccount: oauthAccount(tag, org), addedAt: new Date(0).toISOString(),
  subscriptionType: "max",
  lastUsage: low ? { fiveHour: { usedPercentage: 5, resetsAt: null }, sevenDay: { usedPercentage: 10, resetsAt: null } } : undefined,
});

let failures = 0;
const check = (cond: boolean, label: string) => {
  console.log(`${cond ? "  ✓" : "  ✗ FAIL"} ${label}`);
  if (!cond) failures++;
};

async function seed() {
  // Each test is its own scenario: drop the previous test's swap stamp, or the
  // 45s POST_SWAP_COOLDOWN suppresses every evaluation after the first swap.
  rmSync(join(process.env.TOKENMAXXING_HOME!, "lastswap.json"), { force: true });
  // /usr/bin/true, not /bin/true: macOS has no /bin/true, and a missing
  // claudeBin makes resolveRealClaude fail (it must never PATH-scan its way
  // to the installed tokenmaxxing wrapper and recurse).
  // both bars at 95: the seeded windows (5h 97, Fable 96) target a single bar.
  saveConfig({ thresholds: { session: 95, weekly: 95 }, claudeBin: "/usr/bin/true", codexBin: "", policy: { projectionMargin: 0, greedySessionFloor: 50, switchModels: ["fable", "opus"], usagePollTtlMs: 90_000, maxWaitMs: 3_600_000 } });
  await writeItem(parkedTarget(CRED_A), blob("A"));
  await writeItem(parkedTarget(CRED_B), blob("B"));
  await writeItem(liveTarget(), blob("A")); // A is live
  writeFileSync(process.env.TOKENMAXXING_CLAUDE_JSON!, JSON.stringify({ numStartups: 7, oauthAccount: oauthAccount("A", "org-A"), keep: "me" }));
  saveAccounts({ version: 1, activeAccountUuid: "uuid-A", accounts: [acct("A", "org-A", CRED_A, false), acct("B", "org-B", CRED_B, true)] });
  // A is over threshold (org matches active)
  const usage: UsageState = { fiveHour: { usedPercentage: 97, resetsAt: future }, sevenDay: { usedPercentage: 50, resetsAt: future }, org: "org-A", ts: Date.now(), model: null };
  writeFileSync(process.env.TOKENMAXXING_HOME + "/usage.json", JSON.stringify(usage));
}

try {
  // ---- Test 1: a single swap does the full mechanical dance ----
  console.log("Test 1 - single swap A→B (harvest, refresh, install, rewrite identity)");
  await seed();
  const dec = await evaluateAndMaybeSwap();
  check(dec.swapped && dec.account?.accountUuid === "uuid-B", "decision: swapped to B");
  check(refreshCalls === 1, "exactly one OAuth refresh call");
  const liveNow = JSON.parse((await readItem(liveTarget()))!);
  check(liveNow.claudeAiOauth.accessToken === "FRESH-B-rt", "live keychain now holds B's FRESH access token");
  check(liveNow.claudeAiOauth.refreshToken === "ROT-B-rt", "live keychain has B's rotated refresh token");
  const cj = JSON.parse(readFileSync(process.env.TOKENMAXXING_CLAUDE_JSON!, "utf8"));
  check(cj.oauthAccount.accountUuid === "uuid-B", "claude.json oauthAccount swapped to B");
  check(cj.keep === "me" && cj.numStartups === 7, "claude.json other keys preserved");
  check(loadAccounts().activeAccountUuid === "uuid-B", "accounts.json marks B active");
  const backupA = JSON.parse((await readItem(parkedTarget(CRED_A)))!);
  check(backupA.claudeAiOauth.accessToken === "A-access", "A's live creds harvested into its backup");

  // ---- Test 2: org guard - a second evaluation does NOT double-swap ----
  console.log("Test 2 - org guard: stale usage (org-A) with active=B does nothing");
  // Clear test 1's swap stamp and restore its (now cleared) org-A usage: without
  // this the evaluation exits at post-swap-cooldown and the org guard this test
  // is named for never runs.
  rmSync(join(process.env.TOKENMAXXING_HOME!, "lastswap.json"), { force: true });
  writeFileSync(process.env.TOKENMAXXING_HOME + "/usage.json", JSON.stringify({
    fiveHour: { usedPercentage: 97, resetsAt: future }, sevenDay: { usedPercentage: 50, resetsAt: future },
    org: "org-A", ts: Date.now(), model: null,
  }));
  refreshCalls = 0;
  const dec2 = await evaluateAndMaybeSwap();
  check(!dec2.swapped && dec2.reason === "under-threshold-or-stale", `org guard held (got ${dec2.reason})`);
  check(refreshCalls === 0, "no OAuth call made");

  // ---- Test 3: N concurrent PROCESSES race one flocked swap ----
  console.log("Test 3 - 4 concurrent processes, one flocked swap");
  await seed(); // reset: A active, over threshold
  refreshCalls = 0;
  const runner = `
    const { evaluateAndMaybeSwap } = await import("${join(import.meta.dir, "../../src/lib/decide.ts")}");
    const d = await evaluateAndMaybeSwap();
    console.log(d.swapped ? "SWAPPED" : "noop");
  `;
  const env = {
    ...process.env,
  } as Record<string, string>;
  const procs = Array.from({ length: 4 }, () =>
    Bun.spawn([process.execPath, "-e", runner], { env, stdout: "pipe", stderr: "pipe" }),
  );
  const outs = await Promise.all(procs.map(async (p) => { const o = await new Response(p.stdout).text(); await p.exited; return o.trim(); }));
  const swaps = outs.filter((o) => o.includes("SWAPPED")).length;
  check(swaps === 1, `exactly one process performed the swap (got ${swaps}); others no-op`);
  check(refreshCalls === 1, `exactly one OAuth refresh across all processes (got ${refreshCalls})`);
  check(loadAccounts().activeAccountUuid === "uuid-B", "final state: B active after concurrent race");

  // ---- Test 4: model-aware trigger - aggregate is FINE but Fable's cap is over ----
  console.log("Test 4 - per-model cap on Fable triggers a swap while aggregate is under threshold");
  await seed(); // A active
  refreshCalls = 0;
  // aggregate well under threshold, but active model is Fable
  writeFileSync(process.env.TOKENMAXXING_HOME + "/usage.json", JSON.stringify({
    fiveHour: { usedPercentage: 30, resetsAt: future }, sevenDay: { usedPercentage: 50, resetsAt: future },
    org: "org-A", ts: Date.now(), model: { id: "claude-fable-5", display: "Fable" },
  }));
  // pre-populate the per-model cache (fresh, org-A) so ensurePerModel doesn't shell out
  writeFileSync(process.env.TOKENMAXXING_HOME + "/model-usage.json", JSON.stringify({
    perModel: { Fable: { usedPercentage: 96, resetsAt: future } }, org: "org-A", ts: Date.now(),
  }));
  const dec4 = await evaluateAndMaybeSwap();
  check(dec4.swapped && dec4.account?.accountUuid === "uuid-B", "swapped to B on Fable's per-model cap (aggregate was 30/50)");

  // ---- Test 5: same aggregate + cap, but on Sonnet → NO swap ----
  console.log("Test 5 - same numbers on Sonnet do NOT trigger (sonnet not in switchModels)");
  await seed();
  refreshCalls = 0;
  writeFileSync(process.env.TOKENMAXXING_HOME + "/usage.json", JSON.stringify({
    fiveHour: { usedPercentage: 30, resetsAt: future }, sevenDay: { usedPercentage: 50, resetsAt: future },
    org: "org-A", ts: Date.now(), model: { id: "claude-sonnet-5", display: "Sonnet" },
  }));
  writeFileSync(process.env.TOKENMAXXING_HOME + "/model-usage.json", JSON.stringify({
    perModel: { Sonnet: { usedPercentage: 96, resetsAt: future } }, org: "org-A", ts: Date.now(),
  }));
  const dec5 = await evaluateAndMaybeSwap();
  check(!dec5.swapped, "no swap on Sonnet even at 96% (sonnet = ok)");

  // ---- Test 6: all accounts depleted -> switch to earliest-reset with waitUntil ----
  console.log("Test 6 - all depleted: switch to earliest-reset (B) + waitUntil");
  await seed(); // A active, over threshold
  const soon = Date.now() + 10 * 60 * 1000;
  const later = Date.now() + 40 * 60 * 1000;
  writeFileSync(process.env.TOKENMAXXING_HOME + "/usage.json", JSON.stringify({
    fiveHour: { usedPercentage: 97, resetsAt: later }, sevenDay: { usedPercentage: 50, resetsAt: later },
    org: "org-A", ts: Date.now(), model: null,
  }));
  const idxD = loadAccounts();
  idxD.accounts.find((a) => a.accountUuid === "uuid-B")!.lastUsage = {
    fiveHour: { usedPercentage: 97, resetsAt: soon }, sevenDay: { usedPercentage: 50, resetsAt: soon },
  };
  saveAccounts(idxD);
  refreshCalls = 0;
  // anticipatory=true: only the supervised Stop hook (whose respawn marker can
  // pause until the reset) may pre-park on a still-blocked account.
  const dec6 = await evaluateAndMaybeSwap(Date.now(), true);
  check(dec6.reason === "depleted-wait" && dec6.swapped && dec6.account?.accountUuid === "uuid-B", "depleted -> swapped to earliest-reset B");
  check(dec6.waitUntil === soon, `waitUntil = B's reset (got ${dec6.waitUntil}, want ${soon})`);

  // ---- Test 7: greedy - a half-used session swaps onto the pace-behind account ----
  console.log("Test 7 - greedy: session at 55 (under every bar) still swaps to pace-behind B");
  await seed();
  writeFileSync(process.env.TOKENMAXXING_HOME + "/usage.json", JSON.stringify({
    fiveHour: { usedPercentage: 55, resetsAt: future }, sevenDay: { usedPercentage: 60, resetsAt: future },
    org: "org-A", ts: Date.now(), model: null,
  }));
  const idxG = loadAccounts();
  idxG.accounts.find((a) => a.accountUuid === "uuid-B")!.lastUsage = {
    fiveHour: { usedPercentage: 5, resetsAt: null }, sevenDay: { usedPercentage: 10, resetsAt: future },
  };
  saveAccounts(idxG);
  refreshCalls = 0;
  const dec7 = await evaluateAndMaybeSwap();
  check(dec7.swapped && dec7.account?.accountUuid === "uuid-B" && dec7.waitUntil === undefined, "greedy swap landed on B with no wait");
  check(loadAccounts().activeAccountUuid === "uuid-B", "accounts.json marks B active after the greedy swap");

  // ---- Test 8: greedy idempotence - re-evaluation on B holds still ----
  console.log("Test 8 - greedy idempotence: B keeps the seat on the next evaluation");
  rmSync(join(process.env.TOKENMAXXING_HOME!, "lastswap.json"), { force: true });
  writeFileSync(process.env.TOKENMAXXING_HOME + "/usage.json", JSON.stringify({
    fiveHour: { usedPercentage: 55, resetsAt: future }, sevenDay: { usedPercentage: 12, resetsAt: future },
    org: "org-B", ts: Date.now(), model: null,
  }));
  refreshCalls = 0;
  const dec8 = await evaluateAndMaybeSwap();
  check(dec8.reason === "current-best" && !dec8.swapped, `B still wins (got ${dec8.reason})`);
  check(refreshCalls === 0, "no OAuth call on the idempotent re-check");

  // ---- Test 9: greedy dead-winner fallback must still strictly beat current ----
  console.log("Test 9 - greedy: dead token on the winner never bounces a healthy session onto a worse account");
  await seed();
  await writeItem(parkedTarget(CRED_B), blob("B", "DEAD-B-rt")); // B: best pace, dead grant
  await writeItem(parkedTarget(CRED_C), blob("C"));
  const idx9 = loadAccounts();
  idx9.accounts.find((a) => a.accountUuid === "uuid-B")!.lastUsage = {
    fiveHour: { usedPercentage: 5, resetsAt: null }, sevenDay: { usedPercentage: 5, resetsAt: future },
  };
  idx9.accounts.push(acct("C", "org-C", CRED_C, false));
  idx9.accounts.find((a) => a.accountUuid === "uuid-C")!.lastUsage = {
    fiveHour: { usedPercentage: 5, resetsAt: null }, sevenDay: { usedPercentage: 60, resetsAt: future },
  };
  idx9.accounts.forEach((a) => { a.lastUsageAt = Date.now(); });
  saveAccounts(idx9);
  writeFileSync(process.env.TOKENMAXXING_HOME + "/usage.json", JSON.stringify({
    fiveHour: { usedPercentage: 55, resetsAt: future }, sevenDay: { usedPercentage: 30, resetsAt: future },
    org: "org-A", ts: Date.now(), model: null,
  }));
  refreshCalls = 0;
  const dec9 = await evaluateAndMaybeSwap();
  check(dec9.reason === "current-best" && !dec9.swapped, `stayed on A after B's grant died (got ${dec9.reason})`);
  check(loadAccounts().activeAccountUuid === "uuid-A", "A still active (no bounce onto pace-worse C)");
  check(loadAccounts().accounts.find((a) => a.accountUuid === "uuid-B")?.needsReauth === true, "B marked needs-reauth");
  check(refreshCalls === 1, `exactly one refresh attempt, B's dead grant (got ${refreshCalls})`);
} finally {
  server.stop(true);
  await deleteItem(liveTarget());
  await deleteItem(parkedTarget(CRED_A));
  await deleteItem(parkedTarget(CRED_B));
  await deleteItem(parkedTarget(CRED_C));
  rmSync(base, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nSWAP+CONCURRENCY E2E: ALL PASS" : `\nSWAP+CONCURRENCY E2E: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
