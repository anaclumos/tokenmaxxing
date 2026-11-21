import { expect, test } from "bun:test";
import { join } from "node:path";
import { run } from "./edge-telemetry-fixtures.ts";
import { parseJson, preparedHomes } from "./edge-async-sweep-fixtures.ts";
import { writePool } from "./edge-cli-surface-fixtures.ts";
import { grokAccounts, grokEntry, grokEnv, grokReport, listed, pooledGrok, serveGrokCredits, storeGrokLogin, writeLeftoverGrokPresence } from "./edge-grok-statusonly-fixtures.ts";

const KEPT = "f57806c2-5ac7-4ed2-8ab6-c78ad39f5c41";
const SEATED = "068917d3-6bd8-4fe3-9bc7-d89be4a06d52";

test("a grok-live presence record an older version left for a process that is still running counts as no grok session, and rm --grok removes that account", async () => {
  const homes = preparedHomes();
  writePool(homes, "grok", [pooledGrok(KEPT, "kept@example.com"), pooledGrok(SEATED, "seated@example.com")]);
  storeGrokLogin(homes, KEPT, grokEntry(KEPT));
  storeGrokLogin(homes, SEATED, grokEntry(SEATED));
  const startedAt = writeLeftoverGrokPresence(homes, { sessionId: "0190f5a2-1e3a-7b5c-8d7f-0a2c4e6b8d93", accountId: SEATED, pid: process.pid });
  const stub = serveGrokCredits({});
  try {
    const env = grokEnv(homes, stub);
    const status = await run(["status", "--json", "--cached"], env);
    const seated = grokReport(parseJson(status.stdout), SEATED);
    const rm = await run(["rm", "--grok", "seated@example.com"], env);
    expect({
      recordHasStartTime: startedAt !== "",
      status: seated && { exitCode: status.exitCode, active: seated.active, sessions: seated.sessions },
      rm: { exitCode: rm.exitCode, stderr: rm.stderr },
      left: grokAccounts(homes).map((a) => a.id),
      stores: listed(join(homes.state, "grok-stores")),
    }).toEqual({
      recordHasStartTime: true,
      status: { exitCode: 0, active: false, sessions: 1 },
      rm: { exitCode: 0, stderr: "" },
      left: [KEPT],
      stores: [KEPT.slice(0, 8)],
    });
  } finally {
    stub.stop();
  }
}, 30_000);
