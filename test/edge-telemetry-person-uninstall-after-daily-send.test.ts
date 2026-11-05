import { expect, test } from "bun:test";
import { DAY_MS, freshHomes, run, startStubHost, writeState } from "./edge-telemetry-fixtures.ts";
import { distinctIds, eventNames, hermeticEnv, personFaults, sentEvents } from "./edge-telemetry-person-fixtures.ts";

test(
  "the uninstall send after a daily send goes out under the same install ID, so both land on one person with no person properties",
  async () => {
    const host = startStubHost();
    try {
      const homes = freshHomes();
      const env = hermeticEnv(homes, host.url);
      await run(["status", "--cached"], env);
      const state = writeState(homes, { noticeAt: Date.now() - 2 * DAY_MS });
      await run(["check"], env);
      const daily = sentEvents(host);
      expect(eventNames(daily)).toEqual(["command", "install_daily"]);

      await run(["emails", "--codex"], env);
      const uninstallFrom = host.requests.length;
      const uninstall = await run(["uninstall"], env);
      const uninstallSend = sentEvents(host, uninstallFrom);
      expect({
        uninstallEvents: uninstallSend.filter((event) => event.event === "uninstall").length,
        stderr: uninstall.stderr,
      }).toMatchObject({ uninstallEvents: 1 });
      expect(distinctIds([...daily, ...uninstallSend])).toEqual([state.installId]);
      expect(personFaults([...daily, ...uninstallSend], state.installId)).toEqual([]);
    } finally {
      host.stop();
    }
  },
  120_000,
);
