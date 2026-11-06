import { expect, test } from "bun:test";
import { run } from "./edge-telemetry-fixtures.ts";
import { preparedHomes, startStub, stubEnv } from "./edge-async-sweep-fixtures.ts";
import { fakeGrokEnv, grokStoreRefreshToken, installFakeGrok, labeled, reauthTargets, writeGrokStore, writePool } from "./edge-cli-surface-fixtures.ts";

const PICKED = "a578ac2b-5a37-43e2-9b16-c78ad39f5c40";
const OTHER = "b689bd3c-6b48-44f3-8c27-d89be4a06d51";

test("inverted: auth --grok <label> reauthenticates the named account even when its credential is usable, and touches no other account", async () => {
  const homes = preparedHomes();
  const grok = installFakeGrok(homes);
  writePool(homes, "grok", [labeled(OTHER, "other", "supergrok"), labeled(PICKED, "picked", "supergrok")]);
  writeGrokStore(homes, PICKED, "old-picked-refresh");
  const stub = startStub({ gated: [] });
  try {
    const result = await run(["auth", "--grok", "picked"], fakeGrokEnv(stubEnv(homes, stub.base), homes, PICKED));
    expect({
      exitCode: result.exitCode,
      targets: reauthTargets(result.stdout),
      logins: grok.logins(),
      pickedStore: grokStoreRefreshToken(homes, PICKED),
      otherStore: grokStoreRefreshToken(homes, OTHER),
      stdout: result.stdout,
      stderr: result.stderr,
    }).not.toMatchObject({ exitCode: 0, targets: ["picked"], logins: [PICKED], pickedStore: "fresh-refresh", otherStore: null });
  } finally {
    stub.stop();
  }
}, 30_000);
