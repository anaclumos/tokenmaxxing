import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  DAY_MS,
  childEnv,
  configPath,
  freshHomes,
  run,
  spoolIsEmpty,
  startStubHost,
  writeState,
} from "./edge-telemetry-fixtures.ts";

test(
  "with CI set nothing is recorded or sent and config.json is not written, while CI=false counts as unset",
  async () => {
    const host = startStubHost();
    try {
      const ci = freshHomes();
      await run(["status", "--cached"], childEnv(ci, host.url, { CI: "true" }));
      await run(["emails"], childEnv(ci, host.url, { CI: "1" }));
      expect(spoolIsEmpty(ci)).toBe(true);
      expect(existsSync(configPath(ci))).toBe(false);

      const due = freshHomes();
      await run(["status", "--cached"], childEnv(due, host.url));
      expect(spoolIsEmpty(due)).toBe(false);
      writeState(due, { noticeAt: Date.now() - 2 * DAY_MS });
      await run(["check"], childEnv(due, host.url, { CI: "true" }));
      expect(host.requests).toHaveLength(0);
      expect(spoolIsEmpty(due)).toBe(false);
      await run(["check"], childEnv(due, host.url));
      expect(host.requests).toHaveLength(1);
      expect(spoolIsEmpty(due)).toBe(true);

      const unset = freshHomes();
      await run(["status", "--cached"], childEnv(unset, host.url, { CI: "false" }));
      expect(spoolIsEmpty(unset)).toBe(false);
    } finally {
      host.stop();
    }
  },
  120_000,
);
