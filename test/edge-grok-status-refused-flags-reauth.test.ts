import { expect, test } from "bun:test";
import { join } from "node:path";
import { run } from "./edge-telemetry-fixtures.ts";
import { parseJson, preparedHomes } from "./edge-async-sweep-fixtures.ts";
import { reauthTargets, writePool } from "./edge-cli-surface-fixtures.ts";
import { fileTree, grokAuthText, grokEntry, grokEnv, grokReport, grokStore, installGrok, ISOLATED_HOME, loginRuns, pinGrokBin, pooledGrok, serveGrokCredits, storeGrokLogin, writeGrokAuth } from "./edge-grok-statusonly-fixtures.ts";

const REFUSED = "af1240cb-f4d1-4d8c-9ab0-c1247d3f9cea";
const OTHER = "b02351dc-05e2-4e9d-8bc1-d2358e4a0dfb";

test("status flags a grok account for re-auth when both its stored token and its ~/.grok login are refused, never reads with another account's live login, and auth --grok --all then signs it in again and clears the flag", async () => {
  const homes = preparedHomes();
  const stored = grokEntry(REFUSED, { email: "refused@example.com", key: "stored-token" });
  const live = { [OTHER]: grokEntry(OTHER, { email: "other@example.com", key: "other-live-token" }), [REFUSED]: grokEntry(REFUSED, { email: "refused@example.com", key: "live-token" }) };
  const renewed = grokEntry(REFUSED, { email: "refused@example.com", key: "renewed-token", refresh: "renewed-refresh" });
  const grok = installGrok({ login: { [REFUSED]: renewed } });
  pinGrokBin(homes, grok.bin);
  const ambient = join(homes.home, ".grok");
  writeGrokAuth(ambient, live);
  writePool(homes, "grok", [pooledGrok(REFUSED, "refused@example.com")]);
  storeGrokLogin(homes, REFUSED, stored);
  const stub = serveGrokCredits({ "other-live-token": { percent: 12 }, "renewed-token": { percent: 5 } });
  try {
    const env = grokEnv(homes, stub);
    const sampled = await run(["status", "--json"], env);
    const flagged = grokReport(parseJson(sampled.stdout), REFUSED);
    const triedWhenFlagged = [...stub.bearers];
    const storeWhenFlagged = grokStore(homes, REFUSED);
    const kept = grokReport(parseJson((await run(["status", "--json", "--cached"], env)).stdout), REFUSED);
    const auth = await run(["auth", "--grok", "--all"], env);
    const recovered = grokReport(parseJson((await run(["status", "--json"], env)).stdout), REFUSED);
    expect({
      flagged: flagged && { exitCode: sampled.exitCode, needsReauth: flagged.needsReauth, exhausted: flagged.exhausted, usage: flagged.usage, sampleOk: flagged.sample.ok },
      liveLoginTried: triedWhenFlagged.includes("live-token"),
      otherLoginTried: triedWhenFlagged.includes("other-live-token"),
      storeWhenFlagged,
      keptInCachedStatus: kept?.needsReauth,
      auth: { exitCode: auth.exitCode, targets: reauthTargets(auth.stdout), logins: loginRuns(homes, grok), stderr: auth.stderr },
      recovered: recovered && { needsReauth: recovered.needsReauth, used: recovered.usage?.week?.usedPercentage, sample: recovered.sample },
      store: grokStore(homes, REFUSED),
      ambient: fileTree(ambient),
    }).toEqual({
      flagged: { exitCode: 0, needsReauth: true, exhausted: false, usage: null, sampleOk: false },
      liveLoginTried: true,
      otherLoginTried: false,
      storeWhenFlagged: { doc: { [REFUSED]: stored }, mode: 0o600 },
      keptInCachedStatus: true,
      auth: { exitCode: 0, targets: ["refused@example.com"], logins: [{ grokHome: ISOLATED_HOME, args: "login" }], stderr: "" },
      recovered: { needsReauth: false, used: 5, sample: { ok: true, source: "probe" } },
      store: { doc: { [REFUSED]: renewed }, mode: 0o600 },
      ambient: { "auth.json": grokAuthText(live) },
    });
  } finally {
    stub.stop();
  }
}, 30_000);
