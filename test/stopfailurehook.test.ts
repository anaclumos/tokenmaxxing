import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test } from "bun:test";
import { paths } from "../src/lib/paths.ts";
import { loadModelUsage, loadUsage, saveAccounts, saveLastSwapAt } from "../src/lib/state.ts";
import { RespawnMarkerSchema } from "../src/lib/types.ts";
import { RETRIGGER_PROMPT } from "../src/entries/stopfailurehook.ts";

const repo = join(import.meta.dir, "..");
const H = 3_600_000;
const D = 86_400_000;

const PINNED = "11111111-1111-4111-8111-111111111111";
const STDIN_SID = "33333333-3333-4333-8333-333333333333";
const transcript = join(paths.home, "stopfailure-transcript.jsonl");

beforeEach(() => {
  for (const f of [paths.usageJson, paths.modelUsageJson, paths.lastSwapJson, paths.accountsJson, paths.configJson, paths.claudeJson, paths.depletedJson, transcript]) {
    rmSync(f, { force: true });
  }
  rmSync(paths.respawnDir, { recursive: true, force: true });
});

const fakeClaude = join(paths.home, "fake-claude-stopfailure");

function seed(): void {
  const now = Date.now();
  mkdirSync(paths.home, { recursive: true });
  const clock = (() => {
    const d = new Date(now + 2 * D);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const h24 = d.getUTCHours();
    const h = h24 % 12 === 0 ? 12 : h24 % 12;
    return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${h}:${String(d.getUTCMinutes()).padStart(2, "0")}${h24 >= 12 ? "pm" : "am"} (UTC)`;
  })();
  const usage = [`Current session: 30% used · resets ${clock}`, `Current week (all models): 20% used · resets ${clock}`, `Current week (Fable): 30% used · resets ${clock}`].join("\n");
  writeFileSync(fakeClaude, `#!/bin/sh\nprintf '%s' ${JSON.stringify(JSON.stringify({ result: usage }))}\n`);
  chmodSync(fakeClaude, 0o755);
  writeFileSync(paths.configJson, JSON.stringify({ claudeBin: fakeClaude, policy: { switchModels: ["fable"] } }));
  writeFileSync(paths.claudeJson, JSON.stringify({ oauthAccount: { accountUuid: "A", emailAddress: "a@e.com", organizationUuid: "org-A" } }));
  saveAccounts({
    version: 1,
    activeAccountUuid: "A",
    accounts: [
      {
        accountUuid: "A",
        email: "a@e.com",
        organizationUuid: "org-A",
        label: "acct-a",
        keychainItem: "tokenmaxxing-cred-A",
        oauthAccount: { accountUuid: "A", emailAddress: "a@e.com", organizationUuid: "org-A" },
        addedAt: new Date(0).toISOString(),
        lastUsage: { fiveHour: { usedPercentage: 30, resetsAt: now + 2 * H }, sevenDay: { usedPercentage: 20, resetsAt: now + 3 * D } },
        lastUsageAt: now,
      },
    ],
  });
  writeFileSync(
    paths.usageJson,
    JSON.stringify({
      fiveHour: { usedPercentage: 30, resetsAt: now + 2 * H },
      sevenDay: { usedPercentage: 20, resetsAt: now + 3 * D },
      org: "org-A",
      ts: now,
      model: { id: "claude-fable-5", display: "Fable 5" },
    }),
  );
}

const SESSION_TEXT = "You've hit your session limit · resets 3pm (Asia/Seoul)";
const FABLE_TEXT = "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.";

function writeTranscript(input: { turnStart: number; errorAt: number; text: string; quotaLimits?: Record<string, unknown>; transient?: boolean }): void {
  const rows = [
    { type: "user", timestamp: new Date(input.turnStart).toISOString(), message: { role: "user", content: "keep going" } },
    {
      type: "assistant",
      timestamp: new Date(input.errorAt).toISOString(),
      isApiErrorMessage: true,
      error: "rate_limit",
      apiErrorStatus: 429,
      ...(input.quotaLimits ? { quotaLimits: input.quotaLimits } : { errorDetails: '429 {"error":{"type":"rate_limit_error","message":"x"}}' }),
      ...(input.transient ? { apiErrorIsTransient: true } : {}),
      message: { role: "assistant", content: [{ type: "text", text: input.text }] },
    },
  ];
  writeFileSync(transcript, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function runHook(input: { supervised?: boolean; launchedAt?: number; stdin: Record<string, unknown> }) {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.TOKENMAXXING_SUPERVISED;
  delete env.TOKENMAXXING_SESSION_ID;
  delete env.TOKENMAXXING_LAUNCHED_AT;
  if (input.supervised ?? true) {
    env.TOKENMAXXING_SUPERVISED = "1";
    env.TOKENMAXXING_SESSION_ID = PINNED;
  }
  if (input.launchedAt != null) env.TOKENMAXXING_LAUNCHED_AT = String(input.launchedAt);
  return Bun.spawnSync([process.execPath, "run", join(repo, "src", "main.ts"), "__stop-failure-hook"], {
    env,
    stdin: Buffer.from(JSON.stringify({ session_id: STDIN_SID, transcript_path: transcript, error: "rate_limit", hook_event_name: "StopFailure", ...input.stdin })),
    stdout: "pipe",
    stderr: "pipe",
  });
}

const markers = () => (existsSync(paths.respawnDir) ? readdirSync(paths.respawnDir) : []);

test("a session-limit failure stamps the 5h window, parks on the enforced reset, and writes a retrigger marker", () => {
  seed();
  const now = Date.now();
  const resetsAt = Math.floor((now + 30 * 60_000) / 1000);
  writeTranscript({ turnStart: now - 20_000, errorAt: now - 1_000, text: SESSION_TEXT, quotaLimits: { status: "rejected", rateLimitType: "five_hour", resetsAt } });
  const p = runHook({ launchedAt: now - 60_000, stdin: { last_assistant_message: SESSION_TEXT } });
  expect(p.exitCode).toBe(0);
  expect(loadUsage()?.fiveHour).toEqual({ usedPercentage: 100, resetsAt: resetsAt * 1000 });
  expect(markers()).toEqual([PINNED]);
  const marker = RespawnMarkerSchema.parse(JSON.parse(readFileSync(join(paths.respawnDir, PINNED), "utf8")));
  expect(marker.sessionId).toBe(STDIN_SID);
  expect(marker.prompt).toBe(RETRIGGER_PROMPT);
  expect(marker.waitUntil).toBe(resetsAt * 1000);
  expect(marker.launchedAt).toBe(now - 60_000);
});

test("the Fable credits failure stamps the family cap with the weekly reset", () => {
  seed();
  const now = Date.now();
  writeTranscript({ turnStart: now - 20_000, errorAt: now - 1_000, text: FABLE_TEXT });
  const p = runHook({ stdin: { last_assistant_message: FABLE_TEXT } });
  expect(p.exitCode).toBe(0);
  const mu = loadModelUsage();
  expect(mu?.org).toBe("org-A");
  expect(mu?.perModel["fable"]?.usedPercentage).toBe(100);
  expect(mu?.perModel["fable"]?.resetsAt).toBe(loadUsage()?.sevenDay.resetsAt ?? null);
});

test("inside the cooldown an unproven failure neither stamps nor retriggers; a post-swap launch proves it", () => {
  seed();
  const now = Date.now();
  saveLastSwapAt(now - 10_000);
  writeTranscript({ turnStart: now - 60_000, errorAt: now - 1_000, text: SESSION_TEXT, quotaLimits: { status: "rejected", rateLimitType: "five_hour", resetsAt: Math.floor((now + 30 * 60_000) / 1000) } });
  let p = runHook({ stdin: { last_assistant_message: SESSION_TEXT } });
  expect(p.exitCode).toBe(0);
  expect(loadUsage()?.fiveHour.usedPercentage).toBe(30);
  expect(markers()).toEqual([]);

  p = runHook({ launchedAt: now - 5_000, stdin: { last_assistant_message: SESSION_TEXT } });
  expect(p.exitCode).toBe(0);
  expect(loadUsage()?.fiveHour.usedPercentage).toBe(100);
  expect(markers()).toEqual([PINNED]);
});

test("a subagent failure stamps but never respawns the parent", () => {
  seed();
  const now = Date.now();
  writeTranscript({ turnStart: now - 20_000, errorAt: now - 1_000, text: FABLE_TEXT });
  const p = runHook({ stdin: { last_assistant_message: FABLE_TEXT, agent_id: "agent-1" } });
  expect(p.exitCode).toBe(0);
  expect(loadModelUsage()?.perModel["fable"]?.usedPercentage).toBe(100);
  expect(markers()).toEqual([]);
});

test("a transient 429 and a non-rate_limit error leave everything alone", () => {
  seed();
  const now = Date.now();
  const text = "Server is temporarily limiting requests (not your usage limit)";
  writeTranscript({ turnStart: now - 20_000, errorAt: now - 1_000, text, transient: true });
  let p = runHook({ stdin: { last_assistant_message: text } });
  expect(p.exitCode).toBe(0);
  expect(loadUsage()?.fiveHour.usedPercentage).toBe(30);
  expect(loadModelUsage()?.perModel["fable"]).toBeUndefined();
  expect(loadModelUsage()?.perModel["Fable"]?.usedPercentage).toBe(30);
  expect(markers()).toEqual([]);

  writeTranscript({ turnStart: now - 20_000, errorAt: now - 1_000, text: SESSION_TEXT, quotaLimits: { rateLimitType: "five_hour", resetsAt: Math.floor((now + H) / 1000) } });
  p = runHook({ stdin: { last_assistant_message: SESSION_TEXT, error: "authentication_failed" } });
  expect(p.exitCode).toBe(0);
  expect(loadUsage()?.fiveHour.usedPercentage).toBe(30);
  expect(markers()).toEqual([]);
}, 30_000);

test("an unsupervised session gets the stamp but no marker", () => {
  seed();
  const now = Date.now();
  writeTranscript({ turnStart: now - 20_000, errorAt: now - 1_000, text: SESSION_TEXT, quotaLimits: { rateLimitType: "five_hour", resetsAt: Math.floor((now + 30 * 60_000) / 1000) } });
  const p = runHook({ supervised: false, stdin: { last_assistant_message: SESSION_TEXT } });
  expect(p.exitCode).toBe(0);
  expect(loadUsage()?.fiveHour.usedPercentage).toBe(100);
  expect(markers()).toEqual([]);
});
