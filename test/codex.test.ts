import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { codexIdentityOf, isCodexAccessExpiring, readCodexAuthAt, readLiveCodexAuth, readParkedCodexAuth, writeLiveCodexAuth, writeParkedCodexAuth } from "../src/lib/codexauth.ts";
import { CodexInvalidGrantError, CodexRefreshFailedError, refreshCodexAuth } from "../src/lib/codexoauth.ts";
import { codexLimitLabel, fetchCodexUsage, isSessionWindow, weeklyWindowOf } from "../src/lib/codexusage.ts";
import { CODEX_SWAP_IMPROVEMENT, codexCurrentWins, codexPacePressure, isCodexEngaged, isCodexExhausted, pickBestCodex } from "../src/lib/codexpick.ts";
import { performCodexSwap } from "../src/lib/codexswap.ts";
import { evaluateAndMaybeSwapCodex } from "../src/lib/codexdecide.ts";
import { loadCodexAccounts, loadCodexLastSwapAt, saveCodexAccounts } from "../src/lib/codexstate.ts";
import { writeCodexPresence, presentCodexAccountIds, targetableCodexAccounts } from "../src/lib/codexpresence.ts";
import { codexSupervisorLink, installCodexStopHook, installCodexSupervisor, uninstallCodexStopHook, uninstallCodexSupervisor } from "../src/lib/install.ts";
import { CODEX_SUPERVISOR_ID_ENV, shouldManageCodex } from "../src/entries/codexsupervisor.ts";
import { handleCodexStop } from "../src/entries/codexstophook.ts";
import { codexCredItemFor, codexPaths } from "../src/lib/paths.ts";
import type { CodexAccount, CodexAuthJson, CodexWindow } from "../src/lib/types.ts";

// ---- fixtures ---------------------------------------------------------------

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (payload: unknown) => `${b64url({ alg: "none" })}.${b64url(payload)}.sig`;

function authBlob(id: string, input?: { refreshToken?: string; accessExpSecondsFromNow?: number; omitAccountId?: boolean }): CodexAuthJson {
  const exp = Math.floor((Date.now() + (input?.accessExpSecondsFromNow ?? 3600) * 1000) / 1000);
  return {
    auth_mode: "chatgpt",
    tokens: {
      id_token: jwt({
        email: `${id}@example.com`,
        "https://api.openai.com/auth": { chatgpt_account_id: `acct-${id}`, chatgpt_plan_type: "pro" },
      }),
      access_token: jwt({ exp }),
      refresh_token: input?.refreshToken ?? `rt-${id}`,
      ...(input?.omitAccountId ? {} : { account_id: `acct-${id}` }),
    },
    last_refresh: "2026-07-01T00:00:00.000Z",
    keep_me_sibling: `sibling-${id}`,
  };
}

const week = 7 * 24 * 3600;
const nowMs = () => Date.now();

function window(input: { used: number; resetInMs?: number; seconds?: number | null }): CodexWindow {
  return {
    usedPercentage: input.used,
    resetsAt: input.resetInMs != null ? nowMs() + input.resetInMs : null,
    windowSeconds: input.seconds === undefined ? week : input.seconds,
  };
}

function account(id: string, input?: { weekly?: CodexWindow; perLimit?: Record<string, CodexWindow[]>; needsReauth?: boolean; sampledAt?: number }): CodexAccount {
  return {
    accountId: `acct-${id}`,
    email: `${id}@example.com`,
    label: id,
    planType: "pro",
    credFile: codexCredItemFor(`acct-${id}`),
    addedAt: "2026-07-01T00:00:00.000Z",
    needsReauth: input?.needsReauth,
    lastUsage: { aggregate: input?.weekly ? [input.weekly] : [], perLimit: input?.perLimit ?? {} },
    lastUsageAt: input?.sampledAt ?? nowMs(),
  };
}

// ---- mock endpoints (ports pinned by test/setup.ts env) ----------------------

let refreshCalls = 0;
let usageBody: () => unknown = () => ({});
let server: ReturnType<typeof Bun.serve>;
const RefreshGrantSchema = z.looseObject({ refresh_token: z.string() });

beforeAll(() => {
  server = Bun.serve({
    port: 8792,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/codex-token") {
        const body = RefreshGrantSchema.parse(await req.json());
        refreshCalls++;
        if (body.refresh_token.startsWith("DEAD")) {
          return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
        }
        if (body.refresh_token.startsWith("REUSED")) {
          return new Response(JSON.stringify({ error: "refresh_token_reused" }), { status: 400 });
        }
        if (body.refresh_token.startsWith("BOOM")) {
          return new Response("upstream exploded", { status: 500 });
        }
        return Response.json({
          access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600, marker: "fresh" }),
          refresh_token: `${body.refresh_token}-rot`,
        });
      }
      if (url.pathname === "/codex-usage") {
        return Response.json(usageBody());
      }
      return new Response("not found", { status: 404 });
    },
  });
});
afterAll(() => server.stop(true));

