import { expect, test } from "bun:test";
import { DAY_MS, freshHomes, run, spoolIsEmpty, startStubHost, writeState } from "./edge-telemetry-fixtures.ts";
import { hermeticEnv, installIdOf, personFaults, sentEvents } from "./edge-telemetry-person-fixtures.ts";

test(
  "events kept after a failed send go out the next day under the same install ID as an identified person with no person properties",
  async () => {
    const host = startStubHost();
    const unreachable = startStubHost();
    unreachable.stop();
    try {
      const homes = freshHomes();
      const env = hermeticEnv(homes, host.url);
      await run(["status", "--cached"], env);
      await run(["emails", "--codex"], env);
      const state = writeState(homes, { noticeAt: Date.now() - 2 * DAY_MS });
      await run(["check"], hermeticEnv(homes, unreachable.url));
      expect(host.requests).toHaveLength(0);
      expect(spoolIsEmpty(homes)).toBe(false);

      writeState(homes, { attemptedAt: Date.now() - 2 * DAY_MS });
      await run(["check"], env);
      const sent = sentEvents(host);
      expect(sent.filter((event) => event.event === "command")).toHaveLength(2);
      expect(sent.filter((event) => event.event === "install_daily").length).toBeGreaterThanOrEqual(1);
      expect(personFaults(sent, state.installId)).toEqual([]);
      expect(installIdOf(homes)).toBe(state.installId);
    } finally {
      host.stop();
    }
  },
  120_000,
);
