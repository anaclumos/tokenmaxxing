import { expect, test } from "bun:test";
import { join } from "node:path";
import { run } from "./edge-telemetry-fixtures.ts";
import { parseJson, preparedHomes } from "./edge-async-sweep-fixtures.ts";
import { storeDir, writePool } from "./edge-cli-surface-fixtures.ts";
import { grokAccounts, grokEntry, grokEnv, grokReport, listed, pooledGrok, serveGrokCredits, storeGrokLogin } from "./edge-grok-statusonly-fixtures.ts";

const KEPT = "d35684a0-38a5-4cb0-8ef4-a568b17d3a2f";
const NAMED = "e46795b1-49b6-4dc1-9fa5-b679c28e4b30";

test("a GROK_HOME that names a pooled grok store marks no account active, and rm --grok removes that account and its store", async () => {
  const homes = preparedHomes();
  writePool(homes, "grok", [pooledGrok(KEPT, "kept@example.com"), pooledGrok(NAMED, "named@example.com")]);
  storeGrokLogin(homes, KEPT, grokEntry(KEPT));
  storeGrokLogin(homes, NAMED, grokEntry(NAMED));
  const stub = serveGrokCredits({});
  try {
    const env = grokEnv(homes, stub, { GROK_HOME: storeDir(homes, "grok", NAMED) });
    const status = await run(["status", "--json", "--cached"], env);
    const named = grokReport(parseJson(status.stdout), NAMED);
    const rm = await run(["rm", "--grok", "named@example.com"], env);
    expect({
      status: named && { exitCode: status.exitCode, active: named.active, sessions: named.sessions },
      rm: { exitCode: rm.exitCode, stderr: rm.stderr },
      left: grokAccounts(homes).map((a) => a.id),
      stores: listed(join(homes.state, "grok-stores")),
    }).toEqual({
      status: { exitCode: 0, active: false, sessions: 0 },
      rm: { exitCode: 0, stderr: "" },
      left: [KEPT, NAMED],
      stores: [KEPT.slice(0, 8)],
    });
  } finally {
    stub.stop();
  }
}, 30_000);