const DEFAULT_USAGE_BODY = () => ({
  account_id: "acct-A",
  email: "A@example.com",
  plan_type: "pro",
  rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: week, reset_at: Math.floor(Date.now() / 1000) + week } },
});

beforeEach(() => {
  refreshCalls = 0;
  usageBody = DEFAULT_USAGE_BODY;
  rmSync(codexPaths.home, { recursive: true, force: true });
  rmSync(codexPaths.credsDir, { recursive: true, force: true });
  rmSync(codexPaths.accountsJson, { force: true });
  rmSync(codexPaths.lastSwapJson, { force: true });
  rmSync(codexPaths.respawnDir, { recursive: true, force: true });
  rmSync(codexPaths.presenceDir, { recursive: true, force: true });
  rmSync(codexPaths.lockFile, { force: true });
  mkdirSync(codexPaths.home, { recursive: true });
});

// ---- codexauth ---------------------------------------------------------------

describe("codex identity + auth blobs", () => {
  test("identity comes from tokens.account_id with claims filling email/plan", () => {
    const identity = codexIdentityOf({ auth: authBlob("A") });
    expect(identity).toEqual({ accountId: "acct-A", email: "A@example.com", planType: "pro" });
  });

  test("id_token claim is the fallback when tokens.account_id is absent", () => {
    const identity = codexIdentityOf({ auth: authBlob("B", { omitAccountId: true }) });
    expect(identity.accountId).toBe("acct-B");
  });

  test("a blob with no account id anywhere fails fast", () => {
    const auth = authBlob("C", { omitAccountId: true });
    auth.tokens.id_token = jwt({ email: "c@example.com" });
    expect(() => codexIdentityOf({ auth })).toThrow(/no account id/);
  });

  test("an api-key auth.json (tokens omitted or null) reads as no poolable login; corrupt still throws", () => {
    // `codex login --with-api-key` writes `tokens` OMITTED (serde
    // skip_serializing_if on Option<TokenData>, source-verified at
    // rust-v0.144.5): a valid codex state the real binary runs on, so the
    // shim and `xx status` must not crash on it - there is just nothing to
    // pool (closing-review catch). Genuine corruption keeps throwing.
    writeFileSync(codexPaths.authJson, JSON.stringify({ OPENAI_API_KEY: "sk-test" }));
    expect(readLiveCodexAuth()).toBeNull();
    writeFileSync(codexPaths.authJson, JSON.stringify({ OPENAI_API_KEY: "sk-test", tokens: null }));
    expect(readLiveCodexAuth()).toBeNull();
    writeFileSync(codexPaths.authJson, "{ not json");
    expect(() => readLiveCodexAuth()).toThrow();
  });

  test("parked round-trip preserves unknown siblings verbatim", () => {
    const auth = authBlob("A");
    writeParkedCodexAuth({ credFile: "tokenmaxxing-codex-test", auth });
    const back = readParkedCodexAuth({ credFile: "tokenmaxxing-codex-test" });
    expect(back).toEqual(auth);
    expect(z.looseObject({ keep_me_sibling: z.string() }).parse(back).keep_me_sibling).toBe("sibling-A");
  });

  test("access expiry honors the 5-minute margin and fails closed on garbage", () => {
    expect(isCodexAccessExpiring({ auth: authBlob("A", { accessExpSecondsFromNow: 3600 }) })).toBe(false);
    expect(isCodexAccessExpiring({ auth: authBlob("A", { accessExpSecondsFromNow: 60 }) })).toBe(true);
    const garbage = authBlob("A");
    garbage.tokens.access_token = "not-a-jwt";
    expect(isCodexAccessExpiring({ auth: garbage })).toBe(true);
  });
});

// ---- codexoauth ----------------------------------------------------------------

describe("codex refresh", () => {
  test("rotates tokens, restamps last_refresh, preserves siblings", async () => {
    const fresh = await refreshCodexAuth({ auth: authBlob("A"), now: 1_784_000_000_000 });
    expect(fresh.tokens.refresh_token).toBe("rt-A-rot");
    expect(fresh.last_refresh).toBe(new Date(1_784_000_000_000).toISOString());
    expect(z.looseObject({ keep_me_sibling: z.string() }).parse(fresh).keep_me_sibling).toBe("sibling-A");
    expect(fresh.tokens.account_id).toBe("acct-A");
  });

  test("dead grant classes throw CodexInvalidGrantError", async () => {
    await expect(refreshCodexAuth({ auth: authBlob("A", { refreshToken: "DEAD-1" }) })).rejects.toBeInstanceOf(CodexInvalidGrantError);
    await expect(refreshCodexAuth({ auth: authBlob("A", { refreshToken: "REUSED-1" }) })).rejects.toBeInstanceOf(CodexInvalidGrantError);
  });

  test("a server failure is a retryable refresh failure, not a dead grant", async () => {
    await expect(refreshCodexAuth({ auth: authBlob("A", { refreshToken: "BOOM-1" }) })).rejects.toBeInstanceOf(CodexRefreshFailedError);
  });
});

