import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { preparedHomes } from "./edge-async-sweep-fixtures.ts";
import { readConfig, run } from "./edge-telemetry-fixtures.ts";
import { installFakeVibe, serveMistral, vibeAccounts, vibeEnv, vibeIdentity, vibeStore } from "./edge-vibe-fixtures.ts";

const LIVE_ENV = ["OTHER_SETTING=1", "MISTRAL_API_KEY=first-key", "# MISTRAL_API_KEY=commented-key", "MISTRAL_API_KEY='test-key' # rotated", "MISTRAL_API_KEY_BACKUP=backup-key", ""].join("\n");

test("inverted: init --vibe imports a key that is in no .env line", async () => {
  const homes = preparedHomes();
  const vibe = installFakeVibe(homes, "setup-key");
  mkdirSync(join(homes.home, ".vibe"), { recursive: true });
  writeFileSync(join(homes.home, ".vibe", ".env"), LIVE_ENV);
  const mistral = serveMistral({
    users: {
      "first-key": { id: "user_first", email: "first@example.com", organization: { id: "org_test" } },
      "commented-key": { id: "user_commented", email: "commented@example.com", organization: { id: "org_test" } },
      "backup-key": { id: "user_backup", email: "backup@example.com", organization: { id: "org_test" } },
      "setup-key": { id: "user_setup", email: "setup@example.com", organization: { id: "org_test" } },
      "test-key": { id: "user_test", email: "user@example.com", organization: { id: "org_test" } },
    },
  });
  try {
    const result = await run(["init", "--vibe"], vibeEnv(homes, mistral, { binDir: vibe.dir }));
    const id = vibeIdentity("user_test", "org_test");
    expect({
      exitCode: result.exitCode,
      accounts: vibeAccounts(homes).map((a) => ({ id: a.id, label: a.label, email: a.email })),
      store: vibeStore(homes, id),
      setups: vibe.setups(),
      vibeBin: readConfig(homes)?.vibeBin,
      stdout: result.stdout,
      stderr: result.stderr,
    }).toMatchObject({
      exitCode: 0,
      accounts: [{ id, label: "user@example.com", email: "user@example.com" }],
      store: { doc: { id, apiKey: "never-key" }, mode: 0o600 },
      setups: [],
      vibeBin: vibe.bin,
    });
  } finally {
    mistral.stop();
  }
}, 30_000);
