import { expect, test } from "bun:test";
import { join } from "node:path";
import { preparedHomes } from "./edge-async-sweep-fixtures.ts";
import { run } from "./edge-telemetry-fixtures.ts";
import { installFakeVibe, pinVibeBin, serveMistral, vibeAccounts, vibeEnv, vibeIdentity, vibeStore, vibeStoreDirs } from "./edge-vibe-fixtures.ts";

test("inverted: add --vibe pools a user without an organization under an id nothing derives", async () => {
  const homes = preparedHomes();
  const vibe = installFakeVibe(homes, "test-key");
  pinVibeBin(homes, vibe.bin);
  const mistral = serveMistral({ users: { "test-key": { id: "user_test", email: "user@example.com" } } });
  try {
    const result = await run(["add", "--vibe"], vibeEnv(homes, mistral, { binDir: vibe.dir, vibeHome: join(homes.home, "vibe-home") }));
    const id = vibeIdentity("user_test");
    expect({
      exitCode: result.exitCode,
      accounts: vibeAccounts(homes).map((a) => ({ id: a.id, email: a.email })),
      stores: vibeStoreDirs(homes),
      store: vibeStore(homes, id),
      stdout: result.stdout,
      stderr: result.stderr,
    }).toMatchObject({
      exitCode: 0,
      accounts: [{ id: "never", email: "user@example.com" }],
      stores: [id.slice(0, 8)],
      store: { doc: { id, apiKey: "test-key" }, mode: 0o600 },
    });
  } finally {
    mistral.stop();
  }
}, 30_000);