// ---- codexusage ----------------------------------------------------------------

describe("codex usage mapping", () => {
  test("maps the pinned live wire shape: weekly primary, per-limit rows, epoch seconds to ms", async () => {
    usageBody = () => ({
      account_id: "acct-A",
      email: "A@example.com",
      plan_type: "pro",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 6, limit_window_seconds: week, reset_after_seconds: 1, reset_at: 1_784_780_511 },
        secondary_window: null,
      },
      additional_rate_limits: [
        {
          limit_name: "GPT-5.3-Codex-Spark",
          metered_feature: "codex_bengalfox",
          rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: week, reset_at: 1_784_797_165 } },
        },
      ],
      credits: { has_credits: false },
    });
    const usage = await fetchCodexUsage({ auth: authBlob("A") });
    expect(usage.accountId).toBe("acct-A");
    expect(usage.planType).toBe("pro");
    expect(usage.aggregate).toEqual([{ usedPercentage: 6, resetsAt: 1_784_780_511_000, windowSeconds: week }]);
    expect(usage.perLimit["GPT-5.3-Codex-Spark"]).toEqual([{ usedPercentage: 40, resetsAt: 1_784_797_165_000, windowSeconds: week }]);
  });

  test("window classification is duration-driven", () => {
    expect(isSessionWindow({ window: window({ used: 0, seconds: 5 * 3600 }) })).toBe(true);
    expect(isSessionWindow({ window: window({ used: 0, seconds: week }) })).toBe(false);
    expect(isSessionWindow({ window: window({ used: 0, seconds: null }) })).toBe(false);
    const weekly = window({ used: 10, seconds: week });
    expect(weeklyWindowOf({ aggregate: [window({ used: 50, seconds: 5 * 3600 }), weekly] })).toEqual(weekly);
  });

  test("chart label is the lowercase family, structural across versions", () => {
    expect(codexLimitLabel({ limitName: "GPT-5.3-Codex-Spark" })).toBe("spark");
    expect(codexLimitLabel({ limitName: "GPT-6.1-Codex-Spark" })).toBe("spark");
    expect(codexLimitLabel({ limitName: "GPT-5.3-Codex" })).toBe("codex");
    expect(codexLimitLabel({ limitName: "5.3" })).toBe("5.3");
  });
});

// ---- codexpick ------------------------------------------------------------------

describe("codex picking", () => {
  const bars = { session: 95, weekly: 98 };

  test("ranks by weekly pace pressure: most remaining before the soonest reset wins", () => {
    const behind = account("behind", { weekly: window({ used: 5, resetInMs: 24 * 3600_000 }) });
    const ahead = account("ahead", { weekly: window({ used: 80, resetInMs: 24 * 3600_000 }) });
    expect(codexPacePressure({ account: behind, now: nowMs() })).toBeGreaterThan(codexPacePressure({ account: ahead, now: nowMs() }));
    expect(pickBestCodex({ accounts: [ahead, behind], thresholds: bars, now: nowMs(), currentAccountId: null })?.label).toBe("behind");
  });

  test("screens out accounts over a bar until their reset passes", () => {
    const burnt = account("burnt", { weekly: window({ used: 99, resetInMs: 3600_000 }) });
    const past = account("past", { weekly: window({ used: 99, resetInMs: -60_000 }) });
    expect(isCodexExhausted({ account: burnt, thresholds: bars, now: nowMs() })).toBe(true);
    expect(isCodexExhausted({ account: past, thresholds: bars, now: nowMs() })).toBe(false);
    expect(pickBestCodex({ accounts: [burnt], thresholds: bars, now: nowMs(), currentAccountId: null })).toBeNull();
  });

  test("per-limit family windows screen with the weekly bar", () => {
    const familyBurnt = account("fam", {
      weekly: window({ used: 10, resetInMs: 3600_000 }),
      perLimit: { "GPT-5.3-Codex-Spark": [window({ used: 99, resetInMs: 3600_000 })] },
    });
    expect(isCodexExhausted({ account: familyBurnt, thresholds: bars, now: nowMs() })).toBe(true);
  });

  test("currentWins keeps the seat within the respawn-cost margin, yields past it", () => {
    // a codex greedy swap restarts a live session: a challenger inside the
    // improvement margin must not unseat the incumbent.
    const cur = account("cur", { weekly: window({ used: 40, resetInMs: 24 * 3600_000 }) });
    const marginal = account("marginal", { weekly: window({ used: 35, resetInMs: 24 * 3600_000 }) });
    const better = account("better", { weekly: window({ used: 5, resetInMs: 24 * 3600_000 }) });
    const curPressure = codexPacePressure({ account: cur, now: nowMs() });
    expect(codexPacePressure({ account: marginal, now: nowMs() })).toBeLessThanOrEqual(curPressure * CODEX_SWAP_IMPROVEMENT);
    expect(codexCurrentWins({ active: cur, accounts: [cur, marginal], thresholds: bars, now: nowMs() })).toBe(true);
    expect(codexPacePressure({ account: better, now: nowMs() })).toBeGreaterThan(curPressure * CODEX_SWAP_IMPROVEMENT);
    expect(codexCurrentWins({ active: cur, accounts: [cur, better], thresholds: bars, now: nowMs() })).toBe(false);
    expect(codexCurrentWins({ active: better, accounts: [cur, better], thresholds: bars, now: nowMs() })).toBe(true);
  });

  test("engagement floor reads against every window class, including a 5h-class window", () => {
    const engagedWeekly = account("e", { weekly: window({ used: 55, resetInMs: 24 * 3600_000 }) });
    const fresh = account("f", { weekly: window({ used: 10, resetInMs: 24 * 3600_000 }) });
    const engagedSession = account("s", { weekly: window({ used: 10, resetInMs: 24 * 3600_000 }) });
    engagedSession.lastUsage!.aggregate.push(window({ used: 60, resetInMs: 3600_000, seconds: 5 * 3600 }));
    expect(isCodexEngaged({ account: engagedWeekly, floor: 50, now: nowMs() })).toBe(true);
    expect(isCodexEngaged({ account: fresh, floor: 50, now: nowMs() })).toBe(false);
    expect(isCodexEngaged({ account: engagedSession, floor: 50, now: nowMs() })).toBe(true);
  });
});

