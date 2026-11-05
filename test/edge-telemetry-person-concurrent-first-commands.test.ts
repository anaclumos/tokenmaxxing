import { expect, test } from "bun:test";
import { DAY_MS, freshHomes, run, startStubHost, writeState } from "./edge-telemetry-fixtures.ts";
import { distinctIds, hermeticEnv, personFaults, sentEvents } from "./edge-telemetry-person-fixtures.ts";

test(
  "four first commands that run at once on a fresh install still send as one person under the single install ID",
  async () => {
    const host = startStubHost();
    try {
      const homes = freshHomes();
      const env = hermeticEnv(homes, host.url);
      await Promise.all([["status", "--cached"], ["emails"], ["emails", "--codex"], ["telemetry"]].map((args) => run(args, env)));
      const state = writeState(homes, { noticeAt: Date.now() - 2 * DAY_MS });
      await run(["check"], env);
      const sent = sentEvents(host);

      expect(sent.filter((event) => event.event === "command")).toHaveLength(4);
      expect(distinctIds(sent)).toEqual([state.installId]);
      expect(personFaults(sent, state.installId)).toEqual([]);
    } finally {
      host.stop();
    }
  },
  120_000,
);
