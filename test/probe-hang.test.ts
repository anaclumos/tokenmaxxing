// Regression: a probe child that exits while a leaked descendant still holds
// the inherited stdout/stderr pipes must not wedge probeUsage until the
// descendant dies (pre-fix it blocked on pipe EOF forever - the 2026-07-12
// forever-hung `/usage` probes). probeUsage must give up within
// child-exit + grace per attempt, treating withheld output as a failed probe.

import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../src/lib/paths.ts";
import { saveConfig } from "../src/lib/state.ts";
import { probeUsage } from "../src/lib/usage.ts";

const scratch = join(paths.home, "probe-hang-test");
const sleeperPids = join(scratch, "sleeper-pids");

afterAll(() => {
  // reap the deliberately-leaked pipe holders so runs don't leave orphans;
  // a missing pid file (no sleepers spawned) or an already-exited pid is fine.
  try {
    for (const pid of readFileSync(sleeperPids, "utf8").trim().split("\n")) {
      if (!pid) continue;
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch (e) {
        if ((e as { code?: string }).code !== "ESRCH") throw e;
      }
    }
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") throw e;
  }
  rmSync(scratch, { recursive: true, force: true });
  rmSync(paths.configJson, { force: true });
});

test(
  "a leaked pipe-holding descendant does not wedge probeUsage",
  async () => {
    mkdirSync(scratch, { recursive: true });
    const fake = join(scratch, "claude");
    // exits immediately but leaves a background child holding the pipes open
    writeFileSync(fake, `#!/bin/sh\nsleep 30 &\necho $! >> ${JSON.stringify(sleeperPids)}\necho '{"result":"Current session: 10% used"}'\nexit 0\n`);
    chmodSync(fake, 0o755);
    saveConfig({ thresholds: { session: 95, weekly: 98 }, claudeBin: fake, codexBin: "", policy: { projectionMargin: 0, greedySessionFloor: 50, switchModels: ["fable"], usagePollTtlMs: 90_000, maxWaitMs: 3_600_000 } });

    const started = Date.now();
    const result = await probeUsage();
    const elapsed = Date.now() - started;

    // pipe EOF never arrived within the grace, so every attempt reports failure
    expect(result).toBeNull();
    // 3 attempts * (instant exit + 2s grace) + 2s + 5s retry delays ≈ 13s;
    // anywhere under the holder's 30s lifetime proves the reads were bounded.
    expect(elapsed).toBeLessThan(25_000);
  },
  30_000,
);