// ---- presence (concurrent sessions) -------------------------------------------

describe("codex presence", () => {
  test("a living supervisor's account is present; a dead pid is cleaned up", () => {
    writeCodexPresence({ supervisorId: "sup-1", accountId: "acct-A" });
    expect(presentCodexAccountIds().has("acct-A")).toBe(true);
    mkdirSync(codexPaths.presenceDir, { recursive: true });
    writeFileSync(
      join(codexPaths.presenceDir, "sup-dead"),
      JSON.stringify({ accountId: "acct-B", pid: 2_147_483_646, startedAt: "Wed Jan  1 00:00:00 2020" }),
    );
    const present = presentCodexAccountIds();
    expect(present.has("acct-B")).toBe(false);
    expect(existsSync(join(codexPaths.presenceDir, "sup-dead"))).toBe(false);
  });

  test("a corrupt presence file fails the read loudly instead of dropping protection", () => {
    // a presence file guards a RUNNING session's account from being swapped
    // out from under it; unreadable state must never silently read as absent.
    mkdirSync(codexPaths.presenceDir, { recursive: true });
    writeFileSync(join(codexPaths.presenceDir, "sup-corrupt"), "not json");
    expect(() => presentCodexAccountIds()).toThrow("refusing to treat it as absent");
  });

  test("an ALIVE pid with the wrong start-time identity is treated as dead (pid reuse)", () => {
    // A recycled pid after a supervisor crash must not bench the account
    // forever: identity is pid + ps lstart, not bare aliveness.
    mkdirSync(codexPaths.presenceDir, { recursive: true });
    writeFileSync(
      join(codexPaths.presenceDir, "sup-reused"),
      JSON.stringify({ accountId: "acct-R", pid: process.pid, startedAt: "Wed Jan  1 00:00:00 2020" }),
    );
    expect(presentCodexAccountIds().has("acct-R")).toBe(false);
    expect(existsSync(join(codexPaths.presenceDir, "sup-reused"))).toBe(false);
  });

  test("targetable accounts exclude running accounts but keep the seat itself", () => {
    const accountA = account("A");
    const accountB = account("B");
    writeCodexPresence({ supervisorId: "sup-a", accountId: "acct-A" });
    writeCodexPresence({ supervisorId: "sup-b", accountId: "acct-B" });
    const targetable = targetableCodexAccounts({ accounts: [accountA, accountB], activeAccountId: "acct-A" });
    expect(targetable.map((entry) => entry.accountId)).toEqual(["acct-A"]);
  });
});

// ---- codexswap -------------------------------------------------------------------

function seedPool(input: { accounts: CodexAccount[]; activeId: string | null }): void {
  saveCodexAccounts({ index: { version: 1, activeAccountId: input.activeId, accounts: input.accounts } });
}

