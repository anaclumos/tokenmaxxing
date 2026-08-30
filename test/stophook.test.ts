import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test } from "bun:test";
import { paths } from "../src/lib/paths.ts";
import { saveAccounts } from "../src/lib/state.ts";
import { RespawnMarkerSchema } from "../src/lib/types.ts";

const repo = join(import.meta.dir, "..");
const H = 3_600_000;

const PINNED_A = "11111111-1111-4111-8111-111111111111";
const PINNED_B = "22222222-2222-4222-8222-222222222222";
const STDIN_SID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  for (const f of [paths.usageJson, paths.modelUsageJson, paths.lastSwapJson, paths.accountsJson, paths.configJson, paths.claudeJson, paths.depletedJson]) {
    rmSync(f, { force: true });
  }
  rmSync(paths.respawnDir, { recursive: true, force: true });
});

function seed(input: { sevenDayPct: number; resetInMs: number }): void {
  const now = Date.now();
  writeFileSync(paths.configJson, JSON.stringify({ policy: { switchModels: ["fable"] } }));
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
        lastUsage: {
          fiveHour: { usedPercentage: 60, resetsAt: now + 2 * H },
          sevenDay: { usedPercentage: input.sevenDayPct, resetsAt: now + input.resetInMs },
        },
        lastUsageAt: now,
      },
    ],
  });
  writeFileSync(
    paths.usageJson,
    JSON.stringify({
      fiveHour: { usedPercentage: 60, resetsAt: now + 2 * H },
      sevenDay: { usedPercentage: input.sevenDayPct, resetsAt: now + input.resetInMs },
      org: "org-A",
      ts: now,
      model: { id: "claude-sonnet-5", display: "Sonnet 5" },
    }),
  );
}

function runHook(input: { pinned?: string; supervised?: boolean; stdin: string }) {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.TOKENMAXXING_SUPERVISED;
  delete env.TOKENMAXXING_SESSION_ID;
  if (input.supervised ?? true) env.TOKENMAXXING_SUPERVISED = "1";
  if (input.pinned) env.TOKENMAXXING_SESSION_ID = input.pinned;
  return Bun.spawnSync([process.execPath, "run", join(repo, "src", "main.ts"), "__stop-hook"], {
    env,
    stdin: Buffer.from(input.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("a depleted-pool wait writes the marker keyed by the PINNED sid, resuming the STDIN sid", () => {
  seed({ sevenDayPct: 100, resetInMs: 30 * 60_000 });
  const p = runHook({ pinned: PINNED_A, stdin: JSON.stringify({ session_id: STDIN_SID }) });
  expect(p.exitCode).toBe(0);
  const markerFile = join(paths.respawnDir, PINNED_A);
  expect(existsSync(markerFile)).toBe(true);
  const marker = RespawnMarkerSchema.parse(JSON.parse(readFileSync(markerFile, "utf8")));
  expect(marker.sessionId).toBe(STDIN_SID);
  expect(marker.account).toBe("acct-a");
  expect(marker.waitUntil).toBeGreaterThan(Date.now());
  expect(readdirSync(paths.respawnDir)).toEqual([PINNED_A]);
});

test("a non-UUID stdin session_id falls back to the pinned sid", () => {
  seed({ sevenDayPct: 100, resetInMs: 30 * 60_000 });
  const p = runHook({ pinned: PINNED_B, stdin: JSON.stringify({ session_id: "not-a-uuid" }) });
  expect(p.exitCode).toBe(0);
  const marker = RespawnMarkerSchema.parse(JSON.parse(readFileSync(join(paths.respawnDir, PINNED_B), "utf8")));
  expect(marker.sessionId).toBe(PINNED_B);
});

test("engaged but under every bar writes NO marker (greedy path keeps the seat)", () => {
  seed({ sevenDayPct: 40, resetInMs: 30 * 60_000 });
  const p = runHook({ pinned: PINNED_A, stdin: JSON.stringify({ session_id: STDIN_SID }) });
  expect(p.exitCode).toBe(0);
  expect(existsSync(paths.respawnDir) && readdirSync(paths.respawnDir).length > 0).toBe(false);
});

test("an unsupervised hook writes NO marker even on a depleted pool", () => {
  seed({ sevenDayPct: 100, resetInMs: 30 * 60_000 });
  const p = runHook({ supervised: false, stdin: JSON.stringify({ session_id: STDIN_SID }) });
  expect(p.exitCode).toBe(0);
  expect(existsSync(paths.respawnDir) && readdirSync(paths.respawnDir).length > 0).toBe(false);
});
