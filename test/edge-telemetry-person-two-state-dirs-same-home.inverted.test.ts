import { expect, test } from "bun:test";
import { DAY_MS, freshHomes, run, startStubHost, writeState } from "./edge-telemetry-fixtures.ts";
import { distinctIds, hermeticEnv, installIdOf, personFaults, sentEvents } from "./edge-telemetry-person-fixtures.ts";

test(
  "inverted: two installs for the same user and HOME, each with its own state directory, get different install IDs and send as two separate persons",
  async () => {
    const host = startStubHost();
    try {
      const first = freshHomes();
      const second = { home: first.home, state: freshHomes().state };
      await run(["status", "--cached"], hermeticEnv(first, host.url));
      await run(["status", "--cached"], hermeticEnv(second, host.url));
      const firstId = installIdOf(first);
      const secondId = installIdOf(second);

      writeState(first, { noticeAt: Date.now() - 2 * DAY_MS });
      await run(["check"], hermeticEnv(first, host.url));
      const firstSent = sentEvents(host);
      const secondFrom = host.requests.length;
      writeState(second, { noticeAt: Date.now() - 2 * DAY_MS });
      await run(["check"], hermeticEnv(second, host.url));
      const secondSent = sentEvents(host, secondFrom);

      expect(firstId).toBe(secondId);
      expect([distinctIds(firstSent), distinctIds(secondSent)]).not.toEqual([[firstId], [secondId]]);
      expect([...personFaults(firstSent, firstId), ...personFaults(secondSent, secondId)]).not.toEqual([]);
    } finally {
      host.stop();
    }
  },
  120_000,
);