describe("codex swap", () => {
  test("full sequence: harvest live under its own identity, install refreshed target, persist rotation, commit active", async () => {
    const accountA = account("A");
    const accountB = account("B");
    seedPool({ accounts: [accountA, accountB], activeId: "acct-A" });
    const liveA = authBlob("A", { refreshToken: "rt-A-live" });
    writeLiveCodexAuth({ auth: liveA });
    writeParkedCodexAuth({ credFile: accountA.credFile, auth: authBlob("A", { refreshToken: "rt-A-stale" }) });
    writeParkedCodexAuth({ credFile: accountB.credFile, auth: authBlob("B") });

    await performCodexSwap({ target: accountB });

    const live = readLiveCodexAuth();
    expect(live?.tokens.refresh_token).toBe("rt-B-rot");
    expect(live?.tokens.account_id).toBe("acct-B");
    // A's harvest is the LIVE blob verbatim, not its stale parked copy
    expect(readParkedCodexAuth({ credFile: accountA.credFile })?.tokens.refresh_token).toBe("rt-A-live");
    expect(readParkedCodexAuth({ credFile: accountB.credFile })?.tokens.refresh_token).toBe("rt-B-rot");
    expect(loadCodexAccounts().activeAccountId).toBe("acct-B");
  });

  test("refuses an unpooled live credential BEFORE any network refresh, leaving the target's grant untouched", async () => {
    const accountB = account("B");
    seedPool({ accounts: [accountB], activeId: null });
    writeLiveCodexAuth({ auth: authBlob("STRANGER") });
    writeParkedCodexAuth({ credFile: accountB.credFile, auth: authBlob("B") });
    await expect(performCodexSwap({ target: accountB })).rejects.toThrow(/not in the pool/);
    expect(readLiveCodexAuth()?.tokens.account_id).toBe("acct-STRANGER");
    // the refusal must not have rotated B's token server-side: a rotation here
    // with the parked file unrewritten would strand a reuse-punished token.
    expect(refreshCalls).toBe(0);
    expect(readParkedCodexAuth({ credFile: accountB.credFile })?.tokens.refresh_token).toBe("rt-B");
  });

  test("refuses to install the live account over itself", async () => {
    const accountA = account("A");
    seedPool({ accounts: [accountA], activeId: "acct-A" });
    writeLiveCodexAuth({ auth: authBlob("A") });
    writeParkedCodexAuth({ credFile: accountA.credFile, auth: authBlob("A", { refreshToken: "rt-A-stale" }) });
    await expect(performCodexSwap({ target: accountA })).rejects.toThrow(/onto itself/);
    expect(refreshCalls).toBe(0);
  });

  test("a dead grant marks needs-reauth and leaves the live credential untouched", async () => {
    const accountA = account("A");
    const accountB = account("B");
    seedPool({ accounts: [accountA, accountB], activeId: "acct-A" });
    writeLiveCodexAuth({ auth: authBlob("A") });
    writeParkedCodexAuth({ credFile: accountB.credFile, auth: authBlob("B", { refreshToken: "DEAD-B" }) });
    await expect(performCodexSwap({ target: accountB })).rejects.toBeInstanceOf(CodexInvalidGrantError);
    expect(loadCodexAccounts().accounts.find((entry) => entry.accountId === "acct-B")?.needsReauth).toBe(true);
    expect(readLiveCodexAuth()?.tokens.account_id).toBe("acct-A");
  });
});

// ---- codexdecide -----------------------------------------------------------------

