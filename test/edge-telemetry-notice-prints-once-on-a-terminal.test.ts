import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  childEnv,
  freshHomes,
  packageVersion,
  readState,
  run,
  runOnTerminal,
  spoolEvents,
  spoolIsEmpty,
  startStubHost,
} from "./edge-telemetry-fixtures.ts";

test(
  "the notice prints once on a terminal stderr, never for --json, help, or --version, nothing is sent before it, and --version creates no state",
  async () => {
    const host = startStubHost();
    try {
      const homes = freshHomes();
      const env = childEnv(homes, host.url);

      const json = await runOnTerminal(["status", "--cached", "--json"], env);
      expect(json.stdout).not.toMatch(/telemetry/i);
      expect(readState(homes)?.noticeAt ?? null).toBeNull();
      const recordedByJson = spoolEvents(homes).filter((event) => event.event === "command").length;
      expect(recordedByJson).toBe(1);

      await runOnTerminal(["help"], env);
      await runOnTerminal(["--version"], env);
      expect(readState(homes)?.noticeAt ?? null).toBeNull();
      expect(spoolEvents(homes).filter((event) => event.event === "command")).toHaveLength(recordedByJson);

      const first = await runOnTerminal(["status", "--cached"], env);
      expect(first.stdout).toMatch(/telemetry/i);
      const noticeAt = readState(homes)?.noticeAt ?? null;
      expect(typeof noticeAt).toBe("number");
      expect(Math.abs(Date.now() - (noticeAt ?? 0))).toBeLessThan(10 * 60 * 1000);

      const second = await runOnTerminal(["status", "--cached"], env);
      expect(second.stdout).not.toMatch(/telemetry/i);
      expect(readState(homes)?.noticeAt).toBe(noticeAt);

      await run(["check"], env);
      expect(host.requests).toHaveLength(0);
      expect(spoolIsEmpty(homes)).toBe(false);

      const piped = freshHomes();
      const redirected = await run(["status", "--cached"], childEnv(piped, host.url));
      expect(redirected.stderr).not.toMatch(/telemetry/i);
      expect(readState(piped)?.noticeAt ?? null).toBeNull();

      const neverCreated = join(piped.state, "never-created");
      const version = await run(["--version"], childEnv(piped, host.url, { TOKENMAXXING_HOME: neverCreated }));
      expect(version.exitCode).toBe(0);
      expect(version.stdout).toContain(packageVersion());
      expect(existsSync(neverCreated)).toBe(false);
      expect(host.requests).toHaveLength(0);
    } finally {
      host.stop();
    }
  },
  120_000,
);
