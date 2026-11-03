import { expect, test } from "bun:test";
import {
  DAY_MS,
  childEnv,
  freshHomes,
  readConfig,
  run,
  spoolEvents,
  spoolIsEmpty,
  startStubHost,
  writeState,
} from "./edge-telemetry-fixtures.ts";

test(
  "telemetry off writes telemetry false, deletes the unsent events, stops recording and sending, and telemetry on resumes recording",
  async () => {
    const host = startStubHost();
    try {
      const homes = freshHomes();
      const env = childEnv(homes, host.url);
      await run(["status", "--cached"], env);
      expect(spoolIsEmpty(homes)).toBe(false);

      const off = await run(["telemetry", "off"], env);
      expect(off.exitCode).toBe(0);
      expect(readConfig(homes)?.telemetry).toBe(false);
      expect(spoolIsEmpty(homes)).toBe(true);

      await run(["status", "--cached"], env);
      await run(["emails"], env);
      expect(spoolIsEmpty(homes)).toBe(true);

      writeState(homes, { noticeAt: Date.now() - 2 * DAY_MS });
      await run(["check"], env);
      expect(host.requests).toHaveLength(0);

      const offState = await run(["telemetry"], env);
      expect(offState.exitCode).toBe(0);
      expect(offState.stdout.toLowerCase()).toMatch(/\boff\b|disabled|false/);

      const on = await run(["telemetry", "on"], env);
      expect(on.exitCode).toBe(0);
      expect(readConfig(homes)?.telemetry).not.toBe(false);

      await run(["status", "--cached"], env);
      const commands = spoolEvents(homes).filter((event) => event.event === "command");
      expect(commands.length).toBeGreaterThanOrEqual(1);

      const onState = await run(["telemetry"], env);
      expect(onState.exitCode).toBe(0);
      expect(onState.stdout.toLowerCase()).toMatch(/\bon\b|enabled|true/);
    } finally {
      host.stop();
    }
  },
  120_000,
);
