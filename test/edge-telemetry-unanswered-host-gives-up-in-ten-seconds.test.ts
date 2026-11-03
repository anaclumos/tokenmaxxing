import { expect, test } from "bun:test";
import {
  DAY_MS,
  childEnv,
  freshHomes,
  readState,
  run,
  spoolIsEmpty,
  startStubHost,
  writeState,
} from "./edge-telemetry-fixtures.ts";

test(
  "a host that never answers holds check for about ten seconds, keeps the spool, and the next check sends nothing",
  async () => {
    const host = startStubHost("hang");
    try {
      const homes = freshHomes();
      const env = childEnv(homes, host.url);
      await run(["status", "--cached"], env);
      expect(spoolIsEmpty(homes)).toBe(false);
      writeState(homes, { noticeAt: Date.now() - 2 * DAY_MS });

      const check = await run(["check"], env, { timeoutMs: 90_000 });
      expect(check.durationMs).toBeGreaterThanOrEqual(3_000);
      expect(check.durationMs).toBeLessThan(45_000);
      expect(host.requests).toHaveLength(1);
      expect(spoolIsEmpty(homes)).toBe(false);
      expect(typeof readState(homes)?.attemptedAt).toBe("number");

      host.setBehavior("accept");
      await run(["check"], env, { timeoutMs: 90_000 });
      expect(host.requests).toHaveLength(1);
      expect(spoolIsEmpty(homes)).toBe(false);
    } finally {
      host.stop();
    }
  },
  240_000,
);
