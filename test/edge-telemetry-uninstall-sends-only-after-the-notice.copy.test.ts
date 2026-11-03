import { expect, test } from "bun:test";
import {
  HOUR_MS,
  childEnv,
  freshHomes,
  run,
  sentEvents,
  spoolEvents,
  spoolIsEmpty,
  startStubHost,
  writeState,
} from "./edge-telemetry-fixtures.ts";

test(
  "uninstall records an uninstall event and sends it right away only when the notice was shown in an earlier run",
  async () => {
    const host = startStubHost();
    try {
      const unseen = freshHomes();
      const silent = await run(["uninstall"], childEnv(unseen, host.url));
      expect(silent.exitCode).toBe(0);
      expect(host.requests).not.toHaveLength(0);
      expect(spoolEvents(unseen).some((event) => event.event === "uninstall")).toBe(true);

      const seen = freshHomes();
      const state = writeState(seen, { noticeAt: Date.now() - HOUR_MS });
      const sent = await run(["uninstall"], childEnv(seen, host.url));
      expect(sent.exitCode).toBe(0);
      expect(host.requests).toHaveLength(1);
      const uninstalls = sentEvents(host).filter((event) => event.event === "uninstall");
      expect(uninstalls).toHaveLength(1);
      expect(uninstalls[0]?.distinct_id).toBe(state.installId);
      expect(spoolIsEmpty(seen)).toBe(true);
    } finally {
      host.stop();
    }
  },
  120_000,
);
