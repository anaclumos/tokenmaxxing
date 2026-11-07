import { expect, test } from "bun:test";
import { join } from "node:path";
import { preparedHomes } from "./edge-async-sweep-fixtures.ts";
import { run } from "./edge-telemetry-fixtures.ts";
import { installFakeVibe, pinVibeBin, serveMistral, vibeAccounts, vibeEnv, vibeOnboardLeft, vibeStoreDirs } from "./edge-vibe-fixtures.ts";

test("inverted: add --vibe with a refused setup key leaves a store nothing names", async () => {
  const homes = preparedHomes();
  const vibe = installFakeVibe(homes, "test-key");
  pinVibeBin(homes, vibe.bin);
  const mistral = serveMistral({ users: {} });
  try {
    const result = await run(["add", "--vibe"], vibeEnv(homes, mistral, { binDir: vibe.dir, vibeHome: join(homes.home, "vibe-home") }));
    expect({
      failed: result.exitCode !== 0,
      setups: vibe.setups().length,
      askedIdentity: mistral.calls.some((c) => c.path === "/mistral/v1/users/me" && c.key === "test-key"),
      accounts: vibeAccounts(homes),
      stores: vibeStoreDirs(homes),
      onboardLeft: vibeOnboardLeft(homes),
      stdout: result.stdout,
      stderr: result.stderr,
    }).toMatchObject({ failed: true, setups: 1, askedIdentity: true, accounts: [], stores: ["never"], onboardLeft: [] });
  } finally {
    mistral.stop();
  }
}, 30_000);
