import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { run } from "./edge-telemetry-fixtures.ts";
import { preparedHomes } from "./edge-async-sweep-fixtures.ts";
import { grokAccounts, grokEntry, grokEnv, grokStore, installGrok, ISOLATED_HOME, listed, loginRuns, serveGrokCredits, withPath } from "./edge-grok-statusonly-fixtures.ts";

const FRESH = "7cef1d98-c1ae-4a5f-8d8d-9ef14a0c6fb7";

test("init --grok with no live login runs grok login in a throwaway GROK_HOME under the state directory, pools that login, deletes the throwaway home, and creates no ~/.grok", async () => {
  const homes = preparedHomes();
  const fresh = grokEntry(FRESH, { email: "fresh@example.com" });
  const grok = installGrok({ login: { [FRESH]: fresh } });
  const stub = serveGrokCredits({});
  try {
    const result = await run(["init", "--grok"], grokEnv(homes, stub, withPath(grok.dir)));
    expect({
      exitCode: result.exitCode,
      logins: loginRuns(homes, grok),
      accounts: grokAccounts(homes),
      store: grokStore(homes, FRESH),
      onboardLeft: listed(join(homes.state, "onboard")),
      ambientHomeCreated: existsSync(join(homes.home, ".grok")),
      wrapperInstalled: listed(join(homes.state, "bin")).includes("grok"),
      stderr: result.stderr,
    }).toEqual({
      exitCode: 0,
      logins: [{ grokHome: join(homes.home, ".grok"), args: "login" }],
      accounts: [{ id: FRESH, label: "fresh@example.com", email: "fresh@example.com" }],
      store: { doc: { [FRESH]: fresh }, mode: 0o600 },
      onboardLeft: [],
      ambientHomeCreated: false,
      wrapperInstalled: false,
      stderr: "",
    });
  } finally {
    stub.stop();
  }
}, 30_000);
