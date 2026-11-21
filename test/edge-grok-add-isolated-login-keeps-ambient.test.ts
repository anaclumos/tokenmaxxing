import { expect, test } from "bun:test";
import { join } from "node:path";
import { run } from "./edge-telemetry-fixtures.ts";
import { preparedHomes } from "./edge-async-sweep-fixtures.ts";
import { writePool } from "./edge-cli-surface-fixtures.ts";
import { scratchDir } from "./edge-providers-fixtures.ts";
import { fileTree, grokAccounts, grokAuthText, grokEntry, grokEnv, grokStore, installGrok, ISOLATED_HOME, listed, loginRuns, pinGrokBin, pooledGrok, serveGrokCredits, storeGrokLogin, writeGrokAuth } from "./edge-grok-statusonly-fixtures.ts";

const POOLED = "8df02ea9-d2bf-4b6a-9e9e-af025b1d7ac8";
const ADDED = "9e013fba-e3c0-4c7b-8faf-b0136c2e8bd9";

test("add --grok for an account that GROK_HOME is also signed in to pools the grant of its own isolated login in a 0600 store and leaves both GROK_HOME logins byte-identical", async () => {
  const homes = preparedHomes();
  const pooled = grokEntry(POOLED, { email: "pooled@example.com" });
  const live = { [POOLED]: pooled, [ADDED]: grokEntry(ADDED, { email: "added@example.com", key: "ambient-token", refresh: "ambient-refresh" }) };
  const isolated = grokEntry(ADDED, { email: "added@example.com", key: "isolated-token", refresh: "isolated-refresh" });
  const grok = installGrok({ login: { [ADDED]: isolated } });
  pinGrokBin(homes, grok.bin);
  const ambient = scratchDir("grok-home");
  writeGrokAuth(ambient, live);
  writePool(homes, "grok", [pooledGrok(POOLED, "pooled@example.com")]);
  storeGrokLogin(homes, POOLED, pooled);
  const stub = serveGrokCredits({});
  try {
    const result = await run(["add", "--grok"], grokEnv(homes, stub, { GROK_HOME: ambient }));
    expect({
      exitCode: result.exitCode,
      logins: loginRuns(homes, grok),
      accounts: grokAccounts(homes),
      addedStore: grokStore(homes, ADDED),
      pooledStore: grokStore(homes, POOLED),
      ambient: fileTree(ambient),
      onboardLeft: listed(join(homes.state, "onboard")),
      stderr: result.stderr,
    }).toEqual({
      exitCode: 0,
      logins: [{ grokHome: ISOLATED_HOME, args: "login" }],
      accounts: [
        { id: POOLED, label: "pooled@example.com", email: "pooled@example.com" },
        { id: ADDED, label: "added@example.com", email: "added@example.com" },
      ],
      addedStore: { doc: { [ADDED]: live[ADDED] }, mode: 0o600 },
      pooledStore: { doc: { [POOLED]: pooled }, mode: 0o600 },
      ambient: { "auth.json": grokAuthText(live) },
      onboardLeft: [],
      stderr: "",
    });
  } finally {
    stub.stop();
  }
}, 30_000);
