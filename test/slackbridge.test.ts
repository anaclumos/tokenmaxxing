// slackbridge: the depleted-pool recovery policy (pure park/drop/proceed plan,
// errored-result-only rate-limit classifier, observed-limit persistence - all
// ported from slaude at its shutdown), the detached claude child spawn, and
// the finish_thread close-out.

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { MAX_RECOVERIES, PARK_MAX_MS, TurnOutcomeSchema, cleanupThread, detachedClaudeSpawn, isRateLimitText, parkPlan } from "../src/lib/slackbridge.ts";
import { parseUsageLimitEpoch, recordObservedLimit } from "../src/lib/usage.ts";
import { loadUsage, writeUsage } from "../src/lib/state.ts";
import { loadSlackThread, saveSlackThread } from "../src/lib/slackstate.ts";

const NOW = 1_784_400_000_000;
const DEADLINE = NOW + PARK_MAX_MS;
const usable = { swapped: false, account: null, reason: "current-best" };
const depleted = { swapped: false, account: null, reason: "all-depleted" };

describe("parkPlan", () => {
  test("proceeds on a usable pool", () => {
    expect(parkPlan({ decision: usable, now: NOW, recoveries: 0, deadline: DEADLINE })).toEqual({ kind: "proceed" });
    expect(parkPlan({ decision: { ...usable, reason: "swapped" }, now: NOW, recoveries: 0, deadline: DEADLINE })).toEqual({ kind: "proceed" });
  });

  test("parks slightly past a near recovery", () => {
    const plan = parkPlan({ decision: { ...depleted, waitUntil: NOW + 60_000 }, now: NOW, recoveries: 0, deadline: DEADLINE });
    expect(plan.kind).toBe("park");
    if (plan.kind === "park") expect(plan.wakeAt).toBeGreaterThan(NOW + 60_000);
  });

  test("the wake grace counts against the deadline", () => {
    // a reset in the final seconds of the budget would wake past the promised
    // total hold, so it drops instead of parking.
    expect(parkPlan({ decision: { ...depleted, waitUntil: DEADLINE - 1_000 }, now: NOW, recoveries: 0, deadline: DEADLINE }).kind).toBe("drop");
    expect(parkPlan({ decision: { ...depleted, waitUntil: DEADLINE - 60_000 }, now: NOW, recoveries: 0, deadline: DEADLINE }).kind).toBe("park");
  });

  test("depleted-wait counts as depleted", () => {
    const plan = parkPlan({ decision: { ...depleted, reason: "depleted-wait", waitUntil: NOW + 60_000 }, now: NOW, recoveries: 0, deadline: DEADLINE });
    expect(plan.kind).toBe("park");
  });

  test("drops honestly on unknown or past-deadline recovery", () => {
    expect(parkPlan({ decision: depleted, now: NOW, recoveries: 0, deadline: DEADLINE })).toEqual({ kind: "drop", recoversAt: null });
    const far = DEADLINE + 60_000;
    expect(parkPlan({ decision: { ...depleted, waitUntil: far }, now: NOW, recoveries: 0, deadline: DEADLINE })).toEqual({ kind: "drop", recoversAt: far });
  });

  test("the deadline is SHARED across a message's parks, not per park", () => {
    // first park consumed most of the budget; a second wake only 10min out
    // would pass a per-park cap but exceeds the message's one deadline.
    const later = NOW + PARK_MAX_MS - 60_000;
    const secondWake = later + 600_000;
    expect(parkPlan({ decision: { ...depleted, waitUntil: secondWake }, now: later, recoveries: 1, deadline: DEADLINE })).toEqual({
      kind: "drop",
      recoversAt: secondWake,
    });
  });

  test("the recovery budget caps parking even when the wake is near", () => {
    const soon = NOW + 60_000;
    const plan = parkPlan({ decision: { ...depleted, waitUntil: soon }, now: NOW, recoveries: MAX_RECOVERIES, deadline: DEADLINE });
    expect(plan).toEqual({ kind: "drop", recoversAt: soon });
  });
});

