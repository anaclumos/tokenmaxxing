import { expect, test } from "bun:test";
import { DAY_MS, freshHomes, run, startStubHost, writeState } from "./edge-telemetry-fixtures.ts";
import { eventNames, hermeticEnv, personFaults, sentEvents } from "./edge-telemetry-person-fixtures.ts";

test(
  "every event of the daily send and the uninstall send asks PostHog to skip GeoIP, so the install's person gets no location properties",
  async () => {
    const host = startStubHost();
    try {
      const homes = freshHomes();
      const env = hermeticEnv(homes, host.url);
      await run(["status", "--cached"], env);
      await run(["emails", "--codex"], env);
      const state = writeState(homes, { noticeAt: Date.now() - 2 * DAY_MS });
      await run(["check"], env);
      await run(["telemetry"], env);
      await run(["uninstall"], env);
      const sent = sentEvents(host);

      expect(eventNames(sent)).toEqual(expect.arrayContaining(["command", "install_daily", "uninstall"]));
      expect(sent.filter((event) => event.properties.$geoip_disable !== true).map((event) => event.event)).toEqual([]);
      expect(personFaults(sent, state.installId)).toEqual([]);
    } finally {
      host.stop();
    }
  },
  120_000,
);
