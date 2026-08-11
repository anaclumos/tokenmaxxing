// parseUsageLimitEpoch + recordObservedLimit: limit text → usage.json stamps.

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { parseUsageLimitEpoch, recordObservedLimit } from "../src/lib/usage.ts";
import { loadUsage, writeUsage } from "../src/lib/state.ts";

const NOW = 1_784_400_000_000;

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