describe("parseUsageLimitEpoch", () => {
  test("parses the piped epoch, seconds or milliseconds", () => {
    expect(parseUsageLimitEpoch({ text: "Claude AI usage limit reached|1784369046" })).toBe(1_784_369_046_000);
    expect(parseUsageLimitEpoch({ text: "Claude AI usage limit reached|1784369046000" })).toBe(1_784_369_046_000);
  });

  test("null on phrase-only or malformed epochs", () => {
    expect(parseUsageLimitEpoch({ text: "usage limit reached, resets 3pm" })).toBeNull();
    expect(parseUsageLimitEpoch({ text: "usage limit reached|12345" })).toBeNull();
    // 11/12-digit runs are malformed, never "seconds" (they would become
    // far-future resets).
    expect(parseUsageLimitEpoch({ text: "usage limit reached|17843690460" })).toBeNull();
    expect(parseUsageLimitEpoch({ text: "usage limit reached|178436904600" })).toBeNull();
    expect(parseUsageLimitEpoch({ text: "no limit here" })).toBeNull();
  });
});

describe("recordObservedLimit", () => {
  const claudeJson = process.env.TOKENMAXXING_CLAUDE_JSON!;
  const seedIdentity = (org: string) => {
    writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { accountUuid: "u1", emailAddress: "a@e.com", organizationUuid: org } }));
  };
  const priorUsage = (org: string) => ({
    fiveHour: { usedPercentage: 40, resetsAt: NOW + 3_600_000 },
    sevenDay: { usedPercentage: 70, resetsAt: NOW + 86_400_000 },
    org,
    ts: NOW - 60_000,
    model: null,
  });

  test("stamps the spawn org's session window 100% with the announced reset", async () => {
    seedIdentity("org-a");
    writeUsage(priorUsage("org-a"));
    await recordObservedLimit({ text: "Claude AI usage limit reached|1784369046", now: NOW, org: "org-a" });
    const u = loadUsage();
    expect(u?.fiveHour).toEqual({ usedPercentage: 100, resetsAt: 1_784_369_046_000 });
    expect(u?.sevenDay.usedPercentage).toBe(70); // weekly carried, never fabricated
  });

  test("a weekly-phrased limit stamps the WEEKLY window, not the 5h one", async () => {
    // a 5h-only stamp would re-seat the account in 5h against a days-dead cap.
    seedIdentity("org-a");
    writeUsage(priorUsage("org-a"));
    await recordObservedLimit({ text: "You've hit your weekly limit.", now: NOW, org: "org-a" });
    const u = loadUsage();
    expect(u?.sevenDay).toEqual({ usedPercentage: 100, resetsAt: null });
    expect(u?.fiveHour.usedPercentage).toBe(40); // session carried
  });

  test("never stamps when the spawn org is no longer live (mid-turn swap)", async () => {
    seedIdentity("org-b");
    writeUsage(priorUsage("org-b"));
    await recordObservedLimit({ text: "usage limit reached|1784369046", now: NOW, org: "org-a" });
    expect(loadUsage()?.fiveHour.usedPercentage).toBe(40);
  });

  test("never stamps without a same-org prior snapshot or a known org", async () => {
    seedIdentity("org-a");
    writeUsage(priorUsage("org-b"));
    await recordObservedLimit({ text: "usage limit reached|1784369046", now: NOW, org: "org-a" });
    expect(loadUsage()?.fiveHour.usedPercentage).toBe(40);
    await recordObservedLimit({ text: "usage limit reached|1784369046", now: NOW, org: null });
    expect(loadUsage()?.fiveHour.usedPercentage).toBe(40);
  });
});