describe("codex decide", () => {
  test("greedy swap onto the pace-better account once the active one is engaged", async () => {
    const accountA = account("A", { weekly: window({ used: 60, resetInMs: 24 * 3600_000 }) });
    const accountB = account("B", { weekly: window({ used: 5, resetInMs: 24 * 3600_000 }) });
    seedPool({ accounts: [accountA, accountB], activeId: "acct-A" });
    writeLiveCodexAuth({ auth: authBlob("A") });
    writeParkedCodexAuth({ credFile: accountA.credFile, auth: authBlob("A") });
    writeParkedCodexAuth({ credFile: accountB.credFile, auth: authBlob("B") });

    const decision = await evaluateAndMaybeSwapCodex({});
    expect(decision.swapped).toBe(true);
    expect(decision.account?.accountId).toBe("acct-B");
    expect(readLiveCodexAuth()?.tokens.account_id).toBe("acct-B");
  });

  test("stays put when the engaged active account already wins", async () => {
    const accountA = account("A", { weekly: window({ used: 60, resetInMs: 24 * 3600_000 }) });
    const accountB = account("B", { weekly: window({ used: 90, resetInMs: 24 * 3600_000 }) });
    seedPool({ accounts: [accountA, accountB], activeId: "acct-A" });
    writeLiveCodexAuth({ auth: authBlob("A") });

    const decision = await evaluateAndMaybeSwapCodex({});
    expect(decision).toEqual({ swapped: false, account: null, reason: "current-best" });
  });

  test("disengaged below the floor: no swap even with a fresher sibling", async () => {
    const accountA = account("A", { weekly: window({ used: 20, resetInMs: 24 * 3600_000 }) });
    const accountB = account("B", { weekly: window({ used: 5, resetInMs: 24 * 3600_000 }) });
    seedPool({ accounts: [accountA, accountB], activeId: "acct-A" });
    writeLiveCodexAuth({ auth: authBlob("A") });

    const decision = await evaluateAndMaybeSwapCodex({});
    expect(decision.reason).toBe("under-threshold-or-stale");
  });

  test("hard path: a crossed bar swaps even when greedy would keep the seat", async () => {
    // A is over the weekly bar; B is worse on pace than A was pre-burn but usable.
    const accountA = account("A", { weekly: window({ used: 99, resetInMs: 24 * 3600_000 }) });
    const accountB = account("B", { weekly: window({ used: 70, resetInMs: 24 * 3600_000 }) });
    seedPool({ accounts: [accountA, accountB], activeId: "acct-A" });
    writeLiveCodexAuth({ auth: authBlob("A") });
    writeParkedCodexAuth({ credFile: accountA.credFile, auth: authBlob("A") });
    writeParkedCodexAuth({ credFile: accountB.credFile, auth: authBlob("B") });

    const decision = await evaluateAndMaybeSwapCodex({});
    expect(decision.swapped).toBe(true);
    expect(decision.account?.accountId).toBe("acct-B");
  });

  test("greedy dead-grant re-rank: a dead winner falls through to the next usable account", async () => {
    const accountA = account("A", { weekly: window({ used: 60, resetInMs: 24 * 3600_000 }) });
    const accountB = account("B", { weekly: window({ used: 2, resetInMs: 24 * 3600_000 }) });
    const accountC = account("C", { weekly: window({ used: 5, resetInMs: 24 * 3600_000 }) });
    seedPool({ accounts: [accountA, accountB, accountC], activeId: "acct-A" });
    writeLiveCodexAuth({ auth: authBlob("A") });
    writeParkedCodexAuth({ credFile: accountA.credFile, auth: authBlob("A") });
    writeParkedCodexAuth({ credFile: accountB.credFile, auth: authBlob("B", { refreshToken: "DEAD-B" }) });
    writeParkedCodexAuth({ credFile: accountC.credFile, auth: authBlob("C") });

    const decision = await evaluateAndMaybeSwapCodex({});
    expect(decision.swapped).toBe(true);
    expect(decision.account?.accountId).toBe("acct-C");
    expect(loadCodexAccounts().accounts.find((entry) => entry.accountId === "acct-B")?.needsReauth).toBe(true);
  });

  test("an unpooled live credential is the org-guard analog: no evaluation, no swap", async () => {
    const accountA = account("A", { weekly: window({ used: 60, resetInMs: 24 * 3600_000 }) });
    seedPool({ accounts: [accountA], activeId: "acct-A" });
    writeLiveCodexAuth({ auth: authBlob("STRANGER") });
    const decision = await evaluateAndMaybeSwapCodex({});
    expect(decision).toEqual({ swapped: false, account: null, reason: "live-credential-not-in-pool" });
  });

  test("a stale snapshot re-samples the LIVE credential and stamps its true owner", async () => {
    const old = nowMs() - 10 * 60_000;
    const accountA = account("A", { weekly: window({ used: 10, resetInMs: 24 * 3600_000 }), sampledAt: old });
    seedPool({ accounts: [accountA], activeId: "acct-A" });
    writeLiveCodexAuth({ auth: authBlob("A") });
    writeParkedCodexAuth({ credFile: accountA.credFile, auth: authBlob("A") });
    usageBody = () => ({
      account_id: "acct-A",
      email: "A@example.com",
      plan_type: "pro",
      rate_limit: { primary_window: { used_percent: 42, limit_window_seconds: week, reset_at: Math.floor(Date.now() / 1000) + week } },
    });

    await evaluateAndMaybeSwapCodex({});
    const sampled = loadCodexAccounts().accounts.find((entry) => entry.accountId === "acct-A");
    expect(sampled?.lastUsage?.aggregate[0]?.usedPercentage).toBe(42);
    expect(sampled?.lastUsageAt).toBeGreaterThan(old);
  });

  test("a dead LIVE grant marks its owner and still swaps onto a healthy account", async () => {
    // The live refresh throwing CodexInvalidGrantError used to escape to the
    // hook's generic catch: no mark, no swap, the session stuck on a dead seat.
    const accountA = account("A", { weekly: window({ used: 99, resetInMs: 24 * 3600_000 }), sampledAt: nowMs() - 10 * 60_000 });
    const accountB = account("B", { weekly: window({ used: 5, resetInMs: 24 * 3600_000 }) });
    seedPool({ accounts: [accountA, accountB], activeId: "acct-A" });
    writeLiveCodexAuth({ auth: authBlob("A", { refreshToken: "DEAD-A", accessExpSecondsFromNow: -60 }) });
    writeParkedCodexAuth({ credFile: accountB.credFile, auth: authBlob("B") });

    const decision = await evaluateAndMaybeSwapCodex({});
    expect(decision.swapped).toBe(true);
    expect(decision.account?.accountId).toBe("acct-B");
    expect(loadCodexAccounts().accounts.find((entry) => entry.accountId === "acct-A")?.needsReauth).toBe(true);
  });

  test("a dead live grant forces engagement even when cached usage sits under the floor", async () => {
    const accountA = account("A", { weekly: window({ used: 20, resetInMs: 24 * 3600_000 }), sampledAt: nowMs() - 10 * 60_000 });
    const accountB = account("B", { weekly: window({ used: 5, resetInMs: 24 * 3600_000 }) });
    seedPool({ accounts: [accountA, accountB], activeId: "acct-A" });
    writeLiveCodexAuth({ auth: authBlob("A", { refreshToken: "DEAD-A", accessExpSecondsFromNow: -60 }) });
    writeParkedCodexAuth({ credFile: accountB.credFile, auth: authBlob("B") });

    const decision = await evaluateAndMaybeSwapCodex({});
    expect(decision.swapped).toBe(true);
    expect(decision.account?.accountId).toBe("acct-B");
    expect(loadCodexAccounts().accounts.find((entry) => entry.accountId === "acct-A")?.needsReauth).toBe(true);
  });

  test("a live rotation persists to the parked copy BEFORE the usage fetch can fail", async () => {
    const accountA = account("A", { weekly: window({ used: 10, resetInMs: 24 * 3600_000 }), sampledAt: nowMs() - 10 * 60_000 });
    seedPool({ accounts: [accountA], activeId: "acct-A" });
    writeLiveCodexAuth({ auth: authBlob("A", { accessExpSecondsFromNow: 30 }) });
    writeParkedCodexAuth({ credFile: accountA.credFile, auth: authBlob("A") }); // pre-rotation rt-A
    usageBody = () => ({ error: "boom" }); // schema-invalid: the usage read fails after the refresh

    await expect(evaluateAndMaybeSwapCodex({})).rejects.toThrow();
    // the rotation exists server-side; a stranded pre-rotation parked copy
    // would be reuse-punished on its next refresh.
    expect(readParkedCodexAuth({ credFile: accountA.credFile })?.tokens.refresh_token).toBe("rt-A-rot");
  });

  test("a present (running) sibling is never targeted even when it ranks best", async () => {
    const accountA = account("A", { weekly: window({ used: 60, resetInMs: 24 * 3600_000 }) });
    const accountB = account("B", { weekly: window({ used: 2, resetInMs: 24 * 3600_000 }) });
    const accountC = account("C", { weekly: window({ used: 20, resetInMs: 24 * 3600_000 }) });
    seedPool({ accounts: [accountA, accountB, accountC], activeId: "acct-A" });
    writeLiveCodexAuth({ auth: authBlob("A") });
    writeParkedCodexAuth({ credFile: accountA.credFile, auth: authBlob("A") });
    writeParkedCodexAuth({ credFile: accountB.credFile, auth: authBlob("B") });
    writeParkedCodexAuth({ credFile: accountC.credFile, auth: authBlob("C") });
    writeCodexPresence({ supervisorId: "sup-sibling", accountId: "acct-B" });

    const decision = await evaluateAndMaybeSwapCodex({});
    expect(decision.swapped).toBe(true);
    expect(decision.account?.accountId).toBe("acct-C");
  });
});

