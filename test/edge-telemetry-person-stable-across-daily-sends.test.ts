import { expect, test } from "bun:test";
import { DAY_MS, freshHomes, run, startStubHost, writeState } from "./edge-telemetry-fixtures.ts";
import { type SentEvent, distinctIds, hermeticEnv, installIdOf, personFaults, sentEvents } from "./edge-telemetry-person-fixtures.ts";

test(
  "three daily sends on three days all go out under the one install ID kept in telemetry.json, so PostHog sees one person",
  async () => {
    const host = startStubHost();
    try {
      const homes = freshHomes();
      const env = hermeticEnv(homes, host.url);
      const days: SentEvent[][] = [];

      await run(["status", "--cached"], env);
      const state = writeState(homes, { noticeAt: Date.now() - 3 * DAY_MS });
      await run(["check"], env);
      days.push(sentEvents(host));

      for (const args of [["emails", "--codex"], ["telemetry"]]) {
        await run(args, env);
        const from = host.requests.length;
        writeState(homes, { attemptedAt: Date.now() - 2 * DAY_MS });
        await run(["check"], env);
        days.push(sentEvents(host, from));
      }

      expect(days.map((day) => day.filter((event) => event.event === "install_daily").length)).toEqual([1, 1, 1]);
      expect(days.map(distinctIds)).toEqual([[state.installId], [state.installId], [state.installId]]);
      expect(personFaults(days.flat(), state.installId)).toEqual([]);
      expect(installIdOf(homes)).toBe(state.installId);
    } finally {
      host.stop();
    }
  },
  120_000,
);