describe("isRateLimitText", () => {
  test("matches claude's limit shapes", () => {
    expect(isRateLimitText({ text: "Claude AI usage limit reached|1784369046" })).toBe(true);
    expect(isRateLimitText({ text: "You've hit your weekly limit." })).toBe(true);
    expect(isRateLimitText({ text: "You've hit your usage limit for Fable" })).toBe(true);
    expect(isRateLimitText({ text: "API rate limit exceeded" })).toBe(true);
    expect(isRateLimitText({ text: "5-hour limit reached - resets 3pm" })).toBe(true);
    expect(isRateLimitText({ text: "You are out of extra usage" })).toBe(true);
  });

  test("ordinary failures and prose are not limits", () => {
    expect(isRateLimitText({ text: "ENOENT: no such file" })).toBe(false);
    expect(isRateLimitText({ text: "the tests failed on main" })).toBe(false);
    expect(isRateLimitText({ text: "" })).toBe(false);
  });
});

describe("TurnOutcomeSchema", () => {
  test("rateLimited is required and defaults nowhere", () => {
    expect(() => TurnOutcomeSchema.parse({ sessionId: null, failed: true, finish: false })).toThrow();
    expect(TurnOutcomeSchema.parse({ sessionId: "s", failed: true, rateLimited: true, finish: false }).rateLimited).toBe(true);
  });
});

function pgidOf(pid: number): number {
  const r = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)]);
  return Number(new TextDecoder().decode(r.stdout).trim());
}

describe("detachedClaudeSpawn", () => {
  test("child leads its own process group, apart from the daemon's", () => {
    const child = detachedClaudeSpawn({
      command: "/bin/sleep",
      args: ["5"],
      env: {},
      signal: new AbortController().signal,
    });
    try {
      expect(child.pid).toBeDefined();
      const childPid = child.pid ?? 0;
      expect(pgidOf(childPid)).toBe(childPid);
      expect(pgidOf(childPid)).not.toBe(pgidOf(process.pid));
    } finally {
      child.kill("SIGTERM");
    }
  });

  test("stderr is ignored: the SDK's SpawnedProcess contract never reads it", async () => {
    const child = detachedClaudeSpawn({ command: "/usr/bin/true", args: [], env: {}, signal: new AbortController().signal });
    expect(child.stderr).toBeNull();
    const code = await new Promise((resolve) => {
      child.once("exit", (c) => resolve(c));
    });
    expect(code).toBe(0);
  });

  test("aborting the forwarded signal SIGTERMs the detached group", async () => {
    const ac = new AbortController();
    const child = detachedClaudeSpawn({ command: "/bin/sleep", args: ["30"], env: {}, signal: ac.signal });
    const exited = new Promise((resolve) => {
      child.once("exit", (_c, sig) => resolve(sig));
    });
    ac.abort();
    expect(await exited).toBe("SIGTERM");
  });

  test("an already-aborted signal kills the child instead of leaking it", async () => {
    const ac = new AbortController();
    ac.abort();
    const child = detachedClaudeSpawn({ command: "/bin/sleep", args: ["30"], env: {}, signal: ac.signal });
    const exited = new Promise((resolve) => {
      child.once("exit", (_c, sig) => resolve(sig));
    });
    expect(await exited).toBe("SIGTERM");
  });
});

describe("cleanupThread", () => {
  test("drops the thread record and reports the close-out", () => {
    const threadId = "slack:C0GCTEST:closeout";
    saveSlackThread({ threadId, repo: "/tmp/repo", cwd: "/tmp/repo", sessionId: "s-1", createdAt: new Date().toISOString() });
    const out = cleanupThread({ threadId });
    expect(out.removed).toBe(true);
    expect(loadSlackThread(threadId)).toBeNull();
    expect(out.message).toContain("fresh @mention");
  });

  test("a record-less thread still closes out idempotently", () => {
    const out = cleanupThread({ threadId: "slack:C0GCTEST:neverexisted" });
    expect(out.removed).toBe(true);
  });
});
