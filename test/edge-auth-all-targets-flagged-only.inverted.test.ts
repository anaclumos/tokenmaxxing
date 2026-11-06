import { expect, test } from "bun:test";
import { run } from "./edge-telemetry-fixtures.ts";
import { preparedHomes, startStub, stubEnv } from "./edge-async-sweep-fixtures.ts";
import { fakeGrokEnv, grokStoreRefreshToken, installFakeGrok, labeled, reauthTargets, writeGrokStore, writePool } from "./edge-cli-surface-fixtures.ts";

const HEALTHY = "e3568a0f-3815-41c0-9ef4-a568b17d3a2e";
const STALE = "f4679b1a-4926-42d1-8a05-b679c28e4b3f";

test("inverted: auth --grok --all reauthenticates only the account with no usable credential and leaves the healthy account's store alone", async () => {
  const homes = preparedHomes();
  const grok = installFakeGrok(homes);
  writePool(homes, "grok", [labeled(HEALTHY, "healthy", "supergrok"), labeled(STALE, "stale", "supergrok")]);
  writeGrokStore(homes, HEALTHY, "old-refresh");
  const stub = startStub({ gated: [] });
  try {
    const result = await run(["auth", "--grok", "--all"], fakeGrokEnv(stubEnv(homes, stub.base), homes, STALE));
    expect({
      exitCode: result.exitCode,
      targets: reauthTargets(result.stdout),
      logins: grok.logins(),
      staleStore: grokStoreRefreshToken(homes, STALE),
      healthyStore: grokStoreRefreshToken(homes, HEALTHY),
      stdout: result.stdout,
      stderr: result.stderr,
    }).not.toMatchObject({ exitCode: 0, targets: ["stale"], logins: [STALE], staleStore: "fresh-refresh", healthyStore: "old-refresh" });
  } finally {
    stub.stop();
  }
}, 30_000);
