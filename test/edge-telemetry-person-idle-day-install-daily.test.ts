import { expect, test } from "bun:test";
import { DAY_MS, freshHomes, run, spoolIsEmpty, startStubHost, writeState } from "./edge-telemetry-fixtures.ts";
import { eventNames, hermeticEnv, personFaults, sentEvents } from "./edge-telemetry-person-fixtures.ts";

test(
  "a day with nothing recorded still sends install_daily as the same person, with no person properties",
  async () => {
    const host = startStubHost();
    try {
      const homes = freshHomes();
      const env = hermeticEnv(homes, host.url);
      await run(["status", "--cached"], env);
      const state = writeState(homes, { noticeAt: Date.now() - 2 * DAY_MS });
      await run(["check"], env);
      const firstDay = sentEvents(host);
      expect(eventNames(firstDay)).toEqual(["command", "install_daily"]);
      expect(spoolIsEmpty(homes)).toBe(true);

      const idleFrom = host.requests.length;
      writeState(homes, { attemptedAt: Date.now() - 2 * DAY_MS });
      await run(["check"], env);
      const idleDay = sentEvents(host, idleFrom);
      expect(eventNames(idleDay)).toEqual(["install_daily"]);
      expect(personFaults([...firstDay, ...idleDay], state.installId)).toEqual([]);
    } finally {
      host.stop();
    }
  },
  120_000,
);
