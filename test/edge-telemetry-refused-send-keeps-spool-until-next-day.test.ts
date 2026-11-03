import { expect, test } from "bun:test";
import {
  DAY_MS,
  HOUR_MS,
  childEnv,
  freshHomes,
  readState,
  run,
  spoolIsEmpty,
  startStubHost,
  writeState,
} from "./edge-telemetry-fixtures.ts";

test(
  "a send the host refuses keeps the spool, the next check within a day does not retry, and a check a day later sends the kept events",
  async () => {
    const host = startStubHost("refuse");
    try {
      const homes = freshHomes();
      const env = childEnv(homes, host.url);
      await run(["status", "--cached"], env);
      expect(spoolIsEmpty(homes)).toBe(false);
      writeState(homes, { noticeAt: Date.now() - 2 * DAY_MS });

      await run(["check"], env);
      expect(host.requests).toHaveLength(1);
      expect(spoolIsEmpty(homes)).toBe(false);
      const attemptedAt = readState(homes)?.attemptedAt ?? null;
      expect(typeof attemptedAt).toBe("number");
      expect(Math.abs(Date.now() - (attemptedAt ?? 0))).toBeLessThan(10 * 60 * 1000);

      host.setBehavior("accept");
      await run(["check"], env);
      expect(host.requests).toHaveLength(1);
      expect(spoolIsEmpty(homes)).toBe(false);

      writeState(homes, { attemptedAt: Date.now() - 25 * HOUR_MS });
      await run(["check"], env);
      expect(host.requests).toHaveLength(2);
      const resent = host.requests[1]?.batch ?? [];
      expect(resent.some((event) => event.event === "command")).toBe(true);
      expect(spoolIsEmpty(homes)).toBe(true);
    } finally {
      host.stop();
    }
  },
  120_000,
);
