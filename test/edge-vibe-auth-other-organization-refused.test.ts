import { expect, test } from "bun:test";
import { join } from "node:path";
import { preparedHomes } from "./edge-async-sweep-fixtures.ts";
import { labeled, reauthTargets, writePool } from "./edge-cli-surface-fixtures.ts";
import { run } from "./edge-telemetry-fixtures.ts";
import { installFakeVibe, pinVibeBin, serveMistral, vibeAccounts, vibeEnv, vibeIdentity, vibeStore, vibeStoreDirs, writeVibeStore } from "./edge-vibe-fixtures.ts";

test("auth --vibe <label> refuses a key for the same Mistral user in another organization and keeps the stored key and the reauth flag", async () => {
  const homes = preparedHomes();
  const id = vibeIdentity("user_test", "org_test");
  writePool(homes, "vibe", [{ ...labeled(id, "vibe-one", "pro"), email: "user@example.com", needsReauth: true }]);
  writeVibeStore(homes, id, "old-key");
  const vibe = installFakeVibe(homes, "test-key");
  pinVibeBin(homes, vibe.bin);
  const mistral = serveMistral({ users: { "test-key": { id: "user_test", email: "user@example.com", organization: { id: "org_other" } } } });
  try {
    const result = await run(["auth", "--vibe", "vibe-one"], vibeEnv(homes, mistral, { binDir: vibe.dir, vibeHome: join(homes.home, "vibe-home") }));
    expect({
      exitCode: result.exitCode,
      targets: reauthTargets(result.stdout),
      setups: vibe.setups().length,
      nothingChanged: result.stderr.includes("nothing changed"),
      accounts: vibeAccounts(homes).map((a) => ({ id: a.id, label: a.label, flagged: a.needsReauth === true })),
      stores: vibeStoreDirs(homes),
      store: vibeStore(homes, id),
      stdout: result.stdout,
      stderr: result.stderr,
    }).toMatchObject({
      exitCode: 1,
      targets: ["vibe-one"],
      setups: 1,
      nothingChanged: true,
      accounts: [{ id, label: "vibe-one", flagged: true }],
      stores: [id.slice(0, 8)],
      store: { doc: { id, apiKey: "old-key" }, mode: 0o600 },
    });
  } finally {
    mistral.stop();
  }
}, 30_000);
