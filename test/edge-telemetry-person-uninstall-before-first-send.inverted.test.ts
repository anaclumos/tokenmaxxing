import { expect, test } from "bun:test";
import { freshHomes, run, startStubHost, writeState } from "./edge-telemetry-fixtures.ts";
import { hermeticEnv, personFaults, sentEvents } from "./edge-telemetry-person-fixtures.ts";

test(
  "inverted: uninstall on the day of the notice, before any daily send, sends its uninstall event at once under the install ID with no person properties",
  async () => {
    const host = startStubHost();
    try {
      const homes = freshHomes();
      const env = hermeticEnv(homes, host.url);
      await run(["status", "--cached"], env);
      await run(["emails"], env);
      const state = writeState(homes, { noticeAt: Date.now() - 60_000 });
      expect(host.requests).toHaveLength(0);

      const uninstall = await run(["uninstall"], env);
      const sent = sentEvents(host);
      expect({
        uninstallEvents: sent.filter((event) => event.event === "uninstall").length,
        stderr: uninstall.stderr,
      }).not.toMatchObject({ uninstallEvents: 1 });
      expect(personFaults(sent, state.installId)).not.toEqual([]);
    } finally {
      host.stop();
    }
  },
  120_000,
);
