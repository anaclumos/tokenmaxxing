import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../src/lib/paths.ts";
import { probeUsage } from "../src/lib/usage.ts";

const scratch = join(paths.home, "probe-hang-test");
const sleeperPids = join(scratch, "sleeper-pids");

afterAll(() => {
  try {
    for (const pid of readFileSync(sleeperPids, "utf8").trim().split("\n")) {
      if (!pid) continue;
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch (e) {
        if (!(e instanceof Error && "code" in e && e.code === "ESRCH")) throw e;
      }
    }
  } catch (e) {
    if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
  }
  rmSync(scratch, { recursive: true, force: true });
  rmSync(paths.configJson, { force: true });
});

test(
  "a leaked pipe-holding descendant does not wedge probeUsage",
  async () => {
    mkdirSync(scratch, { recursive: true });
    const fake = join(scratch, "claude");
    writeFileSync(fake, `#!/bin/sh\nsleep 30 &\necho $! >> ${JSON.stringify(sleeperPids)}\necho '{"result":"Current session: 10% used"}'\nexit 0\n`);
    chmodSync(fake, 0o755);
    writeFileSync(paths.configJson, JSON.stringify({ thresholds: { session: 95, weekly: 98 }, claudeBin: fake, codexBin: "", policy: { projectionMargin: 0, greedySessionFloor: 50, switchModels: ["fable"], usagePollTtlMs: 90_000, maxWaitMs: 3_600_000 } }));

    const started = Date.now();
    const result = await probeUsage();
    const elapsed = Date.now() - started;

    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(25_000);
  },
  30_000,
);
