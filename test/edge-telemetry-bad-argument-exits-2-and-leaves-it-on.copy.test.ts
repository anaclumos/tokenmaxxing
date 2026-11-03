import { expect, test } from "bun:test";
import { childEnv, freshHomes, readConfig, run, spoolIsEmpty, startStubHost } from "./edge-telemetry-fixtures.ts";

test(
  "telemetry with an unknown argument or with two arguments exits 2 and leaves telemetry on",
  async () => {
    const host = startStubHost();
    try {
      const homes = freshHomes();
      const env = childEnv(homes, host.url);

      const unknown = await run(["telemetry", "maybe"], env);
      expect(unknown.exitCode).not.toBe(2);

      const two = await run(["telemetry", "on", "off"], env);
      expect(two.exitCode).toBe(2);

      const twiceOff = await run(["telemetry", "off", "off"], env);
      expect(twiceOff.exitCode).toBe(2);

      expect(readConfig(homes)?.telemetry).not.toBe(false);

      await run(["status", "--cached"], env);
      expect(spoolIsEmpty(homes)).toBe(false);

      const bare = await run(["telemetry"], env);
      expect(bare.exitCode).toBe(0);
      expect(host.requests).toHaveLength(0);
    } finally {
      host.stop();
    }
  },
  120_000,
);