// ---- codexstate fail-fast ------------------------------------------------------

describe("codex state fail-fast", () => {
  test("a corrupt codex-accounts.json throws instead of fabricating an empty pool", () => {
    mkdirSync(codexPaths.home, { recursive: true });
    writeFileSync(codexPaths.accountsJson, "{ not json");
    expect(() => loadCodexAccounts()).toThrow();
    writeFileSync(codexPaths.lastSwapJson, "{ not json");
    expect(() => loadCodexLastSwapAt()).toThrow();
  });
});

// ---- stop hook entry -------------------------------------------------------------

describe("codex stop hook", () => {
  test("a swap under a supervisor writes the respawn marker with the stdin session id", async () => {
    const accountA = account("A", { weekly: window({ used: 60, resetInMs: 24 * 3600_000 }) });
    const accountB = account("B", { weekly: window({ used: 5, resetInMs: 24 * 3600_000 }) });
    seedPool({ accounts: [accountA, accountB], activeId: "acct-A" });
    writeLiveCodexAuth({ auth: authBlob("A") });
    writeParkedCodexAuth({ credFile: accountA.credFile, auth: authBlob("A") });
    writeParkedCodexAuth({ credFile: accountB.credFile, auth: authBlob("B") });

    process.env[CODEX_SUPERVISOR_ID_ENV] = "sup-test";
    try {
      await handleCodexStop({ rawStdin: JSON.stringify({ session_id: "sess-42", hook_event_name: "Stop" }) });
    } finally {
      delete process.env[CODEX_SUPERVISOR_ID_ENV];
    }
    const marker = JSON.parse(readFileSync(join(codexPaths.respawnDir, "sup-test"), "utf8"));
    expect(marker.sessionId).toBe("sess-42");
    expect(marker.account).toBe("B");
  });

  test("a broken pool never throws out of the hook", async () => {
    mkdirSync(codexPaths.home, { recursive: true });
    writeFileSync(codexPaths.accountsJson, "{ not json");
    await expect(handleCodexStop({ rawStdin: "not json either" })).resolves.toBeUndefined();
  });
});

