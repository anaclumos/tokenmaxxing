import { expect, test } from "bun:test";
import { childEnv, freshHomes, readConfig, run, spoolIsEmpty, startStubHost } from "./edge-telemetry-fixtures.ts";

test(
  "DO_NOT_TRACK=1 or TOKENMAXXING_TELEMETRY=off records nothing, writes telemetry false, deletes the unsent events, and stays off, while DO_NOT_TRACK=0 keeps it on",
  async () => {
    const host = startStubHost();
    try {
      const doNotTrack = freshHomes();
      await run(["status", "--cached"], childEnv(doNotTrack, host.url));
      expect(spoolIsEmpty(doNotTrack)).toBe(false);

      await run(["status", "--cached"], childEnv(doNotTrack, host.url, { DO_NOT_TRACK: "1" }));
      expect(readConfig(doNotTrack)?.telemetry).toBe(false);
      expect(spoolIsEmpty(doNotTrack)).toBe(true);

      await run(["status", "--cached"], childEnv(doNotTrack, host.url));
      await run(["emails"], childEnv(doNotTrack, host.url));
      expect(spoolIsEmpty(doNotTrack)).toBe(true);

      const zero = freshHomes();
      await run(["status", "--cached"], childEnv(zero, host.url, { DO_NOT_TRACK: "0" }));
      expect(readConfig(zero)?.telemetry).not.toBe(false);
      expect(spoolIsEmpty(zero)).toBe(false);

      const variable = freshHomes();
      await run(["status", "--cached"], childEnv(variable, host.url, { TOKENMAXXING_TELEMETRY: "off" }));
      expect(readConfig(variable)?.telemetry).toBe(false);
      expect(spoolIsEmpty(variable)).toBe(true);

      await run(["status", "--cached"], childEnv(variable, host.url));
      expect(spoolIsEmpty(variable)).toBe(true);
      expect(host.requests).toHaveLength(0);
    } finally {
      host.stop();
    }
  },
  120_000,
);
