import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { cmdCheck } from "../src/cli/check.ts";
import { paths } from "../src/lib/paths.ts";
import { loadNextCheckDueAt, saveAccounts, saveModelUsage, saveNextCheckDueAt } from "../src/lib/state.ts";

const D = 86_400_000;
const H = 3_600_000;
const fakeClaude = join(paths.home, "fake-claude-check");
const probeMarker = join(paths.home, "probe-ran-check");

function clearState(): void {
  for (const f of [paths.usageJson, paths.modelUsageJson, paths.lastSwapJson, paths.accountsJson, paths.configJson, paths.claudeJson, paths.depletedJson, paths.nextCheckJson, probeMarker, fakeClaude]) {
    rmSync(f, { force: true });
  }
}

function seed(): void {
  const now = Date.now();
  writeFileSync(fakeClaude, `#!/bin/sh\ntouch ${JSON.stringify(probeMarker)}\nprintf '%s' '{"result":""}'\n`);
  chmodSync(fakeClaude, 0o755);
  writeFileSync(paths.configJson, JSON.stringify({ claudeBin: fakeClaude, policy: { switchModels: ["fable"] } }));
  writeFileSync(paths.claudeJson, JSON.stringify({ oauthAccount: { accountUuid: "A", emailAddress: "A@e.com", organizationUuid: "org-A" } }));
  saveAccounts({
    version: 1,
    activeAccountUuid: "A",
    accounts: [
      {
        accountUuid: "A",
        email: "A@e.com",
        organizationUuid: "org-A",
        label: "A",
        keychainItem: "tokenmaxxing-cred-A",
        oauthAccount: { accountUuid: "A", emailAddress: "A@e.com", organizationUuid: "org-A" },
        addedAt: new Date(0).toISOString(),
      },
    ],
  });
  writeFileSync(
    paths.usageJson,
    JSON.stringify({
      fiveHour: { usedPercentage: 10, resetsAt: now + 2 * H },
      sevenDay: { usedPercentage: 20, resetsAt: now + 2 * D },
      org: "org-A",
      ts: now,
      model: { id: "claude-fable-5", display: "Fable 5" },
    }),
  );
  saveModelUsage({ perModel: { Fable: { usedPercentage: 30, resetsAt: now + 2 * D } }, org: "org-A", ts: now, sampledAt: now });
}

beforeEach(clearState);
afterAll(clearState);

test("an evaluation schedules the next one from headroom, and a tick before that exits without probing", async () => {
  seed();
  expect(await cmdCheck()).toBe(0);
  const dueAt = loadNextCheckDueAt(Date.now());
  expect(dueAt).not.toBeNull();
  expect(dueAt! - Date.now()).toBeGreaterThan(290_000);
  rmSync(probeMarker, { force: true });
  rmSync(paths.modelUsageJson, { force: true });
  expect(await cmdCheck()).toBe(0);
  expect(existsSync(probeMarker)).toBe(false);
});

test("an absent, corrupt, or far-future schedule is due now", async () => {
  seed();
  const now = Date.now();
  expect(loadNextCheckDueAt(now)).toBeNull();
  writeFileSync(paths.nextCheckJson, "{ nope");
  expect(loadNextCheckDueAt(now)).toBeNull();
  saveNextCheckDueAt({ dueAt: now + 3 * H, ts: now });
  expect(loadNextCheckDueAt(now)).toBeNull();
  saveNextCheckDueAt({ dueAt: now + 120_000, ts: now });
  expect(loadNextCheckDueAt(now)).toBe(now + 120_000);
  expect(await cmdCheck()).toBe(0);
  expect(loadNextCheckDueAt(now)).toBe(now + 120_000);
});