// ---- supervisor shim lifecycle ------------------------------------------------------

describe("codex supervisor install lifecycle", () => {
  test("install writes the shim + hook entry; uninstall removes both", () => {
    installCodexSupervisor();
    expect(existsSync(codexSupervisorLink())).toBe(true);
    const hooks = readFileSync(codexPaths.hooksJson, "utf8");
    expect(hooks).toContain("__codex-stop-hook");
    // quoted command: an install path with a space must not mis-split
    expect(hooks).toContain('\\"');
    uninstallCodexSupervisor();
    expect(existsSync(codexSupervisorLink())).toBe(false);
    expect(readFileSync(codexPaths.hooksJson, "utf8")).not.toContain("__codex-stop-hook");
  });
});

// ---- hooks install ----------------------------------------------------------------

describe("codex hooks.json install", () => {
  // the event map nests under a top-level `hooks` field (HooksFile) - a live
  // 0.13.0 install with the claude-style top-level map made codex refuse the
  // whole file: "unknown field Stop, expected description or hooks".
  const HooksFileSchema = z.looseObject({
    hooks: z.looseObject({
      PreToolUse: z.array(z.unknown()).optional(),
      Stop: z.array(z.looseObject({ hooks: z.array(z.looseObject({ command: z.string() })) })),
    }),
  });

  test("merges idempotently under the hooks field and preserves foreign declarations", () => {
    mkdirSync(codexPaths.home, { recursive: true });
    writeFileSync(codexPaths.hooksJson, JSON.stringify({
      description: "user hooks",
      hooks: {
        PreToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command", command: "/usr/bin/somebody-else" }] }],
        Stop: [{ hooks: [{ type: "command", command: "/usr/bin/foreign-stop" }] }],
      },
    }));
    installCodexStopHook();
    installCodexStopHook();
    const merged = HooksFileSchema.parse(JSON.parse(readFileSync(codexPaths.hooksJson, "utf8")));
    expect(merged.hooks.PreToolUse).toHaveLength(1);
    expect(merged.hooks.Stop).toHaveLength(2);
    expect(merged.hooks.Stop.filter((group) => group.hooks.some((hook) => hook.command.includes("__codex-stop-hook")))).toHaveLength(1);
    expect(z.looseObject({ description: z.string() }).parse(JSON.parse(readFileSync(codexPaths.hooksJson, "utf8"))).description).toBe("user hooks");

    uninstallCodexStopHook();
    const cleaned = HooksFileSchema.parse(JSON.parse(readFileSync(codexPaths.hooksJson, "utf8")));
    expect(cleaned.hooks.Stop).toHaveLength(1);
    expect(cleaned.hooks.Stop[0]!.hooks[0]!.command).toBe("/usr/bin/foreign-stop");
  });

  test("a fresh install produces the nested HooksFile shape, never a top-level event map", () => {
    installCodexStopHook();
    const written = JSON.parse(readFileSync(codexPaths.hooksJson, "utf8"));
    expect(z.looseObject({ Stop: z.unknown().optional() }).parse(written).Stop).toBeUndefined();
    const parsed = HooksFileSchema.parse(written);
    expect(parsed.hooks.Stop).toHaveLength(1);
  });
});

// ---- supervisor arg analysis --------------------------------------------------------

describe("codex supervisor management decision", () => {
  test("interactive launches are managed, utility subcommands and version checks pass through", () => {
    expect(shouldManageCodex({ argv: [] })).toBe(true);
    expect(shouldManageCodex({ argv: ["do the thing"] })).toBe(true);
    expect(shouldManageCodex({ argv: ["resume", "--last"] })).toBe(true);
    expect(shouldManageCodex({ argv: ["exec", "prompt"] })).toBe(false);
    expect(shouldManageCodex({ argv: ["login"] })).toBe(false);
    expect(shouldManageCodex({ argv: ["--version"] })).toBe(false);
    expect(shouldManageCodex({ argv: ["-h"] })).toBe(false);
  });

  test("a value-taking root option's value is not mistaken for the subcommand", () => {
    expect(shouldManageCodex({ argv: ["-m", "gpt-5.6-sol", "exec", "prompt"] })).toBe(false);
    expect(shouldManageCodex({ argv: ["--profile", "work", "login"] })).toBe(false);
    expect(shouldManageCodex({ argv: ["-m", "gpt-5.6-sol", "do the thing"] })).toBe(true);
    expect(shouldManageCodex({ argv: ["-C", "/tmp"] })).toBe(true);
  });
});
