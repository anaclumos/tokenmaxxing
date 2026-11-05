import { expect, test } from "bun:test";
import { DAY_MS, freshHomes, run, spoolEvents, startStubHost, writeState } from "./edge-telemetry-fixtures.ts";
import { eventNames, hermeticEnv, personFaults, sentEvents, spooledLike, writeSpool } from "./edge-telemetry-person-fixtures.ts";

const SPOOLED: Array<[string, Record<string, unknown>]> = [
  ["session_end", { tool: "claude", stdinTty: true, moves: 1, ended: "exit", exitCode: 0, durationMs: 5_400_000 }],
  ["compaction", { result: "ok" }],
  ["account_added", { pool: "claude", poolSize: "2-5" }],
  ["account_imported", { pool: "codex", poolSize: "1" }],
  ["account_removed", { pool: "claude", poolSize: "1" }],
  ["account_reauthenticated", { pool: "claude" }],
  ["account_renamed", { pool: "codex" }],
  ["pi_login_added", { pool: "claude" }],
  ["update", { from: "1.186.0", to: "1.187.0" }],
];

test(
  "inverted: a daily send carries every documented event type under the install ID as an identified event with no person properties",
  async () => {
    const host = startStubHost();
    try {
      const homes = freshHomes();
      const env = hermeticEnv(homes, host.url);
      await run(["emails", "--codex"], env);
      const state = writeState(homes, { noticeAt: Date.now() - 2 * DAY_MS });
      const command = spoolEvents(homes).find((event) => event.event === "command");
      if (command === undefined) throw new Error("emails --codex spooled no command event");
      writeSpool(homes, [command, ...SPOOLED.map(([name, fields]) => spooledLike(command, name, fields, state.installId))]);

      await run(["check"], env);
      const sent = sentEvents(host);
      expect(eventNames(sent)).not.toEqual(["command", "install_daily", ...SPOOLED.map(([name]) => name)].sort());
      expect(personFaults(sent, state.installId)).not.toEqual([]);
    } finally {
      host.stop();
    }
  },
  120_000,
);
