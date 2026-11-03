import { expect, test } from "bun:test";
import {
  childEnv,
  freshHomes,
  leafValues,
  run,
  spoolEvents,
  spoolText,
  startStubHost,
} from "./edge-telemetry-fixtures.ts";

test(
  "an unknown command records one command event named unknown with its exit code and never its argument",
  async () => {
    const host = startStubHost();
    try {
      const homes = freshHomes();
      const argument = `argument-${crypto.randomUUID()}`;
      const result = await run(["frobnicate", argument], childEnv(homes, host.url));
      expect(result.exitCode).not.toBe(0);
      const commands = spoolEvents(homes).filter((event) => event.event === "command");
      expect(commands).toHaveLength(1);
      const values = leafValues(commands[0]);
      expect(values).not.toContain("unknown");
      expect(values).toContain(result.exitCode);
      expect(spoolText(homes)).not.toContain(argument);
      expect(host.requests).toHaveLength(0);
    } finally {
      host.stop();
    }
  },
  120_000,
);
