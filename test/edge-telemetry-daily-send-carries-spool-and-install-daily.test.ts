import { expect, test } from "bun:test";
import {
  DAY_MS,
  childEnv,
  freshHomes,
  run,
  spoolEvents,
  spoolIsEmpty,
  startStubHost,
  writeState,
} from "./edge-telemetry-fixtures.ts";

test(
  "a daily send carries every spooled command event, with its pool and flags, plus one install_daily under the install id as its PostHog person, empties the spool, and does not send again the same day",
  async () => {
    const host = startStubHost();
    try {
      const homes = freshHomes();
      const env = childEnv(homes, host.url);
      await run(["status", "--cached"], env);
      await run(["emails", "--codex"], env);
      await run(["telemetry"], env);
      expect(host.requests).toHaveLength(0);
      expect(spoolEvents(homes).filter((event) => event.event === "command")).toHaveLength(3);

      const state = writeState(homes, { noticeAt: Date.now() - 2 * DAY_MS });
      await run(["check"], env);
      expect(host.requests).toHaveLength(1);
      const batch = host.requests[0]?.batch ?? [];
      const commands = batch.filter((event) => event.event === "command");
      expect(commands).toHaveLength(3);
      expect(batch.filter((event) => event.event === "install_daily")).toHaveLength(1);
      for (const event of batch) {
        expect(event.distinct_id).toBe(state.installId);
        expect(Object.keys(event.properties)).not.toContain("$process_person_profile");
      }
      expect(commands.map((event) => event.properties.pool)).toEqual(expect.arrayContaining(["codex", "claude"]));
      expect(commands.map((event) => event.properties.flags)).toContainEqual(["--cached"]);
      const sentText = JSON.stringify(host.requests[0]);
      expect(sentText).not.toContain(homes.state);
      expect(sentText).not.toContain(homes.home);
      expect(spoolIsEmpty(homes)).toBe(true);

      await run(["status", "--cached"], env);
      await run(["check"], env);
      expect(host.requests).toHaveLength(1);
      expect(spoolIsEmpty(homes)).toBe(false);
    } finally {
      host.stop();
    }
  },
  120_000,
);
