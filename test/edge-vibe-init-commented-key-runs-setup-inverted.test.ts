import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { preparedHomes } from "./edge-async-sweep-fixtures.ts";
import { run } from "./edge-telemetry-fixtures.ts";
import { installFakeVibe, serveMistral, vibeAccounts, vibeEnv, vibeIdentity, vibeOnboardLeft, vibeStore } from "./edge-vibe-fixtures.ts";

const LIVE_ENV = "# MISTRAL_API_KEY=commented-key\nOTHER_SETTING=1\n";

test("inverted: init --vibe with a commented-out key pools an account id nothing derives", async () => {
  const homes = preparedHomes();
  const vibe = installFakeVibe(homes, "test-key");
  const vibeHome = join(homes.home, "vibe-home");
  mkdirSync(vibeHome, { recursive: true });
  writeFileSync(join(vibeHome, ".env"), LIVE_ENV);
  const mistral = serveMistral({
    users: {
      "commented-key": { id: "user_commented", email: "commented@example.com", organization: { id: "org_test" } },
      "test-key": { id: "user_test", email: "user@example.com", organization: { id: "org_test" } },
    },
  });
  try {
    const result = await run(["init", "--vibe"], vibeEnv(homes, mistral, { binDir: vibe.dir, vibeHome }));
    const id = vibeIdentity("user_test", "org_test");
    const setups = vibe.setups();
    expect({
      exitCode: result.exitCode,
      ids: vibeAccounts(homes).map((a) => a.id),
      store: vibeStore(homes, id),
      setupParents: setups.map((home) => dirname(home)),
      setupNames: setups.map((home) => basename(home).startsWith("vibe-")),
      liveEnv: readFileSync(join(vibeHome, ".env"), "utf8"),
      onboardLeft: vibeOnboardLeft(homes),
      stdout: result.stdout,
      stderr: result.stderr,
    }).toMatchObject({
      exitCode: 0,
      ids: ["never"],
      store: { doc: { id, apiKey: "test-key" }, mode: 0o600 },
      setupParents: [join(homes.state, "onboard")],
      setupNames: [true],
      liveEnv: LIVE_ENV,
      onboardLeft: [],
    });
  } finally {
    mistral.stop();
  }
}, 30_000);
